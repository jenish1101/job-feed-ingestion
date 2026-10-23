import os from "node:os";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../app.js";
import { assertNodeVersion, loadConfig } from "../config.js";
import { listen } from "../utils/listen.js";
import { EVENTS, JOBS, connectMongo, ensureIndexes } from "../db/mongo.js";
import { projectRoot } from "../utils/paths.js";
import { startFileWorkers } from "../worker/runtime.js";
import { sleep } from "../utils/sleep.js";
import type { JobPayload, JobRecord } from "../types.js";

const TENANT = "load-tenant";
const SOURCE = "main";
const DISTINCT = 1000;
const REPLAYS = 200;
const OUT_OF_ORDER = 50;
const CONCURRENCY = 20;

interface EventBody {
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: "upsert";
  payload: JobPayload;
}

function payload(title: string, externalJobId: string): JobPayload {
  return {
    title,
    company: "Load Labs",
    location: "Surat",
    experienceMin: 1,
    experienceMax: 3,
    applyUrl: `https://example.test/jobs/${externalJobId}`,
    skills: ["typescript"],
  };
}

function eventBody(
  externalJobId: string,
  version: number,
  title: string,
): EventBody {
  return {
    tenantId: TENANT,
    sourceId: SOURCE,
    eventId: `${externalJobId}-v${version}`,
    externalJobId,
    version,
    operation: "upsert",
    payload: payload(title, externalJobId),
  };
}

function buildEvents(): EventBody[] {
  const events: EventBody[] = [];
  for (let index = 0; index < OUT_OF_ORDER; index += 1) {
    const externalJobId = `oo-${String(index).padStart(2, "0")}`;
    events.push(eventBody(externalJobId, 2, `${externalJobId} v2`));
  }
  for (let index = 0; index < OUT_OF_ORDER; index += 1) {
    const externalJobId = `oo-${String(index).padStart(2, "0")}`;
    events.push(eventBody(externalJobId, 1, `${externalJobId} v1`));
  }
  const simple = DISTINCT - OUT_OF_ORDER * 2;
  for (let index = 0; index < simple; index += 1) {
    const externalJobId = `job-${String(index).padStart(4, "0")}`;
    events.push(eventBody(externalJobId, 1, `${externalJobId} v1`));
  }
  return events;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

async function mapPool<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const current = next;
        next += 1;
        if (current >= items.length) return;
        const item = items[current];
        if (item === undefined) return;
        await task(item);
      }
    },
  );
  await Promise.all(workers);
}

async function main(): Promise<void> {
  assertNodeVersion();
  const config = loadConfig({
    ...process.env,
    WORKER_COUNT: process.env.LOAD_WORKER_COUNT ?? "8",
    POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS ?? "20",
    CLAIM_LEASE_MS: process.env.CLAIM_LEASE_MS ?? "15000",
  });
  const events = buildEvents();
  if (events.length !== DISTINCT)
    throw new Error(`expected ${DISTINCT} events, built ${events.length}`);
  const replays = events.slice(0, REPLAYS);

  const { client, db } = await connectMongo(config.mongoUrl);
  await ensureIndexes(db);
  await db.collection(EVENTS).deleteMany({ tenantId: TENANT });
  await db.collection(JOBS).deleteMany({ tenantId: TENANT });
  const app = createApp({ db, config });
  const server = await listen(app, 0);
  const { workers } = startFileWorkers(db, config, `load-${process.pid}`);
  const latencies: number[] = [];
  let accepted = 0;
  let replayed = 0;
  let errors = 0;

  try {
    console.log(`[load] Starting load benchmark on ${server.url}...`);
    console.log(
      `[load] Submitting ${DISTINCT} events and ${REPLAYS} replays with concurrency ${CONCURRENCY}...`,
    );

    const submit = async (body: EventBody, replay: boolean) => {
      const started = performance.now();
      const response = await fetch(new URL("/events", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      latencies.push(performance.now() - started);
      if (replay && response.status === 200) replayed += 1;
      else if (!replay && response.status === 202) accepted += 1;
      else errors += 1;

      const total = accepted + replayed;
      if (total > 0 && total % 250 === 0) {
        console.log(
          `[load] 🚀 Ingestion progress: ${total}/${DISTINCT + REPLAYS} requests submitted...`,
        );
      }
    };

    await mapPool(events, CONCURRENCY, (body) => submit(body, false));
    await mapPool(replays, CONCURRENCY, (body) => submit(body, true));

    console.log(
      `[load] Ingestion complete (Accepted: ${accepted}, Replays: ${replayed}, Errors: ${errors})`,
    );
    console.log(`[load] Draining queue with ${config.workerCount} workers...`);

    const drainStarted = Date.now();
    let open = DISTINCT;
    let lastReport = 0;
    while (Date.now() - drainStarted < 240_000) {
      open = await db.collection(EVENTS).countDocuments({
        tenantId: TENANT,
        status: { $in: ["pending", "processing"] },
      });
      if (open === 0) break;
      if (Date.now() - lastReport >= 5000) {
        console.log(
          `[load] ⏳ Queue progress: ${DISTINCT - open}/${DISTINCT} processed (${open} remaining)...`,
        );
        lastReport = Date.now();
      }
      await sleep(50);
    }
    const drainMs = Date.now() - drainStarted;
    console.log(
      `[load] ✅ Queue completely drained in ${Math.round(drainMs / 1000)}s! Verifying projections...`,
    );

    const storedEvents = await db
      .collection(EVENTS)
      .countDocuments({ tenantId: TENANT });
    const jobs = await db
      .collection<JobRecord>(JOBS)
      .find({ tenantId: TENANT })
      .toArray();
    const outOfOrder = jobs.filter((job) =>
      String(job.externalJobId).startsWith("oo-"),
    );
    const wrongVersion = outOfOrder.filter(
      (job) =>
        job.version !== 2 ||
        job.title !== `${job.externalJobId} v2` ||
        job.status !== "active",
    );
    const info = await db.command({ buildInfo: 1 });
    const mongoVersion =
      typeof info.version === "string" ? info.version : "unknown";
    const cpu = os.cpus()[0];
    const sorted = [...latencies].sort((left, right) => left - right);
    const result = {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: cpu?.model ?? "unknown",
      memoryMb: Math.round(os.totalmem() / (1024 * 1024)),
      mongo: mongoVersion,
      concurrency: CONCURRENCY,
      workerCount: config.workerCount,
      distinctEvents: DISTINCT,
      replayRequests: REPLAYS,
      outOfOrderJobs: OUT_OF_ORDER,
      accepted,
      replays: replayed,
      errors,
      httpP50Ms: Number(percentile(sorted, 50).toFixed(1)),
      httpP95Ms: Number(percentile(sorted, 95).toFixed(1)),
      drainMs,
      storedEvents,
      finalJobs: jobs.length,
      outOfOrderCorrect: outOfOrder.length - wrongVersion.length,
      openAtEnd: open,
    };
    const destination = path.join(projectRoot, "load-results.json");
    writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));

    const failed =
      accepted !== DISTINCT ||
      replayed !== REPLAYS ||
      errors !== 0 ||
      storedEvents !== DISTINCT ||
      jobs.length !== DISTINCT - OUT_OF_ORDER ||
      wrongVersion.length !== 0 ||
      open !== 0;
    if (failed) process.exitCode = 1;
  } finally {
    await workers.stop();
    await server.close();
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
