import { Router } from "express";
import type { Db } from "mongodb";
import { postEvent, getEvent } from "../controllers/event.controller.js";
import { asyncRoute } from "../utils/asyncRoute.js";

export function eventRouter(db: Db): Router {
  const router = Router();

  // POST /events — accept a new job event
  router.post(
    "/",
    asyncRoute((req, res) => postEvent(db, req, res)),
  );

  // GET /events/:eventId — get status of a stored event
  router.get(
    "/:eventId",
    asyncRoute((req, res) => getEvent(db, req, res)),
  );

  return router;
}
