import { Types, type FilterQuery } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../infra/logger';
import { AppError, Errors, isDuplicateKeyError } from '../lib/errors';
import { haversineKm, fromGeoPoint } from '../lib/geo';
import { withLock } from '../lib/lock';
import { Agent } from '../models/Agent';
import { Assignment, type AssignmentDoc, type IAssignment } from '../models/Assignment';
import type { ActorRef, AssignmentStatus, RequestStatus } from '../models/common';
import type { DispatchConfigDoc } from '../models/DispatchConfig';
import { ServiceRequest, type ServiceRequestDoc } from '../models/ServiceRequest';
import {
  publishAgentById,
  publishAssignment,
  publishOffer,
  publishRequest,
} from '../realtime/publisher';
import { SYSTEM_ACTOR, audit } from './audit.service';
import { getDispatchConfig } from './config.service';
import { scoreCandidate, type ScoreBreakdown } from './scoring';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export interface Actor extends ActorRef {
  agentId?: string | null;
}

type Id = Types.ObjectId | string;

export interface Candidate {
  agentId: string;
  name: string;
  distanceKm: number;
  activeCount: number;
  maxConcurrent: number;
  score: ScoreBreakdown;
}

export type DispatchOutcome =
  | { outcome: 'offered'; request: ServiceRequestDoc; assignment: AssignmentDoc; candidates: number }
  | { outcome: 'waiting'; request: ServiceRequestDoc; candidates: number }
  | { outcome: 'failed'; request: ServiceRequestDoc; reason: string }
  | { outcome: 'skipped'; request: ServiceRequestDoc };

export interface TransitionResult {
  assignment: AssignmentDoc;
  request: ServiceRequestDoc | null;
  /** true when the call was a harmless repeat of an already-applied transition. */
  replayed?: boolean;
  redispatch?: DispatchOutcome | null;
}

/* -------------------------------------------------------------------------- */
/*                              Locking helpers                               */
/* -------------------------------------------------------------------------- */

const requestLockKey = (requestId: Id) => `lock:request:${String(requestId)}`;

export const REQUEST_LOCKED = 'REQUEST_LOCKED';

/**
 * Serialises every state change of one service request across all API
 * instances. waitMs > 0 lets short bursts queue up instead of failing fast.
 */
export function withRequestLock<T>(requestId: Id, fn: () => Promise<T>, waitMs = 3000): Promise<T> {
  return withLock(requestLockKey(requestId), { ttlMs: env.LOCK_TTL_MS, waitMs }, fn, () =>
    Errors.conflict(REQUEST_LOCKED, 'Another operation is in progress for this request. Retry shortly.'),
  );
}

const isLockBusy = (err: unknown) => err instanceof AppError && err.code === REQUEST_LOCKED;

/* -------------------------------------------------------------------------- */
/*                         Low-level atomic operations                        */
/* -------------------------------------------------------------------------- */

/**
 * Atomically reserves one unit of agent capacity. The filter is evaluated and
 * the counter incremented in a single document update, so two concurrent
 * offers can never push an agent above maxConcurrent.
 */
async function reserveAgentSlot(agentId: Id) {
  return Agent.findOneAndUpdate(
    { _id: agentId, status: 'online', $expr: { $lt: ['$activeCount', '$maxConcurrent'] } },
    { $inc: { activeCount: 1 }, $set: { lastAssignedAt: new Date() } },
    { new: true },
  );
}

async function releaseAgentSlot(agentId: Id, statKey?: keyof IAssignmentStats): Promise<void> {
  const statInc = statKey ? { [`stats.${statKey}`]: 1 } : {};
  const res = await Agent.updateOne(
    { _id: agentId, activeCount: { $gt: 0 } },
    { $inc: { activeCount: -1, ...statInc } },
  );
  if (res.modifiedCount === 0 && statKey) await Agent.updateOne({ _id: agentId }, { $inc: statInc });
}

type IAssignmentStats = { offered: number; accepted: number; rejected: number; expired: number; completed: number };

/**
 * Moves an ACTIVE assignment to a terminal status and frees the agent slot.
 * Conditional on `filter` + active=true, so concurrent callers (timeout sweeper
 * vs. agent reject vs. dispatcher cancel) cannot both "win".
 */
