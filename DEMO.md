# End-to-End Scenario Demo & Comprehensive Test Suite Walkthrough

> **Author**: Jenish Gondaliya
> **Project**: Job Feed Ingestion Service

---

## 1. Project Setup & How to Run

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure Environment (`.env`)

Create or verify your `.env` file in the project root:

```env
PORT=3000
MONGO_URL=mongodb://127.0.0.1:27017/jobfeed
PROVIDER_PLAN_PATH=fixtures/provider-plan.json
WORKER_COUNT=2
CLAIM_LEASE_MS=30000
POLL_INTERVAL_MS=500
BACKOFF_BASE_MS=1000
MAX_ATTEMPTS=3
```

> _(Optional: If using local Docker for MongoDB, start it with `docker compose up -d`)_

### Step 3: Run the Live Application (Development Server)

Starts the Express API server and background queue worker loops with live hot-reloading:

```bash
npm run dev
```

Output in console:

```text
[db] connecting to MongoDB...
[db] ✅ MongoDB connected
[server] ✅ job-feed listening on port 3000  →  http://127.0.0.1:3000
```

### Step 4: Quick Manual Verification (cURL / Browser)

- **Health Check**:
  ```bash
  curl http://localhost:3000/health
  # Response: {"status":"ok","db":"connected"}
  ```
- **Post an Event (`202 Accepted`)**:
  ```bash
  curl -X POST http://localhost:3000/events \
    -H "Content-Type: application/json" \
    -d '{
      "eventId": "evt-quick-1",
      "tenantId": "tenant-a",
      "source": "main",
      "action": "upsert",
      "version": 1,
      "externalJobId": "quick-job-1",
      "payload": { "title": "Software Engineer" }
    }'
  # Response: {"status":"accepted","eventId":"evt-quick-1"}
  ```
- **Query Jobs with Cursor Pagination**:
  ```bash
  curl "http://localhost:3000/jobs?tenantId=tenant-a&source=main&limit=10"
  ```

---

## 2. Automated Demo & Test Commands

### 🌟 End-to-End Scenario Demo (Assignment Specification)

Runs the complete 20-request scenario fixture in sequential order, drains Phase 1, submits Phase 2, and asserts all final database projections:

```bash
npm run demo
```

### 🧪 Full Integration Test Suite (Real MongoDB)

Executes all 27 integration tests across 6 suites verifying atomicity, concurrency, crash recovery, retries, and isolation:

```bash
npm test
```

### 🚀 High-Throughput Load Benchmark (1,000 Events)

Runs 1,000 distinct events + 200 replays with live console progress bars:

```bash
npm run load
```

---

## 3. End-to-End Scenario Demo Walkthrough (`npm run demo`)

The demo script (`src/scripts/demo.ts`) tests the entire lifecycle using the official scenario fixture (`fixtures/scenario.json`). **No fixture IDs are hardcoded into the business logic**—the engine dynamically processes any arbitrary stream conforming to the API contract.

### How the Demo Executes:

1. **Initializes Database**: Connects to MongoDB, asserts all unique and compound indexes, and cleans test tenant namespaces (`tenant-a`, `tenant-b`).
2. **Launches App with Background Workers**: Starts the Express server with **2 concurrent worker loops** consuming from the MongoDB work queue.
3. **Phase 1 Execution (14 Requests)**:
   - Submits events sequentially in fixture order.
   - Asserts HTTP response status codes immediately at submission (`202 Accepted`, `200 OK` replay, `409 Conflict`, `400 Bad Request`).
4. **Phase 1 Settlement**:
   - Waits for workers to drain all claimed events until queue is empty.
   - Verifies the settled database projections against expected Phase 1 outcomes.
5. **Phase 2 Execution (6 Requests)**:
   - Submits delayed updates, out-of-order versions, archives, and reactivations.
   - Checks HTTP statuses immediately upon arrival.
6. **Phase 2 Settlement**:
   - Drains background queue completely.
   - Verifies final job projection states, version overrides, tombstones, and recovery.
7. **Verification**: Prints `demo passed` when 100% of HTTP codes and settled database records match specifications.

---

### Phase 1 Expected Outcomes

