import type { NextFunction, Request, Response } from 'express';
import { Errors } from '../lib/errors';
import type { Role } from '../models/common';
import { verifyToken, type AuthUser } from '../services/auth.service';
import type { Actor } from '../services/dispatch.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

/**
 * Permission matrix. Routes ask for a permission, never a role, so changing
 * who may do what is a one-line edit here.
 */
export const PERMISSIONS = {
  'request:create': ['admin', 'dispatcher'],
  'request:read': ['admin', 'dispatcher', 'agent'],
  'request:list': ['admin', 'dispatcher'],
  'request:update': ['admin', 'dispatcher'],
  'request:assign': ['admin', 'dispatcher'],
  'request:cancel': ['admin', 'dispatcher'],
  'assignment:respond': ['agent'],
  'agent:list': ['admin', 'dispatcher'],
  'agent:manage': ['admin'],
  'agent:self': ['agent'],
  'config:read': ['admin', 'dispatcher'],
  'config:update': ['admin'],
  'audit:read': ['admin', 'dispatcher'],
  'dashboard:read': ['admin', 'dispatcher'],
  'user:manage': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next(Errors.unauthorized());
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch (err) {
    next(err);
  }
}

export function authorize(permission: Permission) {
  const allowed: readonly Role[] = PERMISSIONS[permission];
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Errors.unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(Errors.forbidden(`Role "${req.user.role}" is not allowed to ${permission.replace(':', ' ')}`));
    }
    if (req.user.role === 'agent' && !req.user.agentId) {
      return next(Errors.forbidden('Agent account has no agent profile'));
    }
    next();
  };
}

export function actorOf(req: Request): Actor & { id: string } {
  const u = req.user!;
  return { id: u.id, role: u.role, name: u.name, agentId: u.agentId };
}
