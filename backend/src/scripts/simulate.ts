/**
 * Demo traffic generator. Run while the API is up:
 *
 *   npm run simulate                 # agents 2..8 + a request every 6s
 *   npm run simulate -- --no-requests
 *
 * - Logs in seeded agents (agent1 is left for you to drive from the UI).
 * - Each agent connects over Socket.IO, heartbeats every 5s and drifts around.
 * - On an offer: ~70% accept, ~15% reject, ~15% ignore (to show timeouts).
 *   Accepted jobs are started after 3s and completed after 8-15s.
 * - agent8 goes silent for 45s every few minutes to demonstrate offline detection.
 * - The dispatcher account creates random requests (with Idempotency-Key).
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { CATEGORIES, PRIORITIES } from '../models/common';
import { CITY_CENTER, DEMO_PASSWORDS } from './seedData';

const API = process.env.API_URL ?? 'http://localhost:4000';
const AGENT_COUNT = Number(process.env.SIM_AGENTS ?? 8);
const CREATE_REQUESTS = !process.argv.includes('--no-requests');
const REQUEST_EVERY_MS = Number(process.env.SIM_REQUEST_EVERY_MS ?? 6000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function login(email: string, password: string) {
  return api<{ token: string; user: { name: string; agentId: string | null } }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

interface Offer {
  assignment: { id: string; expiresAt: string };
  request: { code: string; title: string };
}

async function runAgent(index: number) {
  const email = `agent${index}@dispatch.test`;
  const { token, user } = await login(email, DEMO_PASSWORDS.agent);
  const flaky = index === AGENT_COUNT;
  let location = { lat: CITY_CENTER.lat + rand(-0.04, 0.04), lng: CITY_CENTER.lng + rand(-0.04, 0.04) };
  let silentUntil = 0;

  const socket: Socket = io(API, { auth: { token }, transports: ['websocket'] });
  const log = (msg: string) => console.log(`[${user.name.padEnd(13)}] ${msg}`);

  const beat = () => {
    if (Date.now() < silentUntil) return;
    location = { lat: location.lat + rand(-0.002, 0.002), lng: location.lng + rand(-0.002, 0.002) };
    socket.emit('agent:heartbeat', { location });
  };

  socket.on('connect', () => {
    log('connected');
    beat();
  });
  socket.on('connect_error', (err) => log(`connect error: ${err.message}`));

  socket.on('assignment:offered', async ({ assignment, request }: Offer) => {
    const roll = Math.random();
    const think = rand(1000, 4000);
    log(`offer ${request.code} "${request.title}" (thinking ${(think / 1000).toFixed(1)}s)`);
    await sleep(think);
    try {
      if (roll < 0.7) {
        await api(`/assignments/${assignment.id}/accept`, { method: 'POST', token });
        log(`accepted ${request.code}`);
        await sleep(3000);
        await api(`/assignments/${assignment.id}/start`, { method: 'POST', token });
        log(`started ${request.code}`);
        await sleep(rand(8000, 15000));
        await api(`/assignments/${assignment.id}/complete`, { method: 'POST', token });
        log(`completed ${request.code}`);
      } else if (roll < 0.85) {
        await api(`/assignments/${assignment.id}/reject`, {
          method: 'POST',
          token,
          body: JSON.stringify({ reason: pick(['Too far', 'On break', 'Vehicle issue']) }),
        });
        log(`rejected ${request.code}`);
      } else {
        log(`ignoring ${request.code} (will time out)`);
      }
    } catch (err) {
      log(`action failed: ${(err as Error).message}`);
    }
  });

  setInterval(beat, 5000);

  if (flaky) {
    setInterval(() => {
      silentUntil = Date.now() + 45_000;
      log('going silent for 45s (offline detection demo)');
    }, 180_000);
  }
}

async function runRequestGenerator() {
  const { token } = await login('dispatcher@dispatch.test', DEMO_PASSWORDS.dispatcher);
  const titles: Record<string, string[]> = {
    delivery: ['Parcel pickup', 'Grocery drop', 'Document courier'],
    repair: ['AC not cooling', 'Leaking kitchen tap', 'Laptop screen repair'],
    medical: ['Home sample collection', 'First-aid assistance', 'Medicine delivery'],
    installation: ['Wi-Fi router setup', 'TV wall mount', 'Water purifier install'],
  };
  for (;;) {
    const category = pick(CATEGORIES);
    const priority = pick([...PRIORITIES, 'normal', 'normal', 'high'] as const);
    try {
      const { request } = await api<{ request: { code: string } }>('/requests', {
        method: 'POST',
        token,
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          title: pick(titles[category]),
          category,
          priority,
          location: { lat: CITY_CENTER.lat + rand(-0.05, 0.05), lng: CITY_CENTER.lng + rand(-0.05, 0.05) },
          address: `Sector ${Math.ceil(rand(1, 30))}, Bengaluru`,
        }),
      });
      console.log(`[dispatcher   ] created ${request.code} (${priority}/${category})`);
    } catch (err) {
      console.log(`[dispatcher   ] create failed: ${(err as Error).message}`);
    }
    await sleep(REQUEST_EVERY_MS);
  }
}

async function main() {
  console.log(`Simulating against ${API}`);
  for (let i = 2; i <= AGENT_COUNT; i++) {
    await runAgent(i).catch((err) => console.error(`agent${i} failed: ${(err as Error).message}`));
  }
  if (CREATE_REQUESTS) void runRequestGenerator();
}

void main();
