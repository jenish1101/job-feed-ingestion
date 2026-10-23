import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { JOBS } from "../src/db/mongo.js";
import type { Provider } from "../src/worker/provider.js";
import type { StoredEvent } from "../src/types.js";
import {
  connectTestDb,
  deps,
  drain,
  postEvent,
  testConfig,
  upsert,
} from "./helpers.js";

test.describe("provider failures", { concurrency: false }, () => {
  let database: Awaited<ReturnType<typeof connectTestDb>>;
  let baseUrl = "";
  let close: () => Promise<void> = async () => undefined;

  test.before(async () => {
    database = await connectTestDb("jobfeed_test_provider");
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

  test("429 and 503 retry with backoff and then succeed", async () => {
    const stamps: number[] = [];
    const provider: Provider = async (_event: StoredEvent, attempt: number) => {
      stamps.push(Date.now());
      return attempt === 1 ? 429 : attempt === 2 ? 503 : 200;
    };
    const started = Date.now();
    assert.equal(
      (
        await postEvent(
          baseUrl,
          upsert({ eventId: "evt-retry", externalJobId: "retry" }),
        )
      ).status,
      202,
    );
    await drain(deps({ db: database.db, provider, backoffBaseMs: 80 }));
    const event = await database.db
      .collection<StoredEvent>("events")
      .findOne({ eventId: "evt-retry" });
    assert.equal(event?.status, "succeeded");
    assert.equal(event?.attempts, 3);
    assert.equal(event?.lastError, null);
    assert.equal(stamps.length, 3);
    assert.ok((stamps[1] ?? 0) - (stamps[0] ?? 0) >= 50);
    assert.ok((stamps[2] ?? 0) - (stamps[1] ?? 0) >= 100);
    assert.ok(Date.now() - started < 5_000);
    const outcomes = event?.attemptHistory.map((entry) => entry.outcome);
    assert.deepEqual(outcomes, [
      "started",
      "retry",
      "started",
      "retry",
      "started",
      "success",
    ]);
  });

  test("422 is permanent and does not create a job", async () => {
    let calls = 0;
    const provider: Provider = async () => {
      calls += 1;
      return 422;
    };
    await postEvent(
      baseUrl,
      upsert({ eventId: "evt-422", externalJobId: "perm" }),
    );
    await drain(deps({ db: database.db, provider }));
    const event = await database.db
      .collection<StoredEvent>("events")
      .findOne({ eventId: "evt-422" });
    assert.equal(event?.status, "failed");
    assert.equal(event?.attempts, 1);
    assert.match(event?.lastError ?? "", /422/);
    assert.equal(calls, 1);
    assert.equal(
      await database.db
        .collection(JOBS)
        .countDocuments({ externalJobId: "perm" }),
      0,
    );
  });

  test("three 503 responses exhaust the attempt budget without a job", async () => {
    let calls = 0;
    const provider: Provider = async () => {
      calls += 1;
      return 503;
    };
    await postEvent(
      baseUrl,
      upsert({ eventId: "evt-503", externalJobId: "exhaust" }),
    );
    await drain(deps({ db: database.db, provider, backoffBaseMs: 30 }));
    const event = await database.db
      .collection<StoredEvent>("events")
      .findOne({ eventId: "evt-503" });
    assert.equal(event?.status, "failed");
    assert.equal(event?.attempts, 3);
    assert.match(event?.lastError ?? "", /503/);
    assert.equal(calls, 3);
    assert.equal(
      event?.attemptHistory.filter((entry) => entry.outcome === "retry").length,
      2,
    );
    assert.equal(event?.attemptHistory.at(-1)?.outcome, "exhausted");
    assert.equal(
      await database.db
        .collection(JOBS)
        .countDocuments({ externalJobId: "exhaust" }),
      0,
    );
  });
});
