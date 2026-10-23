import { Router } from "express";
import type { Db } from "mongodb";
import { getHealth } from "../controllers/health.controller.js";
import { asyncRoute } from "../utils/asyncRoute.js";

export function healthRouter(db: Db): Router {
  const router = Router();

  // GET /health
  router.get(
    "/",
    asyncRoute((req, res) => getHealth(db, req, res)),
  );

  return router;
}