| Job / Event Identity        | Action / Version | HTTP Status | Settled Database State & Verification                                             |
| :-------------------------- | :--------------: | :---------: | :-------------------------------------------------------------------------------- |
| `tenant-a / main / alpha`   |   `v1` ➔ `v3`    |    `202`    | Active Version 3, Title: `Senior Full Stack Developer`.                           |
| `tenant-a / main / fixed`   | `v1` (corrected) |    `202`    | Active Version 1, Title: `Backend Engineer`, Skills: `["typescript", "mongodb"]`. |
| `tenant-b / main / alpha`   |       `v1`       |    `202`    | Active Version 1 (isolated tenant: distinct job record from `tenant-a`).          |
| `tenant-a / other / alpha`  |       `v1`       |    `202`    | Active Version 1 (isolated source: distinct job record from source `main`).       |
| `tenant-a / main / beta`    |       `v1`       |    `202`    | Active Version 1 after upstream `429` rate-limit backoff and second attempt.      |
| `tenant-a / main / gamma`   |       `v1`       |    `202`    | Marked `failed` on provider `422` (permanent error, no job created).              |
| `tenant-a / main / delta`   |       `v1`       |    `202`    | Marked `failed` after three `503` attempts exhausted (no job created).            |
| `tenant-a / main / epsilon` |  `v2` (archive)  |    `202`    | Archived Version 2 with tombstone; no prior upsert existed.                       |
| `tenant-a / main / eta`     |       `v1`       |    `202`    | Active Version 1 `Platform Engineer`.                                             |

#### Phase 1 Rejection & Replay Checks:

- **Whitespace in Event ID** (`evt-space`): Returns `400 Bad Request`. Event ID is **not reserved**.
- **Invalid HTTP URL**: Returns `400 Bad Request`. Re-submitted with corrected HTTPS URL as `evt-fix` ➔ returns `202 Accepted`.
- **Exact Replay with Reordered JSON Keys**: Returns `200 OK` (no duplicate work item created).
- **Conflicting Body for Reused ID**: Returns `409 Conflict`.

---

### Phase 2 Expected Outcomes (Out-of-Order & Archival)

| Job / Event Identity | Action / Version | HTTP Status | Settled Database State & Verification                                             |
| :------------------- | :--------------: | :---------: | :-------------------------------------------------------------------------------- |
| `alpha`              |  `v2` (delayed)  |    `202`    | Stale version discarded as `noop` (0 attempts); Version 3 remains current.        |
| `epsilon`            |  `v1` (delayed)  |    `202`    | Stale upsert discarded as `noop`; Version 2 archive tombstone blocks overwrite.   |
| `epsilon`            |  `v3` (upsert)   |    `202`    | Active `Reactivated Role` (higher version successfully reactivates archived job). |
| `eta`                | `v2` (fails 422) |    `202`    | Event marked `failed`; eta job remains visible at previous Version 1.             |
| `alpha`              |  `v4` (archive)  |    `202`    | Archived; title remains `Senior Full Stack Developer`.                            |
| `alpha`              |  Replay of `v4`  |    `200`    | Idempotent replay; returns `200 OK` with no duplicate work.                       |

---

## 4. Executable Integration Test Suite Checks

All tests are implemented using Node's native test runner (`node:test`) against **real MongoDB integration databases** (no mocks), ensuring unique index validation, concurrency, and lease recovery:

```bash
npm test
```

### Coverage Mapping for Assignment Requirements:

