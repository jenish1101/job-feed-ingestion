export type Operation = "upsert" | "archive";

export interface JobPayload {
  title: string;
  company: string;
  location: string;
  experienceMin: number;
  experienceMax: number;
  applyUrl: string;
  skills: string[];
}

interface EventBase {
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
}

export type ValidatedEvent =
  | (EventBase & { operation: "upsert"; payload: JobPayload })
  | (EventBase & { operation: "archive" });

export type EventStatus =
  "pending" | "processing" | "succeeded" | "noop" | "failed";

export type AttemptOutcome =
  | "started"
  | "retry"
  | "permanent"
  | "success"
  | "exhausted"
  | "skipped_stale"
  | "already_applied";

export interface AttemptRecord {
  attempt: number;
  at: Date;
  outcome: AttemptOutcome;
  statusCode?: number;
  error?: string;
}

export interface StoredEvent {
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: Operation;
  payload?: JobPayload;
  canonical: string;
  status: EventStatus;
  attempts: number;
  attemptHistory: AttemptRecord[];
  lastError: string | null;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type JobStatus = "active" | "archived";

export interface JobRecord {
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number;
  status: JobStatus;
  title?: string;
  company?: string;
  location?: string;
  experienceMin?: number;
  experienceMax?: number;
  applyUrl?: string;
  skills?: string[];
  appliedEventId: string;
  updatedAt: Date;
}

export const TERMINAL_STATUSES: readonly EventStatus[] = [
  "succeeded",
  "noop",
  "failed",
];
