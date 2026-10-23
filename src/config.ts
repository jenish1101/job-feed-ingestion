import path from "node:path";
import { projectRoot } from "./utils/paths.js";

export interface AppConfig {
  port: number;
  mongoUrl: string;
  workerCount: number;
  leaseMs: number;
  pollIntervalMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  maxAttempts: number;
  providerPlanPath: string;
  maxPageSize: number;
  defaultPageSize: number;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

try {
  process.loadEnvFile?.();
} catch {
  // Ignore when .env does not exist
}

export function assertNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(
      `Node.js 22 or newer is required. Found ${process.version}`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerPlan =
    env.PROVIDER_PLAN_PATH?.trim() || "fixtures/provider-plan.json";
  const maxPageSize = integerEnv(env, "MAX_PAGE_SIZE", 100, 1);
  const defaultPageSize = integerEnv(env, "DEFAULT_PAGE_SIZE", 20, 1);
  if (defaultPageSize > maxPageSize) {
    throw new Error("DEFAULT_PAGE_SIZE must not exceed MAX_PAGE_SIZE");
  }
  return {
    port: integerEnv(env, "PORT", 3000, 0),
    mongoUrl: env.MONGO_URL?.trim() || "mongodb://127.0.0.1:27018/jobfeed",
    workerCount: integerEnv(env, "WORKER_COUNT", 2, 1),
    leaseMs: integerEnv(env, "CLAIM_LEASE_MS", 15_000, 1),
    pollIntervalMs: integerEnv(env, "POLL_INTERVAL_MS", 200, 10),
    backoffBaseMs: integerEnv(env, "BACKOFF_BASE_MS", 200, 0),
    backoffCapMs: integerEnv(env, "BACKOFF_CAP_MS", 5_000, 0),
    maxAttempts: integerEnv(env, "MAX_ATTEMPTS", 3, 1),
    providerPlanPath: path.resolve(projectRoot, providerPlan),
    maxPageSize,
    defaultPageSize,
  };
}
