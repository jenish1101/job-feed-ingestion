import { assertNodeVersion, loadConfig } from "../config.js";
import { connectMongo, ensureIndexes } from "../db/mongo.js";
import { startFileWorkers } from "./runtime.js";

async function main(): Promise<void> {
  assertNodeVersion();
  const config = loadConfig();
  const { client, db } = await connectMongo(config.mongoUrl);
  await ensureIndexes(db);
  const { workers } = startFileWorkers(db, config, `worker-${process.pid}`);
  console.log(`started ${config.workerCount} worker loop(s)`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`worker shutting down on ${signal}`);
    await workers.stop();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (error: unknown) => {
  console.error(error);
  process.exit(1);
});

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
