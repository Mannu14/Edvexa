import type { AssignmentStatus, Priority, RequestStatus } from './types';

export const STATUS_LABEL: Record<RequestStatus | AssignmentStatus, string> = {
  pending: 'Pending',
  offered: 'Offered',
  accepted: 'Accepted',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  rejected: 'Rejected',
  expired: 'Expired',
  revoked: 'Revoked',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
};

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Human sentence for an audit event in the activity feed. */
export function describeEvent(e: {
  action: string;
  actor: { name: string; role: string };
  meta?: Record<string, unknown>;
  from: string | null;
  to: string | null;
}): string {
  const meta = e.meta ?? {};
  const agent = (meta.agentName as string) ?? 'agent';
  const by = e.actor.role === 'system' ? 'auto' : e.actor.name;
  switch (e.action) {
    case 'request.created':
      return `${e.actor.name} created a ${meta.priority} ${meta.category} request`;
    case 'request.updated':
      return `${e.actor.name} edited the request`;
    case 'request.cancelled':
      return `${e.actor.name} cancelled: ${meta.reason}`;
    case 'request.failed':
      return `Dispatch failed (${String(meta.reason).replace(/_/g, ' ').toLowerCase()})`;
    case 'assignment.offered':
      return `Offered to ${agent} (${by}${meta.distanceKm != null ? `, ${meta.distanceKm} km` : ''})`;
    case 'assignment.accepted':
      return `${agent} accepted`;
    case 'assignment.started':
      return `${agent} started work`;
    case 'assignment.completed':
      return `${agent} completed the job`;
    case 'assignment.rejected':
      return `${agent} rejected${meta.reason && meta.reason !== 'REJECTED_BY_AGENT' ? `: ${meta.reason}` : ''}`;
    case 'assignment.expired':
      return `Offer to ${agent} timed out`;
    case 'assignment.revoked':
      return `Revoked from ${agent} (${String(meta.reason).replace(/_/g, ' ').toLowerCase()})`;
    case 'agent.online':
      return `${e.actor.name} came online`;
    case 'agent.offline':
      return `Agent went offline${meta.reason ? ` (${String(meta.reason).replace(/_/g, ' ').toLowerCase()})` : ''}`;
    case 'config.updated':
      return `${e.actor.name} updated dispatch rules`;
    default:
      return e.action;
  }
}
