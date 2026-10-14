import { Schema, model, type HydratedDocument } from 'mongoose';
import { applyJsonTransform, type Priority } from './common';

export interface PriorityRule {
  /** Multiplies maxRadiusKm, so urgent work can reach further agents. */
  radiusMultiplier: number;
  /** How long the agent has to accept an offer before it expires. */
  offerTimeoutSec: number;
}

export interface IDispatchConfig {
  key: string;
  autoDispatch: boolean;
  maxRadiusKm: number;
  candidateLimit: number;
  maxAttempts: number;
  maxPendingSec: number;
  weights: { distance: number; workload: number; fairness: number };
  priorityRules: Record<Priority, PriorityRule>;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_DISPATCH_CONFIG: Omit<IDispatchConfig, 'createdAt' | 'updatedAt'> = {
  key: 'default',
  autoDispatch: true,
  maxRadiusKm: 10,
  candidateLimit: 5,
  maxAttempts: 5,
  maxPendingSec: 600,
  weights: { distance: 0.6, workload: 0.25, fairness: 0.15 },
  priorityRules: {
    low: { radiusMultiplier: 1, offerTimeoutSec: 60 },
    normal: { radiusMultiplier: 1, offerTimeoutSec: 45 },
    high: { radiusMultiplier: 1.5, offerTimeoutSec: 30 },
    critical: { radiusMultiplier: 2, offerTimeoutSec: 20 },
  },
  updatedBy: null,
};

const ruleSchema = new Schema<PriorityRule>(
  {
    radiusMultiplier: { type: Number, required: true, min: 0.1, max: 10 },
    offerTimeoutSec: { type: Number, required: true, min: 5, max: 3600 },
  },
  { _id: false },
);

const configSchema = new Schema<IDispatchConfig>(
  {
    key: { type: String, required: true, unique: true },
    autoDispatch: { type: Boolean, required: true },
    maxRadiusKm: { type: Number, required: true, min: 0.1 },
    candidateLimit: { type: Number, required: true, min: 1, max: 50 },
    maxAttempts: { type: Number, required: true, min: 1, max: 50 },
    maxPendingSec: { type: Number, required: true, min: 10 },
    weights: {
      distance: { type: Number, required: true, min: 0 },
      workload: { type: Number, required: true, min: 0 },
      fairness: { type: Number, required: true, min: 0 },
    },
    priorityRules: {
      low: { type: ruleSchema, required: true },
      normal: { type: ruleSchema, required: true },
      high: { type: ruleSchema, required: true },
      critical: { type: ruleSchema, required: true },
    },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

applyJsonTransform(configSchema);

export type DispatchConfigDoc = HydratedDocument<IDispatchConfig>;
export const DispatchConfig = model<IDispatchConfig>('DispatchConfig', configSchema);
