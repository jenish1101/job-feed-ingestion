import type { AppConfig } from "../config.js";
import type { Provider } from "./provider.js";
import { claimAndProcess, type ProcessorDeps } from "./processor.js";
import { sleep } from "../utils/sleep.js";
import type { Db } from "mongodb";

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export function processorDeps(options: {
  db: Db;
  config: AppConfig;
  provider: Provider;
  workerId: string;
  afterProjection?: ProcessorDeps["afterProjection"];
}): ProcessorDeps {
  return {
    db: options.db,
    workerId: options.workerId,
    leaseMs: options.config.leaseMs,
    maxAttempts: options.config.maxAttempts,
    backoffBaseMs: options.config.backoffBaseMs,
    backoffCapMs: options.config.backoffCapMs,
    provider: options.provider,
    afterProjection: options.afterProjection,
  };
}

export function startWorkers(options: {
  db: Db;
  config: AppConfig;
  provider: Provider;
  workerIdPrefix: string;
  afterProjection?: ProcessorDeps["afterProjection"];
}): WorkerHandle {
  let stopped = false;
  const loops: Promise<void>[] = [];

  for (let index = 0; index < options.config.workerCount; index += 1) {
    const workerId = `${options.workerIdPrefix}-${index + 1}`;
    loops.push(runLoop(workerId));
  }

  return {
    stop: async () => {
      stopped = true;
      await Promise.all(loops);
    },
  };

  async function runLoop(workerId: string): Promise<void> {
    const deps = processorDeps({ ...options, workerId });
    while (!stopped) {
      try {
        const result = await claimAndProcess(deps);
        if (stopped) return;
        if (result === "idle") await sleep(options.config.pollIntervalMs);
      } catch (error) {
        console.error(
          `worker ${workerId} stopped a claim without acknowledging it`,
          error,
        );
        if (stopped) return;
        await sleep(options.config.pollIntervalMs);
      }
    }
  }
}