async function endAssignment(
  filter: FilterQuery<IAssignment>,
  to: AssignmentStatus,
  reason: string,
  statKey?: keyof IAssignmentStats,
): Promise<{ assignment: AssignmentDoc; previousStatus: AssignmentStatus } | null> {
  const ts = new Date();
  const $set: Partial<IAssignment> = { status: to, active: false, endedAt: ts, endReason: reason };
  if (to === 'completed') $set.completedAt = ts;

  const before = await Assignment.findOneAndUpdate({ ...filter, active: true }, { $set }, { returnDocument: 'before' });
  if (!before) return null;

  const previousStatus = before.status;
  before.set($set); // reflect the committed update locally; never saved
  await releaseAgentSlot(before.agent, statKey);
  return { assignment: before, previousStatus };
}

/** Puts a request back in the queue after its active assignment ended. */
async function returnToPending(requestId: Id, assignmentId: Id, agentId: Id) {
  return ServiceRequest.findOneAndUpdate(
    { _id: requestId, currentAssignment: assignmentId, status: { $in: ['offered', 'accepted'] } },
    {
      $set: {
        status: 'pending',
        currentAssignment: null,
        assignedAgent: null,
        assignedAgentName: null,
        offeredAt: null,
        acceptedAt: null,
      },
      $addToSet: { triedAgents: agentId },
    },
    { new: true },
  );
}

async function failRequest(request: ServiceRequestDoc, reason: string, actor: Actor): Promise<DispatchOutcome> {
  const failed = await ServiceRequest.findOneAndUpdate(
    { _id: request._id, status: 'pending' },
    { $set: { status: 'failed', failureReason: reason, failedAt: new Date() } },
    { new: true },
  );
  if (!failed) return { outcome: 'skipped', request };
  await audit({
    action: 'request.failed',
    entityType: 'request',
    entityId: failed._id,
    request: failed._id,
    actor,
    from: 'pending',
    to: 'failed',
    meta: { reason, attempts: failed.attempts },
  });
  publishRequest(failed);
  return { outcome: 'failed', request: failed, reason };
}

/* -------------------------------------------------------------------------- */
/*                             Candidate selection                            */
/* -------------------------------------------------------------------------- */

/**
 * Ranks eligible agents for a request:
 *  1. $geoNear over the 2dsphere index limited to the priority-adjusted radius
 *  2. hard filters: online, has the required skill, has spare capacity, not
 *     previously tried for this request (rejected / timed out / revoked)
 *  3. weighted score (distance, workload, fairness) from the dispatch config
 */
export async function findCandidates(request: ServiceRequestDoc, cfg: DispatchConfigDoc): Promise<Candidate[]> {
  const rule = cfg.priorityRules[request.priority];
  const radiusKm = cfg.maxRadiusKm * rule.radiusMultiplier;
  const exclude = request.triedAgents.map((id) => new Types.ObjectId(String(id)));

  const rows = await Agent.aggregate<{
    _id: Types.ObjectId;
    name: string;
    distanceMeters: number;
    activeCount: number;
    maxConcurrent: number;
    lastAssignedAt: Date | null;
    lastOnlineAt: Date | null;
    createdAt: Date;
  }>([
    {
      $geoNear: {
        near: {
          type: 'Point',
          coordinates: [request.location.coordinates[0], request.location.coordinates[1]],
        },
        key: 'location',
        distanceField: 'distanceMeters',
        maxDistance: radiusKm * 1000,
        spherical: true,
        query: { status: 'online', skills: request.category, _id: { $nin: exclude } },
      },
    },
    { $match: { $expr: { $lt: ['$activeCount', '$maxConcurrent'] } } },
    { $limit: 200 },
  ]);

  const now = Date.now();
  return rows
    .map((r) => {
      const distanceKm = Math.round(r.distanceMeters) / 1000;
      const since = r.lastAssignedAt ?? r.lastOnlineAt ?? r.createdAt;
      const score = scoreCandidate(
        { distanceKm, activeCount: r.activeCount, maxConcurrent: r.maxConcurrent, idleMs: now - since.getTime() },
        cfg.weights,
        radiusKm,
      );
      return {
        agentId: String(r._id),
        name: r.name,
        distanceKm,
        activeCount: r.activeCount,
        maxConcurrent: r.maxConcurrent,
        score,
      };
    })
    .sort((a, b) => b.score.total - a.score.total || a.distanceKm - b.distanceKm)
    .slice(0, cfg.candidateLimit);
}

