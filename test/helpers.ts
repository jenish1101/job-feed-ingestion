import assert from "node:assert/strict";
import { MongoClient, type Db } from "mongodb";
import { loadConfig, type AppConfig } from "../src/config.js";
import { EVENTS, ensureIndexes } from "../src/db/mongo.js";
import {
  claimAndProcess,
  type ProcessorDeps,
} from "../src/worker/processor.js";
import type { Provider } from "../src/worker/provider.js";
import { sleep } from "../src/utils/sleep.js";

try {
  process.loadEnvFile?.();
} catch {
  // Ignore when .env does not exist
}

export function testDatabaseUrl(name: string): string {
  const configured =
    process.env.MONGO_URL ?? "mongodb://127.0.0.1:27018/jobfeed";
  const url = new URL(configured);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function connectTestDb(
  name: string,
): Promise<{ client: MongoClient; db: Db; url: string }> {
  const url = testDatabaseUrl(name);
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(name);
  await db.dropDatabase();
  await ensureIndexes(db);
  return { client, db, url };
}

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    WORKER_COUNT: "2",
    POLL_INTERVAL_MS: "20",
    CLAIM_LEASE_MS: "5000",
    BACKOFF_BASE_MS: "40",
    BACKOFF_CAP_MS: "200",
    MAX_ATTEMPTS: "3",
    PORT: "0",
    ...overrides,
  });
}

export function upsert(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const payloadOverride = overrides.payload;
  const rest = { ...overrides };
  delete rest.payload;
  const payload = {
    title: "Engineer",
    company: "Labs",
    location: "Surat",
    experienceMin: 1,
    experienceMax: 3,
    applyUrl: "https://example.test/jobs/job-1",
    skills: ["TypeScript"],
    ...(typeof payloadOverride === "object" && payloadOverride !== null
      ? payloadOverride
      : {}),
  };
  return {
    tenantId: "tenant-a",
    sourceId: "main",
    eventId: "evt-1",
    externalJobId: "job-1",
    version: 1,
    operation: "upsert",
    ...rest,
    payload,
  };
}

export async function postEvent(
  baseUrl: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL("/events", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text === "" ? {} : JSON.parse(text);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  return { status: response.status, body: parsed as Record<string, unknown> };
}

export function deps(options: {
  db: Db;
  workerId?: string;
  provider?: Provider;
  afterProjection?: ProcessorDeps["afterProjection"];
  backoffBaseMs?: number;
  maxAttempts?: number;
  leaseMs?: number;
}): ProcessorDeps {
  return {
    db: options.db,
    workerId: options.workerId ?? "test-worker",
    leaseMs: options.leaseMs ?? 5_000,
    maxAttempts: options.maxAttempts ?? 3,
    backoffBaseMs: options.backoffBaseMs ?? 40,
    backoffCapMs: 200,
    provider: options.provider ?? (async () => 200),
    afterProjection: options.afterProjection,
  };
}

export async function drain(
  worker: ProcessorDeps,
  timeoutMs = 25_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await claimAndProcess(worker);
    const open = await worker.db.collection(EVENTS).countDocuments({
      status: { $in: ["pending", "processing"] },
    });
    if (result === "idle" && open === 0) return;
    if (result === "idle") await sleep(15);
  }
  throw new Error("timed out waiting for events to settle");
}
