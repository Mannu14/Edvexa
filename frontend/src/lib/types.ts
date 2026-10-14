export type Role = 'admin' | 'dispatcher' | 'agent';
export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type Category = 'delivery' | 'repair' | 'medical' | 'installation';
export type RequestStatus = 'pending' | 'offered' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
export type AssignmentStatus =
  | 'offered'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'revoked';

export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'critical'];
export const CATEGORIES: Category[] = ['delivery', 'repair', 'medical', 'installation'];
export const OPEN_STATUSES: RequestStatus[] = ['pending', 'offered', 'accepted', 'in_progress'];

export interface LatLng {
  lat: number;
  lng: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  agentId: string | null;
}

export interface Agent {
  id: string;
  name: string;
  skills: Category[];
  status: 'online' | 'offline';
  available: boolean;
  location: LatLng;
  activeCount: number;
  maxConcurrent: number;
  lastSeenAt: string | null;
  stats: { offered: number; accepted: number; rejected: number; expired: number; completed: number };
}

export interface ServiceRequest {
  id: string;
  code: string;
  title: string;
  description: string;
  category: Category;
  priority: Priority;
  priorityRank: number;
  status: RequestStatus;
  location: LatLng;
  address: string;
  assignedAgent: string | null;
  assignedAgentName: string | null;
  currentAssignment: string | null;
  attempts: number;
  triedAgents: string[];
  failureReason: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: string;
  request: string;
  agent: string;
  agentName: string;
  status: AssignmentStatus;
  active: boolean;
  mode: 'auto' | 'manual';
  score: number | null;
  distanceKm: number | null;
  offeredAt: string;
  expiresAt: string;
  respondedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  requestDetail?: ServiceRequest | null;
}

export interface AuditEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  request: string | null;
  actor: { id: string | null; role: string; name: string };
  from: string | null;
  to: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface Candidate {
  agentId: string;
  name: string;
  distanceKm: number;
  activeCount: number;
  maxConcurrent: number;
  score: { distance: number; workload: number; fairness: number; total: number };
}

export interface PriorityRule {
  radiusMultiplier: number;
  offerTimeoutSec: number;
}

export interface DispatchConfig {
  autoDispatch: boolean;
  maxRadiusKm: number;
  candidateLimit: number;
  maxAttempts: number;
  maxPendingSec: number;
  weights: { distance: number; workload: number; fairness: number };
  priorityRules: Record<Priority, PriorityRule>;
  updatedBy: string | null;
  updatedAt: string;
}

export interface Summary {
  requests: Record<RequestStatus, number>;
  agents: { total: number; online: number; available: number; busy: number; offline: number };
  last24h: { offers: number; accepted: number; rejected: number; expired: number; acceptanceRate: number | null };
}

export interface DispatchOutcome {
  outcome: 'offered' | 'waiting' | 'failed' | 'queued' | 'skipped';
  assignment?: Assignment;
  candidates?: number;
  reason?: string;
}
