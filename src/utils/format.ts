import type { StoredEvent } from "../types.js";

// ---------- event location helper ----------

export function eventLocation(
  event: Pick<StoredEvent, "tenantId" | "sourceId" | "eventId">,
): string {
  const params = new URLSearchParams({
    tenantId: event.tenantId,
    sourceId: event.sourceId,
  });
  return `/events/${encodeURIComponent(event.eventId)}?${params.toString()}`;
}

// ---------- public response shapes ----------

/** Shape returned by GET /events/:eventId and POST /events */
export function publicEvent(event: StoredEvent) {
  return {
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    eventId: event.eventId,
    externalJobId: event.externalJobId,
    version: event.version,
    operation: event.operation,
    status: event.status,
    attempts: event.attempts,
    lastError: event.lastError,
    nextAttemptAt: event.nextAttemptAt,
    attemptHistory: event.attemptHistory,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    location: eventLocation(event),
  };
}
