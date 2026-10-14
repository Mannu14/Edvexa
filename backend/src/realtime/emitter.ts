import type { Server } from 'socket.io';

/**
 * Thin indirection between domain services and Socket.IO so services stay
 * transport-agnostic and testable (no server bound = events are dropped).
 */
let io: Server | null = null;

export const ROOMS = {
  dashboard: 'dashboard',
  agent: (agentId: string) => `agent:${agentId}`,
  user: (userId: string) => `user:${userId}`,
};

export const EVENTS = {
  requestUpdated: 'request:updated',
  assignmentOffered: 'assignment:offered',
  assignmentUpdated: 'assignment:updated',
  agentUpdated: 'agent:updated',
  auditEvent: 'audit:event',
} as const;

export function bindIo(server: Server | null): void {
  io = server;
}

export function realtimeEnabled(): boolean {
  return io !== null;
}

export function emit(event: string, payload: unknown, rooms: string[]): void {
  if (!io || rooms.length === 0) return;
  io.to(rooms).emit(event, payload);
}
