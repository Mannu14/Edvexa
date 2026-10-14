import { Schema, Types, model, type HydratedDocument } from 'mongoose';
import { actorSchema, applyJsonTransform, type ActorRef } from './common';

export type AuditEntity = 'request' | 'assignment' | 'agent' | 'config' | 'user';

export interface IAuditLog {
  action: string;
  entityType: AuditEntity;
  entityId: Types.ObjectId;
  /** Correlates every event that belongs to one service request. */
  request: Types.ObjectId | null;
  actor: ActorRef;
  from: string | null;
  to: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

const auditSchema = new Schema<IAuditLog>(
  {
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    request: { type: Schema.Types.ObjectId, default: null },
    actor: { type: actorSchema, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  // minimize:false keeps `meta: {}` in the output instead of dropping the key.
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

auditSchema.index({ createdAt: -1 });
auditSchema.index({ request: 1, createdAt: -1 });
auditSchema.index({ entityId: 1, createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });

applyJsonTransform(auditSchema);

export type AuditLogDoc = HydratedDocument<IAuditLog>;
export const AuditLog = model<IAuditLog>('AuditLog', auditSchema);
