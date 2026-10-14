import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

let client: Redis | null = null;

/**
 * Connects to Redis. `memory` swaps in ioredis-mock so the project runs and
 * tests without a Redis server. The mock implements SET NX PX, sorted sets and
 * Lua EVAL, which is everything the lock / presence / idempotency code uses.
 * It is single-process only, so multi-instance deployments need real Redis.
 */
export async function connectRedis(url: string = env.REDIS_URL): Promise<Redis> {
  if (client) return client;

  if (url === 'memory') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RedisMock = require('ioredis-mock');
    client = new RedisMock() as Redis;
    logger.warn('Using in-memory Redis mock (REDIS_URL=memory). Do not use in production.');
  } else {
    client = new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true });
    client.on('error', (err) => logger.error({ err }, 'Redis error'));
    await new Promise<void>((resolve, reject) => {
      client!.once('ready', () => resolve());
      client!.once('error', reject);
    });
    logger.info('Connected to Redis');
  }
  return client;
}

export function redis(): Redis {
  if (!client) throw new Error('Redis not connected. Call connectRedis() first.');
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => undefined);
  client = null;
}
