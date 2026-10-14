import { logger } from '../infra/logger';
import type { Category } from '../models/common';
import { User } from '../models/User';
import { SYSTEM_ACTOR } from '../services/audit.service';
import { createUser } from '../services/auth.service';
import { getDispatchConfig } from '../services/config.service';

/** Synthetic city centre used by the seed data, simulator and dashboard map (Bengaluru). */
export const CITY_CENTER = { lat: 12.9716, lng: 77.5946 };

export const DEMO_PASSWORDS = {
  admin: 'Admin@12345',
  dispatcher: 'Dispatch@12345',
  agent: 'Agent@12345',
};

const AGENTS: { name: string; skills: Category[]; dLat: number; dLng: number; maxConcurrent: number }[] = [
  { name: 'Aarav Mehta', skills: ['delivery', 'repair'], dLat: 0.012, dLng: -0.018, maxConcurrent: 2 },
  { name: 'Diya Kapoor', skills: ['delivery'], dLat: -0.021, dLng: 0.011, maxConcurrent: 2 },
  { name: 'Kabir Rao', skills: ['repair', 'installation'], dLat: 0.031, dLng: 0.027, maxConcurrent: 1 },
  { name: 'Meera Iyer', skills: ['medical'], dLat: -0.008, dLng: -0.034, maxConcurrent: 1 },
  { name: 'Rohan Das', skills: ['delivery', 'installation'], dLat: 0.044, dLng: -0.006, maxConcurrent: 1 },
  { name: 'Sara Khan', skills: ['medical', 'delivery'], dLat: -0.036, dLng: -0.022, maxConcurrent: 1 },
  { name: 'Vikram Singh', skills: ['repair'], dLat: 0.005, dLng: 0.041, maxConcurrent: 1 },
  { name: 'Anaya Nair', skills: ['installation', 'repair', 'delivery'], dLat: -0.046, dLng: 0.035, maxConcurrent: 2 },
];

export async function seedIfEmpty(): Promise<boolean> {
  if ((await User.estimatedDocumentCount()) > 0) return false;

  await getDispatchConfig();
  await createUser(
    { name: 'Ada Admin', email: 'admin@dispatch.test', password: DEMO_PASSWORDS.admin, role: 'admin' },
    SYSTEM_ACTOR,
  );
  await createUser(
    { name: 'Dev Dispatcher', email: 'dispatcher@dispatch.test', password: DEMO_PASSWORDS.dispatcher, role: 'dispatcher' },
    SYSTEM_ACTOR,
  );

  for (const [i, a] of AGENTS.entries()) {
    await createUser(
      {
        name: a.name,
        email: `agent${i + 1}@dispatch.test`,
        password: DEMO_PASSWORDS.agent,
        role: 'agent',
        agent: {
          skills: a.skills,
          maxConcurrent: a.maxConcurrent,
          location: { lat: CITY_CENTER.lat + a.dLat, lng: CITY_CENTER.lng + a.dLng },
        },
      },
      SYSTEM_ACTOR,
    );
  }

  logger.info(
    `Seeded demo users: admin@dispatch.test / ${DEMO_PASSWORDS.admin}, dispatcher@dispatch.test / ${DEMO_PASSWORDS.dispatcher}, agent1..${AGENTS.length}@dispatch.test / ${DEMO_PASSWORDS.agent}`,
  );
  return true;
}
