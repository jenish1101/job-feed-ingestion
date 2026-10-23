# Mandatory Quality Control & Verification Report (QC_REPORT.md)

> **Author**: Jenish Gondaliya
> **Project**: Job Feed Ingestion Service
> **Repository**: `job-feed-ingestion`

---

## 1. Environment & Setup Details

All verification checks were run directly on my local development workstation:

- **Node.js**: `v24.18.0` (also cross-verified on `v22.21.1`)
- **Package Manager**: npm `10.9.4`
- **TypeScript**: `5.8.3` (Strict mode enabled in `tsconfig.json` & `tsconfig.test.json`)
- **Primary Database**: MongoDB Atlas 8.0.34 (Remote cluster via `MONGODB_URI`)
- **Local Fallback**: MongoDB 7.0.40 via Docker Compose (`docker compose up -d`)
- **Runtime Dependencies**: `express` (^4.21.2), `mongodb` (^6.16.0)

---

## 2. Command Execution Log & Actual Results

Every check specified in the evaluation guidelines was executed. The results are recorded below:

| Check Category               | Command Executed                                                            |    Status     | Actual Result / Notes                                                                                     |
| :--------------------------- | :-------------------------------------------------------------------------- | :-----------: | :-------------------------------------------------------------------------------------------------------- |
| **Clean Setup & Docker**     | `npm run setup` (`docker compose up -d --wait && npm install`)              | ✅ **Passed** | Container configured via official `mongo:7.0` with healthcheck; all dependencies installed cleanly.       |
| **Linting**                  | `npm run lint` (`tsc --noEmit && prettier --check .`)                       | ✅ **Passed** | Exited `code 0`. Strict TypeScript compiler check and Prettier rule verification passed with 0 errors.    |
| **Format Check**             | `npm run format:check` (`prettier --check .`)                               | ✅ **Passed** | Exited `code 0`. All 51 project files verified matching Prettier code style without warnings.             |
| **TypeScript Checking**      | `npm run typecheck` (`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`)  | ✅ **Passed** | Exited `code 0`. Both application code (`src/`) and test suites (`test/`) compiled with zero errors.      |
| **Build**                    | `npm run build` (`tsc`)                                                     | ✅ **Passed** | Exited `code 0`. Emitted clean JavaScript output to `dist/`.                                              |
| **Unit & Integration Tests** | `npm test` (`node --import tsx --test --test-concurrency=1 test/*.test.ts`) | ✅ **Passed** | Exited `code 0`. **27 / 27 tests passed** across 6 suites (0 failures, 0 skipped, total duration: 70.5s). |
| **End-to-End Demo**          | `npm run demo` (`tsx src/scripts/demo.ts`)                                  | ✅ **Passed** | Exited `code 0`. Dispatched 20 fixture events across 2 phases; verified settled projections in DB.        |
| **Load Benchmark**           | `npm run load` (`tsx src/scripts/load.ts`)                                  | ✅ **Passed** | Exited `code 0`. 1,200 requests (1,000 distinct + 200 replays) ingested with 0 HTTP errors.               |
| **Dependency Audit**         | `npm audit`                                                                 | ✅ **Passed** | 0 vulnerabilities found across all installed dependencies.                                                |

---

## 3. Real Load Benchmark Measurements

Ran `npm run load` against tenant `load-tenant` using concurrency of 20:

| Metric                         | Measured Value |    Requirement / Expected Target    | Status |
| :----------------------------- | :------------: | :---------------------------------: | :----: |
| **Distinct Valid Events**      |   **1,000**    |   1,000 accepted (`202 Accepted`)   | ✅ Met |
| **Exact Replay Requests**      |    **200**     |     200 acknowledged (`200 OK`)     | ✅ Met |
| **HTTP Errors**                |     **0**      |              0 errors               | ✅ Met |
| **Stored Events in DB**        |   **1,000**    |     Exactly 1,000 event records     | ✅ Met |
| **Final Projected Jobs**       |    **950**     | 950 active jobs (50 upsert updates) | ✅ Met |
| **Out-of-Order Updates (v2)**  |  **50 / 50**   |     100% resolved to version 2      | ✅ Met |
| **Queue Backlog at End**       |     **0**      |      All pending items drained      | ✅ Met |
| **HTTP p50 Ingestion Latency** |  **374.3 ms**  |        Sub-second ingestion         | ✅ Met |
| **HTTP p95 Ingestion Latency** |  **913.8 ms**  |        Sub-second ingestion         | ✅ Met |
| **Total Queue Drain Time**     |   **124.4s**   |    < 300s (5-minute SLA target)     | ✅ Met |

_Note: Measured against remote MongoDB Atlas cluster (~50ms round-trip latency)._

---

## 4. Challenge of 3 Plausible Failure Hypotheses

### Hypothesis 1 (Concurrency Race):

> _"Under burst traffic, concurrent identical `POST /events` requests might slip past application checks and insert duplicate work items or duplicate job projections."_

- **Test Suite**: `test/concurrency.test.ts`
- **Test Method**: Dispatched 12 identical `POST /events` requests simultaneously with the exact same payload and identity.
- **Observed Evidence**:
  - The first request succeeded with `202 Accepted`.
  - The remaining 11 requests received `200 OK` (recognized as exact replays).
  - The `events` collection contained exactly **1** document.
  - The compound unique index `{ tenantId: 1, sourceId: 1, eventId: 1 }` in MongoDB guaranteed uniqueness even when requests arrived in the exact same millisecond.
- **Verdict**: **Hypothesis disproven / Check passed.**

---

### Hypothesis 2 (Worker Crash & Recovery):

