import { z } from 'zod';
import { CATEGORIES, PRIORITIES, REQUEST_STATUSES, ROLES } from '../models/common';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
export const idParams = z.object({ id: objectId });

export const latLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createUserBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().email(),
    password: z.string().min(8).max(128),
    role: z.enum(ROLES),
    agent: z
      .object({
        skills: z.array(z.enum(CATEGORIES)).min(1),
        location: latLng,
        maxConcurrent: z.number().int().min(1).max(10).optional(),
      })
      .optional(),
  })
  .strict();

export const createRequestBody = z
  .object({
    title: z.string().trim().min(3).max(140),
    description: z.string().max(2000).optional(),
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES).default('normal'),
    location: latLng,
    address: z.string().max(300).optional(),
  })
  .strict();

export const updateRequestBody = z
  .object({
    title: z.string().trim().min(3).max(140).optional(),
    description: z.string().max(2000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    address: z.string().max(300).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const csvList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const listRequestsQuery = z.object({
  status: csvList(REQUEST_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  agentId: objectId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const assignBody = z.object({ agentId: objectId }).strict();
export const reassignBody = z
  .object({ agentId: objectId.optional(), reason: z.string().max(300).optional() })
  .strict();
export const cancelBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export const rejectBody = z.object({ reason: z.string().max(300).optional() }).strict();

export const agentStatusBody = z
  .object({ status: z.enum(['online', 'offline']), location: latLng.optional() })
  .strict();
export const heartbeatBody = z.object({ location: latLng.optional() }).strict();

export const listAgentsQuery = z.object({
  status: z.enum(['online', 'offline']).optional(),
  available: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  skill: z.enum(CATEGORIES).optional(),
});

export const updateAgentBody = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    skills: z.array(z.enum(CATEGORIES)).min(1).optional(),
    maxConcurrent: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const priorityRule = z.object({
  radiusMultiplier: z.number().min(0.1).max(10).optional(),
  offerTimeoutSec: z.number().int().min(5).max(3600).optional(),
});

export const updateConfigBody = z
  .object({
    autoDispatch: z.boolean().optional(),
    maxRadiusKm: z.number().min(0.1).max(500).optional(),
    candidateLimit: z.number().int().min(1).max(50).optional(),
    maxAttempts: z.number().int().min(1).max(50).optional(),
    maxPendingSec: z.number().int().min(10).max(86_400).optional(),
    weights: z
      .object({
        distance: z.number().min(0).max(1).optional(),
        workload: z.number().min(0).max(1).optional(),
        fairness: z.number().min(0).max(1).optional(),
      })
      .optional(),
    priorityRules: z
      .object({
        low: priorityRule.optional(),
        normal: priorityRule.optional(),
        high: priorityRule.optional(),
        critical: priorityRule.optional(),
      })
      .optional(),
  })
  .strict();

export const auditQuery = z.object({
  requestId: objectId.optional(),
  entityId: objectId.optional(),
  action: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
