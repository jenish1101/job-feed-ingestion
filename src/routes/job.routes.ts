import { Router } from "express";
import type { Db } from "mongodb";
import type { AppConfig } from "../config.js";
import { getJobs } from "../controllers/job.controller.js";
import { asyncRoute } from "../utils/asyncRoute.js";

export function jobRouter(db: Db, config: AppConfig): Router {
  const router = Router();

  // GET /jobs — list jobs with pagination
  router.get(
    "/",
    asyncRoute((req, res) => getJobs(db, config, req, res)),
  );

  return router;
}
