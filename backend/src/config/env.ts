import 'dotenv/config';
import { z } from 'zod';

const DEV_SECRET = 'dev-only-secret-change-me-0123456789';

const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  MONGO_URI: z.string().default('memory'),
  REDIS_URL: z.string().default('memory'),
  JWT_SECRET: z.string().min(16).default(DEV_SECRET),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  HEARTBEAT_TTL_MS: z.coerce.number().int().positive().default(20_000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  LOCK_TTL_MS: z.coerce.number().int().positive().default(10_000),
  SEED_ON_START: bool('true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET === DEV_SECRET) {
  throw new Error('JWT_SECRET must be set explicitly in production');
}

export const env = parsed.data;
export type Env = typeof env;
