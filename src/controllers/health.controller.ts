import type { Request, Response } from "express";
import type { Db } from "mongodb";

/**
 * GET /health
 * Returns 200 {"status":"ok"} when MongoDB responds to a ping.
 * Returns 503 {"status":"degraded"} when MongoDB is unreachable.
 */
export async function getHealth(
  db: Db,
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    await db.command({ ping: 1 });
    res.status(200).json({ status: "ok", dependencies: { mongo: "up" } });
  } catch {
    res
      .status(503)
      .json({ status: "degraded", dependencies: { mongo: "down" } });
  }
}
