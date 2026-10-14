import type { Types } from 'mongoose';
import { Agent } from '../models/Agent';
import type { AssignmentDoc } from '../models/Assignment';
import { ServiceRequest, type ServiceRequestDoc } from '../models/ServiceRequest';
import { EVENTS, ROOMS, emit, realtimeEnabled } from './emitter';

type Id = Types.ObjectId | string;

export function publishRequest(request: ServiceRequestDoc): void {
  const rooms = [ROOMS.dashboard];
  if (request.assignedAgent) rooms.push(ROOMS.agent(String(request.assignedAgent)));
  emit(EVENTS.requestUpdated, request.toJSON(), rooms);
}

export async function publishRequestById(id: Id): Promise<void> {
  if (!realtimeEnabled()) return;
  const request = await ServiceRequest.findById(id);
  if (request) publishRequest(request);
}

export function publishAssignment(assignment: AssignmentDoc): void {
  emit(EVENTS.assignmentUpdated, assignment.toJSON(), [ROOMS.dashboard, ROOMS.agent(String(assignment.agent))]);
}

export function publishOffer(assignment: AssignmentDoc, request: ServiceRequestDoc): void {
  emit(
    EVENTS.assignmentOffered,
    { assignment: assignment.toJSON(), request: request.toJSON() },
    [ROOMS.agent(String(assignment.agent))],
  );
}

export async function publishAgentById(id: Id): Promise<void> {
  if (!realtimeEnabled()) return;
  const agent = await Agent.findById(id);
  if (agent) emit(EVENTS.agentUpdated, agent.toJSON(), [ROOMS.dashboard, ROOMS.agent(String(agent._id))]);
}
