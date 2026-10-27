/**
 * Column-oriented raw sample containers used by every algorithm. Times are milliseconds
 * relative to the session epoch; positions are metres in the source frame.
 */

export interface CarSamples {
  t: number[];
  speed: number[];
  throttle: number[];
  brake: number[];
  rpm?: number[];
  gear?: number[];
  drs?: (number | null)[];
}

export interface PositionSamples {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
}

export interface LapTiming {
  driverNumber: number;
  lapNumber: number;
  /** ms since session epoch; null when the source did not provide a start timestamp. */
  startMs: number | null;
  lapTime: number | null;
  sector1: number | null;
  sector2: number | null;
  sector3: number | null;
  isPitOutLap: boolean;
  stSpeed?: number | null;
}

export function sliceByTime<T extends { t: number[] }>(s: T, fromMs: number, toMs: number): T {
  let lo = 0;
  while (lo < s.t.length && s.t[lo]! < fromMs) lo++;
  let hi = lo;
  while (hi < s.t.length && s.t[hi]! <= toMs) hi++;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) out[k] = Array.isArray(v) ? v.slice(lo, hi) : v;
  return out as T;
}

/** Sort by time and drop exact-duplicate timestamps (sources occasionally repeat samples). */
export function normalizeSamples<T extends { t: number[] }>(s: T): T {
  const idx = s.t.map((_, i) => i).sort((a, b) => s.t[a]! - s.t[b]!);
  const keep: number[] = [];
  let last = -Infinity;
  for (const i of idx) {
    if (s.t[i]! !== last) keep.push(i);
    last = s.t[i]!;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) out[k] = Array.isArray(v) ? keep.map((i) => v[i]) : v;
  return out as T;
}
