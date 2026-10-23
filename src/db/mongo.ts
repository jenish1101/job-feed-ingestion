import { MongoClient, type Db } from "mongodb";

export const EVENTS = "events";
export const JOBS = "jobs";
export const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export async function connectMongo(
  url: string,
): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(url);
  await client.connect();
  return { client, db: client.db() };
}

export async function ensureIndexes(db: Db): Promise<void> {
  const events = db.collection(EVENTS);
  const jobs = db.collection(JOBS);
  await events.createIndex(
    { tenantId: 1, sourceId: 1, eventId: 1 },
    { unique: true, name: "event_identity" },
  );
  await events.createIndex(
    { status: 1, nextAttemptAt: 1, createdAt: 1 },
    { name: "pending_work" },
  );
  await events.createIndex(
    { status: 1, claimExpiresAt: 1 },
    { name: "expired_claims" },
  );
  await events.createIndex(
    { createdAt: 1 },
    { name: "event_ttl", expireAfterSeconds: EVENT_TTL_SECONDS },
  );
  await jobs.createIndex(
    { tenantId: 1, sourceId: 1, externalJobId: 1 },
    { unique: true, name: "job_identity" },
  );
  await jobs.createIndex(
    { tenantId: 1, status: 1, sourceId: 1, externalJobId: 1 },
    { name: "job_list" },
  );
}
