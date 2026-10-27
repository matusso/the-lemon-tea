import type { DistanceTrace } from "@lemon-tea/shared-types";

export const DELTA_ALGORITHM_VERSION = "distance-delta-v1";

/**
 * Delta convention: A_minus_B.
 *   delta(d) = tA(d) - tB(d)
 *   negative  -> A reached distance d earlier, i.e. A is AHEAD / faster up to d
 *   positive  -> A is behind
 * A section gain for A over [d1, d2] is  -(delta(d2) - delta(d1)); we report `deltaChange`
 * with the same A_minus_B sign so that negative always means "good for A".
 */
export const DELTA_CONVENTION = "A_minus_B" as const;

/**
 * Empirical resolution of the distance-aligned delta at ~3.7 Hz sampling with 1 km/h speed
 * quantisation: two identical synthetic laps sampled with different phase differ by up to
 * ~35 ms locally (see comparison.test.ts). Section changes smaller than this are not explained.
 */
export const DELTA_NOISE_FLOOR_SECONDS = 0.04;

export interface DeltaResult {
  convention: typeof DELTA_CONVENTION;
  distance: number[];
  delta: number[];
  finalDelta: number;
  /** Most negative point of the cumulative delta (A's largest lead). */
  maxLeadForA: { distance: number; delta: number };
  /** Most positive point (A's largest deficit). */
  maxDeficitForA: { distance: number; delta: number };
}

export function assertSameGrid(a: DistanceTrace, b: DistanceTrace): void {
  if (a.distance.length !== b.distance.length) throw new Error("Traces are on different distance grids");
  const n = a.distance.length;
  if (Math.abs(a.distance[n - 1]! - b.distance[n - 1]!) > 1e-6) throw new Error("Traces have different reference lengths");
}

export function computeDelta(a: DistanceTrace, b: DistanceTrace): DeltaResult {
  assertSameGrid(a, b);
  const delta = a.time.map((ta, i) => ta - b.time[i]!);
  let lo = 0, hi = 0;
  for (let i = 1; i < delta.length; i++) {
    if (delta[i]! < delta[lo]!) lo = i;
    if (delta[i]! > delta[hi]!) hi = i;
  }
  return {
    convention: DELTA_CONVENTION,
    distance: a.distance,
    delta,
    finalDelta: delta[delta.length - 1]!,
    maxLeadForA: { distance: a.distance[lo]!, delta: delta[lo]! },
    maxDeficitForA: { distance: a.distance[hi]!, delta: delta[hi]! },
  };
}

/** Index of the grid point closest to distance d. */
export function indexAt(distance: readonly number[], d: number): number {
  if (distance.length < 2) return 0;
  const step = distance[1]! - distance[0]!;
  return Math.max(0, Math.min(distance.length - 1, Math.round((d - distance[0]!) / step)));
}

/** Change in A_minus_B delta over [d1, d2]. Negative = A gained time in that section. */
export function sectionDelta(res: DeltaResult, d1: number, d2: number): number {
  return res.delta[indexAt(res.distance, d2)]! - res.delta[indexAt(res.distance, d1)]!;
}

export interface SectionDelta {
  label: string;
  from: number;
  to: number;
  deltaChange: number;
}

export function equalSections(res: DeltaResult, count: number): SectionDelta[] {
  const L = res.distance[res.distance.length - 1]!;
  const out: SectionDelta[] = [];
  for (let k = 0; k < count; k++) {
    const from = (L * k) / count;
    const to = (L * (k + 1)) / count;
    out.push({ label: `M${k + 1}`, from, to, deltaChange: sectionDelta(res, from, to) });
  }
  return out;
}
