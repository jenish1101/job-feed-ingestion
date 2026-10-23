# SCALE.md — Job Feed Ingestion Service

> **Author**: Jenish Gondaliya  
> **Project**: Job Feed Ingestion Service

---

## 1. Starting Numbers

Before getting into the math, here are the assumptions I'm working with. Some of these (like per-worker throughput) are estimates based on local testing — they'd need profiling in a real production environment.

| What                   | Value                                           |
| :--------------------- | :---------------------------------------------- |
| Current traffic        | 100,000 events/day (~1.2 events/sec average)    |
| Target traffic         | 10,000,000 events/day (~116 events/sec average) |
| Peak burst             | 5,000 events/sec                                |
| Processing SLA         | Every accepted event processed within 5 minutes |
| Payload size           | 1 KB average                                    |
| Retention              | 7 days                                          |
| Active job projections | ~1,000,000                                      |
| Per-worker throughput  | ~25 ms/event → ~40 events/sec/worker            |
| Worker pool            | 40 workers → ~1,600 events/sec total            |

The 25 ms/event figure comes from local runs with a co-located MongoDB. In my actual dev setup (remote Atlas), it's closer to 60–70 ms because of network latency. I'll use the 25 ms assumption for the design calculations since that's what production would look like with a proper deployment.

---

## 2. Average vs Burst Traffic

At 10M events/day the average is ~116/sec. That's easy — 40 workers handle it with ~93% headroom. The real concern is the burst.

**At 5,000 events/sec:**

- We accept at 5,000/sec but only process 1,600/sec.
- Backlog grows at 3,400 events/sec while the burst is running.
- After the burst ends, we have 1,600 − 116 = 1,484 events/sec of spare capacity to drain it.

To stay within 5 minutes, the backlog at burst-end has to be drainable in 300 seconds:

- Max drainable backlog = 300 × 1,484 = ~445,000 events
- Max burst duration = 445,000 ÷ 3,400 = **~131 seconds**

So the design handles a 5,000/sec burst for about 2 minutes before SLA risk kicks in. Beyond that you'd need to either add workers or start throttling new ingestion.

| Burst length | Backlog at end | Drain time | Total time |    SLA?    |
| :----------: | :------------: | :--------: | :--------: | :--------: |
|  10 seconds  |     34,000     |  ~23 sec   |  ~33 sec   |     ✅     |
|  60 seconds  |    204,000     |  ~137 sec  |  ~3.3 min  |     ✅     |
| 130 seconds  |    442,000     |  ~298 sec  |   ~5 min   | ✅ (tight) |
|  10 minutes  |   2,040,000    |  ~23 min   |  ~33 min   |     ❌     |

I haven't tested this at actual 5,000 events/sec — these numbers come from the math, not a real load test at that scale. The local benchmark section at the end shows what I did actually measure.

---

## 3. Storage & TTL

At 10M events/day for 7 days that's 70M stored events. At roughly 1.4 KB per event (1 KB payload + overhead + index space), that's about **98 GB on the primary** and ~294 GB across a 3-node replica set.

The jobs collection with 1M documents at ~1 KB is only ~1 GB. Not a concern.

What actually matters for performance is keeping the working set in RAM — specifically the index on `{ status, nextAttemptAt, _id }` that workers hit constantly. At this event volume I'd estimate that index at around 8 GB. If the MongoDB instance doesn't have enough RAM to keep it hot, worker poll latency will spike.

Rough recommendation: M40 or M50 on Atlas (16–32 GB RAM). That's my estimate — a real capacity plan would need profiling with actual data distribution.

TTL cleanup is handled automatically by the `{ createdAt: 1 }` index with `expireAfterSeconds: 604800`. Nothing manual needed.

---

## 4. Indexes, Sharding & Hot Keys

The two unique indexes that matter:

- `events`: `{ tenantId, source, eventId }` — enforces idempotency
- `jobs`: `{ tenantId, source, externalJobId }` — one document per logical job

Both start with `tenantId`, which makes `{ tenantId: 1 }` a natural shard key. MongoDB requires the shard key to be a prefix of any unique index, and this satisfies that.

**The hot key problem** — this is something I thought about but don't have a great answer for yet. If one enterprise tenant sends 80% of all traffic, their shard becomes a bottleneck regardless of how many shards you have. A few options:

- Add a hashed component: `{ tenantId: 1, _id: "hashed" }`. This spreads one tenant's writes across shards but makes tenant-scoped reads slightly less efficient since they'd need to query multiple shards.
- Rate-limit heavy tenants at the API layer first (see Section 5). This is the easiest lever and probably the first thing I'd pull.
- Detect hot shards via Atlas metrics and manually move chunks. This is more of an ops response than a design solution.

**Worker polling contention** — with 40 workers all running `findOneAndUpdate` on the same `{ status, nextAttemptAt }` index, you'll see some contention at the head of the index. At 40 workers this is fine in practice. At 100+ workers it starts showing up as wait time on the primary. The fix is switching to MongoDB Change Streams so workers get pushed new events instead of polling — but that's a bigger change I'd do when the problem actually appears.

