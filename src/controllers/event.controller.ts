import type { Request, Response } from "express";
import type { Db } from "mongodb";
import { validateEvent } from "../utils/validate.js";
import { acceptEvent, findEvent } from "../services/event.service.js";
import { publicEvent } from "../utils/format.js";
import { queryString } from "../utils/queryString.js";

/**
 * POST /events
 * Validates the incoming event, then accepts, deduplicates, or rejects it.
 *
 * - 202: event accepted and stored for background processing
 * - 200: exact duplicate (same content) — idempotent re-submission
 * - 409: same event ID but different content — conflict
 * - 400: validation failed
 */
export async function postEvent(
  db: Db,
  req: Request,
  res: Response,
): Promise<void> {
  const validated = validateEvent(req.body);
  if (!validated.ok) {
    res.status(400).json({ error: "invalid_event", details: validated.errors });
    return;
  }

  const result = await acceptEvent(db, req.body, validated.event);

  if (result.outcome === "duplicate") {
    res
      .status(200)
      .json({ outcome: "duplicate", ...publicEvent(result.event) });
    return;
  }

  if (result.outcome === "conflict") {
    res.status(409).json({
      error: "event_identity_conflict",
      tenantId: validated.event.tenantId,
      sourceId: validated.event.sourceId,
      eventId: validated.event.eventId,
      location: result.location,
    });
    return;
  }

  // outcome === "accepted"
  res.status(202).json({ outcome: "accepted", ...publicEvent(result.event) });
}

/**
 * GET /events/:eventId?tenantId=...&sourceId=...
 * Returns the current status, attempt count, and history for a stored event.
 *
 * - 200: event found
 * - 400: missing or invalid query parameters
 * - 404: event not found
 */
export async function getEvent(
  db: Db,
  req: Request,
  res: Response,
): Promise<void> {
  const tenantId = queryString(req.query.tenantId);
  const sourceId = queryString(req.query.sourceId);

  // Reject multi-value query params (Express gives arrays for ?x=1&x=2)
  if (typeof tenantId === "object" || typeof sourceId === "object") {
    res.status(400).json({
      error: "invalid_query",
      details: ["query parameter must be a single value"],
    });
    return;
  }

  // Reuse event validation to check tenantId, sourceId, and eventId format
  const validated = validateEvent({
    tenantId,
    sourceId,
    eventId: req.params["eventId"],
    externalJobId: "placeholder",
    version: 1,
    operation: "archive",
  });
  if (!validated.ok) {
    res.status(400).json({ error: "invalid_query", details: validated.errors });
    return;
  }

  const event = await findEvent(
    db,
    validated.event.tenantId,
    validated.event.sourceId,
    validated.event.eventId,
  );

  if (!event) {
    res.status(404).json({ error: "event_not_found" });
    return;
  }

  res.status(200).json(publicEvent(event));
}
