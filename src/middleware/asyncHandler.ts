import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Forwards rejected promises from async route handlers to the error middleware (Express 4). */
export const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
