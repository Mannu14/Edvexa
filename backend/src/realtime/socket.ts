import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../infra/logger';
import { verifyToken, type AuthUser } from '../services/auth.service';
import { heartbeat } from '../services/presence.service';
import { ROOMS, bindIo } from './emitter';

const heartbeatPayload = z
  .object({ location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional() })
  .optional();

type Ack = (response: { ok: boolean; error?: string; serverTime?: number }) => void;

/**
 * Socket.IO server.
 *  - JWT is verified during the handshake (auth.token); unauthenticated sockets never connect.
 *  - Dispatchers/admins join the `dashboard` room and receive every domain event.
 *  - Agents join `agent:<id>` and only receive their own offers/updates.
 *  - Agents send `agent:heartbeat` to stay online (see presence.service).
 */
export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true },
    pingInterval: 10_000,
    pingTimeout: 5_000,
  });

  io.use((socket, next) => {
    const raw =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!raw) return next(new Error('UNAUTHORIZED'));
    try {
      socket.data.user = verifyToken(raw);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    socket.join(ROOMS.user(user.id));

    if (user.role === 'admin' || user.role === 'dispatcher') {
      socket.join(ROOMS.dashboard);
    }

    if (user.role === 'agent' && user.agentId) {
      const agentId = user.agentId;
      socket.join(ROOMS.agent(agentId));

      socket.on('agent:heartbeat', async (payload: unknown, ack?: Ack) => {
        const parsed = heartbeatPayload.safeParse(payload);
        if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_PAYLOAD' });
        try {
          await heartbeat(agentId, parsed.data?.location ?? null, {
            id: user.id,
            role: 'agent',
            name: user.name,
            agentId,
          });
          ack?.({ ok: true, serverTime: Date.now() });
        } catch (err) {
          logger.warn({ err, agentId }, 'Heartbeat failed');
          ack?.({ ok: false, error: 'HEARTBEAT_FAILED' });
        }
      });
    }

    logger.debug({ userId: user.id, role: user.role }, 'Socket connected');
    socket.on('disconnect', (reason) => logger.debug({ userId: user.id, reason }, 'Socket disconnected'));
  });

  bindIo(io);
  return io;
}