/* -------------------------------------------------------------------------- */
/*                         Offer (assignment creation)                        */
/* -------------------------------------------------------------------------- */

interface OfferParams {
  requestId: Id;
  agentId: Id;
  actor: Actor;
  mode: 'auto' | 'manual';
  cfg: DispatchConfigDoc;
  score?: number | null;
  distanceKm?: number | null;
}

/**
 * Offers a pending request to one agent. Safe to call concurrently even
 * WITHOUT the Redis lock; three independent database guards apply:
 *
 *  1. Agent capacity is reserved with a conditional $inc (no overbooking).
 *  2. The assignment insert hits a partial unique index on {request} where
 *     active=true, so only one active assignment per request can exist.
 *  3. The request moves pending -> offered with a conditional update; the
 *     loser compensates (deactivates its assignment, frees the agent slot).
 *
 * Callers normally hold the per-request Redis lock as well; the lock reduces
 * contention, the database guards provide correctness.
 */
export async function offerToAgentUnlocked(p: OfferParams): Promise<{ request: ServiceRequestDoc; assignment: AssignmentDoc }> {
  const request = await ServiceRequest.findById(p.requestId);
  if (!request) throw Errors.notFound('Request');
  if (request.status !== 'pending') {
    throw Errors.conflict(
      'INVALID_STATE',
      `Request ${request.code} is ${request.status}; only pending requests can be assigned`,
    );
  }

  const profile = await Agent.findById(p.agentId);
  if (!profile) throw Errors.notFound('Agent');
  if (!profile.skills.includes(request.category)) {
    throw Errors.conflict('AGENT_SKILL_MISMATCH', `${profile.name} does not handle "${request.category}" requests`);
  }

  const agent = await reserveAgentSlot(profile._id);
  if (!agent) throw Errors.conflict('AGENT_UNAVAILABLE', `${profile.name} is offline or at full capacity`);

  const now = new Date();
  const timeoutSec = p.cfg.priorityRules[request.priority].offerTimeoutSec;
  const distanceKm =
    p.distanceKm ??
    Math.round(haversineKm(fromGeoPoint(request.location), fromGeoPoint(agent.location)) * 1000) / 1000;

  let assignment: AssignmentDoc;
  try {
    assignment = await Assignment.create({
      request: request._id,
      agent: agent._id,
      agentName: agent.name,
      status: 'offered',
      active: true,
      mode: p.mode,
      score: p.score ?? null,
      distanceKm,
      offeredAt: now,
      expiresAt: new Date(now.getTime() + timeoutSec * 1000),
      assignedBy: { id: p.actor.id ?? null, role: p.actor.role, name: p.actor.name },
    });
  } catch (err) {
    await releaseAgentSlot(agent._id);
    if (isDuplicateKeyError(err)) {
      throw Errors.conflict('ALREADY_ASSIGNED', `Request ${request.code} already has an active assignment`);
    }
    throw err;
  }

  const updated = await ServiceRequest.findOneAndUpdate(
    { _id: request._id, status: 'pending' },
    {
      $set: {
        status: 'offered',
        assignedAgent: agent._id,
        assignedAgentName: agent.name,
        currentAssignment: assignment._id,
        offeredAt: now,
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  );

  if (!updated) {
    // Request changed underneath us (cancelled, or another offer won). Undo.
    await Assignment.updateOne(
      { _id: assignment._id },
      { $set: { status: 'cancelled', active: false, endedAt: new Date(), endReason: 'STATE_CHANGED' } },
    );
    await releaseAgentSlot(agent._id);
    throw Errors.conflict('INVALID_STATE', `Request ${request.code} changed state concurrently`);
  }

  await Agent.updateOne({ _id: agent._id }, { $inc: { 'stats.offered': 1 } });
  await audit({
    action: 'assignment.offered',
    entityType: 'assignment',
    entityId: assignment._id,
    request: updated._id,
    actor: p.actor,
    from: 'pending',
    to: 'offered',
    meta: {
      agentId: String(agent._id),
      agentName: agent.name,
      mode: p.mode,
      score: p.score ?? null,
      distanceKm,
      attempt: updated.attempts,
      expiresAt: assignment.expiresAt.toISOString(),
    },
  });

  publishRequest(updated);
  publishAssignment(assignment);
  publishOffer(assignment, updated);
  void publishAgentById(agent._id);

  return { request: updated, assignment };
}

/* -------------------------------------------------------------------------- */
/*                               Auto dispatch                                */
/* -------------------------------------------------------------------------- */

/** Picks the best candidate and offers the request. Caller must hold the request lock. */
export async function autoDispatchUnlocked(
  requestId: Id,
  actor: Actor,
  cfg: DispatchConfigDoc,
): Promise<DispatchOutcome> {
  const request = await ServiceRequest.findById(requestId);
  if (!request) throw Errors.notFound('Request');
  if (request.status !== 'pending') return { outcome: 'skipped', request };

  if (request.attempts >= cfg.maxAttempts) return failRequest(request, 'MAX_ATTEMPTS_REACHED', actor);

  const candidates = await findCandidates(request, cfg);
  for (const candidate of candidates) {
    try {
      const result = await offerToAgentUnlocked({
        requestId: request._id,
        agentId: candidate.agentId,
        actor,
        mode: 'auto',
        cfg,
        score: candidate.score.total,
        distanceKm: candidate.distanceKm,
      });
      return { outcome: 'offered', ...result, candidates: candidates.length };
    } catch (err) {
      // Candidate filled up / went offline between ranking and reservation: try the next one.
      if (err instanceof AppError && err.code === 'AGENT_UNAVAILABLE') continue;
      throw err;
    }
  }

  const ageSec = (Date.now() - request.createdAt.getTime()) / 1000;
  if (ageSec >= cfg.maxPendingSec) return failRequest(request, 'NO_AGENT_AVAILABLE', actor);
  return { outcome: 'waiting', request, candidates: candidates.length };
}

/** Dispatcher-triggered auto dispatch. */
export async function dispatchRequest(requestId: Id, actor: Actor): Promise<DispatchOutcome> {
  const cfg = await getDispatchConfig();
  const result = await withRequestLock(requestId, () => autoDispatchUnlocked(requestId, actor, cfg));
  if (result.outcome === 'skipped') {
    throw Errors.conflict('INVALID_STATE', `Request ${result.request.code} is ${result.request.status}; nothing to dispatch`);
  }
  return result;
}

/** Dispatcher picks a specific agent. */
export async function assignManually(requestId: Id, agentId: Id, actor: Actor) {
  const cfg = await getDispatchConfig();
  return withRequestLock(requestId, () =>
    offerToAgentUnlocked({ requestId, agentId, actor, mode: 'manual', cfg }),
  );
}

/** Ranked candidates without side effects (explains dispatch decisions in the UI). */
export async function previewCandidates(requestId: Id): Promise<{ radiusKm: number; candidates: Candidate[] }> {
  const request = await ServiceRequest.findById(requestId);
  if (!request) throw Errors.notFound('Request');
  const cfg = await getDispatchConfig();
  return {
    radiusKm: cfg.maxRadiusKm * cfg.priorityRules[request.priority].radiusMultiplier,
    candidates: await findCandidates(request, cfg),
  };
}

/* -------------------------------------------------------------------------- */
/*                           Agent-driven transitions                         */
/* -------------------------------------------------------------------------- */

async function loadOwnAssignment(assignmentId: Id, actor: Actor): Promise<AssignmentDoc> {
  const assignment = await Assignment.findById(assignmentId);
  if (!assignment) throw Errors.notFound('Assignment');
  if (actor.role === 'agent' && String(assignment.agent) !== actor.agentId) {
    throw Errors.forbidden('This assignment belongs to another agent');
  }
  return assignment;
}

const PROGRESS_STEPS = {
  accept: {
    from: 'offered',
    to: 'accepted',
    requestFrom: 'offered',
    requestTo: 'accepted',
    timestamp: 'respondedAt',
    requestTimestamp: 'acceptedAt',
    action: 'assignment.accepted',
  },
  start: {
    from: 'accepted',
    to: 'in_progress',
    requestFrom: 'accepted',
    requestTo: 'in_progress',
    timestamp: 'startedAt',
    requestTimestamp: 'startedAt',
    action: 'assignment.started',
  },
  complete: {
    from: 'in_progress',
    to: 'completed',
    requestFrom: 'in_progress',
    requestTo: 'completed',
    timestamp: 'completedAt',
    requestTimestamp: 'completedAt',
    action: 'assignment.completed',
  },
} as const satisfies Record<
  string,
  {
    from: AssignmentStatus;
    to: AssignmentStatus;
    requestFrom: RequestStatus;
    requestTo: RequestStatus;
    timestamp: string;
    requestTimestamp: string;
    action: string;
  }
>;

export type ProgressStep = keyof typeof PROGRESS_STEPS;

/**
 * accept / start / complete. Each is a conditional update on the assignment
 * (expected current status, owning agent, and for accept an unexpired offer)
 * followed by a conditional update on the request. Repeating a step that has
 * already been applied returns the current state instead of an error.
 */
export async function progressAssignment(assignmentId: Id, actor: Actor, step: ProgressStep): Promise<TransitionResult> {
  const spec = PROGRESS_STEPS[step];
  const existing = await loadOwnAssignment(assignmentId, actor);

  return withRequestLock(existing.request, async () => {
    const now = new Date();
    let assignment: AssignmentDoc | null;

    if (step === 'complete') {
      const ended = await endAssignment(
        { _id: existing._id, agent: existing.agent, status: 'in_progress' },
        'completed',
        'COMPLETED',
        'completed',
      );
      assignment = ended?.assignment ?? null;
    } else {
      const filter: FilterQuery<IAssignment> = { _id: existing._id, agent: existing.agent, status: spec.from, active: true };
      if (step === 'accept') filter.expiresAt = { $gt: now };
      assignment = await Assignment.findOneAndUpdate(filter, { $set: { status: spec.to, [spec.timestamp]: now } }, { new: true });
      if (assignment && step === 'accept') await Agent.updateOne({ _id: assignment.agent }, { $inc: { 'stats.accepted': 1 } });
    }

    if (!assignment) {
      const current = (await Assignment.findById(existing._id))!;
      if (current.status === spec.to) {
        return { assignment: current, request: await ServiceRequest.findById(current.request), replayed: true };
      }
      if (step === 'accept' && current.status === 'offered') {
        throw Errors.conflict('OFFER_EXPIRED', 'This offer has expired and can no longer be accepted');
      }
      throw Errors.conflict('INVALID_STATE', `Assignment is ${current.status}; cannot ${step}`);
    }

    const request = await ServiceRequest.findOneAndUpdate(
      { _id: assignment.request, currentAssignment: assignment._id, status: spec.requestFrom },
      { $set: { status: spec.requestTo, [spec.requestTimestamp]: now } },
      { new: true },
    );
    if (!request) {
      // Defensive: should be unreachable while holding the lock. Keep data consistent.
      if (step !== 'complete') await endAssignment({ _id: assignment._id }, 'cancelled', 'REQUEST_STATE_CHANGED');
      throw Errors.conflict('INVALID_STATE', 'The request is no longer in a state that allows this action');
    }

    await audit({
      action: spec.action,
      entityType: 'assignment',
      entityId: assignment._id,
      request: request._id,
      actor,
      from: spec.from,
      to: spec.to,
      meta: { agentId: String(assignment.agent), agentName: assignment.agentName, requestStatus: request.status },
    });

    publishAssignment(assignment);
    publishRequest(request);
    void publishAgentById(assignment.agent);
    return { assignment, request };
  });
}

/**
 * Ends an active assignment without completing it (reject, timeout, revoke),
 * returns the request to the queue and optionally re-dispatches it at once.
 * Caller must hold the request lock.
 */
async function releaseAndRedispatch(opts: {
  filter: FilterQuery<IAssignment>;
  to: 'rejected' | 'expired' | 'revoked';
  reason: string;
  statKey?: keyof IAssignmentStats;
  actor: Actor;
  action: string;
  cfg: DispatchConfigDoc;
  redispatch: boolean;
}): Promise<TransitionResult | null> {
  const ended = await endAssignment(opts.filter, opts.to, opts.reason, opts.statKey);
  if (!ended) return null;
  const { assignment, previousStatus } = ended;

  const request = await returnToPending(assignment.request, assignment._id, assignment.agent);
  await audit({
    action: opts.action,
    entityType: 'assignment',
    entityId: assignment._id,
    request: assignment.request,
    actor: opts.actor,
    from: previousStatus,
    to: opts.to,
    meta: { agentId: String(assignment.agent), agentName: assignment.agentName, reason: opts.reason },
  });

  publishAssignment(assignment);
  void publishAgentById(assignment.agent);
  if (request) publishRequest(request);

  let redispatch: DispatchOutcome | null = null;
  if (request && opts.redispatch && opts.cfg.autoDispatch) {
    redispatch = await autoDispatchUnlocked(request._id, SYSTEM_ACTOR, opts.cfg);
  }
  return { assignment, request: redispatch?.request ?? request, redispatch };
}

/** Agent declines an offer; the request is immediately re-dispatched to the next best agent. */
export async function rejectAssignment(assignmentId: Id, actor: Actor, reason?: string): Promise<TransitionResult> {
  const existing = await loadOwnAssignment(assignmentId, actor);
  const cfg = await getDispatchConfig();

  return withRequestLock(existing.request, async () => {
    const result = await releaseAndRedispatch({
      filter: { _id: existing._id, agent: existing.agent, status: 'offered' },
      to: 'rejected',
      reason: reason?.trim() || 'REJECTED_BY_AGENT',
      statKey: 'rejected',
      actor,
      action: 'assignment.rejected',
      cfg,
      redispatch: true,
    });
    if (result) return result;

    const current = (await Assignment.findById(existing._id))!;
    if (current.status === 'rejected') {
      return { assignment: current, request: await ServiceRequest.findById(current.request), replayed: true };
    }
    throw Errors.conflict('INVALID_STATE', `Assignment is ${current.status}; only offered assignments can be rejected`);
  });
}

/* -------------------------------------------------------------------------- */
/*                         Dispatcher-driven transitions                      */
/* -------------------------------------------------------------------------- */

export async function cancelRequest(requestId: Id, actor: Actor, reason: string) {
  return withRequestLock(requestId, async () => {
    const before = await ServiceRequest.findOneAndUpdate(
      { _id: requestId, status: { $in: ['pending', 'offered', 'accepted', 'in_progress'] } },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason } },
      { returnDocument: 'before' },
    );

    if (!before) {
      const current = await ServiceRequest.findById(requestId);
      if (!current) throw Errors.notFound('Request');
      if (current.status === 'cancelled') return { request: current, assignment: null, replayed: true };
      throw Errors.conflict('INVALID_STATE', `Request ${current.code} is ${current.status} and cannot be cancelled`);
    }

    let assignment: AssignmentDoc | null = null;
    if (before.currentAssignment) {
      const ended = await endAssignment({ _id: before.currentAssignment }, 'cancelled', 'REQUEST_CANCELLED');
      if (ended) {
        assignment = ended.assignment;
        publishAssignment(assignment);
        void publishAgentById(assignment.agent);
      }
    }

    const request = (await ServiceRequest.findById(requestId))!;
    await audit({
      action: 'request.cancelled',
      entityType: 'request',
      entityId: request._id,
      request: request._id,
      actor,
      from: before.status,
      to: 'cancelled',
      meta: { reason, agentId: before.assignedAgent ? String(before.assignedAgent) : null },
    });
    publishRequest(request);
    return { request, assignment, replayed: false };
  });
}

