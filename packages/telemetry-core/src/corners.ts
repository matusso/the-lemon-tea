import type { DistanceTrace } from "@lemon-tea/shared-types";
import { movingAverage } from "./distance.ts";
import { indexAt, type DeltaResult } from "./delta.ts";

export const CORNER_ALGORITHM_VERSION = "corner-analysis-v1";

/**
 * A corner detected from speed telemetry. Numbering is sequential along the lap and is NOT
 * the official turn numbering; when circuit metadata supplies official turns they are mapped
 * in the circuit engine and passed as `officialLabel`.
 */
export interface DetectedCorner {
  index: number;
  label: string;
  officialLabel?: string;
  /** Distance of the speed minimum on the reference lap(s). */
  minSpeedDistance: number;
  /** Start of the analysis window: speed peak on the preceding straight. */
  windowStart: number;
  /** End of the analysis window: full throttle reached + traction zone, or next peak. */
  windowEnd: number;
  /** Speed drop from the preceding peak, km/h; used to classify corner speed band. */
  speedDrop: number;
  minSpeed: number;
  band: "low" | "medium" | "high";
}

export interface CornerDetectionOptions {
  /** Minimum speed drop for a dip to count as a corner (km/h). */
  minProminence: number;
  /** Dips closer than this are merged (metres). */
  mergeDistance: number;
  /** Distance after full throttle that still counts as corner exit (metres). */
  tractionZone: number;
}

export const DEFAULT_CORNER_OPTIONS: CornerDetectionOptions = {
  minProminence: 12,
  mergeDistance: 120,
  tractionZone: 120,
};

/**
 * Detect corners as prominent local minima of smoothed speed. Uses the element-wise
 * minimum of the supplied traces so that a corner one driver takes flat but another lifts
 * for is still analysed consistently for both.
 */
export function detectCorners(traces: DistanceTrace[], opts: CornerDetectionOptions = DEFAULT_CORNER_OPTIONS): DetectedCorner[] {
  if (!traces.length) return [];
  const ref = traces[0]!;
  const n = ref.distance.length;
  const step = ref.distance[1]! - ref.distance[0]!;
  const minSpeed = new Array<number>(n);
  const minThrottle = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    minSpeed[i] = Math.min(...traces.map((t) => t.speed[i]!));
    minThrottle[i] = Math.min(...traces.map((t) => t.throttle[i]!));
  }
  const v = movingAverage(minSpeed, Math.max(3, Math.round(25 / step) | 1));

  // candidate local minima
  const cands: number[] = [];
  for (let i = 1; i < n - 1; i++) if (v[i]! <= v[i - 1]! && v[i]! < v[i + 1]!) cands.push(i);

  // prominence: rise to the highest point before the next lower minimum on each side
  const prominent = cands.filter((i) => {
    const leftPeak = maxIn(v, Math.max(0, i - Math.round(1500 / step)), i);
    const rightPeak = maxIn(v, i, Math.min(n - 1, i + Math.round(1500 / step)));
    return Math.min(leftPeak.value, rightPeak.value) - v[i]! >= opts.minProminence;
  });

  // merge minima that are close together (chicanes resolve to their slowest point)
  const merged: number[] = [];
  for (const i of prominent) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (i - last) * step < opts.mergeDistance) {
      if (v[i]! < v[last]!) merged[merged.length - 1] = i;
    } else merged.push(i);
  }

  const corners: DetectedCorner[] = [];
  for (let k = 0; k < merged.length; k++) {
    const i = merged[k]!;
    const prev = k > 0 ? merged[k - 1]! : 0;
    const next = k < merged.length - 1 ? merged[k + 1]! : n - 1;
    const peakBefore = maxIn(v, prev, i);
    const peakAfter = maxIn(v, i, next);
    let fullThrottle = i;
    while (fullThrottle < peakAfter.index && minThrottle[fullThrottle]! < 95) fullThrottle++;
    const endIdx = Math.min(peakAfter.index, fullThrottle + Math.round(opts.tractionZone / step));
    const drop = peakBefore.value - v[i]!;
    const vmin = v[i]!;
    corners.push({
      index: k + 1,
      label: `C${k + 1}`,
      minSpeedDistance: ref.distance[i]!,
      windowStart: ref.distance[peakBefore.index]!,
      windowEnd: ref.distance[Math.max(endIdx, i + 1)]!,
      speedDrop: drop,
      minSpeed: vmin,
      band: vmin < 130 ? "low" : vmin < 210 ? "medium" : "high",
    });
  }
  // ensure windows do not overlap (chicane exits may run into the next braking zone)
  for (let k = 1; k < corners.length; k++) {
    if (corners[k]!.windowStart < corners[k - 1]!.windowEnd) corners[k]!.windowStart = corners[k - 1]!.windowEnd;
  }
  return corners;
}

function maxIn(xs: readonly number[], from: number, to: number): { index: number; value: number } {
  let bi = from;
  for (let i = from; i <= to; i++) if (xs[i]! > xs[bi]!) bi = i;
  return { index: bi, value: xs[bi]! };
}

/** Per-driver, per-corner metrics. All distances are on the normalised lap-distance axis. */
export interface CornerMetrics {
  /** First brake application in the window (binary brake channel, not pressure). */
  brakeStart: number | null;
  brakeEnd: number | null;
  brakingDistance: number | null;
  brakingDuration: number | null;
  /** Speed at window start (end of the preceding straight). */
  approachSpeed: number;
  /** Speed when braking (or lifting) begins. */
  entrySpeed: number;
  minSpeed: number;
  /** Distance of the speed minimum. This is the "speed apex", not a measured racing-line apex. */
  minSpeedDistance: number;
  /** First point after the minimum where throttle exceeds 20% and keeps rising. */
  throttleOn: number | null;
  fullThrottle: number | null;
  exitSpeed: number;
  /** Mean longitudinal acceleration between the speed minimum and window end, m/s^2. */
  exitAcceleration: number;
  /** Minimum throttle in the window; 100 means taken flat. */
  minThrottle: number;
  timeInWindow: number;
}