> _"If a worker process crashes immediately after writing the job projection but before marking the event as processed, the next worker will run the provider call again, causing duplicate downstream calls or corrupt state."_

- **Test Suites**: `test/recovery.test.ts` and `test/crash-process.test.ts`
- **Test Method**:
  - Worker claimed an event and wrote the projection to the `jobs` collection.
  - The worker process was abruptly terminated (`process.exit(1)`) via the `CRASH_AFTER_PROJECTION` debug hook before writing to the `events` collection.
  - A second worker process was started after the lease (`lockedUntil`) expired.
- **Observed Evidence**:
  - The second worker claimed the abandoned event.
  - It checked the existing job projection and found `job.appliedEventId === event.eventId`.
  - It recognized the projection was already applied, **skipped the external provider verification**, and safely marked the event `processed`.
  - External provider call count remained strictly **1**, attempts remained **1**, and the job projection was never duplicated.
- **Verdict**: **Hypothesis disproven / Check passed.**

---

### Hypothesis 3 (Documentation Claim Challenge):

> _"README.md and DESIGN.md claim: 'When external provider returns 429 or 503, the system retries up to 3 times with exponential backoff (500ms, 1000ms), and if all 3 attempts fail, the event is marked failed without creating any partial job projection.' Does the code actually enforce this, or does it retry forever or create incomplete jobs?"_

- **Test Suite**: `test/provider-failures.test.ts`
- **Test Method**:
  - Configured provider plan with 3 consecutive `503 Service Unavailable` responses for job `delta`.
  - Started worker and monitored attempt counts and collection state.
- **Observed Evidence**:
  - Attempt 1 failed at `0ms` (backoff set for `500ms`).
  - Attempt 2 failed at `~500ms` (backoff set for `1000ms`).
  - Attempt 3 failed at `~1500ms`.
  - Event status moved to `failed` with `attempts: 3` and `lastError` populated.
  - The `jobs` collection was queried for `delta`: returned `null` (0 documents). No partial or corrupted job was ever created.
- **Verdict**: **Documentation claim verified by automated test.**

---

## 5. Cross-Check: Documentation vs. Final Code

I checked every key claim in the documentation against the final codebase to ensure there are no outdated or unsupported claims:

| Documentation Claim                                       | Document                  | Code Implementation                                                               | Verified In                           |   Status   |
| :-------------------------------------------------------- | :------------------------ | :-------------------------------------------------------------------------------- | :------------------------------------ | :--------: |
| `POST /events` returns `202`, `200`, `409`, `400`         | `README.md`               | `src/controllers/event.controller.ts` (handles replay, hash mismatch, validation) | `test/acceptance.test.ts`             | ✅ Matches |
| Pagination via opaque base64 cursor (`updatedAt` + `_id`) | `README.md` & `DESIGN.md` | `src/controllers/job.controller.ts`                                               | `test/pagination-persistence.test.ts` | ✅ Matches |
| Health endpoint returns `200 ok` / `503 degraded`         | `README.md`               | `src/routes/health.routes.ts` (pings `admin.ping()`)                              | `test/acceptance.test.ts`             | ✅ Matches |
| Unique compound index on `(tenantId, sourceId, eventId)`  | `DESIGN.md`               | `src/db/mongo.ts` (`createIndexes`)                                               | `test/indexes.test.ts`                | ✅ Matches |
| Worker polling index on `(status, nextAttemptAt)`         | `DESIGN.md`               | `src/db/mongo.ts` (`createIndexes`)                                               | `test/indexes.test.ts`                | ✅ Matches |
| Projection index on `(tenantId, updatedAt, _id)`          | `DESIGN.md`               | `src/db/mongo.ts` (`createIndexes`)                                               | `test/indexes.test.ts`                | ✅ Matches |
| Retry count: max 3 attempts with exponential backoff      | `DESIGN.md`               | `src/worker/worker.ts` (`MAX_ATTEMPTS = 3`, 500ms base)                           | `test/provider-failures.test.ts`      | ✅ Matches |
| Drain time for 1,000 events within 5-min SLA              | `SCALE.md`                | `src/scripts/load.ts` (actual measured drain: 124.4s)                             | `load-results.json`                   | ✅ Matches |

---

## 6. Security, Tenant Scoping & Secrets Review

- **Tenant Scoping**:
  - Every single MongoDB query and projection write includes `{ tenantId }` in its filter (e.g. `events.find({ tenantId })`, `jobs.updateOne({ tenantId, ... })`).
  - Cross-tenant data access is blocked by query structure. Tested in `test/version-isolation.test.ts` (same identifiers in different tenants remain completely isolated).
- **Untrusted Input Handling**:
  - Strict input validation in `src/utils/validate.ts`.
  - Leading/trailing whitespace on identifiers is strictly rejected (`tenantId`, `sourceId`, `eventId`, `externalJobId`).
  - Salary bounds (`0 <= min <= max`), experience (`0..50`), and `https://` URLs are strictly validated.
  - Malformed payloads return `400 Bad Request` and never reserve an event ID (`test/validate.test.ts`).
- **Credential Hygiene**:
  - No database passwords, Atlas connection URIs, or provider tokens are committed in git.
  - `.env` is ignored via `.gitignore`; only `.env.example` with dummy values is tracked.
  - No raw AI chat transcripts containing private environment variables were committed.
- **Dependencies**:
  - Production dependencies are kept minimal: only `express` and `mongodb`.
  - `npm audit` reports **0 known vulnerabilities**.

---

## 7. Submission Sign-Off

- **All 27 integration tests passing.**
- **Clean TypeScript compilation.**
- **No changes to application or test logic were made after this QC pass.**

---

## 💙 Author

**Jenish Gondaliya**
_Thank you for reviewing the Quality Control report!_
