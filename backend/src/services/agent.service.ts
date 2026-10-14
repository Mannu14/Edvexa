import type { FilterQuery } from 'mongoose';
import { Errors } from '../lib/errors';
import { Agent, type IAgent } from '../models/Agent';
import { ACTIVE_ASSIGNMENT_STATUSES, Assignment } from '../models/Assignment';
import type { Category } from '../models/common';
import { ServiceRequest } from '../models/ServiceRequest';
import { publishAgentById } from '../realtime/publisher';
import { audit } from './audit.service';
import type { Actor } from './dispatch.service';

export async function listAgents(q: { status?: 'online' | 'offline'; available?: boolean; skill?: Category }) {
  const filter: FilterQuery<IAgent> = {};
  if (q.status) filter.status = q.status;
  if (q.skill) filter.skills = q.skill;
  if (q.available === true) {
    filter.status = 'online';
    filter.$expr = { $lt: ['$activeCount', '$maxConcurrent'] };
  }
  const agents = await Agent.find(filter).sort({ status: -1, name: 1 }).limit(500);
  return agents.map((a) => a.toJSON());
}

export async function getAgent(id: string) {
  const agent = await Agent.findById(id);
  if (!agent) throw Errors.notFound('Agent');
  return agent;
}

export async function updateAgent(
  id: string,
  input: { name?: string; skills?: Category[]; maxConcurrent?: number },
  actor: Actor,
) {
  const agent = await Agent.findByIdAndUpdate(id, { $set: input }, { new: true, runValidators: true });
  if (!agent) throw Errors.notFound('Agent');
  await audit({ action: 'agent.updated', entityType: 'agent', entityId: agent._id, actor, meta: { changes: input } });
  void publishAgentById(agent._id);
  return agent;
}

/** An agent's assignments joined with their requests (for the agent console). */
export async function listAgentAssignments(agentId: string, activeOnly: boolean) {
  const filter = activeOnly
    ? { agent: agentId, active: true, status: { $in: ACTIVE_ASSIGNMENT_STATUSES } }
    : { agent: agentId };
  const assignments = await Assignment.find(filter).sort({ createdAt: -1 }).limit(activeOnly ? 50 : 100);
  const requests = await ServiceRequest.find({ _id: { $in: assignments.map((a) => a.request) } });
  const byId = new Map(requests.map((r) => [String(r._id), r.toJSON()]));
  return assignments.map((a) => ({ ...a.toJSON(), requestDetail: byId.get(String(a.request)) ?? null }));
}