export function cornerMetrics(t: DistanceTrace, c: DetectedCorner): CornerMetrics {
  const s = indexAt(t.distance, c.windowStart);
  const e = indexAt(t.distance, c.windowEnd);
  let iMin = s;
  for (let i = s; i <= e; i++) if (t.speed[i]! < t.speed[iMin]!) iMin = i;

  let bStart: number | null = null;
  let bEnd: number | null = null;
  for (let i = s; i <= iMin + 5 && i <= e; i++) {
    if (t.brake[i]! > 0 && bStart === null) bStart = i;
    if (bStart !== null && t.brake[i]! === 0) { bEnd = i; break; }
  }
  if (bStart !== null && bEnd === null) {
    for (let i = bStart; i <= e; i++) if (t.brake[i]! === 0) { bEnd = i; break; }
  }

  // Lift point when there is no braking: first drop below 95% throttle
  let liftIdx = s;
  for (let i = s; i <= iMin; i++) if (t.throttle[i]! < 95) { liftIdx = i; break; }
  const entryIdx = bStart ?? liftIdx;

  let thrOn: number | null = null;
  for (let i = iMin; i <= e; i++) {
    if (t.throttle[i]! > 20 && (i + 1 > e || t.throttle[i + 1]! >= t.throttle[i]!)) { thrOn = i; break; }
  }
  let full: number | null = null;
  for (let i = thrOn ?? iMin; i <= e; i++) if (t.throttle[i]! >= 95) { full = i; break; }

  let minThrottle = 100;
  for (let i = s; i <= e; i++) minThrottle = Math.min(minThrottle, t.throttle[i]!);

  const exitDt = t.time[e]! - t.time[iMin]!;
  const exitAcceleration = exitDt > 0 ? (t.speed[e]! - t.speed[iMin]!) / 3.6 / exitDt : 0;
  const d = (i: number | null) => (i === null ? null : t.distance[i]!);

  return {
    brakeStart: d(bStart),
    brakeEnd: d(bEnd),
    brakingDistance: bStart !== null && bEnd !== null ? t.distance[bEnd]! - t.distance[bStart]! : null,
    brakingDuration: bStart !== null && bEnd !== null ? t.time[bEnd]! - t.time[bStart]! : null,
    approachSpeed: t.speed[s]!,
    entrySpeed: t.speed[entryIdx]!,
    minSpeed: t.speed[iMin]!,
    minSpeedDistance: t.distance[iMin]!,
    throttleOn: d(thrOn),
    fullThrottle: d(full),
    exitSpeed: t.speed[e]!,
    exitAcceleration,
    minThrottle,
    timeInWindow: t.time[e]! - t.time[s]!,
  };
}

export type CornerPhase = "entry" | "mid" | "exit";

export interface CornerComparison {
  corner: DetectedCorner;
  a: CornerMetrics;
  b: CornerMetrics;
  /** A_minus_B delta change over the whole window; negative = A gained. */
  deltaChange: number;
  phases: { phase: CornerPhase; from: number; to: number; deltaChange: number }[];
  dominantPhase: CornerPhase;
  apexAssessment: {
    status: "not_determinable";
    reason: string;
  };
}

/**
 * Phase boundaries come from the mean of both drivers' events so neither driver's
 * behaviour defines the yardstick alone:
 *   entry: window start -> mean brake release (or speed minimum if no braking)
 *   mid:   -> mean throttle reapplication
 *   exit:  -> window end
 */
export function compareCorner(a: DistanceTrace, b: DistanceTrace, delta: DeltaResult, c: DetectedCorner): CornerComparison {
  const ma = cornerMetrics(a, c);
  const mb = cornerMetrics(b, c);
  const avg = (x: number | null, y: number | null, fallback: number) =>
    x !== null && y !== null ? (x + y) / 2 : x ?? y ?? fallback;
  const apex = (ma.minSpeedDistance + mb.minSpeedDistance) / 2;
  let entryEnd = avg(ma.brakeEnd, mb.brakeEnd, apex);
  let midEnd = avg(ma.throttleOn, mb.throttleOn, apex);
  entryEnd = Math.min(Math.max(entryEnd, c.windowStart), c.windowEnd);
  midEnd = Math.min(Math.max(midEnd, entryEnd), c.windowEnd);
  const at = (d: number) => delta.delta[indexAt(delta.distance, d)]!;
  const phases = [
    { phase: "entry" as const, from: c.windowStart, to: entryEnd },
    { phase: "mid" as const, from: entryEnd, to: midEnd },
    { phase: "exit" as const, from: midEnd, to: c.windowEnd },
  ].map((p) => ({ ...p, deltaChange: at(p.to) - at(p.from) }));
  const total = at(c.windowEnd) - at(c.windowStart);
  // dominant = phase contributing most in the direction of the total
  const sign = Math.sign(total) || 1;
  const dominant = [...phases].sort((p, q) => sign * q.deltaChange - sign * p.deltaChange)[0]!.phase;
  return {
    corner: c,
    a: ma,
    b: mb,
    deltaChange: total,
    phases,
    dominantPhase: dominant,
    apexAssessment: {
      status: "not_determinable",
      reason:
        "Apex hit/miss needs track-boundary geometry and position accuracy below ~0.5 m. Available position data is ~4 Hz with metre-level noise, so only the speed-minimum point is reported.",
    },
  };
}
