import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { startSweeper } from './jobs/sweeper';
import { logger } from './infra/logger';
import { connectMongo, disconnectMongo } from './infra/mongo';
import { connectRedis, disconnectRedis } from './infra/redis';
import { closeSocketServer, createSocketServer } from './realtime/socket';
import { seedIfEmpty } from './scripts/seedData';

async function main() {
  await connectMongo();
  await connectRedis();
  if (env.SEED_ON_START) await seedIfEmpty();

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  const stopSweeper = startSweeper();

  server.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (docs: http://localhost:${env.PORT}/docs)`);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopSweeper();
    await closeSocketServer(io);
    server.close();
    await Promise.allSettled([disconnectRedis(), disconnectMongo()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
