import { env } from '../config/env';
import { logger } from '../infra/logger';
import { acquireLock, releaseLock } from '../lib/lock';
import { dispatchPendingQueue, expireDueOffers } from '../services/dispatch.service';
import { sweepStalePresence } from '../services/presence.service';

const LEADER_KEY = 'lock:sweeper';

/**
 * One pass of background maintenance:
 *  1. presence  - agents without a recent heartbeat go offline (their work is re-queued)
 *  2. timeouts  - unanswered offers past expiresAt are expired and re-dispatched
 *  3. queue     - pending requests are dispatched by priority, then age
 *
 * Every step is individually safe to run concurrently (conditional updates +
 * per-request locks), the leader lock only avoids duplicated effort when
 * several API instances are running.
 */
export async function runSweepOnce() {
  const offline = await sweepStalePresence();
  const expired = await expireDueOffers();
  const dispatched = await dispatchPendingQueue();
  return { offline: offline.length, expired, dispatched };
}

export function startSweeper(intervalMs = env.SWEEP_INTERVAL_MS): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    let token: string | null = null;
    try {
      token = await acquireLock(LEADER_KEY, intervalMs * 5);
      if (!token) return;
      const result = await runSweepOnce();
      if (result.offline || result.expired || result.dispatched) logger.info(result, 'Sweep completed');
    } catch (err) {
      logger.error({ err }, 'Sweep failed');
    } finally {
      if (token) await releaseLock(LEADER_KEY, token).catch(() => undefined);
      running = false;
    }
  };

  const handle = setInterval(tick, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
