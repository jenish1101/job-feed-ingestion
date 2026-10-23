# AI Assistance & Verification Record (AI_USAGE.md)

> **Author**: Jenish Gondaliya
> **Project**: Job Feed Ingestion Service
> **Repository**: `job-feed-ingestion`

---

## 1. Tool & Model Attribution

- **AI Tools / Models Used**: Google Antigravity Agentic Assistant (Claude Sonnet & Gemini Flash)
- **Environment**: Antigravity IDE & Pair Programming Workspace
- **Scope**: Used AI on meaningful project artifacts (architecture scaffolding, worker processing, scale calculations, and integration tests), followed by independent human review and verification.

---

## 2. Prompts & Scopes of Assistance

Here are the key prompts and tasks requested from the AI assistant during development:

1. **Worker & Processor Scaffolding (`src/worker/worker.ts`, `src/worker/processor.ts`)**:
   - _Prompt summary_: "Implement the background worker loop with MongoDB `findOneAndUpdate` atomic event claiming, claim leases (`lockedUntil`), stale lease recovery, and exponential backoff retry logic for 429/503 provider errors."
2. **Modular Architecture Restructuring (`src/routes/`, `src/controllers/`, `src/services/`, `src/db/`)**:
   - _Prompt summary_: "Reorganize the flat service implementation into clean, layered modules (routes, controllers, services, database access, worker runtime) while preserving exact idempotency and projection logic."
3. **Scaling & Capacity Sizing (`SCALE.md`)**:
   - _Prompt summary_: "Draft a scaling plan for growth from 100k to 10M events/day, with bursts of 5,000 events/second, calculating drain times, storage assumptions, and worker counts."
4. **Integration Test Suite Generation (`test/*.test.ts`)**:
   - _Prompt summary_: "Generate automated integration tests for out-of-order version handling, process crash recovery after projection writes, and concurrent duplicate request handling."

---

## 3. Meaningful Artifacts Reviewed

The following primary artifacts were generated with AI assistance and independently reviewed:

| Artifact                        | Purpose                                                | Review Outcome                          |
| :------------------------------ | :----------------------------------------------------- | :-------------------------------------- |
| `src/worker/worker.ts`          | Worker polling loop, atomic claim, exponential backoff | Reviewed & modified                     |
| `src/worker/processor.ts`       | Event processing pipeline, idempotency checks          | Reviewed & accepted                     |
| `src/services/event.service.ts` | Ingestion, canonical hashing, replay detection         | Reviewed & accepted                     |
| `SCALE.md`                      | Growth analysis, burst drain math, sharding tradeoffs  | Reviewed & rewritten for practical tone |
| `test/recovery.test.ts`         | Crash recovery & lease expiration verification         | Reviewed & modified timeouts            |
| `test/concurrency.test.ts`      | Burst concurrent request race condition tests          | Reviewed & verified                     |

---

## 4. What Was Accepted vs. What I Changed / Corrected

Following the evaluation instructions, no AI code was accepted without personal review. Below is an honest account of what was accepted as-is and what required human engineering fixes:

| Area                             | What AI Generated                                                                                     | What I Accepted vs. Changed / Corrected                                                                                                                                                 |
| :------------------------------- | :---------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core Ingestion & Idempotency** | Canonical JSON hashing (`canonicalize.ts`) and unique compound index `(tenantId, sourceId, eventId)`. | **Accepted with no material defects**. The logic was mathematically sound and prevented duplicate ingestion cleanly. I did not invent artificial mistakes here.                         |
| **Directory Paths Resolution**   | When scaffolding `src/utils/paths.ts`, the relative project root path was written as `".."`.          | **Changed / Corrected**. Resolving from `src/utils/` needed `"../.."`. Fixed the path resolution so fixture scenarios load reliably across environments.                                |
| **Cloud Database Latency**       | Hardcoded 8-second drain timeouts in tests and scripts designed for fast local Docker.                | **Changed / Corrected**. Integration tests failed against remote MongoDB Atlas (~50ms latency). Increased timeout bounds to 25s in `test/helpers.ts` and 180s in `src/scripts/load.ts`. |
| **Port Conflicts**               | `demo.ts` hardcoded port 3000, failing with `EADDRINUSE` if the dev server was already running.       | **Changed / Corrected**. Added automatic fallback to port 0 (ephemeral port allocation) so demo runs cleanly regardless of other processes.                                             |
| **TypeScript Strict Typing**     | Implicit `any` types were present in test suite event iterations and load benchmark callbacks.        | **Changed / Corrected**. Added explicit type annotations (`JobRecord`, `StoredEvent`, `EventBody`) ensuring 100% strict `tsc` compilation.                                              |
| **Tone of Documentation**        | `SCALE.md` was initially drafted with overly formal LaTeX notation and academic language.             | **Changed / Corrected**. Rewrote it into practical, conversational developer prose with realistic system assumptions and explicit alert thresholds.                                     |

---

## 5. How I Verified Everything (Independent Checks)

An AI review alone is never proof. Every artifact was verified through direct local commands:

1. **Strict TypeScript Compilation**:

   ```bash
   npm run typecheck
   ```

   _Result_: **0 errors** across both `src/` and `test/` under strict compiler flags.

2. **Linting & Code Style**:

   ```bash
   npm run lint
   ```

   _Result_: **0 errors**. Typecheck and Prettier formatting verified clean.

3. **Full Automated Test Suite**:

   ```bash
   npm test
   ```

   _Result_: **All 27 integration tests passed** across 6 test suites with 0 failures and 0 skipped.

4. **Scenario Demo**:

   ```bash
   npm run demo
   ```

   _Result_: Executed 20 fixture requests across Phase 1 and Phase 2; confirmed all settled projection states.

5. **Concurrency & Load Benchmark**:

   ```bash
   npm run load
   ```

   _Result_: 1,200 events processed under concurrency 20 with 0 HTTP errors and 100% projection accuracy.

6. **Security & Secrets Hygiene**:

   - Confirmed `.env` is gitignored.
   - Confirmed no hardcoded connection secrets or raw private AI conversation logs are in the repository.

---

## 💙 Author

**Jenish Gondaliya**
_Thank you for reviewing the AI usage disclosure!_
