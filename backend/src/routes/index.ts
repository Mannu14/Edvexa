import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { redis } from '../infra/redis';
import { asyncHandler } from '../lib/asyncHandler';
import { Errors } from '../lib/errors';
import { actorOf, authenticate, authorize } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { validate } from '../middleware/validate';
import { Agent } from '../models/Agent';
import { Assignment } from '../models/Assignment';
import { AuditLog } from '../models/AuditLog';
import { REQUEST_STATUSES } from '../models/common';
import { ServiceRequest } from '../models/ServiceRequest';
import { User } from '../models/User';
import { getAgent, listAgentAssignments, listAgents, updateAgent } from '../services/agent.service';
import { createUser, login, toAuthUser } from '../services/auth.service';
import { getDispatchConfig, updateDispatchConfig } from '../services/config.service';
import {
  assignManually,
  cancelRequest,
  dispatchRequest,
  previewCandidates,
  progressAssignment,
  reassignRequest,
  rejectAssignment,
} from '../services/dispatch.service';
import { goOffline, heartbeat } from '../services/presence.service';
import { createRequest, getRequestDetail, listRequests, summarizeOutcome, updateRequest } from '../services/request.service';
import * as S from './schemas';

export function buildRouter(): Router {
  const api = Router();

  /* ------------------------------- Health -------------------------------- */

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  api.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const mongoOk = mongoose.connection.readyState === 1;
      const redisOk = (await redis().ping().catch(() => null)) === 'PONG';
      res.status(mongoOk && redisOk ? 200 : 503).json({ mongo: mongoOk, redis: redisOk });
    }),
  );

  /* -------------------------------- Auth --------------------------------- */

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts, try again in a minute' } },
  });

  api.post(
    '/auth/login',
    loginLimiter,
    validate({ body: S.loginBody }),
    asyncHandler(async (req, res) => {
      res.json(await login(req.body.email, req.body.password));
    }),
  );

  api.use(authenticate);

  api.get(
    '/auth/me',
    asyncHandler(async (req, res) => {
      const user = await User.findById(req.user!.id);
      if (!user || !user.active) throw Errors.unauthorized('User no longer exists');
      res.json({ user: { ...user.toJSON(), agentId: toAuthUser(user).agentId } });
    }),
  );

  /* -------------------------------- Users -------------------------------- */

  api.get(
    '/users',
    authorize('user:manage'),
    asyncHandler(async (_req, res) => {
      const users = await User.find().sort({ role: 1, name: 1 });
      res.json({ data: users.map((u) => u.toJSON()) });
    }),
  );

  api.post(
    '/users',
    authorize('user:manage'),
    idempotency(),
    validate({ body: S.createUserBody }),
    asyncHandler(async (req, res) => {
      const user = await createUser(req.body, actorOf(req));
      res.status(201).json({ user: user.toJSON() });
    }),
  );

  /* ------------------------- Agents (self-service) ------------------------ */

  api.get(
    '/agents/me',
    authorize('agent:self'),
    asyncHandler(async (req, res) => {
      res.json({ agent: (await getAgent(req.user!.agentId!)).toJSON() });
    }),
  );

  api.post(
    '/agents/me/status',
    authorize('agent:self'),
    validate({ body: S.agentStatusBody }),
    asyncHandler(async (req, res) => {
      const agentId = req.user!.agentId!;
      if (req.body.status === 'online') await heartbeat(agentId, req.body.location, actorOf(req));
      else await goOffline(agentId, actorOf(req));
      res.json({ agent: (await getAgent(agentId)).toJSON() });
    }),
  );

  api.post(
    '/agents/me/heartbeat',
    authorize('agent:self'),
    validate({ body: S.heartbeatBody }),
    asyncHandler(async (req, res) => {
      res.json(await heartbeat(req.user!.agentId!, req.body.location, actorOf(req)));
    }),
  );

  api.get(
    '/agents/me/assignments',
    authorize('agent:self'),
    asyncHandler(async (req, res) => {
      const activeOnly = req.query.active !== 'false';
      res.json({ data: await listAgentAssignments(req.user!.agentId!, activeOnly) });
    }),
  );

  /* ------------------------- Agents (management) ------------------------- */

  api.get(
    '/agents',
    authorize('agent:list'),
    validate({ query: S.listAgentsQuery }),
    asyncHandler(async (req, res) => {
      res.json({ data: await listAgents(req.query as never) });
    }),
  );

  api.get(
    '/agents/:id',
    authorize('agent:list'),
    validate({ params: S.idParams }),
    asyncHandler(async (req, res) => {
      res.json({ agent: (await getAgent(req.params.id)).toJSON() });
    }),
  );

  api.patch(
    '/agents/:id',
    authorize('agent:manage'),
    validate({ params: S.idParams, body: S.updateAgentBody }),
    asyncHandler(async (req, res) => {
      res.json({ agent: (await updateAgent(req.params.id, req.body, actorOf(req))).toJSON() });
    }),
  );

  /* ------------------------------ Requests ------------------------------- */

  api.post(
    '/requests',
    authorize('request:create'),
    idempotency({ required: true }),
    validate({ body: S.createRequestBody }),
    asyncHandler(async (req, res) => {
      const { request, dispatch } = await createRequest(req.body, actorOf(req));
      res.status(201).json({ request: request.toJSON(), dispatch });
    }),
  );

  api.get(
    '/requests',
    authorize('request:list'),
    validate({ query: S.listRequestsQuery }),
    asyncHandler(async (req, res) => {
      res.json(await listRequests(req.query as never));
    }),
  );

  api.get(
    '/requests/:id',
    authorize('request:read'),
    validate({ params: S.idParams }),
    asyncHandler(async (req, res) => {
      res.json(await getRequestDetail(req.params.id, actorOf(req)));
    }),
  );

  api.patch(
    '/requests/:id',
    authorize('request:update'),
    validate({ params: S.idParams, body: S.updateRequestBody }),
    asyncHandler(async (req, res) => {
      res.json({ request: (await updateRequest(req.params.id, req.body, actorOf(req))).toJSON() });
    }),
  );

  api.get(
    '/requests/:id/candidates',
    authorize('request:assign'),
    validate({ params: S.idParams }),
    asyncHandler(async (req, res) => {
      res.json(await previewCandidates(req.params.id));
    }),
  );

  api.post(
    '/requests/:id/dispatch',
    authorize('request:assign'),
    idempotency(),
    validate({ params: S.idParams }),
    asyncHandler(async (req, res) => {
      const result = await dispatchRequest(req.params.id, actorOf(req));
      res.json({ request: result.request.toJSON(), dispatch: summarizeOutcome(result) });
    }),
  );

  api.post(
    '/requests/:id/assign',
    authorize('request:assign'),
    idempotency({ required: true }),
    validate({ params: S.idParams, body: S.assignBody }),
    asyncHandler(async (req, res) => {
      const { request, assignment } = await assignManually(req.params.id, req.body.agentId, actorOf(req));
      res.status(201).json({ request: request.toJSON(), assignment: assignment.toJSON() });
    }),
  );

  api.post(
    '/requests/:id/reassign',
    authorize('request:assign'),
    idempotency({ required: true }),
    validate({ params: S.idParams, body: S.reassignBody }),
    asyncHandler(async (req, res) => {
      const result = await reassignRequest(req.params.id, actorOf(req), req.body);
      res.json({ request: result.request.toJSON(), dispatch: summarizeOutcome(result) });
    }),
  );

  api.post(
    '/requests/:id/cancel',
    authorize('request:cancel'),
    idempotency(),
    validate({ params: S.idParams, body: S.cancelBody }),
    asyncHandler(async (req, res) => {
      const result = await cancelRequest(req.params.id, actorOf(req), req.body.reason);
      res.json({
        request: result.request.toJSON(),
        assignment: result.assignment?.toJSON() ?? null,
        replayed: result.replayed,
      });
    }),
  );

  /* ----------------------------- Assignments ----------------------------- */

  for (const step of ['accept', 'start', 'complete'] as const) {
    api.post(
      `/assignments/:id/${step}`,
      authorize('assignment:respond'),
      validate({ params: S.idParams }),
      asyncHandler(async (req, res) => {
        const result = await progressAssignment(req.params.id, actorOf(req), step);
        res.json({
          assignment: result.assignment.toJSON(),
          request: result.request?.toJSON() ?? null,
          replayed: Boolean(result.replayed),
        });
      }),
    );
  }

  api.post(
    '/assignments/:id/reject',
    authorize('assignment:respond'),
    validate({ params: S.idParams, body: S.rejectBody }),
    asyncHandler(async (req, res) => {
      const result = await rejectAssignment(req.params.id, actorOf(req), req.body.reason);
      res.json({
        assignment: result.assignment.toJSON(),
        request: result.request?.toJSON() ?? null,
        redispatch: result.redispatch ? summarizeOutcome(result.redispatch) : null,
        replayed: Boolean(result.replayed),
      });
    }),
  );

  /* -------------------------------- Config ------------------------------- */

  api.get(
    '/config/dispatch',
    authorize('config:read'),
    asyncHandler(async (_req, res) => {
      res.json({ config: (await getDispatchConfig()).toJSON() });
    }),
  );

  api.put(
    '/config/dispatch',
    authorize('config:update'),
    validate({ body: S.updateConfigBody }),
    asyncHandler(async (req, res) => {
      res.json({ config: (await updateDispatchConfig(req.body, actorOf(req))).toJSON() });
    }),
  );

  /* -------------------------------- Audit -------------------------------- */

  api.get(
    '/audit',
    authorize('audit:read'),
    validate({ query: S.auditQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as { requestId?: string; entityId?: string; action?: string; page: number; limit: number };
      const filter: Record<string, unknown> = {};
      if (q.requestId) filter.request = q.requestId;
      if (q.entityId) filter.entityId = q.entityId;
      if (q.action) filter.action = q.action;
      const [data, total] = await Promise.all([
        AuditLog.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((q.page - 1) * q.limit)
          .limit(q.limit),
        AuditLog.countDocuments(filter),
      ]);
      res.json({ data: data.map((d) => d.toJSON()), page: q.page, limit: q.limit, total });
    }),
  );

  /* ------------------------------ Dashboard ------------------------------ */

  api.get(
    '/dashboard/summary',
    authorize('dashboard:read'),
    asyncHandler(async (_req, res) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [byStatus, agentsTotal, online, available, outcomes] = await Promise.all([
        ServiceRequest.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Agent.countDocuments(),
        Agent.countDocuments({ status: 'online' }),
        Agent.countDocuments({ status: 'online', $expr: { $lt: ['$activeCount', '$maxConcurrent'] } }),
        Assignment.aggregate<{ _id: string; count: number }>([
          { $match: { offeredAt: { $gte: since } } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
      ]);

      const requests = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<string, number>;
      for (const row of byStatus) requests[row._id] = row.count;
      const outcome = Object.fromEntries(outcomes.map((o) => [o._id, o.count])) as Record<string, number>;
      const accepted = (outcome.accepted ?? 0) + (outcome.in_progress ?? 0) + (outcome.completed ?? 0);
      const declined = (outcome.rejected ?? 0) + (outcome.expired ?? 0);

      res.json({
        requests,
        agents: { total: agentsTotal, online, available, busy: online - available, offline: agentsTotal - online },
        last24h: {
          offers: outcomes.reduce((n, o) => n + o.count, 0),
          accepted,
          rejected: outcome.rejected ?? 0,
          expired: outcome.expired ?? 0,
          acceptanceRate: accepted + declined > 0 ? Math.round((accepted / (accepted + declined)) * 1000) / 10 : null,
        },
      });
    }),
  );

  return api;
}
