import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { EVENTS, JOBS } from "../src/db/mongo.js";
import type { Provider } from "../src/worker/provider.js";
import type { JobRecord, StoredEvent } from "../src/types.js";
import {
  connectTestDb,
  deps,
  drain,
  postEvent,
  testConfig,
  upsert,
} from "./helpers.js";

test.describe("versions and isolation", { concurrency: false }, () => {
  let database: Awaited<ReturnType<typeof connectTestDb>>;
  let baseUrl = "";
  let close: () => Promise<void> = async () => undefined;

  test.before(async () => {
    database = await connectTestDb("jobfeed_test_version");
    const server = await listen(
      createApp({ db: database.db, config: testConfig() }),
    );
    baseUrl = server.url;
    close = server.close;
  });

  test.after(async () => {
    await close();
    await database.client.close();
  });

  test("the same identifiers in another tenant or source are separate jobs", async () => {
    const calls: string[] = [];
    const provider: Provider = async (event: StoredEvent) => {
      calls.push(`${event.tenantId}/${event.sourceId}/${event.eventId}`);
      return 200;
    };
    for (const body of [
      upsert({
        eventId: "shared",
        externalJobId: "alpha",
        payload: { title: "A" },
      }),
      upsert({
        tenantId: "tenant-b",
        eventId: "shared",
        externalJobId: "alpha",
        payload: { title: "B" },
      }),
      upsert({
        sourceId: "other",
        eventId: "shared",
        externalJobId: "alpha",
        payload: { title: "C" },
      }),
    ]) {
      assert.equal((await postEvent(baseUrl, body)).status, 202);
    }
    await drain(deps({ db: database.db, provider }));
    assert.equal(calls.length, 3);

    const tenantA = await fetch(
      new URL("/jobs?tenantId=tenant-a&status=all&limit=20", baseUrl),
    );
    const bodyA = (await tenantA.json()) as {
      jobs: Array<{ sourceId: string; title: string }>;
    };
    assert.deepEqual(
      bodyA.jobs.map((job) => `${job.sourceId}:${job.title}`).sort(),
      ["main:A", "other:C"],
    );
    const tenantB = await fetch(
      new URL("/jobs?tenantId=tenant-b&status=active", baseUrl),
    );
    const bodyB = (await tenantB.json()) as { jobs: Array<{ title: string }> };
    assert.deepEqual(
      bodyB.jobs.map((job) => job.title),
      ["B"],
    );
    const missing = await fetch(new URL("/jobs", baseUrl));
    assert.equal(missing.status, 400);
  });

  test("a higher version wins when lower versions arrive later", async () => {
    const calls: number[] = [];
    const provider: Provider = async (event: StoredEvent) => {
      calls.push(event.version);
      return 200;
    };
    for (const version of [3, 1, 2]) {
      assert.equal(
        (
          await postEvent(
            baseUrl,
            upsert({
              eventId: `late-${version}`,
              externalJobId: "late",
              version,
              payload: { title: `v${version}` },
            }),
          )
        ).status,
        202,
      );
    }
    await drain(deps({ db: database.db, provider }));
    const job = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "late" });
    assert.equal(job?.version, 3);
    assert.equal(job?.title, "v3");
    assert.deepEqual(calls, [3]);
    const stale = await database.db
      .collection<StoredEvent>(EVENTS)
      .find({ externalJobId: "late", version: { $lt: 3 } })
      .toArray();
    assert.equal(stale.length, 2);
    assert.equal(
      stale.every((event) => event.status === "noop" && event.attempts === 0),
      true,
    );
  });

  test("an archive tombstone blocks older upserts and a newer upsert can reactivate it", async () => {
    const provider: Provider = async () => 200;
    const worker = deps({ db: database.db, provider });
    assert.equal(
      (
        await postEvent(baseUrl, {
          tenantId: "tenant-a",
          sourceId: "main",
          eventId: "arch-2",
          externalJobId: "tomb",
          version: 2,
          operation: "archive",
        })
      ).status,
      202,
    );
    await drain(worker);
    let job = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "tomb" });
    assert.equal(job?.status, "archived");
    assert.equal(job?.version, 2);
    assert.equal(job?.title, undefined);

    assert.equal(
      (
        await postEvent(
          baseUrl,
          upsert({
            eventId: "arch-1",
            externalJobId: "tomb",
            version: 1,
            payload: { title: "Too Late" },
          }),
        )
      ).status,
      202,
    );
    await drain(worker);
    job = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "tomb" });
    assert.equal(job?.status, "archived");
    assert.equal(job?.version, 2);
    assert.equal(job?.title, undefined);

    assert.equal(
      (
        await postEvent(
          baseUrl,
          upsert({
            eventId: "arch-3",
            externalJobId: "tomb",
            version: 3,
            payload: { title: "Reactivated" },
          }),
        )
      ).status,
      202,
    );
    await drain(worker);
    job = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "tomb" });
    assert.equal(job?.status, "active");
    assert.equal(job?.version, 3);
    assert.equal(job?.title, "Reactivated");
    assert.equal(
      await database.db
        .collection(JOBS)
        .countDocuments({ externalJobId: "tomb" }),
      1,
    );
  });

  test("a failed higher version leaves the previous job visible", async () => {
    const provider: Provider = async (event: StoredEvent) =>
      event.version === 2 ? 422 : 200;
    const worker = deps({ db: database.db, provider });
    await postEvent(
      baseUrl,
      upsert({
        eventId: "keep-1",
        externalJobId: "keep",
        version: 1,
        payload: { title: "Visible" },
      }),
    );
    await drain(worker);
    await postEvent(
      baseUrl,
      upsert({
        eventId: "keep-2",
        externalJobId: "keep",
        version: 2,
        payload: { title: "Hidden" },
      }),
    );
    await drain(worker);
    let job = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "keep" });
    assert.equal(job?.version, 1);
    assert.equal(job?.title, "Visible");
    const failed = await database.db
      .collection<StoredEvent>(EVENTS)
      .findOne({ eventId: "keep-2" });
    assert.equal(failed?.status, "failed");

    await postEvent(
      baseUrl,
      upsert({
        eventId: "keep-3",
        externalJobId: "keep",
        version: 3,
        payload: { title: "Next" },
      }),
    );
    await drain(worker);
    job = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "keep" });
    assert.equal(job?.version, 3);
    assert.equal(job?.title, "Next");
  });
});
