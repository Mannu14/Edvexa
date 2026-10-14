import { env } from '../config/env';
import { redis } from '../infra/redis';
import { logger } from '../infra/logger';
import { Errors } from '../lib/errors';
import { toGeoPoint, type LatLng } from '../lib/geo';
import { Agent } from '../models/Agent';
import { publishAgentById } from '../realtime/publisher';
import { SYSTEM_ACTOR, audit } from './audit.service';
import { revokeAgentAssignments, type Actor } from './dispatch.service';

/**
 * Presence model
 * --------------
 * Agents send a heartbeat every few seconds (Socket.IO or REST). Each heartbeat
 * does ZADD presence:heartbeats <now> <agentId>, which is O(log n) and never
 * touches MongoDB on the hot path. The sweeper atomically pops every member
 * whose score is older than HEARTBEAT_TTL_MS (Lua, so a heartbeat racing the
 * sweep cannot be lost) and marks those agents offline.
 *
 * A socket disconnect alone does NOT mark the agent offline: mobile networks
 * drop connections constantly, and the TTL gives the agent time to reconnect.
 */
export const HEARTBEAT_KEY = 'presence:heartbeats';
const persistKey = (agentId: string) => `presence:persisted:${agentId}`;
const PERSIST_EVERY_SEC = 10;

const POP_STALE_SCRIPT = `
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if #ids > 0 then
  redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
end
return ids`;

export async function heartbeat(agentId: string, location?: LatLng | null, actor?: Actor) {
  await redis().zadd(HEARTBEAT_KEY, Date.now(), agentId);

  const now = new Date();
  // Offline -> online transition happens exactly once thanks to the conditional filter.
  const cameOnline = await Agent.findOneAndUpdate(
    { _id: agentId, status: 'offline' },
    {
      $set: {
        status: 'online',
        lastOnlineAt: now,
        lastSeenAt: now,
        ...(location ? { location: toGeoPoint(location) } : {}),
      },
    },
    { new: true },
  );

  if (cameOnline) {
    await audit({
      action: 'agent.online',
      entityType: 'agent',
      entityId: cameOnline._id,
      actor: actor ?? { id: null, role: 'agent', name: cameOnline.name },
      from: 'offline',
      to: 'online',
    });
    void publishAgentById(agentId);
    return { status: 'online' as const, transitioned: true };
  }

  // Throttle Mongo writes: persist lastSeenAt / location at most every PERSIST_EVERY_SEC.
  const shouldPersist = await redis().set(persistKey(agentId), '1', 'EX', PERSIST_EVERY_SEC, 'NX');
  if (shouldPersist === 'OK' || location) {
    const res = await Agent.updateOne(
      { _id: agentId },
      { $set: { lastSeenAt: now, ...(location ? { location: toGeoPoint(location) } : {}) } },
    );
    if (res.matchedCount === 0) throw Errors.notFound('Agent');
    if (location) void publishAgentById(agentId);
  }
  return { status: 'online' as const, transitioned: false };
}

export async function markAgentOffline(agentId: string, reason: string, actor: Actor = SYSTEM_ACTOR): Promise<boolean> {
  const agent = await Agent.findOneAndUpdate(
    { _id: agentId, status: 'online' },
    { $set: { status: 'offline' } },
    { new: true },
  );
  if (!agent) return false;

  await audit({
    action: 'agent.offline',
    entityType: 'agent',
    entityId: agent._id,
    actor,
    from: 'online',
    to: 'offline',
    meta: { reason },
  });
  void publishAgentById(agentId);

  // Offered and accepted (not yet started) work goes back to the queue.
  const revoked = await revokeAgentAssignments(agentId, `AGENT_OFFLINE:${reason}`, actor);
  if (revoked > 0) logger.info({ agentId, revoked, reason }, 'Revoked assignments of offline agent');
  return true;
}

export async function goOffline(agentId: string, actor: Actor) {
  await redis().zrem(HEARTBEAT_KEY, agentId);
  await markAgentOffline(agentId, 'MANUAL', actor);
}

/** Marks agents offline whose last heartbeat is older than the TTL. */
export async function sweepStalePresence(): Promise<string[]> {
  const cutoff = Date.now() - env.HEARTBEAT_TTL_MS;
  const stale = (await redis().eval(POP_STALE_SCRIPT, 1, HEARTBEAT_KEY, String(cutoff))) as string[];

  // Backstop: agents marked online in Mongo with no live heartbeat entry
  // (e.g. Redis was flushed or the API restarted with the in-memory mock).
  const orphanCutoff = new Date(Date.now() - env.HEARTBEAT_TTL_MS * 2);
  const orphans = await Agent.find({
    status: 'online',
    $or: [{ lastSeenAt: { $lt: orphanCutoff } }, { lastSeenAt: null }],
  }).select('_id');
  const live = new Set(await redis().zrange(HEARTBEAT_KEY, 0, -1));
  const ids = new Set(stale);
  for (const o of orphans) if (!live.has(String(o._id))) ids.add(String(o._id));

  const offline: string[] = [];
  for (const id of ids) {
    try {
      if (await markAgentOffline(id, 'HEARTBEAT_TIMEOUT')) offline.push(id);
    } catch (err) {
      logger.error({ err, agentId: id }, 'Failed to mark agent offline');
    }
  }
  return offline;
}
