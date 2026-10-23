import type { NextFunction, Request, Response } from "express";

/**
 * Wraps an async route handler so Express can catch any thrown errors
 * and pass them to the next() error middleware.
 */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}
