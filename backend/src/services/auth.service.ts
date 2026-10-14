import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError, Errors, isDuplicateKeyError } from '../lib/errors';
import { toGeoPoint, type LatLng } from '../lib/geo';
import { Agent } from '../models/Agent';
import type { ActorRef, Category, Role } from '../models/common';
import { User, type UserDoc } from '../models/User';
import { audit } from './audit.service';

const DUMMY_HASH = bcrypt.hashSync('timing-safe-placeholder', 10);

export interface TokenPayload {
  sub: string;
  role: Role;
  name: string;
  agentId: string | null;
}

export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  agentId: string | null;
}

export function signToken(user: AuthUser): string {
  const payload: TokenPayload = { sub: user.id, role: user.role, name: user.name, agentId: user.agentId };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] });
}

export function verifyToken(token: string): AuthUser {
  try {
    const p = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    return { id: p.sub, role: p.role, name: p.name, agentId: p.agentId ?? null };
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Token is invalid or expired');
  }
}

export function toAuthUser(user: UserDoc): AuthUser {
  return { id: String(user._id), role: user.role, name: user.name, agentId: user.agent ? String(user.agent) : null };
}

export async function login(email: string, password: string) {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  // Compare even when the user is missing so response time does not reveal valid emails.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.active) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  const authUser = toAuthUser(user);
  return { token: signToken(authUser), user: { ...user.toJSON(), agentId: authUser.agentId } };
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role: Role;
  agent?: { skills: Category[]; location: LatLng; maxConcurrent?: number };
}

/**
 * Creates a user and, for agents, the linked agent profile. MongoDB
 * transactions need a replica set, so we use a compensating delete instead.
 */
export async function createUser(input: CreateUserInput, actor: ActorRef) {
  if (input.role === 'agent' && !input.agent) {
    throw Errors.badRequest('Agent users require an agent profile (skills, location)');
  }

  let user: UserDoc;
  try {
    user = await User.create({
      name: input.name,
      email: input.email,
      passwordHash: await bcrypt.hash(input.password, 10),
      role: input.role,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw Errors.conflict('EMAIL_TAKEN', 'A user with this email already exists');
    throw err;
  }

  if (input.role === 'agent' && input.agent) {
    try {
      const agent = await Agent.create({
        user: user._id,
        name: input.name,
        skills: input.agent.skills,
        location: toGeoPoint(input.agent.location),
        maxConcurrent: input.agent.maxConcurrent ?? 1,
      });
      user.agent = agent._id;
      await user.save();
    } catch (err) {
      await User.deleteOne({ _id: user._id });
      throw err;
    }
  }

  await audit({
    action: 'user.created',
    entityType: 'user',
    entityId: user._id,
    actor,
    meta: { email: user.email, role: user.role },
  });
  return user;
}
