import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { redis } from '../infra/redis';
import { logger } from '../infra/logger';
import { Errors } from '../lib/errors';

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
const PROCESSING_TTL_SEC = 60;
const COMPLETED_TTL_SEC = 24 * 60 * 60;

interface StoredRecord {
  state: 'processing' | 'completed';
  fingerprint: string;
  status?: number;
  body?: unknown;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Idempotency-Key support (same contract as Stripe's API):
 *
 *  - First request with a key claims it atomically (SET NX) in "processing".
 *  - A concurrent duplicate while processing gets 409 IDEMPOTENCY_IN_PROGRESS.
 *  - A retry after success replays the stored status + body (header
 *    `Idempotent-Replayed: true`) without running the handler again.
 *  - Reusing a key with a different method/path/body gets 422.
 *  - Non-2xx results release the key so the client may retry with it.
 *
 * Keys are scoped per user so two users cannot collide or read each other's replays.
 */
export function idempotency({ required = false }: { required?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');
    if (!key) {
      return required ? next(Errors.badRequest('Idempotency-Key header is required for this operation')) : next();
    }
    if (!KEY_PATTERN.test(key)) {
      return next(Errors.badRequest('Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-:.]'));
    }

    const redisKey = `idem:${req.user?.id ?? 'anon'}:${key}`;
    const fingerprint = createHash('sha256')
      .update(`${req.method} ${req.baseUrl}${req.path} ${stableStringify(req.body ?? {})}`)
      .digest('hex');

    try {
      const claimed = await redis().set(
        redisKey,
        JSON.stringify({ state: 'processing', fingerprint } satisfies StoredRecord),
        'EX',
        PROCESSING_TTL_SEC,
        'NX',
      );

      if (claimed !== 'OK') {
        const raw = await redis().get(redisKey);
        if (!raw) {
          throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is being processed');
        }
        const existing = JSON.parse(raw) as StoredRecord;
        if (existing.fingerprint !== fingerprint) {
          throw Errors.unprocessable(
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used with a different request payload',
          );
        }
        if (existing.state === 'processing') {
          res.setHeader('Retry-After', '1');
          throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is being processed');
        }
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(existing.status ?? 200).json(existing.body);
      }
    } catch (err) {
      return next(err);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const write =
        status >= 200 && status < 300
          ? redis().set(
              redisKey,
              JSON.stringify({ state: 'completed', fingerprint, status, body } satisfies StoredRecord),
              'EX',
              COMPLETED_TTL_SEC,
            )
          : redis().del(redisKey);
      write.catch((err: unknown) => logger.error({ err, redisKey }, 'Failed to persist idempotency record'));
      return originalJson(body);
    };
    next();
  };
}
