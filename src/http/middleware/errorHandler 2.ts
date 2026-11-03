import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../../logger.ts';
import { ApiError } from '../errors.ts';

/** Unknown routes. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(404, 'not_found', `No route for ${req.method} ${req.path}`));
}

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

/** Every error leaves as the same JSON envelope; internals are logged, never sent. */
export function createErrorHandler(log: Logger) {
  // Express recognises error handlers by their four parameters.
  return function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
    let apiError: ApiError;
    if (err instanceof ApiError) {
      apiError = err;
    } else if ((err as BodyParserError)?.type === 'entity.parse.failed') {
      apiError = new ApiError(400, 'invalid_json', 'The request body is not valid JSON');
    } else if ((err as BodyParserError)?.type === 'entity.too.large') {
      apiError = new ApiError(413, 'payload_too_large', 'The request body is too large');
    } else {
      (req.log ?? log).error({ err }, 'Unhandled error');
      apiError = new ApiError(500, 'internal', 'Internal error');
    }
    if (res.headersSent) return;
    res.status(apiError.status).json(apiError.toBody());
  };
}
