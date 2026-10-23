import type { Db } from "mongodb";
import { canonicalize } from "../utils/canonicalize.js";
import { EVENTS, isDuplicateKey } from "../db/mongo.js";
import type { StoredEvent } from "../types.js";
import { eventLocation } from "../utils/format.js";
import type { ValidatedEvent } from "../types.js";

export type AcceptResult =
  | { outcome: "accepted"; event: StoredEvent }
  | { outcome: "duplicate"; event: StoredEvent }
  | { outcome: "conflict"; location: string };

/**
 * Stores a new event in the database.
 * - Returns "accepted" (202) for a brand new event.
 * - Returns "duplicate" (200) if the same event was already received with identical content.
 * - Returns "conflict" (409) if the event ID was reused with different content.
 */
export async function acceptEvent(
  db: Db,
  rawBody: unknown,
  validated: ValidatedEvent,
): Promise<AcceptResult> {
  const collection = db.collection<StoredEvent>(EVENTS);
  const identity = {
    tenantId: validated.tenantId,
    sourceId: validated.sourceId,
    eventId: validated.eventId,
  };
  const canonical = canonicalize(rawBody);

  // Check for existing event before inserting
  const checkReplay = async (): Promise<AcceptResult | null> => {
    const existing = await collection.findOne(identity);
    if (!existing) return null;
    if (existing.canonical === canonical) {
      return { outcome: "duplicate", event: existing };
    }
    return { outcome: "conflict", location: eventLocation(existing) };
  };

  const preCheck = await checkReplay();
  if (preCheck) return preCheck;

  const now = new Date();
  const document: StoredEvent = {
    ...identity,
    externalJobId: validated.externalJobId,
    version: validated.version,
    operation: validated.operation,
    canonical,
    status: "pending",
    attempts: 0,
    attemptHistory: [],
    lastError: null,
    claimedBy: null,
    claimExpiresAt: null,
    nextAttemptAt: new Date(0),
    createdAt: now,
    updatedAt: now,
  };
  if (validated.operation === "upsert") document.payload = validated.payload;

  try {
    await collection.insertOne(document);
    return { outcome: "accepted", event: document };
  } catch (error) {
    // Race condition: another request inserted the same event concurrently
    if (!isDuplicateKey(error)) throw error;
    const postCheck = await checkReplay();
    if (postCheck) return postCheck;
    return {
      outcome: "conflict",
      location: eventLocation(identity as StoredEvent),
    };
  }
}

/**
 * Finds a single event by its identity (tenantId, sourceId, eventId).
 */
export async function findEvent(
  db: Db,
  tenantId: string,
  sourceId: string,
  eventId: string,
): Promise<StoredEvent | null> {
  return db
    .collection<StoredEvent>(EVENTS)
    .findOne({ tenantId, sourceId, eventId });
}
