import type { IDispatchConfig } from '../models/DispatchConfig';

/** Agents idle this long get the full fairness bonus. */
export const FAIRNESS_HORIZON_MS = 30 * 60 * 1000;

export interface CandidateInput {
  distanceKm: number;
  activeCount: number;
  maxConcurrent: number;
  /** Time since the agent last received work (or came online). */
  idleMs: number;
}

export interface ScoreBreakdown {
  distance: number;
  workload: number;
  fairness: number;
  total: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Weighted score in [0, 1]. Each factor is normalised to [0, 1] where 1 is best:
 *  - distance: linear falloff to 0 at the search radius
 *  - workload: remaining capacity as a share of max capacity
 *  - fairness: how long the agent has waited for work (prevents starving idle agents)
 * Weights come from the admin-editable dispatch config.
 */
export function scoreCandidate(
  input: CandidateInput,
  weights: IDispatchConfig['weights'],
  radiusKm: number,
): ScoreBreakdown {
  const distance = clamp01(1 - input.distanceKm / radiusKm);
  const workload = clamp01(1 - input.activeCount / input.maxConcurrent);
  const fairness = clamp01(input.idleMs / FAIRNESS_HORIZON_MS);

  const weightSum = weights.distance + weights.workload + weights.fairness || 1;
  const total =
    (weights.distance * distance + weights.workload * workload + weights.fairness * fairness) / weightSum;

  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { distance: round(distance), workload: round(workload), fairness: round(fairness), total: round(total) };
}