/**
 * Revokes the current assignment and either offers to a chosen agent or runs
 * auto-dispatch (excluding the previous agent). The target agent is checked
 * before revoking so a bad target does not strand the request.
 */
export async function reassignRequest(
  requestId: Id,
  actor: Actor,
  opts: { agentId?: string; reason?: string },
): Promise<DispatchOutcome> {
  const cfg = await getDispatchConfig();

  return withRequestLock(requestId, async () => {
    const request = await ServiceRequest.findById(requestId);
    if (!request) throw Errors.notFound('Request');

    if (request.status !== 'pending') {
      if (!['offered', 'accepted'].includes(request.status)) {
        throw Errors.conflict('INVALID_STATE', `Request ${request.code} is ${request.status} and cannot be reassigned`);
      }
      if (opts.agentId && String(request.assignedAgent) === opts.agentId) {
        throw Errors.badRequest('The request is already assigned to this agent');
      }
      if (opts.agentId) {
        const target = await Agent.findOne({
          _id: opts.agentId,
          status: 'online',
          $expr: { $lt: ['$activeCount', '$maxConcurrent'] },
        });
        if (!target) throw Errors.conflict('AGENT_UNAVAILABLE', 'Target agent is offline or at full capacity');
      }

      await releaseAndRedispatch({
        filter: { _id: request.currentAssignment, status: { $in: ['offered', 'accepted'] } },
        to: 'revoked',
        reason: opts.reason?.trim() || 'REASSIGNED_BY_DISPATCHER',
        actor,
        action: 'assignment.revoked',
        cfg,
        redispatch: false,
      });
    }

    if (opts.agentId) {
      const result = await offerToAgentUnlocked({ requestId, agentId: opts.agentId, actor, mode: 'manual', cfg });
      return { outcome: 'offered', ...result, candidates: 1 };
    }
    return autoDispatchUnlocked(requestId, actor, cfg);
  });
}

