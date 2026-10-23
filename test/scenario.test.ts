import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listen } from "../src/utils/listen.js";
import { projectRoot } from "../src/utils/paths.js";
import { createFileProvider } from "../src/worker/provider.js";
import { loadScenario, runScenario } from "../src/scripts/scenario-runner.js";
import { startWorkers } from "../src/worker/workers.js";
import { connectTestDb, testConfig } from "./helpers.js";

test(
  "the fixture scenario settles phase 1 before submitting phase 2",
  { timeout: 30_000 },
  async () => {
    const scenario = loadScenario(
      path.join(projectRoot, "fixtures/scenario.json"),
    );
    const requestCount = scenario.phases.reduce(
      (sum: number, phase) => sum + phase.requests.length,
      0,
    );
    assert.equal(requestCount, 20);
    assert.deepEqual(
      scenario.phases.map((phase) => phase.name),
      ["phase-1", "phase-2"],
    );

    const database = await connectTestDb("jobfeed_test_scenario");
    const config = testConfig({
      BACKOFF_BASE_MS: "30",
      BACKOFF_CAP_MS: "120",
      POLL_INTERVAL_MS: "20",
    });
    const server = await listen(createApp({ db: database.db, config }));
    const workers = startWorkers({
      db: database.db,
      config,
      provider: createFileProvider(config.providerPlanPath),
      workerIdPrefix: "scenario",
    });
    try {
      await runScenario(server.url, scenario, { timeoutMs: 15_000 });
    } finally {
      await workers.stop();
      await server.close();
      await database.client.close();
    }
  },
);
