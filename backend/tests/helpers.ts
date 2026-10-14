import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app';
import { connectMongo } from '../src/infra/mongo';
import { connectRedis, disconnectRedis, redis } from '../src/infra/redis';
import { toGeoPoint } from '../src/lib/geo';
import { Agent } from '../src/models/Agent';
import { CATEGORIES, type Category, type Priority } from '../src/models/common';
import { nextSequence } from '../src/models/Counter';
import { ServiceRequest } from '../src/models/ServiceRequest';
import { User } from '../src/models/User';
import { SYSTEM_ACTOR } from '../src/services/audit.service';
import { signToken, toAuthUser } from '../src/services/auth.service';
import { updateDispatchConfig, type DispatchConfigPatch } from '../src/services/config.service';
import { HEARTBEAT_KEY } from '../src/services/presence.service';

export const CENTER = { lat: 12.9716, lng: 77.5946 };
/** Point roughly `km` kilometres north of the centre. */
export const north = (km: number) => ({ lat: CENTER.lat + km / 111.2, lng: CENTER.lng });

export const app = createApp();
export const api = () => request(app);
export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
export const idemKey = () => `test-${randomUUID()}`;

/** Fresh database per test file, wiped before every test. */
export function useTestEnv() {
  beforeAll(async () => {
    await connectMongo(inject('mongoUri'), `test_${randomUUID().slice(0, 8)}`);
    await connectRedis('memory');
  });

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
    await redis().flushall();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await disconnectRedis();
  });
}

let counter = 0;
const uniqueEmail = (prefix: string) => `${prefix}-${++counter}-${Date.now()}@test.local`;

export async function createStaff(role: 'admin' | 'dispatcher' = 'dispatcher') {
  const user = await User.create({ name: `${role} ${counter}`, email: uniqueEmail(role), passwordHash: 'unused', role });
  return { user, token: signToken(toAuthUser(user)) };
}

export async function createAgent(
  opts: {
    name?: string;
    location?: { lat: number; lng: number };
    skills?: Category[];
    maxConcurrent?: number;
    online?: boolean;
  } = {},
) {
  const name = opts.name ?? `Agent ${++counter}`;
  const user = await User.create({ name, email: uniqueEmail('agent'), passwordHash: 'unused', role: 'agent' });
  const online = opts.online ?? true;
  const now = new Date();
  const agent = await Agent.create({
    user: user._id,
    name,
    skills: opts.skills ?? [...CATEGORIES],
    location: toGeoPoint(opts.location ?? CENTER),
    maxConcurrent: opts.maxConcurrent ?? 1,
    status: online ? 'online' : 'offline',
    lastOnlineAt: online ? now : null,
    lastSeenAt: online ? now : null,
  });
  user.agent = agent._id;
  await user.save();
  if (online) await redis().zadd(HEARTBEAT_KEY, Date.now(), String(agent._id));
  return { user, agent, agentId: String(agent._id), token: signToken(toAuthUser(user)) };
}

export async function createPendingRequest(
  createdBy: mongoose.Types.ObjectId,
  opts: { location?: { lat: number; lng: number }; category?: Category; priority?: Priority; title?: string } = {},
) {
  return ServiceRequest.create({
    code: `REQ-${await nextSequence('request')}`,
    title: opts.title ?? 'Test request',
    category: opts.category ?? 'delivery',
    priority: opts.priority ?? 'normal',
    location: toGeoPoint(opts.location ?? CENTER),
    createdBy,
  });
}

export function setConfig(patch: DispatchConfigPatch) {
  return updateDispatchConfig(patch, SYSTEM_ACTOR);
}

export function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Leaking kitchen tap',
    category: 'repair',
    priority: 'normal',
    location: CENTER,
    address: 'MG Road',
    ...overrides,
  };
}
