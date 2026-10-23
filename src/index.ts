import { createApp } from "./app.js";
import { assertNodeVersion, loadConfig } from "./config.js";
import { listen } from "./utils/listen.js";
import { connectMongo, ensureIndexes } from "./db/mongo.js";
import { startFileWorkers } from "./worker/runtime.js";

async function main(): Promise<void> {
  assertNodeVersion();
  const config = loadConfig();
  console.log(`[db] connecting to MongoDB...`);
  const { client, db } = await connectMongo(config.mongoUrl);
  console.log(`[db] ✅ MongoDB connected`);
  await ensureIndexes(db);
  const app = createApp({ db, config });
  const { workers } = startFileWorkers(db, config, `api-${process.pid}`);
  const server = await listen(app, config.port);
  console.log(
    `[server] ✅ job-feed listening on port ${config.port}  →  ${server.url}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`shutting down on ${signal}`);
    await workers.stop();
    await server.close();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
