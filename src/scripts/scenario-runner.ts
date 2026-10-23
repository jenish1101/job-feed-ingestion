import { readFileSync } from "node:fs";
import {
  TERMINAL_STATUSES,
  type EventStatus,
  type JobStatus,
} from "../types.js";
import { sleep } from "../utils/sleep.js";

interface ScenarioRequest {
  expectStatus: number;
  body: Record<string, unknown>;
}

interface EventExpectation {
  tenantId: string;
  sourceId: string;
  eventId: string;
  status: EventStatus;
  attempts?: number;
  errorIncludes?: string;
  sawStatusCode?: number;
}

interface JobExpectation {
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number;
  status: JobStatus;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  skills?: string[];
}

interface JobIdentity {
  tenantId: string;
  sourceId: string;
  externalJobId: string;
}

interface ScenarioPhase {
  name: string;
  requests: ScenarioRequest[];
  events?: EventExpectation[];
  jobs?: JobExpectation[];
  absentJobs?: JobIdentity[];
}

export interface Scenario {
  phases: ScenarioPhase[];
}

interface PublicEvent {
  status: EventStatus;
  attempts: number;
  lastError: string | null;
  attemptHistory: Array<{ statusCode?: number }>;
  location?: string;
  eventId?: string;
}

interface PublicJob {
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number;
  status: JobStatus;
  title: string | null;
  company: string | null;
  location: string | null;
  skills: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseScenario(raw: unknown): Scenario {
  if (!isRecord(raw) || !Array.isArray(raw.phases)) {
    throw new Error("scenario must contain phases");
  }
  const phases: ScenarioPhase[] = [];
  for (const phase of raw.phases) {
    if (
      !isRecord(phase) ||
      typeof phase.name !== "string" ||
      !Array.isArray(phase.requests)
    ) {
      throw new Error("scenario phase is invalid");
    }
    const requests: ScenarioRequest[] = [];
    for (const request of phase.requests) {
      if (
        !isRecord(request) ||
        typeof request.expectStatus !== "number" ||
        !isRecord(request.body)
      ) {
        throw new Error(`scenario ${phase.name} has an invalid request`);
      }
      requests.push({ expectStatus: request.expectStatus, body: request.body });
    }
    phases.push({
      name: phase.name,
      requests,
      events: phase.events as EventExpectation[] | undefined,
      jobs: phase.jobs as JobExpectation[] | undefined,
      absentJobs: phase.absentJobs as JobIdentity[] | undefined,
    });
  }
  return { phases };
}

export function loadScenario(filePath: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("response was not a JSON object");
  return parsed;
}

async function listJobs(
  baseUrl: string,
  tenantId: string,
): Promise<PublicJob[]> {
  const jobs: PublicJob[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL("/jobs", baseUrl);
    url.searchParams.set("tenantId", tenantId);
    url.searchParams.set("status", "all");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url);
    if (response.status !== 200) {
      throw new Error(`list jobs failed with ${response.status}`);
    }
    const body = await readJson(response);
    if (!Array.isArray(body.jobs))
      throw new Error("jobs response did not include a list");
    jobs.push(...(body.jobs as PublicJob[]));
    cursor = typeof body.nextCursor === "string" ? body.nextCursor : null;
  } while (cursor);
  return jobs;
}

function sameIdentity(job: PublicJob, expected: JobIdentity): boolean {
  return (
    job.tenantId === expected.tenantId &&
    job.sourceId === expected.sourceId &&
    job.externalJobId === expected.externalJobId
  );
}

function matchesJob(job: PublicJob, expected: JobExpectation): string | null {
  if (job.version !== expected.version)
    return `version ${job.version} !== ${expected.version}`;
  if (job.status !== expected.status)
    return `status ${job.status} !== ${expected.status}`;
  if (expected.title !== undefined && job.title !== expected.title) {
    return `title ${JSON.stringify(job.title)} !== ${JSON.stringify(expected.title)}`;
  }
  if (expected.company !== undefined && job.company !== expected.company) {
    return `company ${JSON.stringify(job.company)} !== ${JSON.stringify(expected.company)}`;
  }
  if (expected.location !== undefined && job.location !== expected.location) {
    return `location ${JSON.stringify(job.location)} !== ${JSON.stringify(expected.location)}`;
  }
  if (
    expected.skills !== undefined &&
    JSON.stringify(job.skills) !== JSON.stringify(expected.skills)
  ) {
    return `skills ${JSON.stringify(job.skills)} !== ${JSON.stringify(expected.skills)}`;
  }
  return null;
}

