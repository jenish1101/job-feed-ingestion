import type { Db } from "mongodb";
import type { AppConfig } from "../config.js";
import { createFileProvider, type Provider } from "./provider.js";
import type { ProcessorDeps } from "./processor.js";
import { startWorkers, type WorkerHandle } from "./workers.js";

export function projectionCrashHook(): NonNullable<
  ProcessorDeps["afterProjection"]
> {
  return async (event) => {
    if (process.env.CRASH_AFTER_PROJECTION !== event.eventId) return;
    process.stderr.write(
      `stopping after projection write before ack: ${event.tenantId}/${event.sourceId}/${event.eventId}\n`,
    );
    process.exit(1);
  };
}

export function startFileWorkers(
  db: Db,
  config: AppConfig,
  prefix: string,
): {
  provider: Provider;
  workers: WorkerHandle;
} {
  const provider = createFileProvider(config.providerPlanPath);
  const workers = startWorkers({
    db,
    config,
    provider,
    workerIdPrefix: prefix,
    afterProjection: projectionCrashHook(),
  });
  return { provider, workers };
}
