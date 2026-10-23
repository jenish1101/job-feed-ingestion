import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { EVENTS, JOBS } from "../src/db/mongo.js";
import type { Provider } from "../src/worker/provider.js";
import { startWorkers } from "../src/worker/workers.js";
import { canonicalize } from "../src/utils/canonicalize.js";
import type { JobRecord, StoredEvent } from "../src/types.js";
import { connectTestDb, postEvent, testConfig, upsert } from "./helpers.js";
import { sleep } from "../src/utils/sleep.js";

test.describe("concurrency", { concurrency: false }, () => {
  let database: Awaited<ReturnType<typeof connectTestDb>>;
  let baseUrl = "";
  let close: () => Promise<void> = async () => undefined;

  test.before(async () => {
    database = await connectTestDb("jobfeed_test_concurrency");
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

  test("concurrent identical posts create one work item", async () => {
    const body = upsert({ eventId: "evt-dup", externalJobId: "dup" });
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => postEvent(baseUrl, body)),
    );
    const statuses = responses.map((response) => response.status).sort();
    assert.equal(
      responses.filter((response) => response.status === 202).length,
      1,
    );
    assert.equal(
      responses.filter((response) => response.status === 200).length,
      11,
    );
    assert.deepEqual(
      statuses.filter((status) => status !== 200 && status !== 202),
      [],
    );
    assert.equal(
      await database.db
        .collection(EVENTS)
        .countDocuments({ eventId: "evt-dup" }),
      1,
    );
  });

  test("concurrent conflicting posts keep one stored body", async () => {
    const first = upsert({
      eventId: "evt-race",
      externalJobId: "race",
      payload: { title: "One" },
    });
    const second = upsert({
      eventId: "evt-race",
      externalJobId: "race",
      payload: { title: "Two" },
    });
    const responses = await Promise.all([
      postEvent(baseUrl, first),
      postEvent(baseUrl, second),
      postEvent(baseUrl, first),
      postEvent(baseUrl, second),
    ]);
    assert.equal(
      responses.filter((response) => response.status === 202).length,
      1,
    );
    assert.ok(responses.some((response) => response.status === 409));
    for (const response of responses)
      assert.ok([200, 202, 409].includes(response.status));
    const stored = await database.db
      .collection<StoredEvent>(EVENTS)
      .find({ eventId: "evt-race" })
      .toArray();
    assert.equal(stored.length, 1);
    const canonical = stored[0]?.canonical;
    assert.ok(
      canonical === canonicalize(first) || canonical === canonicalize(second),
    );
  });

  test("two worker loops drain distinct events and a version race leaves one job", async () => {
    const provider: Provider = async () => 200;
    for (let index = 0; index < 20; index += 1) {
      const response = await postEvent(
        baseUrl,
        upsert({
          eventId: `batch-${index}`,
          externalJobId: `batch-${index}`,
          payload: { title: `Batch ${index}` },
        }),
      );
      assert.equal(response.status, 202);
    }
    await postEvent(
      baseUrl,
      upsert({
        eventId: "order-1",
        externalJobId: "ordered",
        version: 1,
        payload: { title: "v1" },
      }),
    );
    await postEvent(
      baseUrl,
      upsert({
        eventId: "order-2",
        externalJobId: "ordered",
        version: 2,
        payload: { title: "v2" },
      }),
    );

    const workers = startWorkers({
      db: database.db,
      config: testConfig(),
      provider,
      workerIdPrefix: "pool",
    });
    try {
      const deadline = Date.now() + 8_000;
      let open = 1;
      while (Date.now() < deadline) {
        open = await database.db.collection(EVENTS).countDocuments({
          status: { $in: ["pending", "processing"] },
        });
        if (open === 0) break;
        await sleep(20);
      }
      assert.equal(open, 0);
    } finally {
      await workers.stop();
    }

    assert.equal(
      await database.db
        .collection(JOBS)
        .countDocuments({ externalJobId: /^batch-/ }),
      20,
    );
    const ordered = await database.db
      .collection<JobRecord>(JOBS)
      .find({ externalJobId: "ordered" })
      .toArray();
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0]?.version, 2);
    assert.equal(ordered[0]?.title, "v2");
    const higher = await database.db
      .collection<StoredEvent>(EVENTS)
      .findOne({ eventId: "order-2" });
    assert.equal(higher?.status, "succeeded");
  });
});
