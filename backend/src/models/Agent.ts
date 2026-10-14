import { Schema, Types, model, type HydratedDocument } from 'mongoose';
import { CATEGORIES, applyJsonTransform, pointSchema, type GeoPoint } from './common';

export type AgentStatus = 'online' | 'offline';

export interface IAgent {
  user: Types.ObjectId;
  name: string;
  skills: string[];
  status: AgentStatus;
  location: GeoPoint;
  /** Number of assignments currently held (offered/accepted/in_progress). */
  activeCount: number;
  maxConcurrent: number;
  lastSeenAt: Date | null;
  lastOnlineAt: Date | null;
  lastAssignedAt: Date | null;
  stats: { offered: number; accepted: number; rejected: number; expired: number; completed: number };
  createdAt: Date;
  updatedAt: Date;
}

const agentSchema = new Schema<IAgent>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    name: { type: String, required: true, trim: true },
    skills: { type: [{ type: String, enum: CATEGORIES }], default: [] },
    status: { type: String, enum: ['online', 'offline'], default: 'offline', index: true },
    location: { type: pointSchema, required: true },
    activeCount: { type: Number, default: 0, min: 0 },
    maxConcurrent: { type: Number, default: 1, min: 1, max: 10 },
    lastSeenAt: { type: Date, default: null },
    lastOnlineAt: { type: Date, default: null },
    lastAssignedAt: { type: Date, default: null },
    stats: {
      offered: { type: Number, default: 0 },
      accepted: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
      expired: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

agentSchema.index({ location: '2dsphere' });

agentSchema.virtual('available').get(function (this: IAgent) {
  return this.status === 'online' && this.activeCount < this.maxConcurrent;
});

applyJsonTransform(agentSchema);

export type AgentDoc = HydratedDocument<IAgent>;
export const Agent = model<IAgent>('Agent', agentSchema);
