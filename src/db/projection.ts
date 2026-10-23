import type { Db } from "mongodb";
import { isDuplicateKey, JOBS } from "./mongo.js";
import type { JobRecord, StoredEvent } from "../types.js";

export async function applyProjection(
  db: Db,
  event: StoredEvent,
): Promise<"applied" | "stale"> {
  const jobs = db.collection<JobRecord>(JOBS);
  const identity = {
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    externalJobId: event.externalJobId,
  };
  const now = new Date();
  const fields: Partial<JobRecord> = {
    version: event.version,
    status: event.operation === "archive" ? "archived" : "active",
    appliedEventId: event.eventId,
    updatedAt: now,
  };
  if (event.operation === "upsert" && event.payload) {
    fields.title = event.payload.title;
    fields.company = event.payload.company;
    fields.location = event.payload.location;
    fields.experienceMin = event.payload.experienceMin;
    fields.experienceMax = event.payload.experienceMax;
    fields.applyUrl = event.payload.applyUrl;
    fields.skills = event.payload.skills;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await jobs.updateOne(
      { ...identity, version: { $lt: event.version } },
      { $set: fields },
    );
    if (updated.matchedCount === 1) return "applied";

    const existing = await jobs.findOne(identity);
    if (existing) {
      if (existing.version > event.version) return "stale";
      if (existing.version === event.version) {
        return existing.appliedEventId === event.eventId ? "applied" : "stale";
      }
      continue;
    }

    try {
      const inserted: JobRecord = {
        ...identity,
        version: event.version,
        status: event.operation === "archive" ? "archived" : "active",
        appliedEventId: event.eventId,
        updatedAt: now,
      };
      if (event.operation === "upsert" && event.payload) {
        inserted.title = event.payload.title;
        inserted.company = event.payload.company;
        inserted.location = event.payload.location;
        inserted.experienceMin = event.payload.experienceMin;
        inserted.experienceMax = event.payload.experienceMax;
        inserted.applyUrl = event.payload.applyUrl;
        inserted.skills = event.payload.skills;
      }
      await jobs.insertOne(inserted);
      return "applied";
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  const existing = await jobs.findOne(identity);
  if (
    existing &&
    existing.version === event.version &&
    existing.appliedEventId === event.eventId
  ) {
    return "applied";
  }
  if (existing && existing.version >= event.version) return "stale";
  throw new Error("failed to apply job projection");
}
