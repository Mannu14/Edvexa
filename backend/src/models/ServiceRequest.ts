import { Schema, Types, model, type HydratedDocument } from 'mongoose';
import {
  CATEGORIES,
  PRIORITIES,
  PRIORITY_RANK,
  REQUEST_STATUSES,
  applyJsonTransform,
  pointSchema,
  type Category,
  type GeoPoint,
  type Priority,
  type RequestStatus,
} from './common';

export interface IServiceRequest {
  code: string;
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  /** Numeric priority so the pending queue can be sorted by an index. */
  priorityRank: number;
  location: GeoPoint;
  address: string;
  status: RequestStatus;
  assignedAgent: Types.ObjectId | null;
  assignedAgentName: string | null;
  currentAssignment: Types.ObjectId | null;
  /** Number of offers made so far (bounded by config.maxAttempts). */
  attempts: number;
  /** Agents that rejected, timed out or were revoked; excluded from auto-dispatch. */
  triedAgents: Types.ObjectId[];
  createdBy: Types.ObjectId;
  cancelReason: string | null;
  failureReason: string | null;
  offeredAt: Date | null;
  acceptedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const requestSchema = new Schema<IServiceRequest>(
  {
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, default: '', maxlength: 2000 },
    category: { type: String, enum: CATEGORIES, required: true },
    priority: { type: String, enum: PRIORITIES, default: 'normal' },
    priorityRank: { type: Number, default: PRIORITY_RANK.normal },
    location: { type: pointSchema, required: true },
    address: { type: String, default: '', maxlength: 300 },
    status: { type: String, enum: REQUEST_STATUSES, default: 'pending' },
    assignedAgent: { type: Schema.Types.ObjectId, ref: 'Agent', default: null },
    assignedAgentName: { type: String, default: null },
    currentAssignment: { type: Schema.Types.ObjectId, ref: 'Assignment', default: null },
    attempts: { type: Number, default: 0 },
    triedAgents: { type: [Schema.Types.ObjectId], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cancelReason: { type: String, default: null },
    failureReason: { type: String, default: null },
    offeredAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

requestSchema.pre('validate', function (next) {
  this.priorityRank = PRIORITY_RANK[this.priority];
  next();
});

// Pending queue: highest priority first, then FIFO.
requestSchema.index({ status: 1, priorityRank: -1, createdAt: 1 });
requestSchema.index({ location: '2dsphere' });

applyJsonTransform(requestSchema);

export type ServiceRequestDoc = HydratedDocument<IServiceRequest>;
export const ServiceRequest = model<IServiceRequest>('ServiceRequest', requestSchema);
