import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { JOBS, connectMongo } from "../src/db/mongo.js";
import type { JobRecord } from "../src/types.js";
import {
  connectTestDb,
  deps,
  drain,
  postEvent,
  testConfig,
  upsert,
} from "./helpers.js";

interface JobPage {
  jobs: Array<{ externalJobId: string; status: string; sourceId: string }>;
  nextCursor: string | null;
}

async function list(baseUrl: string, query: string): Promise<JobPage> {
  const response = await fetch(new URL(`/jobs?${query}`, baseUrl));
  assert.equal(response.status, 200);
  return (await response.json()) as JobPage;
}

test.describe("pagination and restart", { concurrency: false }, () => {
  let database: Awaited<ReturnType<typeof connectTestDb>>;
  let baseUrl = "";
  let close: () => Promise<void> = async () => undefined;

  test.before(async () => {
    database = await connectTestDb("jobfeed_test_pages");
    const server = await listen(
      createApp({ db: database.db, config: testConfig() }),
    );
    baseUrl = server.url;
    close = server.close;
  });

  test.after(async () => {
    await close().catch(() => undefined);
    await database.client.close().catch(() => undefined);
  });

  test("pages are stable, capped, and do not revisit keys when data changes", async () => {
    const worker = deps({ db: database.db });
    for (let index = 0; index < 25; index += 1) {
      const id = `job-${String(index).padStart(2, "0")}`;
      assert.equal(
        (
          await postEvent(
            baseUrl,
            upsert({ eventId: `evt-${id}`, externalJobId: id }),
          )
        ).status,
        202,
      );
    }
    await postEvent(baseUrl, {
      tenantId: "tenant-a",
      sourceId: "main",
      eventId: "evt-archived",
      externalJobId: "archived-job",
      version: 1,
      operation: "archive",
    });
    await drain(worker);

    const first = await list(baseUrl, "tenantId=tenant-a&limit=10");
    assert.equal(first.jobs.length, 10);
    assert.equal(typeof first.nextCursor, "string");
    const firstIds = first.jobs.map((job) => job.externalJobId);

    await postEvent(
      baseUrl,
      upsert({
        eventId: "evt-early",
        externalJobId: "job-05b",
        payload: { title: "Inserted late" },
      }),
    );
    await postEvent(
      baseUrl,
      upsert({ eventId: "evt-late", externalJobId: "job-99" }),
    );
    await drain(worker);

    const seen = new Set(firstIds);
    let cursor = first.nextCursor;
    const later: string[] = [];
    while (cursor) {
      const page = await list(
        baseUrl,
        `tenantId=tenant-a&limit=10&cursor=${encodeURIComponent(cursor)}`,
      );
      for (const job of page.jobs) {
        assert.equal(seen.has(job.externalJobId), false);
        seen.add(job.externalJobId);
        later.push(job.externalJobId);
      }
      cursor = page.nextCursor;
    }
    assert.equal(later.includes("job-05b"), false);
    assert.equal(later.includes("job-99"), true);

    const defaults = await list(baseUrl, "tenantId=tenant-a");
    assert.equal(defaults.jobs.length, 20);
    assert.equal(
      defaults.jobs.some((job) => job.externalJobId === "archived-job"),
      false,
    );
    const archived = await list(baseUrl, "tenantId=tenant-a&status=archived");
    assert.deepEqual(
      archived.jobs.map((job) => job.externalJobId),
      ["archived-job"],
    );
    const mismatched = await fetch(
      new URL(
        `/jobs?tenantId=tenant-a&status=all&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        baseUrl,
      ),
    );
    assert.equal(mismatched.status, 400);
  });

  test("job state survives a new API connection", async () => {
    await postEvent(
      baseUrl,
      upsert({
        eventId: "evt-persist",
        externalJobId: "persist",
        payload: { title: "Kept" },
      }),
    );
    await drain(deps({ db: database.db }));
    const mongoUrl = database.url;
    await close();
    await database.client.close();

    const reconnected = await connectMongo(mongoUrl);
    try {
      const stored = await reconnected.db
        .collection<JobRecord>(JOBS)
        .findOne({ externalJobId: "persist" });
      assert.equal(stored?.title, "Kept");
      const server = await listen(
        createApp({ db: reconnected.db, config: testConfig() }),
      );
      try {
        const response = await fetch(
          new URL("/jobs?tenantId=tenant-a&status=all&limit=100", server.url),
        );
        const body = (await response.json()) as {
          jobs: Array<{ externalJobId: string; title: string }>;
        };
        assert.equal(
          body.jobs.some(
            (job) => job.externalJobId === "persist" && job.title === "Kept",
          ),
          true,
        );
      } finally {
        await server.close();
      }
    } finally {
      await reconnected.client.close();
    }
  });
});
