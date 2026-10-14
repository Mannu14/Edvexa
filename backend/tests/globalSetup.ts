import { MongoMemoryServer } from 'mongodb-memory-server';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** One mongod for the whole run; every test file uses its own database on it. */
export default async function setup({ provide }: GlobalSetupContext) {
  const server = await MongoMemoryServer.create();
  provide('mongoUri', server.getUri());
  return async () => {
    await server.stop();
  };
}