---

## 5. Backpressure & Retry Storms

Two things I'd add as traffic grows:

**Per-tenant rate limiting** — cap each tenant at some max rate (e.g., 500 events/sec) at the API level. Return `429` with a `Retry-After` header. This stops one tenant from flooding the queue. I'd probably implement this with a Redis token bucket at the gateway layer, though a simpler in-memory counter works for a first version.

**Global backpressure** — if the pending queue depth goes above some threshold (say 500,000 events), start throttling lower-priority ingestion. The idea is to protect DB write capacity for workers draining the existing backlog rather than making it worse.

**Retry jitter** — without this, a provider outage followed by recovery causes all pending retries to hit at the same time. Use full jitter: `sleep = random(0, min(cap, base * 2^attempt))`. This is already in the codebase for the current retry logic.

---

## 6. Metrics, Alerts & When to Add Kafka

### What to watch

| Metric                       | Why it matters                                       |
| :--------------------------- | :--------------------------------------------------- |
| `jobfeed_queue_age_seconds`  | Age of oldest pending event — the main SLA signal    |
| `jobfeed_queue_depth`        | How many events are waiting                          |
| `jobfeed_ingestion_rate`     | Events/sec being accepted                            |
| `jobfeed_worker_duration_ms` | p50/p95 per-event processing time                    |
| `jobfeed_retry_rate`         | How often workers retry upstream                     |
| `jobfeed_failed_events`      | Events that hit permanent failure                    |
| `jobfeed_db_iops`            | MongoDB primary write IOPS — first saturation signal |

### Alert thresholds (starting points — tune in production)

| Alert               | Threshold           | Severity | Action                          |
| :------------------ | :------------------ | :------- | :------------------------------ |
| Queue age high      | `> 60s`             | Warning  | Check workers and provider      |
| Queue age critical  | `> 240s`            | Critical | Add workers; check for outage   |
| Queue depth growing | `> 100,000`         | Warning  | Enable throttling               |
| High failure rate   | `> 1%` of ingestion | Warning  | Check provider error breakdown  |
| Retry storm         | `> 20%` retry rate  | Warning  | Provider degraded; check jitter |
| DB IOPS near limit  | `> 80%` provisioned | Critical | Scale up or add shards          |
| Slow workers        | p95 `> 10s`         | Warning  | Provider latency issue          |

These are rough starting numbers. I'd expect to adjust them once there's real production traffic to see what "normal" looks like.

### When to switch to Kafka

I'd add Kafka when at least one of these is happening regularly:

- Queue age alerts fire often and adding workers doesn't help (MongoDB throughput is the limit, not worker count)
- Multiple teams want to consume the same event stream independently (analytics, search, notifications) — MongoDB polling doesn't fan-out
- DB IOPS is consistently near its limit

**How to do it without breaking things (Transactional Outbox Pattern):**  
Don't change how the API writes — it stays atomic to MongoDB. Set up Debezium or MongoDB Change Streams to tail the oplog and forward events to Kafka topics partitioned by `tenantId`. Workers become Kafka consumers. No polling, no index contention.

The thing to avoid: writing to MongoDB and Kafka in the same request handler. If one fails and the other succeeds you've permanently lost or duplicated an event. I've read about this enough to know it's the main failure mode people run into.

---

## 7. Local Load Test (What I Actually Measured)

```bash
npm run load
```

Everything in the sections above is a design estimate. This section is real numbers from my machine.

**Environment:**

- Node.js v24.18.0, Windows 11, Intel i5-1235U (12 cores), 7.9 GB RAM
- MongoDB v8.0.34 on a remote Atlas cluster
- 20 concurrent HTTP requests, 8 background worker loops

**What ran:**

- 1,000 distinct events under separate `load-tenant-*` IDs
- 200 exact replays of events already submitted
- 50 jobs where a higher version arrived before the lower one

**Results:**

| Metric               | Result     |
| :------------------- | :--------- |
| Accepted             | 1,000      |
| Replays (200 OK)     | 200        |
| Errors               | 0          |
| HTTP p50             | 249.8 ms   |
| HTTP p95             | 941.1 ms   |
| Drain time           | 61 seconds |
| Final jobs in DB     | 950        |
| Out-of-order correct | 50 / 50    |
| Open at end          | 0          |

**What I took from this:**

The p95 of 941 ms looks high but it's almost entirely Atlas network latency — each MongoDB write has a ~150–250 ms round-trip over the internet. On a same-region or local instance I'd expect p95 under 100 ms.

The 61-second drain with 8 workers over Atlas works out to about 16 events/sec/worker. The design estimate is 40 events/sec/worker with a co-located cluster. The gap is purely the network — not a concern for production.

Out-of-order version handling worked correctly in all 50 cases. No lower version overwrote a higher one.

Don't extrapolate these numbers to production directly. The bottleneck here is Atlas network latency, not the application or MongoDB itself.

---

## 💙 Author

**Jenish Gondaliya**  
_Thank you for reviewing the scaling plan!_
