import type { DistanceTrace } from "@lemon-tea/shared-types";
import { grid, interpLinear, interpLinearClamped, interpStep, bisectRight } from "./interpolate.ts";
import type { CarSamples, PositionSamples } from "./samples.ts";
import { sliceByTime } from "./samples.ts";

export const DISTANCE_ALGORITHM_VERSION = "lap-distance-v1";

/** Samples further apart than this are treated as a data gap and never bridged (ms). */
export const MAX_SAMPLE_GAP_MS = 1500;

/**
 * Cumulative distance by trapezoidal integration of speed over time.
 * speed km/h -> m/s; t in ms. Gaps above MAX_SAMPLE_GAP_MS are integrated with the mean
 * speed of the bounding samples, which is the least-assumption choice, and are reported.
 */
export function integrateDistance(t: readonly number[], speedKmh: readonly number[]): { d: number[]; gaps: number } {
  const d = new Array<number>(t.length);
  let gaps = 0;
  if (!t.length) return { d, gaps };
  d[0] = 0;
  for (let i = 1; i < t.length; i++) {
    const dt = (t[i]! - t[i - 1]!) / 1000;
    if (dt * 1000 > MAX_SAMPLE_GAP_MS) gaps++;
    d[i] = d[i - 1]! + ((speedKmh[i]! + speedKmh[i - 1]!) / 2 / 3.6) * dt;
  }
  return { d, gaps };
}

export interface BuildTraceOptions {
  sessionId: string;
  driverNumber: number;
  lapNumber: number;
  lapStartMs: number;
  lapTime: number;
  stepMetres: number;
  /**
   * Common lap length used to normalise distance. Integrated distance differs per lap by
   * ~0.5% (line choice, speed sensor), so both laps are scaled to the same length so that
   * start and finish line coincide exactly. Defaults to this lap's own integrated length.
   */
  referenceLength?: number;
}

export interface TraceBuildResult {
  trace: DistanceTrace;
  integratedLength: number;
  gaps: number;
}

/**
 * Map one lap of raw samples onto a distance grid.
 *
 * Method:
 *  1. take car samples in [start - 2s, end + 2s] so interpolation at the boundaries is supported
 *  2. integrate speed -> distance, then shift so distance(lapStart) = 0
 *  3. scale so that distance(lapEnd) = referenceLength
 *  4. on the distance grid, interpolate time (linear), continuous channels (linear) and
 *     discrete channels (step)
 */
export function buildLapTrace(car: CarSamples, pos: PositionSamples | null, o: BuildTraceOptions): TraceBuildResult {
  const startMs = o.lapStartMs;
  const endMs = o.lapStartMs + o.lapTime * 1000;
  const c = sliceByTime(car, startMs - 2000, endMs + 2000);
  if (c.t.length < 10) throw new Error(`Insufficient car samples for lap ${o.lapNumber} of #${o.driverNumber}`);

  const { d: rawD, gaps } = integrateDistance(c.t, c.speed);
  const d0 = interpLinearClamped(c.t, rawD, startMs);
  const d1 = interpLinearClamped(c.t, rawD, endMs);
  const integratedLength = d1 - d0;
  const refLen = o.referenceLength ?? integratedLength;
  const scale = refLen / integratedLength;
  const dNorm = rawD.map((v) => (v - d0) * scale);

  const g = grid(0, refLen, o.stepMetres);
  // The finish line must be on the grid so that delta(L) equals the lap-time difference.
  if (refLen - g[g.length - 1]! > 1e-6) g.push(refLen);
  const tAt = g.map((x) => interpLinearClamped(dNorm, c.t, x));
  const time = tAt.map((ms) => (ms - startMs) / 1000);
  // Force exact boundary alignment: t(0)=0 and t(L)=lapTime by construction of the scaling.
  time[0] = Math.max(0, time[0]!);

  const lin = (ys: readonly number[]) => tAt.map((ms) => interpLinearClamped(c.t, ys, ms));
  const step = (ys: readonly number[]) => tAt.map((ms) => {
    const v = interpStep(c.t, ys, ms);
    return Number.isNaN(v) ? ys[ms < c.t[0]! ? 0 : ys.length - 1]! : v;
  });

  const speed = lin(c.speed);
  const throttle = lin(c.throttle).map((v) => Math.min(100, Math.max(0, v)));
  const brake = step(c.brake).map((v) => (v > 0 ? 1 : 0));
  const gear = c.gear ? step(c.gear) : undefined;
  const rpm = c.rpm ? lin(c.rpm) : undefined;
  const acceleration = longitudinalAcceleration(time, speed);

  const measuredMask = tAt.map((ms) => {
    const i = bisectRight(c.t, ms);
    const halfStepMs = (o.stepMetres / Math.max(1, interpLinearClamped(c.t, c.speed, ms) / 3.6)) * 500;
    const near = (j: number) => j >= 0 && j < c.t.length && Math.abs(c.t[j]! - ms) <= halfStepMs;
    return near(i) || near(i + 1);
  });

  let x: number[] | undefined;
  let y: number[] | undefined;
  if (pos && pos.t.length > 4) {
    const p = sliceByTime(pos, startMs - 3000, endMs + 3000);
    if (p.t.length > 4) {
      x = tAt.map((ms) => interpLinear(p.t, p.x, ms, MAX_SAMPLE_GAP_MS * 2));
      y = tAt.map((ms) => interpLinear(p.t, p.y, ms, MAX_SAMPLE_GAP_MS * 2));
    }
  }

  const trace: DistanceTrace = {
    sessionId: o.sessionId,
    driverNumber: o.driverNumber,
    lapNumber: o.lapNumber,
    lapTime: o.lapTime,
    distance: g,
    time,
    speed,
    throttle,
    brake,
    ...(gear ? { gear } : {}),
    ...(rpm ? { rpm } : {}),
    acceleration,
    ...(x && y ? { x, y } : {}),
    sourceSampleCount: c.t.length,
    measuredMask,
  };
  return { trace, integratedLength, gaps };
}

/**
 * Longitudinal acceleration (m/s^2) from speed on the distance grid using central differences
 * in time, then a 5-point moving average. Speed is quantised to 1 km/h at ~4 Hz, so raw
 * differences are noisy; the smoothing window (~25 m at 5 m steps) is documented in TELEMETRY_ENGINE.md.
 */
export function longitudinalAcceleration(time: readonly number[], speedKmh: readonly number[]): number[] {
  const n = time.length;
  const raw = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dt = time[b]! - time[a]!;
    raw[i] = dt > 0 ? (speedKmh[b]! - speedKmh[a]!) / 3.6 / dt : 0;
  }
  return movingAverage(raw, 5);
}

export function movingAverage(xs: readonly number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < xs.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(xs.length - 1, i + half); j++) {
      if (Number.isFinite(xs[j]!)) { s += xs[j]!; c++; }
    }
    out[i] = c ? s / c : Number.NaN;
  }
  return out;
}
