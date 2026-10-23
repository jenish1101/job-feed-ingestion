import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { EVENTS, JOBS } from "../src/db/mongo.js";
import { projectRoot } from "../src/utils/paths.js";
import { sleep } from "../src/utils/sleep.js";
import type { JobRecord, StoredEvent } from "../src/types.js";
import { connectTestDb, postEvent, testConfig, upsert } from "./helpers.js";

function childEnv(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function startWorker(env: NodeJS.ProcessEnv): {
  child: ChildProcess;
  output: () => string;
} {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/worker/worker.ts"],
    {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
}

function waitForExit(
  child: ChildProcess,
  output: () => string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker timed out\n${output()}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

test(
  "a worker process that dies after the projection write is recovered by a second process",
  { timeout: 20_000 },
  async () => {
    const database = await connectTestDb("jobfeed_test_crash");
    const mongoUrl = database.url;
    const server = await listen(
      createApp({ db: database.db, config: testConfig() }),
    );
    const shared = {
      MONGO_URL: mongoUrl,
      WORKER_COUNT: "1",
      CLAIM_LEASE_MS: "400",
      POLL_INTERVAL_MS: "20",
      BACKOFF_BASE_MS: "20",
      MAX_ATTEMPTS: "3",
    };
    try {
      const accepted = await postEvent(
        server.url,
        upsert({
          eventId: "evt-process-crash",
          externalJobId: "process-crash",
          payload: { title: "Saved" },
        }),
      );
      assert.equal(accepted.status, 202);

      const crashed = startWorker(
        childEnv({ ...shared, CRASH_AFTER_PROJECTION: "evt-process-crash" }),
      );
      const exitCode = await waitForExit(crashed.child, crashed.output, 8_000);
      assert.equal(exitCode, 1, crashed.output());
      assert.match(
        crashed.output(),
        /stopping after projection write before ack/,
      );

      const midway = await database.db
        .collection<JobRecord>(JOBS)
        .findOne({ externalJobId: "process-crash" });
      const unfinished = await database.db
        .collection<StoredEvent>(EVENTS)
        .findOne({ eventId: "evt-process-crash" });
      assert.equal(midway?.title, "Saved");
      assert.equal(unfinished?.status, "processing");

      const recovered = startWorker(
        childEnv({ ...shared, CRASH_AFTER_PROJECTION: undefined }),
      );
      try {
        const deadline = Date.now() + 5_000;
        let status: StoredEvent["status"] | undefined = unfinished?.status;
        while (Date.now() < deadline) {
          const event = await database.db
            .collection<StoredEvent>(EVENTS)
            .findOne({ eventId: "evt-process-crash" });
          status = event?.status;
          if (status === "succeeded") break;
          await sleep(40);
        }
        assert.equal(status, "succeeded");
        const jobs = await database.db
          .collection<JobRecord>(JOBS)
          .find({ externalJobId: "process-crash" })
          .toArray();
        const event = await database.db
          .collection<StoredEvent>(EVENTS)
          .findOne({ eventId: "evt-process-crash" });
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.appliedEventId, "evt-process-crash");
        assert.equal(event?.attempts, 1);
      } finally {
        recovered.child.kill("SIGTERM");
        await waitForExit(recovered.child, recovered.output, 5_000);
      }
    } finally {
      await server.close();
      await database.client.close();
    }
  },
);
