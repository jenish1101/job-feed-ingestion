# DESIGN.md — Job Feed Ingestion Service

> **Author**: Jenish Gondaliya  
> **Project**: Job Feed Ingestion Service  
> **Repository**: `job-feed-ingestion`

---

## 1. Architecture

The service accepts job feed events over HTTP, saves them to MongoDB, and processes them in the background using worker loops. The HTTP handler just validates, saves, and returns `202` — it never calls the external provider directly.

```
POST /events
     │
     ├── validate & normalize input
     ├── check for duplicate / conflict (unique index)
     └── insert event as "pending" into MongoDB
     │
     ▼ returns 202 immediately
MongoDB 'events' collection
     │
     ▼ background workers poll this collection
Worker Pool (2+ loops)
     │
     ├── claim next pending event (atomic lease)
     ├── skip if version is already stale
     ├── call external provider
     ├── write job projection to 'jobs' collection
     └── mark event as "succeeded" (or retry on 429/503)
```

**Why this split?**  
The external provider can be slow or flaky. If we called it inside the HTTP handler, any timeout or rate-limit (429) would hang the client's connection. Instead, we accept the event fast and let workers handle the slow part in the background.

---

## 2. Rules the System Always Keeps

These are the guarantees the system maintains regardless of timing, retries, or crashes:

1. **202 only after durable write** — We return `202 Accepted` only after MongoDB confirms the event is saved. If the server crashes right after, the event is still in the queue.

2. **Replay is safe** — Sending the exact same event again (same ID, same body, any key order) returns `200 OK` with no extra work created. Sending the same ID with a different body returns `409 Conflict`.

3. **Invalid events don't reserve the ID** — A `400 Bad Request` means the ID is free. The client can fix the payload and retry with the same event ID.

4. **Highest version wins** — If version 3 is already applied and version 2 arrives late, version 2 is silently skipped. The stored job stays at version 3.

5. **Archives block old upserts** — When a job is archived at version N, any older upsert (version < N) arriving later is discarded. A newer upsert (version > N) can reactivate it.

6. **Tenant + source isolation** — Two tenants with the same `externalJobId` get completely separate job records. Same for different sources within the same tenant.

---

## 3. Event Lifecycle

```
POST /events
    ├── 400 → rejected, ID not reserved
    ├── 200 → duplicate replay, no new work
    ├── 409 → conflicting body, rejected
    └── 202 → saved as [pending]

[pending]
    └── worker picks it up → [processing] (30s lease)

[processing]
    ├── version already stale → [succeeded] (noop)
    ├── provider 200 → write to jobs → [succeeded]
    ├── provider 429/503 → wait, retry → back to [pending]
    ├── provider 422 → permanent fail → [failed]
    └── max retries hit → [failed]

    ↑ if worker crashes mid-flight:
    └── lease expires after 30s → another worker picks it up
```

---

## 4. Database Collections & Indexes

Two collections — one for the queue, one for the read model.

### `events` — queue and audit log

Every raw event lives here from arrival until TTL expiry (7 days).

| Index          | Fields                              | Purpose                                                        |
| :------------- | :---------------------------------- | :------------------------------------------------------------- |
| **UNIQUE**     | `{ tenantId, source, eventId }`     | Prevents duplicate inserts; acts as the replay gate            |
| Work queue     | `{ status, nextAttemptAt, _id }`    | Workers use this to claim the next eligible event quickly      |
| Lease recovery | `{ status, claimExpiresAt }`        | Finds events whose lease has expired (crashed worker recovery) |
| TTL            | `{ createdAt }` — expires in 7 days | Auto-deletes old events so storage doesn't grow unboundedly    |

### `jobs` — current job state

One document per logical job. This is what `GET /jobs` reads from.

| Index      | Fields                                 | Purpose                               |
| :--------- | :------------------------------------- | :------------------------------------ |
| **UNIQUE** | `{ tenantId, source, externalJobId }`  | Ensures exactly one document per job  |
| Pagination | `{ tenantId, status, createdAt, _id }` | Stable keyset cursor for listing jobs |

---

## 5. Concurrency & Atomicity

All the tricky concurrency cases are handled with single-document atomic operations — no distributed transactions needed.

**Two requests for the same event arrive at the same time**  
MongoDB's unique index lets only one insert succeed. The other catches a duplicate key error, reads the stored body, and returns `200 OK` (if body matches) or `409 Conflict` (if it doesn't).

**Two workers try to claim the same event**  
`findOneAndUpdate` is atomic. Only one worker gets the document back with `status: "processing"`. The other finds nothing and moves on.

**A late version tries to overwrite a newer one**  
The job update query includes `{ version: { $lt: incomingVersion } }`. If a newer version already exists, MongoDB updates 0 documents. The stored job is untouched.

---

## 6. What Happens When Things Fail

### Acceptance fails (server crashes before returning 202)

The event was never committed to MongoDB. The client gets a connection error and can safely retry. No partial state exists.

### Projection write fails (worker writes to `jobs` but crashes before finishing)

The event stays in `status: "processing"`. After 30 seconds the lease expires. A second worker picks it up, calls the provider again (at-least-once), writes the projection, and marks the event `succeeded`.

### Acknowledgment fails (job written but event not marked `succeeded`)

This is the most interesting case. The job record in `jobs` already has `appliedEventId` set to this event's ID. When a second worker picks up the expired lease, it checks `jobs` first — sees that `appliedEventId` already matches — and marks the event `succeeded` **without calling the provider again**. No duplicate side effect.

---

## 7. Alternatives I Considered and Rejected

### Calling the provider inside the HTTP handler

Rejected. If the provider takes 3 seconds or returns 429, the HTTP request hangs. The client times out. Nothing is recoverable from the caller's perspective. Decoupling keeps the API fast regardless of provider health.

### Using Kafka or Redis for the work queue

I intentionally avoided adding Kafka or Redis to keep the runnable core dependency-free.

The bigger reason: if I write to MongoDB and _then_ publish to Kafka, those are two separate writes. If MongoDB succeeds but Kafka publish fails, I've lost the event from the queue. This is the classic **Dual-Write Problem**. Using MongoDB for both storage and queuing means both happen in one operation — there's no gap where one can fail without the other.

**That said — MongoDB is not a real message queue.**  
This tradeoff makes sense at this scale (up to ~5,000 events/second with good indexing). For genuinely high-throughput systems — millions of events per day, multiple downstream consumers, or burst traffic that regularly spikes beyond that threshold — you'd want Kafka. The right migration path is the **Transactional Outbox Pattern**: keep writing to MongoDB, use MongoDB Change Streams (or Debezium) to forward events to Kafka topics, and let consumer groups process from there. That way you don't have the dual-write problem at the ingestion boundary.

See `SCALE.md` for the specific thresholds where I'd make that call.

### Multi-document transactions

Rejected. MongoDB multi-document transactions add coordination overhead and slow write throughput. Every concurrency case here — duplicate detection, worker leasing, version checks — is solvable with a single conditional `findOneAndUpdate`. No transactions needed.

---

## 8. Bottleneck & Tradeoff I Accepted

**First bottleneck**: MongoDB primary node write IOPS. Ingestion, worker polling, lease claims, and job projection updates all hit the same primary. That's the first thing that saturates under heavy load.

**Tradeoff I accepted**: External provider calls are **at-least-once**. If a worker crashes during the HTTP call to the provider, another worker will retry it. I'm assuming the provider handles duplicate calls gracefully (idempotent by job ID), which is a reasonable assumption for this type of integration but worth documenting as a limit.

---

## 💙 Author

**Jenish Gondaliya**  
_Thank you for reviewing the system design!_