/* -------------------------------------------------------------------------- */
/*                          Background / system flows                         */
/* -------------------------------------------------------------------------- */

/** Expires offers whose acceptance window has passed and re-dispatches them. */
export async function expireDueOffers(limit = 50): Promise<number> {
  const due = await Assignment.find({ status: 'offered', active: true, expiresAt: { $lte: new Date() } })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .select('_id request');
  if (due.length === 0) return 0;

  const cfg = await getDispatchConfig();
  let expired = 0;
  for (const item of due) {
    try {
      const result = await withRequestLock(
        item.request,
        () =>
          releaseAndRedispatch({
            filter: { _id: item._id, status: 'offered', expiresAt: { $lte: new Date() } },
            to: 'expired',
            reason: 'OFFER_TIMEOUT',
            statKey: 'expired',
            actor: SYSTEM_ACTOR,
            action: 'assignment.expired',
            cfg,
            redispatch: true,
          }),
        0,
      );
      if (result) expired += 1;
    } catch (err) {
      if (!isLockBusy(err)) logger.error({ err, assignmentId: String(item._id) }, 'Failed to expire offer');
    }
  }
  return expired;
}

/** Called when an agent goes offline: frees their not-yet-started work. */
export async function revokeAgentAssignments(agentId: Id, reason: string, actor: Actor = SYSTEM_ACTOR): Promise<number> {
  const active = await Assignment.find({ agent: agentId, active: true, status: { $in: ['offered', 'accepted'] } }).select(
    '_id request',
  );
  if (active.length === 0) return 0;

  const cfg = await getDispatchConfig();
  let revoked = 0;
  for (const item of active) {
    try {
      const result = await withRequestLock(item.request, () =>
        releaseAndRedispatch({
          filter: { _id: item._id, status: { $in: ['offered', 'accepted'] } },
          to: 'revoked',
          reason,
          actor,
          action: 'assignment.revoked',
          cfg,
          redispatch: true,
        }),
      );
      if (result) revoked += 1;
    } catch (err) {
      logger.error({ err, assignmentId: String(item._id) }, 'Failed to revoke assignment');
    }
  }
  return revoked;
}

/** Drains the pending queue: highest priority first, then oldest first. */
export async function dispatchPendingQueue(limit = 25): Promise<number> {
  const cfg = await getDispatchConfig();
  if (!cfg.autoDispatch) return 0;

  const pending = await ServiceRequest.find({ status: 'pending' })
    .sort({ priorityRank: -1, createdAt: 1 })
    .limit(limit)
    .select('_id');

  let offered = 0;
  for (const item of pending) {
    try {
      const result = await withRequestLock(item._id, () => autoDispatchUnlocked(item._id, SYSTEM_ACTOR, cfg), 0);
      if (result.outcome === 'offered') offered += 1;
    } catch (err) {
      if (!isLockBusy(err)) logger.error({ err, requestId: String(item._id) }, 'Auto-dispatch failed');
    }
  }
  return offered;
}
