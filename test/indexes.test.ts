import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENTS,
  JOBS,
  EVENT_TTL_SECONDS,
  isDuplicateKey,
} from "../src/db/mongo.js";
import { connectTestDb } from "./helpers.js";

test("mongo indexes match the documented model and reject duplicate identities", async () => {
  const { client, db } = await connectTestDb("jobfeed_test_indexes");
  try {
    const eventIndexes = await db.collection(EVENTS).indexes();
    const jobIndexes = await db.collection(JOBS).indexes();
    const eventNames = eventIndexes.map((index) => index.name);
    const jobNames = jobIndexes.map((index) => index.name);
    for (const name of [
      "event_identity",
      "pending_work",
      "expired_claims",
      "event_ttl",
    ]) {
      assert.equal(eventNames.includes(name), true, name);
    }
    for (const name of ["job_identity", "job_list"]) {
      assert.equal(jobNames.includes(name), true, name);
    }
    const ttl = eventIndexes.find((index) => index.name === "event_ttl");
    assert.equal(ttl?.expireAfterSeconds, EVENT_TTL_SECONDS);

    const identity = {
      tenantId: "tenant-a",
      sourceId: "main",
      eventId: "evt-1",
    };
    await db.collection(EVENTS).insertOne({ ...identity, status: "pending" });
    await assert.rejects(
      () => db.collection(EVENTS).insertOne({ ...identity, status: "pending" }),
      (error: unknown) => isDuplicateKey(error),
    );
    const job = {
      tenantId: "tenant-a",
      sourceId: "main",
      externalJobId: "job-1",
      version: 1,
    };
    await db.collection(JOBS).insertOne(job);
    await assert.rejects(
      () => db.collection(JOBS).insertOne({ ...job, version: 2 }),
      (error: unknown) => isDuplicateKey(error),
    );
  } finally {
    await client.close();
  }
});