async function waitForTerminal(
  baseUrl: string,
  request: ScenarioRequest,
  timeoutMs: number,
): Promise<void> {
  const tenantId = request.body.tenantId;
  const sourceId = request.body.sourceId;
  const eventId = request.body.eventId;
  if (
    typeof tenantId !== "string" ||
    typeof sourceId !== "string" ||
    typeof eventId !== "string"
  ) {
    throw new Error("accepted event is missing identity fields");
  }
  const deadline = Date.now() + timeoutMs;
  let latest = "missing";
  while (Date.now() < deadline) {
    const url = new URL(`/events/${encodeURIComponent(eventId)}`, baseUrl);
    url.searchParams.set("tenantId", tenantId);
    url.searchParams.set("sourceId", sourceId);
    const response = await fetch(url);
    if (response.status === 200) {
      const body = (await readJson(response)) as unknown as PublicEvent;
      latest = body.status;
      if (TERMINAL_STATUSES.includes(body.status)) return;
    }
    await sleep(30);
  }
  throw new Error(`event ${tenantId}/${sourceId}/${eventId} stayed ${latest}`);
}

async function assertEvents(
  baseUrl: string,
  expectations: EventExpectation[],
): Promise<void> {
  for (const expected of expectations) {
    const url = new URL(
      `/events/${encodeURIComponent(expected.eventId)}`,
      baseUrl,
    );
    url.searchParams.set("tenantId", expected.tenantId);
    url.searchParams.set("sourceId", expected.sourceId);
    const response = await fetch(url);
    if (response.status !== 200) {
      throw new Error(`event ${expected.eventId} returned ${response.status}`);
    }
    const body = (await readJson(response)) as unknown as PublicEvent;
    if (body.status !== expected.status) {
      throw new Error(
        `event ${expected.eventId} status ${body.status} !== ${expected.status}`,
      );
    }
    if (
      expected.attempts !== undefined &&
      body.attempts !== expected.attempts
    ) {
      throw new Error(
        `event ${expected.eventId} attempts ${body.attempts} !== ${expected.attempts}`,
      );
    }
    if (
      expected.errorIncludes !== undefined &&
      !(body.lastError ?? "").includes(expected.errorIncludes)
    ) {
      throw new Error(
        `event ${expected.eventId} lastError ${body.lastError ?? ""}`,
      );
    }
    if (
      expected.sawStatusCode !== undefined &&
      !body.attemptHistory.some(
        (entry) => entry.statusCode === expected.sawStatusCode,
      )
    ) {
      throw new Error(
        `event ${expected.eventId} did not record status ${expected.sawStatusCode}`,
      );
    }
  }
}

async function assertJobs(
  baseUrl: string,
  expectedJobs: JobExpectation[],
  absent: JobIdentity[],
): Promise<void> {
  const tenants = new Set<string>();
  for (const job of expectedJobs) tenants.add(job.tenantId);
  for (const job of absent) tenants.add(job.tenantId);
  const actual: PublicJob[] = [];
  for (const tenantId of tenants)
    actual.push(...(await listJobs(baseUrl, tenantId)));

  for (const expected of expectedJobs) {
    const found = actual.find((job) => sameIdentity(job, expected));
    if (!found) {
      throw new Error(
        `missing job ${expected.tenantId}/${expected.sourceId}/${expected.externalJobId}`,
      );
    }
    const mismatch = matchesJob(found, expected);
    if (mismatch) {
      throw new Error(
        `job ${expected.tenantId}/${expected.sourceId}/${expected.externalJobId} ${mismatch}`,
      );
    }
  }
  for (const missing of absent) {
    if (actual.some((job) => sameIdentity(job, missing))) {
      throw new Error(
        `job ${missing.tenantId}/${missing.sourceId}/${missing.externalJobId} should be absent`,
      );
    }
  }
}

export async function runScenario(
  baseUrl: string,
  scenario: Scenario,
  options: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const log = options.log ?? (() => undefined);
  for (const phase of scenario.phases) {
    for (const [index, request] of phase.requests.entries()) {
      const response = await fetch(new URL("/events", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const label =
        typeof request.body.eventId === "string"
          ? request.body.eventId
          : `request-${index + 1}`;
      log(
        `${phase.name} ${index + 1}/${phase.requests.length} ${label} -> ${response.status}`,
      );
      if (response.status !== request.expectStatus) {
        const detail = await response.text();
        throw new Error(
          `${phase.name} ${label} expected HTTP ${request.expectStatus} but got ${response.status}: ${detail}`,
        );
      }
      if (request.expectStatus === 200 || request.expectStatus === 202) {
        const body = await readJson(response);
        if (body.eventId !== request.body.eventId) {
          throw new Error(
            `${phase.name} ${label} response event id did not match the request`,
          );
        }
        if (typeof body.location !== "string") {
          throw new Error(
            `${phase.name} ${label} response did not include a location`,
          );
        }
      }
    }
    for (const request of phase.requests) {
      if (request.expectStatus === 202)
        await waitForTerminal(baseUrl, request, timeoutMs);
    }
    if (phase.events) await assertEvents(baseUrl, phase.events);
    if (phase.jobs || phase.absentJobs) {
      await assertJobs(baseUrl, phase.jobs ?? [], phase.absentJobs ?? []);
    }
    log(`${phase.name} settled`);
  }
}
