import { Schema, Types, model, type HydratedDocument } from 'mongoose';
import { ASSIGNMENT_STATUSES, actorSchema, applyJsonTransform, type ActorRef, type AssignmentStatus } from './common';

export const ACTIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = ['offered', 'accepted', 'in_progress'];

export interface IAssignment {
  request: Types.ObjectId;
  agent: Types.ObjectId;
  agentName: string;
  status: AssignmentStatus;
  /**
   * true while the assignment holds the request (offered/accepted/in_progress).
   * Backed by a partial unique index: at most ONE active assignment per request.
   */
  active: boolean;
  mode: 'auto' | 'manual';
  score: number | null;
  distanceKm: number | null;
  offeredAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  assignedBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
}

const assignmentSchema = new Schema<IAssignment>(
  {
    request: { type: Schema.Types.ObjectId, ref: 'ServiceRequest', required: true },
    agent: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
    agentName: { type: String, required: true },
    status: { type: String, enum: ASSIGNMENT_STATUSES, default: 'offered' },
    active: { type: Boolean, default: true },
    mode: { type: String, enum: ['auto', 'manual'], required: true },
    score: { type: Number, default: null },
    distanceKm: { type: Number, default: null },
    offeredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: null },
    assignedBy: { type: actorSchema, required: true },
  },
  { timestamps: true },
);

assignmentSchema.index(
  { request: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'uniq_active_assignment_per_request' },
);
assignmentSchema.index({ request: 1, createdAt: -1 });
assignmentSchema.index({ agent: 1, active: 1 });
assignmentSchema.index({ status: 1, expiresAt: 1 });

applyJsonTransform(assignmentSchema);

export type AssignmentDoc = HydratedDocument<IAssignment>;
export const Assignment = model<IAssignment>('Assignment', assignmentSchema);
