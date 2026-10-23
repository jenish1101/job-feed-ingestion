import type { Db, WithId } from "mongodb";
import { EVENTS, JOBS } from "../db/mongo.js";
import type { Provider } from "./provider.js";
import { applyProjection } from "../db/projection.js";
import type { AttemptRecord, JobRecord, StoredEvent } from "../types.js";

export interface ProcessorDeps {
  db: Db;
  workerId: string;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  provider: Provider;
  now?: () => Date;
  afterProjection?: (event: StoredEvent) => Promise<void>;
}

function clock(deps: ProcessorDeps): Date {
  return deps.now ? deps.now() : new Date();
}

export async function claimNext(
  deps: ProcessorDeps,
): Promise<WithId<StoredEvent> | null> {
  const now = clock(deps);
  const claimed = await deps.db
    .collection<StoredEvent>(EVENTS)
    .findOneAndUpdate(
      {
        $or: [
          { status: "pending", nextAttemptAt: { $lte: now } },
          { status: "processing", claimExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "processing",
          claimedBy: deps.workerId,
          claimExpiresAt: new Date(now.getTime() + deps.leaseMs),
          updatedAt: now,
        },
      },
      { sort: { createdAt: 1, _id: 1 }, returnDocument: "after" },
    );
  return claimed ?? null;
}

async function finish(
  deps: ProcessorDeps,
  event: WithId<StoredEvent>,
  status: "succeeded" | "noop" | "failed",
  history: AttemptRecord,
  lastError: string | null,
): Promise<void> {
  const now = clock(deps);
  await deps.db.collection<StoredEvent>(EVENTS).updateOne(
    { _id: event._id, status: "processing", claimedBy: deps.workerId },
    {
      $set: {
        status,
        lastError,
        claimedBy: null,
        claimExpiresAt: null,
        updatedAt: now,
      },
      $push: { attemptHistory: history },
    },
  );
}

function backoffDelay(deps: ProcessorDeps, attempt: number): number {
  const exponential = deps.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  if (deps.backoffCapMs === 0) return exponential;
  return Math.min(deps.backoffCapMs, exponential);
}

async function processClaimed(
  deps: ProcessorDeps,
  event: WithId<StoredEvent>,
): Promise<void> {
  const job = await deps.db.collection<JobRecord>(JOBS).findOne({
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    externalJobId: event.externalJobId,
  });

  if (job && job.version > event.version) {
    await finish(
      deps,
      event,
      "noop",
      {
        attempt: event.attempts,
        at: clock(deps),
        outcome: "skipped_stale",
        error: "a newer job version is already applied",
      },
      null,
    );
    return;
  }

  if (job && job.version === event.version) {
    const ours = job.appliedEventId === event.eventId;
    await finish(
      deps,
      event,
      ours ? "succeeded" : "noop",
      {
        attempt: event.attempts,
        at: clock(deps),
        outcome: ours ? "already_applied" : "skipped_stale",
        error: ours
          ? "projection was already written by this event"
          : "an equivalent job version is already applied",
      },
      null,
    );
    return;
  }

  if (event.attempts >= deps.maxAttempts) {
    await finish(
      deps,
      event,
      "failed",
      {
        attempt: event.attempts,
        at: clock(deps),
        outcome: "exhausted",
        error: "attempt budget exhausted before the job projection was updated",
      },
      "attempt budget exhausted before the job projection was updated",
    );
    return;
  }

  const attempt = event.attempts + 1;
  const startedAt = clock(deps);
  const started = await deps.db
    .collection<StoredEvent>(EVENTS)
    .findOneAndUpdate(
      {
        _id: event._id,
        status: "processing",
        claimedBy: deps.workerId,
        attempts: event.attempts,
      },
      {
        $inc: { attempts: 1 },
        $set: { updatedAt: startedAt },
        $push: {
          attemptHistory: { attempt, at: startedAt, outcome: "started" },
        },
      },
      { returnDocument: "after" },
    );
  if (!started) return;

  const statusCode = await deps.provider(started, attempt);
  const retryable = statusCode === 429 || statusCode === 503;
  if (statusCode === 200) {
    const applied = await applyProjection(deps.db, started);
    if (applied === "applied" && deps.afterProjection)
      await deps.afterProjection(started);
    if (applied === "stale") {
      await finish(
        deps,
        started,
        "noop",
        {
          attempt,
          at: clock(deps),
          outcome: "skipped_stale",
          statusCode,
          error: "a newer job version won during verification",
        },
        null,
      );
      return;
    }
    await finish(
      deps,
      started,
      "succeeded",
      { attempt, at: clock(deps), outcome: "success", statusCode },
      null,
    );
    return;
  }

  const error = `provider returned ${statusCode}`;
  if (retryable && attempt < deps.maxAttempts) {
    const now = clock(deps);
    await deps.db.collection<StoredEvent>(EVENTS).updateOne(
      { _id: started._id, status: "processing", claimedBy: deps.workerId },
      {
        $set: {
          status: "pending",
          nextAttemptAt: new Date(now.getTime() + backoffDelay(deps, attempt)),
          claimedBy: null,
          claimExpiresAt: null,
          lastError: error,
          updatedAt: now,
        },
        $push: {
          attemptHistory: {
            attempt,
            at: now,
            outcome: "retry",
            statusCode,
            error,
          },
        },
      },
    );
    return;
  }

  await finish(
    deps,
    started,
    "failed",
    {
      attempt,
      at: clock(deps),
      outcome: retryable ? "exhausted" : "permanent",
      statusCode,
      error,
    },
    error,
  );
}

export async function claimAndProcess(
  deps: ProcessorDeps,
): Promise<"processed" | "idle"> {
  const event = await claimNext(deps);
  if (!event) return "idle";
  await processClaimed(deps, event);
  return "processed";
}
