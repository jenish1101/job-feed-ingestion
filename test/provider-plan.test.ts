import assert from "node:assert/strict";
import test from "node:test";
import { projectRoot } from "../src/utils/paths.js";
import {
  createFileProvider,
  parseProviderPlan,
} from "../src/worker/provider.js";
import type { StoredEvent } from "../src/types.js";
import path from "node:path";

function event(overrides: Partial<StoredEvent>): StoredEvent {
  return {
    tenantId: "tenant-a",
    sourceId: "main",
    eventId: "evt",
    externalJobId: "beta",
    version: 1,
    operation: "upsert",
    canonical: "{}",
    status: "pending",
    attempts: 0,
    attemptHistory: [],
    lastError: null,
    claimedBy: null,
    claimExpiresAt: null,
    nextAttemptAt: new Date(0),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

test("the supplied provider plan retries beta, rejects gamma, and exhausts delta", async () => {
  const provider = createFileProvider(
    path.join(projectRoot, "fixtures/provider-plan.json"),
  );
  assert.equal(await provider(event({ externalJobId: "beta" }), 1), 429);
  assert.equal(await provider(event({ externalJobId: "beta" }), 2), 200);
  assert.equal(await provider(event({ externalJobId: "gamma" }), 1), 422);
  assert.equal(await provider(event({ externalJobId: "delta" }), 3), 503);
  assert.equal(
    await provider(event({ externalJobId: "eta", version: 2 }), 1),
    422,
  );
  assert.equal(
    await provider(event({ externalJobId: "eta", version: 1 }), 1),
    200,
  );
  assert.equal(await provider(event({ externalJobId: "alpha" }), 1), 200);
});

test("provider plans reject an unsupported default", () => {
  assert.throws(
    () => parseProviderPlan({ default: "fail", rules: [] }),
    /default/,
  );
});
