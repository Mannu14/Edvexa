import type { FilterQuery, Types } from 'mongoose';
import { logger } from '../infra/logger';
import { Errors } from '../lib/errors';
import { toGeoPoint, type LatLng } from '../lib/geo';
import { Assignment } from '../models/Assignment';
import { PRIORITY_RANK, type Category, type Priority, type RequestStatus } from '../models/common';
import { nextSequence } from '../models/Counter';
import { ServiceRequest, type IServiceRequest } from '../models/ServiceRequest';
import { publishRequest } from '../realtime/publisher';
import { audit } from './audit.service';
import { getDispatchConfig } from './config.service';
import { autoDispatchUnlocked, withRequestLock, type Actor, type DispatchOutcome } from './dispatch.service';

export interface CreateRequestInput {
  title: string;
  description?: string;
  category: Category;
  priority?: Priority;
  location: LatLng;
  address?: string;
}

export async function createRequest(input: CreateRequestInput, actor: Actor & { id: string }) {
  const code = `REQ-${await nextSequence('request')}`;
  const request = await ServiceRequest.create({
    code,
    title: input.title,
    description: input.description ?? '',
    category: input.category,
    priority: input.priority ?? 'normal',
    location: toGeoPoint(input.location),
    address: input.address ?? '',
    createdBy: actor.id,
  });

  await audit({
    action: 'request.created',
    entityType: 'request',
    entityId: request._id,
    request: request._id,
    actor,
    to: 'pending',
    meta: { code, priority: request.priority, category: request.category },
  });
  publishRequest(request);

  // Try to dispatch immediately; if that is not possible the sweeper retries.
  const cfg = await getDispatchConfig();
  let dispatch: DispatchOutcome | null = null;
  if (cfg.autoDispatch) {
    try {
      dispatch = await withRequestLock(request._id, () => autoDispatchUnlocked(request._id, actor, cfg), 1000);
    } catch (err) {
      logger.warn({ err, requestId: request.id }, 'Initial auto-dispatch failed; sweeper will retry');
    }
  }

  return {
    request: dispatch?.request ?? request,
    dispatch: dispatch ? summarizeOutcome(dispatch) : { outcome: 'queued' as const },
  };
}

export function summarizeOutcome(result: DispatchOutcome) {
  switch (result.outcome) {
    case 'offered':
      return { outcome: result.outcome, assignment: result.assignment.toJSON(), candidates: result.candidates };
    case 'waiting':
      return { outcome: result.outcome, candidates: result.candidates };
    case 'failed':
      return { outcome: result.outcome, reason: result.reason };
    default:
      return { outcome: result.outcome };
  }
}

export interface ListRequestsQuery {
  status?: RequestStatus[];
  priority?: Priority;
  category?: Category;
  agentId?: string;
  page: number;
  limit: number;
}

export async function listRequests(q: ListRequestsQuery) {
  const filter: FilterQuery<IServiceRequest> = {};
  if (q.status?.length) filter.status = { $in: q.status };
  if (q.priority) filter.priority = q.priority;
  if (q.category) filter.category = q.category;
  if (q.agentId) filter.assignedAgent = q.agentId;

  const [data, total] = await Promise.all([
    ServiceRequest.find(filter)
      .sort({ priorityRank: -1, createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
    ServiceRequest.countDocuments(filter),
  ]);
  return { data: data.map((d) => d.toJSON()), page: q.page, limit: q.limit, total };
}

export async function getRequestDetail(id: string, actor: Actor) {
  const request = await ServiceRequest.findById(id);
  if (!request) throw Errors.notFound('Request');

  const assignments = await Assignment.find({ request: request._id }).sort({ createdAt: -1 });
  if (actor.role === 'agent' && !assignments.some((a) => String(a.agent) === actor.agentId)) {
    // Agents may only see requests that were offered to them.
    throw Errors.notFound('Request');
  }
  return { request: request.toJSON(), assignments: assignments.map((a) => a.toJSON()) };
}

export interface UpdateRequestInput {
  title?: string;
  description?: string;
  priority?: Priority;
  address?: string;
}

/** Edits are only allowed while the request is still waiting in the queue. */
export async function updateRequest(id: string | Types.ObjectId, input: UpdateRequestInput, actor: Actor) {
  return withRequestLock(id, async () => {
    const $set: Record<string, unknown> = { ...input };
    if (input.priority) $set.priorityRank = PRIORITY_RANK[input.priority];

    const before = await ServiceRequest.findOneAndUpdate({ _id: id, status: 'pending' }, { $set }, { returnDocument: 'before' });
    if (!before) {
      const current = await ServiceRequest.findById(id);
      if (!current) throw Errors.notFound('Request');
      throw Errors.conflict('INVALID_STATE', `Request ${current.code} is ${current.status}; only pending requests can be edited`);
    }
    const request = (await ServiceRequest.findById(id))!;
    const changes = Object.fromEntries(
      Object.keys(input).map((k) => [k, { from: before.get(k), to: request.get(k) }]),
    );
    await audit({
      action: 'request.updated',
      entityType: 'request',
      entityId: request._id,
      request: request._id,
      actor,
      meta: { changes },
    });
    publishRequest(request);
    return request;
  });
}
