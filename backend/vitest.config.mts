import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    // Each file gets its own database; run files serially to keep the
    // single in-memory mongod predictable on CI machines.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      SEED_ON_START: 'false',
      HEARTBEAT_TTL_MS: '20000',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**', 'src/docs/**', 'src/server.ts'],
    },
  },
});
