import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { EVENTS, JOBS, connectMongo } from "../src/db/mongo.js";
import type { JobRecord } from "../src/types.js";
import {
  connectTestDb,
  deps,
  drain,
  postEvent,
  testConfig,
  upsert,
} from "./helpers.js";

test.describe("acceptance", { concurrency: false }, () => {
  const context: {
    baseUrl: string;
    close: () => Promise<void>;
    dbName: string;
  } = {
    baseUrl: "",
    close: async () => undefined,
    dbName: "jobfeed_test_api",
  };
  let database: Awaited<ReturnType<typeof connectTestDb>> | undefined;

  test.before(async () => {
    database = await connectTestDb(context.dbName);
    const app = createApp({ db: database.db, config: testConfig() });
    const server = await listen(app);
    context.baseUrl = server.url;
    context.close = server.close;
  });

  test.after(async () => {
    await context.close();
    await database?.client.close();
  });

  test("invalid events return 400 and do not reserve the event id", async () => {
    assert.ok(database);
    const invalid = [
      upsert({ eventId: " evt-space ", externalJobId: "space" }),
      upsert({
        eventId: "evt-fix",
        payload: { applyUrl: "http://example.test/jobs/fixed" },
      }),
      upsert({ eventId: "evt-version", version: 0 }),
      upsert({ eventId: "evt-blank", payload: { title: "  " } }),
    ];
    for (const body of invalid) {
      const response = await postEvent(context.baseUrl, body);
      assert.equal(response.status, 400);
      assert.equal(response.body.error, "invalid_event");
    }
    assert.equal(await database.db.collection(EVENTS).countDocuments({}), 0);

    const corrected = await postEvent(
      context.baseUrl,
      upsert({
        eventId: "evt-fix",
        externalJobId: "fixed",
        payload: {
          title: "  Backend Engineer  ",
          skills: [" TypeScript ", "MongoDB", "typescript"],
        },
      }),
    );
    assert.equal(corrected.status, 202);
    assert.equal(
      await database.db
        .collection(EVENTS)
        .countDocuments({ eventId: "evt-fix" }),
      1,
    );
    await drain(deps({ db: database.db }));
    const job = await database.db
      .collection<JobRecord>(JOBS)
      .findOne({ externalJobId: "fixed" });
    assert.equal(job?.title, "Backend Engineer");
    assert.deepEqual(job?.skills, ["typescript", "mongodb"]);
  });

  test("exact and reordered replays return 200 and a different body returns 409", async () => {
    assert.ok(database);
    const original = upsert({ eventId: "evt-replay", externalJobId: "replay" });
    const accepted = await postEvent(context.baseUrl, original);
    assert.equal(accepted.status, 202);
    assert.equal(typeof accepted.body.location, "string");

    const replay = await postEvent(context.baseUrl, {
      payload: original.payload,
      operation: original.operation,
      version: original.version,
      externalJobId: original.externalJobId,
      eventId: original.eventId,
      sourceId: original.sourceId,
      tenantId: original.tenantId,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.outcome, "duplicate");
    const location = replay.body.location;
    assert.equal(typeof location, "string");
    const follow = await fetch(new URL(String(location), context.baseUrl));
    assert.equal(follow.status, 200);

    const trimmed = upsert({
      eventId: "evt-replay",
      externalJobId: "replay",
      payload: { title: "Engineer" },
    });
    const changed = upsert({
      eventId: "evt-replay",
      externalJobId: "replay",
      payload: { title: "Different" },
    });
    assert.equal((await postEvent(context.baseUrl, trimmed)).status, 200);
    const conflict = await postEvent(context.baseUrl, changed);
    assert.equal(conflict.status, 409);
    assert.equal(
      await database.db
        .collection(EVENTS)
        .countDocuments({ eventId: "evt-replay" }),
      1,
    );
  });

  test("health reports ok while mongo is reachable", async () => {
    const response = await fetch(new URL("/health", context.baseUrl));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      dependencies: { mongo: string };
    };
    assert.equal(body.status, "ok");
    assert.equal(body.dependencies.mongo, "up");
  });
});

test("health reports degraded when mongo is unreachable", async () => {
  const { client, db } = await connectMongo(
    process.env.MONGO_URL ?? "mongodb://127.0.0.1:27018/jobfeed",
  );
  const app = createApp({ db, config: testConfig() });
  const server = await listen(app);
  try {
    await client.close();
    const response = await fetch(new URL("/health", server.url));
    assert.equal(response.status, 503);
    const body = (await response.json()) as {
      status: string;
      dependencies: { mongo: string };
    };
    assert.equal(body.status, "degraded");
    assert.equal(body.dependencies.mongo, "down");
  } finally {
    await server.close();
  }
});
