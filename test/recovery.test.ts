import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { EVENTS, JOBS } from "../src/db/mongo.js";
import { claimAndProcess, claimNext } from "../src/worker/processor.js";
import type { JobRecord, StoredEvent } from "../src/types.js";
import {
  connectTestDb,
  deps,
  postEvent,
  testConfig,
  upsert,
} from "./helpers.js";

test.describe("recovery", { concurrency: false }, () => {
  let database: Awaited<ReturnType<typeof connectTestDb>>;
  let baseUrl = "";
  let close: () => Promise<void> = async () => undefined;

  test.before(async () => {
    database = await connectTestDb("jobfeed_test_recovery");
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

  test("an abandoned claim is completed by another worker", async () => {
    assert.equal(
      (await postEvent(baseUrl, upsert({ eventId: "evt-abandon" }))).status,
      202,
    );
    const abandoned = await claimNext(
      deps({ db: database.db, workerId: "worker-a" }),
    );
    assert.equal(abandoned?.status, "processing");
    assert.equal(abandoned?.claimedBy, "worker-a");
    await database.db
      .collection(EVENTS)
      .updateOne(
        { eventId: "evt-abandon" },
        { $set: { claimExpiresAt: new Date(0) } },
      );
    let calls = 0;
    const result = await claimAndProcess(
      deps({
        db: database.db,
        workerId: "worker-b",
        provider: async () => {
          calls += 1;
          return 200;
        },
      }),
    );
    assert.equal(result, "processed");
    assert.equal(calls, 1);
    const event = await database.db
      .collection<StoredEvent>(EVENTS)
      .findOne({ eventId: "evt-abandon" });
    assert.equal(event?.status, "succeeded");
    assert.equal(
      await database.db
        .collection(JOBS)
        .countDocuments({ externalJobId: "job-1" }),
      1,
    );
  });

  test("a crash after the projection write acknowledges the same job without a second provider call", async () => {
    assert.equal(
      (
        await postEvent(
          baseUrl,
          upsert({
            eventId: "evt-crash",
            externalJobId: "crash",
            payload: { title: "Once" },
          }),
        )
      ).status,
      202,
    );
    let calls = 0;
    await assert.rejects(
      () =>
        claimAndProcess(
          deps({
            db: database.db,
            workerId: "worker-a",
            provider: async () => {
              calls += 1;
              return 200;
            },
            afterProjection: async () => {
              throw new Error("stop after projection");
            },
          }),
        ),
      /stop after projection/,
    );

    const midway = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "crash" });
    assert.equal(midway?.title, "Once");
    assert.equal(midway?.appliedEventId, "evt-crash");
    const pendingAck = await database.db
      .collection<StoredEvent>(EVENTS)
      .findOne({ eventId: "evt-crash" });
    assert.equal(pendingAck?.status, "processing");
    assert.equal(calls, 1);

    await database.db
      .collection(EVENTS)
      .updateOne(
        { eventId: "evt-crash" },
        { $set: { claimExpiresAt: new Date(0) } },
      );
    await claimAndProcess(
      deps({
        db: database.db,
        workerId: "worker-b",
        provider: async () => {
          calls += 1;
          return 200;
        },
      }),
    );

    const event = await database.db
      .collection<StoredEvent>(EVENTS)
      .findOne({ eventId: "evt-crash" });
    const jobs = await database.db
      .collection<JobRecord>(JOBS)
      .find({ externalJobId: "crash" })
      .toArray();
    assert.equal(event?.status, "succeeded");
    assert.equal(event?.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.version, 1);
    assert.equal(jobs[0]?.title, "Once");
  });
});
