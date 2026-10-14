/**
 * Seeds demo users into a persistent MongoDB (MONGO_URI must not be "memory").
 * With MONGO_URI=memory the API seeds itself on start, so this is not needed.
 */
import { env } from '../config/env';
import { logger } from '../infra/logger';
import { connectMongo, disconnectMongo } from '../infra/mongo';
import { seedIfEmpty } from './seedData';

async function main() {
  if (env.MONGO_URI === 'memory') {
    logger.warn('MONGO_URI=memory: the API seeds automatically on start. Nothing to do.');
    return;
  }
  await connectMongo();
  const seeded = await seedIfEmpty();
  if (!seeded) logger.info('Database already has users; skipping seed.');
  await disconnectMongo();
}

main().catch((err) => {
  logger.error({ err }, 'Seed failed');
  process.exit(1);
});
