import type { Request, Response } from "express";
import type { Db } from "mongodb";
import type { AppConfig } from "../config.js";
import { validateEvent } from "../utils/validate.js";
import { listJobs, publicJob } from "../services/job.service.js";
import { queryString } from "../utils/queryString.js";

/**
 * GET /jobs?tenantId=...&sourceId=...&status=active&limit=20&cursor=...
 *
 * Returns a paginated list of jobs for a tenant.
 * - tenantId is required
 * - sourceId is optional (filters to one source)
 * - status defaults to "active"; also accepts "archived" or "all"
 * - limit defaults to config.defaultPageSize, max config.maxPageSize
 * - cursor is an opaque token from the previous page's nextCursor
 *
 * - 200: page of jobs with optional nextCursor
 * - 400: invalid query parameters
 */
export async function getJobs(
  db: Db,
  config: AppConfig,
  req: Request,
  res: Response,
): Promise<void> {
  // --- Parse query params ---
  const tenantRaw = queryString(req.query.tenantId);
  const sourceRaw = queryString(req.query.sourceId);
  const statusRaw = queryString(req.query.status);
  const limitRaw = queryString(req.query.limit);
  const cursorRaw = queryString(req.query.cursor);

  // Reject multi-value params
  const multiValueErrors = [
    tenantRaw,
    sourceRaw,
    statusRaw,
    limitRaw,
    cursorRaw,
  ].flatMap((v) => (typeof v === "object" ? [v.error] : []));
  if (multiValueErrors.length > 0) {
    res.status(400).json({ error: "invalid_query", details: multiValueErrors });
    return;
  }

  // --- Validate tenantId (required) ---
  const tenantId = (tenantRaw as string | undefined) ?? "";
  const tenantCheck = validateEvent({
    tenantId,
    sourceId: "placeholder",
    eventId: "placeholder",
    externalJobId: "placeholder",
    version: 1,
    operation: "archive",
  });
  if (!tenantCheck.ok) {
    const errors = tenantCheck.errors.filter((e) => e.startsWith("tenantId"));
    res.status(400).json({ error: "invalid_query", details: errors });
    return;
  }

  // --- Validate optional sourceId ---
  let sourceId: string | undefined;
  if (sourceRaw !== undefined) {
    const sourceCheck = validateEvent({
      tenantId: tenantCheck.event.tenantId,
      sourceId: sourceRaw as string,
      eventId: "placeholder",
      externalJobId: "placeholder",
      version: 1,
      operation: "archive",
    });
    if (!sourceCheck.ok) {
      const errors = sourceCheck.errors.filter((e) => e.startsWith("sourceId"));
      res.status(400).json({ error: "invalid_query", details: errors });
      return;
    }
    sourceId = sourceCheck.event.sourceId;
  }

  // --- Validate status ---
  const status = (statusRaw as string | undefined) ?? "active";
  if (status !== "active" && status !== "archived" && status !== "all") {
    res.status(400).json({
      error: "invalid_query",
      details: ["status must be active, archived, or all"],
    });
    return;
  }

  // --- Validate limit ---
  let limit = config.defaultPageSize;
  if (limitRaw !== undefined) {
    const limitStr = limitRaw as string;
    if (!/^[0-9]+$/.test(limitStr)) {
      res.status(400).json({
        error: "invalid_query",
        details: ["limit must be a positive integer"],
      });
      return;
    }
    limit = Number(limitStr);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > config.maxPageSize
    ) {
      res.status(400).json({
        error: "invalid_query",
        details: [`limit must be from 1 to ${config.maxPageSize}`],
      });
      return;
    }
  }

  // --- List jobs via service ---
  const result = await listJobs(db, {
    tenantId: tenantCheck.event.tenantId,
    sourceId,
    status,
    limit,
    cursor: cursorRaw as string | undefined,
  });

  if (result.cursorMismatch) {
    res.status(400).json({
      error: "invalid_query",
      details: ["cursor does not match this query"],
    });
    return;
  }

  res.status(200).json({
    jobs: result.jobs.map(publicJob),
    nextCursor: result.nextCursor,
  });
}