| Assignment Requirement                   | Test File                                                                                                                                                                                                                                                      | Key Test Cases & Verification                                                                                                                                                                                                                                                                                                                                         |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validation, Normalization & Replay**   | [`test/validate.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/validate.test.ts)[`test/api.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/api.test.ts)                                       | • Invalid event IDs, versions, HTTP URLs, experience rejected with `400`.• Whitespace trimmed, skills deduplicated preserving first-seen order.• Canonical JSON ignores key order.• Identical replay returns `200 OK`; conflicting body returns `409 Conflict`.• Corrected request reuses rejected ID without conflict.                                               |
| **Tenant / Source Isolation & Versions** | [`test/version-isolation.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/version-isolation.test.ts)                                                                                                                            | • Same job ID across tenants (`tenant-a` vs `tenant-b`) or sources (`main` vs `other`) creates isolated jobs.• Out-of-order versions: higher version wins regardless of arrival order.• Archive tombstones prevent delayed older upserts from reactivating jobs.• Newer upsert reactivates archived job.• Failed higher version keeps previous lower version visible. |
| **Retry Success, Failures & Backoff**    | [`test/provider-failures.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/provider-failures.test.ts)[`test/provider-plan.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/provider-plan.test.ts) | • `429` and `503` retry with exponential backoff and visible attempt counts.• `422` permanent failure immediately stops retries without creating a job.• Three `503` responses exhaust retry budget, leaving event marked `failed` with 0 phantom jobs.                                                                                                               |
| **Concurrency & Race Conditions**        | [`test/concurrency.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/concurrency.test.ts)[`test/indexes.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/indexes.test.ts)                         | • Concurrent identical POSTs create exactly 1 work item (`$setOnInsert`).• Concurrent conflicting POSTs preserve 1 stored body and return `409`.• Two worker loops concurrently drain distinct events; version race leaves 1 consistent job.• MongoDB compound indexes reject duplicate identities under high concurrency.                                            |
| **Worker Crash & Recovery**              | [`test/crash-process.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/crash-process.test.ts)[`test/recovery.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/recovery.test.ts)                   | • Worker deliberately killed (`SIGKILL`) immediately after projection write before acknowledging event.• Lease expires (`claimExpiresAt`), allowing a second worker process to reclaim.• Final state is verified: exactly 1 logical job, event marked `succeeded`, no duplicate provider side effects.                                                                |
| **Persistence & Keyset Pagination**      | [`test/pagination-persistence.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/pagination-persistence.test.ts)                                                                                                                  | • Job records survive complete API/worker process restarts.• Cursor-based keyset pagination `{ createdAt, _id }` is stable, capped, and does not revisit or skip keys when data changes.                                                                                                                                                                              |
| **Fixture Scenario Integration**         | [`test/scenario.test.ts`](file:///c:/Users/JENISH/OneDrive/Desktop/Task/job-feed-ingestion/test/scenario.test.ts)                                                                                                                                              | • Full automated suite check verifying Phase 1 settles before Phase 2 submits.                                                                                                                                                                                                                                                                                        |

---

## 5. Test Suite Execution Output

```text
▶ acceptance (3897ms)
  ✔ invalid events return 400 and do not reserve the event id
  ✔ exact and reordered replays return 200 and a different body returns 409
  ✔ health reports ok while mongo is reachable
▶ concurrency (12060ms)
  ✔ concurrent identical posts create one work item
  ✔ concurrent conflicting posts keep one stored body
  ✔ two worker loops drain distinct events and a version race leaves one job
✔ a worker process that dies after the projection write is recovered by a second process (5463ms)
✔ mongo indexes match the documented model and reject duplicate identities (1472ms)
▶ pagination and restart (28178ms)
  ✔ pages are stable, capped, and do not revisit keys when data changes
  ✔ job state survives a new API connection
▶ provider failures (8503ms)
  ✔ 429 and 503 retry with backoff and then succeed
  ✔ 422 is permanent and does not create a job
  ✔ three 503 responses exhaust the attempt budget without a job
▶ recovery (5753ms)
  ✔ an abandoned claim is completed by another worker
  ✔ a crash after the projection write acknowledges the same job without a second provider call
✔ the fixture scenario settles phase 1 before submitting phase 2 (13487ms)
✔ canonical JSON ignores object key order and keeps array order
✔ normalization trims display fields and deduplicates skills in first-seen order
✔ validation rejects identifiers, versions, urls, experience, and archive payloads
✔ a valid archive omits payload
▶ versions and isolation (11214ms)
  ✔ the same identifiers in another tenant or source are separate jobs
  ✔ a higher version wins when lower versions arrive later
  ✔ an archive tombstone blocks older upserts and a newer upsert can reactivate it
  ✔ a failed higher version leaves the previous job visible

ℹ tests 27 | suites 6 | pass 27 | fail 0 | cancelled 0 | skipped 0
```

---

## 6. Summary of Why the Final State is Guaranteed Correct

1. **At-Least-Once Delivery with Idempotent Projections**: If a worker crashes after writing the projection, the event is re-claimed after lease expiration (`claimExpiresAt`). The projection check detects that version $V$ or higher has already been applied, marking the event `succeeded` without re-dispatching external side effects.
2. **ACID Single-Document Operations**: MongoDB's atomic `findOneAndUpdate` handles queue claiming and projection updates, preventing duplicate logical jobs even under concurrent worker execution.
3. **Deterministic Tombstones**: Archives write `{ isArchived: true, version }`, preventing delayed older updates from reactivating archived jobs.

---

## 💙 Author

**Jenish Gondaliya**
_Thank you for evaluating the demo walkthrough and test suite verification!_
