import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { Agent } from '../src/models/Agent';
import { bindIo } from '../src/realtime/emitter';
import { createSocketServer } from '../src/realtime/socket';
import { api, app, auth, createAgent, createPendingRequest, createStaff, idemKey, useTestEnv } from './helpers';

useTestEnv();

let server: http.Server;
let ioServer: Server;
let url: string;
const clients: Socket[] = [];

beforeAll(async () => {
  server = http.createServer(app);
  ioServer = createSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  clients.splice(0).forEach((c) => c.disconnect());
});

afterAll(async () => {
  bindIo(null);
  ioServer.close();
  await new Promise((resolve) => server.close(resolve));
});

function open(token?: string): Promise<Socket> {
  const socket = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const nextEvent = <T = any>(socket: Socket, event: string, match: (p: T) => boolean = () => true) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 5000);
    const handler = (payload: T) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

describe('Socket.IO real-time updates', () => {
  it('refuses connections without a valid JWT', async () => {
    await expect(open()).rejects.toThrow('UNAUTHORIZED');
    await expect(open('garbage')).rejects.toThrow('UNAUTHORIZED');
  });

  it('pushes the offer to the agent and status changes to the dashboard', async () => {
    const { user, token } = await createStaff();
    const agent = await createAgent();
    const req = await createPendingRequest(user._id);

    const dashboard = await open(token);
    const agentSocket = await open(agent.token);

    const offered = nextEvent(agentSocket, 'assignment:offered');
    const dashboardUpdate = nextEvent(dashboard, 'request:updated', (r: any) => r.id === req.id && r.status === 'offered');
    const auditEvent = nextEvent(dashboard, 'audit:event', (e: any) => e.action === 'assignment.offered');

    const res = await api()
      .post(`/api/requests/${req.id}/assign`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send({ agentId: agent.agentId });
    expect(res.status).toBe(201);

    const offer = await offered;
    expect(offer.request.id).toBe(req.id);
    expect(offer.assignment.status).toBe('offered');
    expect((await dashboardUpdate).assignedAgent).toBe(agent.agentId);
    expect((await auditEvent).request).toBe(req.id);
  });

  it('does not leak other agents’ offers', async () => {
    const { user, token } = await createStaff();
    const target = await createAgent();
    const bystander = await createAgent();
    const req = await createPendingRequest(user._id);

    const bystanderSocket = await open(bystander.token);
    const leaked: unknown[] = [];
    bystanderSocket.on('assignment:offered', (p) => leaked.push(p));

    await api()
      .post(`/api/requests/${req.id}/assign`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send({ agentId: target.agentId });
    await new Promise((r) => setTimeout(r, 200));

    expect(leaked).toHaveLength(0);
  });

  it('brings an agent online through a socket heartbeat and broadcasts it', async () => {
    const { token } = await createStaff();
    const agent = await createAgent({ online: false });
    const dashboard = await open(token);
    const agentSocket = await open(agent.token);

    const update = nextEvent(dashboard, 'agent:updated', (a: any) => a.id === agent.agentId && a.status === 'online');
    const ack = await agentSocket.emitWithAck('agent:heartbeat', { location: { lat: 12.98, lng: 77.6 } });

    expect(ack.ok).toBe(true);
    expect((await update).location).toEqual({ lat: 12.98, lng: 77.6 });
    expect((await Agent.findById(agent.agentId))!.status).toBe('online');
  });
});
