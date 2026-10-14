import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { logger } from '../infra/logger';
import { AppError, isDuplicateKeyError } from '../lib/errors';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

/** Every error leaves the API in one shape: { error: { code, message, details?, requestId } }. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details: unknown;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid value for ${err.path}`;
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Document validation failed';
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  } else if (isDuplicateKeyError(err)) {
    status = 409;
    code = 'DUPLICATE';
    message = 'Resource already exists';
  } else if (err instanceof SyntaxError && 'body' in err) {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Malformed JSON body';
  }

  if (status >= 500) logger.error({ err, requestId: req.requestId }, 'Unhandled error');

  res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId: req.requestId } });
}
