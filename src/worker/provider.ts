import { readFileSync, statSync } from "node:fs";
import type { StoredEvent } from "../types.js";

export type Provider = (event: StoredEvent, attempt: number) => Promise<number>;

export interface ProviderRule {
  tenantId?: string;
  sourceId?: string;
  externalJobId?: string;
  eventId?: string;
  version?: number;
  responses: number[];
}

interface ProviderPlan {
  default: "success";
  rules: ProviderRule[];
}

function isRule(value: unknown): value is ProviderRule {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const rule = value as Record<string, unknown>;
  if (!Array.isArray(rule.responses) || rule.responses.length === 0)
    return false;
  if (
    !rule.responses.every(
      (code) => typeof code === "number" && Number.isInteger(code),
    )
  ) {
    return false;
  }
  for (const field of [
    "tenantId",
    "sourceId",
    "externalJobId",
    "eventId",
  ] as const) {
    if (rule[field] !== undefined && typeof rule[field] !== "string")
      return false;
  }
  if (
    rule.version !== undefined &&
    (typeof rule.version !== "number" || !Number.isInteger(rule.version))
  ) {
    return false;
  }
  return true;
}

export function parseProviderPlan(raw: unknown): ProviderPlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("provider plan must be an object");
  }
  const body = raw as Record<string, unknown>;
  if (body.default !== undefined && body.default !== "success") {
    throw new Error("provider plan default must be success");
  }
  if (!Array.isArray(body.rules) || !body.rules.every(isRule)) {
    throw new Error("provider plan rules are invalid");
  }
  return { default: "success", rules: body.rules };
}

function matches(rule: ProviderRule, event: StoredEvent): boolean {
  if (rule.tenantId !== undefined && rule.tenantId !== event.tenantId)
    return false;
  if (rule.sourceId !== undefined && rule.sourceId !== event.sourceId)
    return false;
  if (
    rule.externalJobId !== undefined &&
    rule.externalJobId !== event.externalJobId
  )
    return false;
  if (rule.eventId !== undefined && rule.eventId !== event.eventId)
    return false;
  if (rule.version !== undefined && rule.version !== event.version)
    return false;
  return true;
}

export function statusFor(
  plan: ProviderPlan,
  event: StoredEvent,
  attempt: number,
): number {
  const rule = plan.rules.find((candidate) => matches(candidate, event));
  if (!rule) return 200;
  const index = Math.min(Math.max(attempt, 1) - 1, rule.responses.length - 1);
  return rule.responses[index] ?? 200;
}

export function createFileProvider(planPath: string): Provider {
  let cached: { mtimeMs: number; plan: ProviderPlan } | null = null;
  const load = (): ProviderPlan => {
    const mtimeMs = statSync(planPath).mtimeMs;
    if (cached && cached.mtimeMs === mtimeMs) return cached.plan;
    const plan = parseProviderPlan(
      JSON.parse(readFileSync(planPath, "utf8")) as unknown,
    );
    cached = { mtimeMs, plan };
    return plan;
  };
  return async (event, attempt) => statusFor(load(), event, attempt);
}
