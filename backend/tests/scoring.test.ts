import { haversineKm } from '../src/lib/geo';
import { FAIRNESS_HORIZON_MS, scoreCandidate } from '../src/services/scoring';

const weights = { distance: 0.6, workload: 0.25, fairness: 0.15 };

describe('haversineKm', () => {
  it('matches a known city-to-city distance', () => {
    const bengaluru = { lat: 12.9716, lng: 77.5946 };
    const mysuru = { lat: 12.2958, lng: 76.6394 };
    expect(haversineKm(bengaluru, mysuru)).toBeCloseTo(127.9, 0);
  });

  it('is zero for the same point and symmetric', () => {
    const a = { lat: 10, lng: 20 };
    const b = { lat: 11, lng: 21 };
    expect(haversineKm(a, a)).toBe(0);
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 10);
  });
});

describe('scoreCandidate', () => {
  const base = { distanceKm: 2, activeCount: 0, maxConcurrent: 1, idleMs: 0 };

  it('ranks closer agents higher', () => {
    const near = scoreCandidate({ ...base, distanceKm: 1 }, weights, 10);
    const far = scoreCandidate({ ...base, distanceKm: 8 }, weights, 10);
    expect(near.total).toBeGreaterThan(far.total);
  });

  it('ranks less loaded agents higher', () => {
    const idle = scoreCandidate({ ...base, maxConcurrent: 3, activeCount: 0 }, weights, 10);
    const loaded = scoreCandidate({ ...base, maxConcurrent: 3, activeCount: 2 }, weights, 10);
    expect(idle.total).toBeGreaterThan(loaded.total);
  });

  it('rewards agents that have waited longer for work, capped at the horizon', () => {
    const waited = scoreCandidate({ ...base, idleMs: FAIRNESS_HORIZON_MS * 3 }, weights, 10);
    expect(waited.fairness).toBe(1);
    expect(waited.total).toBeGreaterThan(scoreCandidate(base, weights, 10).total);
  });

  it('normalises by weight sum so the total stays in [0, 1]', () => {
    const best = scoreCandidate({ distanceKm: 0, activeCount: 0, maxConcurrent: 1, idleMs: FAIRNESS_HORIZON_MS }, { distance: 5, workload: 5, fairness: 5 }, 10);
    const worst = scoreCandidate({ distanceKm: 50, activeCount: 1, maxConcurrent: 1, idleMs: 0 }, weights, 10);
    expect(best.total).toBe(1);
    expect(worst.total).toBe(0);
  });
});
