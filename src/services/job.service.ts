import type { Db, Filter } from "mongodb";
import { JOBS } from "../db/mongo.js";
import type { JobRecord } from "../types.js";
import {
  encodeCursor,
  decodeCursor,
  type CursorPayload,
} from "../utils/cursor.js";

export interface JobListOptions {
  tenantId: string;
  sourceId?: string;
  status: "active" | "archived" | "all";
  limit: number;
  cursor?: string;
}

export interface JobListResult {
  jobs: JobRecord[];
  nextCursor: string | null;
  /** Set when the cursor doesn't match the current query filters */
  cursorMismatch?: true;
}

/**
 * Returns a page of jobs for a tenant, with cursor-based pagination.
 * Sorted by (sourceId, externalJobId) for a deterministic, stable page order.
 */
export async function listJobs(
  db: Db,
  options: JobListOptions,
): Promise<JobListResult> {
  const { tenantId, sourceId, status, limit } = options;
  const filterSourceId = sourceId ?? null;

  // Decode and validate cursor if provided
  let decodedCursor: CursorPayload | null = null;
  if (options.cursor !== undefined) {
    decodedCursor = decodeCursor(options.cursor);
    // Cursor must match the current query's status + source filter
    if (
      !decodedCursor ||
      decodedCursor.status !== status ||
      decodedCursor.filterSourceId !== filterSourceId
    ) {
      return { jobs: [], nextCursor: null, cursorMismatch: true };
    }
  }

  // Build MongoDB filter
  const and: Filter<JobRecord>[] = [{ tenantId }];
  if (sourceId !== undefined) and.push({ sourceId });
  if (status !== "all") and.push({ status });

  // Cursor-based pagination: only return records after the last seen key
  if (decodedCursor) {
    if (sourceId !== undefined) {
      // Single source: just advance by externalJobId
      and.push({ externalJobId: { $gt: decodedCursor.externalJobId } });
    } else {
      // Multi-source: advance by (sourceId, externalJobId) pair
      and.push({
        $or: [
          {
            sourceId: decodedCursor.sourceId,
            externalJobId: { $gt: decodedCursor.externalJobId },
          },
          { sourceId: { $gt: decodedCursor.sourceId } },
        ],
      });
    }
  }

  // Fetch one extra to know if there's a next page
  const rows = await db
    .collection<JobRecord>(JOBS)
    .find({ $and: and })
    .sort({ sourceId: 1, externalJobId: 1 })
    .limit(limit + 1)
    .toArray();

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({
          sourceId: last.sourceId,
          externalJobId: last.externalJobId,
          status,
          filterSourceId,
        })
      : null;

  return { jobs: page, nextCursor };
}

/** Formats a JobRecord for the public API response */
export function publicJob(job: JobRecord) {
  return {
    tenantId: job.tenantId,
    sourceId: job.sourceId,
    externalJobId: job.externalJobId,
    version: job.version,
    status: job.status,
    title: job.title ?? null,
    company: job.company ?? null,
    location: job.location ?? null,
    experienceMin: job.experienceMin ?? null,
    experienceMax: job.experienceMax ?? null,
    applyUrl: job.applyUrl ?? null,
    skills: job.skills ?? [],
    appliedEventId: job.appliedEventId,
    updatedAt: job.updatedAt,
  };
}
