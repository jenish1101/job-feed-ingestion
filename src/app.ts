import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Db } from "mongodb";
import type { AppConfig } from "./config.js";
import { healthRouter } from "./routes/health.routes.js";
import { eventRouter } from "./routes/event.routes.js";
import { jobRouter } from "./routes/job.routes.js";

export interface AppDeps {
  db: Db;
  config: AppConfig;
}

/**
 * Creates and returns the Express application.
 * Routes are split into health / events / jobs.
 */
export function createApp({ db, config }: AppDeps): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // Mount routers
  app.use("/health", healthRouter(db));
  app.use("/events", eventRouter(db));
  app.use("/jobs", jobRouter(db, config));

  // Global error handler — catches any error thrown by a route
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof SyntaxError && "body" in error) {
        res.status(400).json({ error: "invalid_json" });
        return;
      }
      console.error(error);
      res.status(500).json({ error: "internal_error" });
    },
  );

  return app;
}
