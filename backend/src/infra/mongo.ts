import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { env } from '../config/env';
import { logger } from './logger';
import { registerModels } from '../models';

let memoryServer: MongoMemoryServer | null = null;

/**
 * Connects to MongoDB. `memory` boots an in-process mongod for zero-setup demos.
 * Indexes are synced on startup because the partial unique index on
 * assignments is a correctness guarantee, not just a performance hint.
 */
export async function connectMongo(uri: string = env.MONGO_URI, dbName?: string): Promise<void> {
  let target = uri;
  if (uri === 'memory') {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    target = memoryServer.getUri();
    logger.warn('Using in-memory MongoDB (MONGO_URI=memory). Data is lost on restart.');
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(target, { dbName: dbName ?? (uri === 'memory' ? 'edvexa_dispatch' : undefined) });
  await syncIndexes();
  logger.info({ db: mongoose.connection.name }, 'Connected to MongoDB');
}

export async function syncIndexes(): Promise<void> {
  const models = registerModels();
  await Promise.all(models.map((m) => m.syncIndexes()));
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
