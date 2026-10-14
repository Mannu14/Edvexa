import type { Types } from 'mongoose';
import { AuditLog, type AuditEntity } from '../models/AuditLog';
import type { ActorRef } from '../models/common';
import { logger } from '../infra/logger';
import { EVENTS, ROOMS, emit } from '../realtime/emitter';

export const SYSTEM_ACTOR: ActorRef = { id: null, role: 'system', name: 'system' };

export interface AuditEntry {
  action: string;
  entityType: AuditEntity;
  entityId: Types.ObjectId | string;
  request?: Types.ObjectId | string | null;
  actor: ActorRef;
  from?: string | null;
  to?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Appends an immutable audit record and streams it to the dashboard feed.
 * Audit writes never fail the business operation that triggered them: the
 * state change has already been committed, so we log loudly instead.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const doc = await AuditLog.create({
      ...entry,
      request: entry.request ?? null,
      from: entry.from ?? null,
      to: entry.to ?? null,
      meta: entry.meta ?? {},
    });
    emit(EVENTS.auditEvent, doc.toJSON(), [ROOMS.dashboard]);
  } catch (err) {
    logger.error({ err, entry }, 'Failed to write audit log');
  }
}
