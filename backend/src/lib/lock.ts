import { randomUUID } from 'node:crypto';
import { redis } from '../infra/redis';
import { logger } from '../infra/logger';

/**
 * Release only if we still own the lock. A plain DEL could delete a lock that
 * expired and was re-acquired by someone else in the meantime.
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const result = await redis().set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? token : null;
}

export async function releaseLock(key: string, token: string): Promise<boolean> {
  const result = await redis().eval(RELEASE_SCRIPT, 1, key, token);
  return result === 1;
}

export interface LockOptions {
  ttlMs: number;
  /** How long to keep retrying before giving up. 0 = try once. */
  waitMs?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding a Redis lock (SET NX PX + token-checked release).
 *
 * The lock serialises work on one key across all API instances. It is the
 * first line of defence only: if it expires mid-operation (GC pause, slow DB)
 * the conditional MongoDB updates and unique index still prevent corruption.
 */
export async function withLock<T>(
  key: string,
  opts: LockOptions,
  fn: () => Promise<T>,
  onBusy: () => Error,
): Promise<T> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const baseDelay = opts.retryDelayMs ?? 20;

  let token = await acquireLock(key, opts.ttlMs);
  while (!token && Date.now() < deadline) {
    await sleep(baseDelay + Math.floor(Math.random() * baseDelay));
    token = await acquireLock(key, opts.ttlMs);
  }
  if (!token) throw onBusy();

  try {
    return await fn();
  } finally {
    await releaseLock(key, token).catch((err) => logger.warn({ err, key }, 'Failed to release lock'));
  }
}
