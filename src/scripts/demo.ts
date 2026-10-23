import path from "node:path";
import { createApp } from "../app.js";
import { assertNodeVersion, loadConfig } from "../config.js";
import { listen } from "../utils/listen.js";
import { EVENTS, JOBS, connectMongo, ensureIndexes } from "../db/mongo.js";
import { startFileWorkers } from "../worker/runtime.js";
import { loadScenario, runScenario } from "./scenario-runner.js";
import { projectRoot } from "../utils/paths.js";
import { sleep } from "../utils/sleep.js";

function tenantsIn(scenario: ReturnType<typeof loadScenario>): string[] {
  const tenants = new Set<string>();
  for (const phase of scenario.phases) {
    for (const request of phase.requests) {
      if (typeof request.body.tenantId === "string")
        tenants.add(request.body.tenantId);
    }
  }
  return [...tenants];
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(new URL("/health", baseUrl));
      if (response.status === 200) return;
    } catch {
      // The listener may not accept connections on the first attempt.
    }
    await sleep(100);
  }
  throw new Error("service did not become healthy");
}

async function main(): Promise<void> {
  assertNodeVersion();
  const config = loadConfig();
  const scenarioPath = path.resolve(
    projectRoot,
    process.env.SCENARIO_PATH?.trim() || "fixtures/scenario.json",
  );
  const scenario = loadScenario(scenarioPath);
  const requestCount = scenario.phases.reduce(
    (sum, phase) => sum + phase.requests.length,
    0,
  );
  const { client, db } = await connectMongo(config.mongoUrl);
  await ensureIndexes(db);
  const tenants = tenantsIn(scenario);
  await db.collection(EVENTS).deleteMany({ tenantId: { $in: tenants } });
  await db.collection(JOBS).deleteMany({ tenantId: { $in: tenants } });

  const app = createApp({ db, config });
  let server;
  try {
    server = await listen(app, config.port);
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "EADDRINUSE"
    ) {
      server = await listen(app, 0);
    } else {
      throw err;
    }
  }
  const { workers } = startFileWorkers(db, config, `demo-${process.pid}`);
  try {
    await waitForHealth(server.url);
    console.log(`demo server ${server.url}`);
    console.log(`scenario ${scenarioPath} (${requestCount} requests)`);
    await runScenario(server.url, scenario, {
      log: (line) => console.log(line),
    });
    console.log("demo passed");
  } finally {
    await workers.stop();
    await server.close();
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
