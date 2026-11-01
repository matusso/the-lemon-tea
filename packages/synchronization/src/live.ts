import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";
import { positionAt } from "./positions.ts";

/** Sample payload of one live delta, as sent over the live WebSocket (epoch-ms times). */
export interface LiveSamplesPayload {
  car?: Record<string, CarSamples>;
  position?: Record<string, PositionSamples>;
}

type Columns = Record<string, unknown[]> & { t: number[] };

/** Append `inc` (time-sorted) to `cur`, keeping time order and dropping duplicate times. */
function mergeColumns<T extends Columns>(cur: T, inc: T): void {
  const keys = Object.keys(cur).filter((k) => Array.isArray(inc[k]));
  if (!inc.t.length) return;
  const last = cur.t.length ? cur.t[cur.t.length - 1]! : -Infinity;
  if (inc.t[0]! > last) {
    for (const k of keys) (cur[k] as unknown[]).push(...(inc[k] as unknown[]));
    return;
  }
  // overlapping delta (reconnect, late batch): rebuild in time order
  const rows = new Map<number, Record<string, unknown>>();
  for (const src of [cur, inc]) {
    for (let i = 0; i < src.t.length; i++) rows.set(src.t[i]!, Object.fromEntries(keys.map((k) => [k, (src[k] as unknown[])[i]])));
  }
  const ts = [...rows.keys()].sort((a, b) => a - b);
  for (const k of keys) (cur as Record<string, unknown[]>)[k] = ts.map((t) => rows.get(t)![k]);
}

function trimBefore<T extends Columns>(s: T, minT: number): void {
  let i = 0;
  while (i < s.t.length && s.t[i]! < minT) i++;
  if (!i) return;
  for (const k of Object.keys(s)) if (Array.isArray(s[k])) (s as Record<string, unknown[]>)[k] = (s[k] as unknown[]).slice(i);
}

/**
 * Rolling in-memory buffer of live samples, in session time (ms since the session epoch) like
 * replay data, so the same rendering code draws both. Only the most recent `keepMs` is kept.
 */
export class LiveBuffer {
  readonly positions = new Map<number, PositionSamples>();
  readonly car = new Map<number, CarSamples>();
  /** Latest sample time (session ms) over all cars; -Infinity before any data. */
  latestMs = -Infinity;
  private version = 0;

  constructor(
    readonly epochMs: number,
    private readonly keepMs = 15 * 60_000,
  ) {}

  /** Monotonic counter, bumped whenever samples are added. */
  get revision(): number {
    return this.version;
  }

  ingest(p: LiveSamplesPayload): number {
    let added = 0;
    const shift = <T extends Columns>(s: T): T => ({ ...s, t: s.t.map((t) => t - this.epochMs) });
    for (const [k, s] of Object.entries(p.position ?? {})) {
      if (!s?.t?.length) continue;
      const dn = Number(k);
      const inc = shift(s as unknown as Columns) as unknown as PositionSamples;
      if (!inc.z || inc.z.length !== inc.t.length) inc.z = new Array(inc.t.length).fill(0);
      const cur = this.positions.get(dn);
      if (cur) mergeColumns(cur as unknown as Columns, inc as unknown as Columns);
      else this.positions.set(dn, { t: [...inc.t], x: [...inc.x], y: [...inc.y], z: [...inc.z] });
      this.latestMs = Math.max(this.latestMs, inc.t[inc.t.length - 1]!);
      added += inc.t.length;
    }
    for (const [k, s] of Object.entries(p.car ?? {})) {
      if (!s?.t?.length) continue;
      const dn = Number(k);
      const inc = shift(s as unknown as Columns) as unknown as CarSamples;
      const cur = this.car.get(dn);
      if (cur) mergeColumns(cur as unknown as Columns, inc as unknown as Columns);
      else this.car.set(dn, { ...inc, t: [...inc.t] });
      this.latestMs = Math.max(this.latestMs, inc.t[inc.t.length - 1]!);
      added += inc.t.length;
    }
    if (added) {
      const minT = this.latestMs - this.keepMs;
      for (const s of this.positions.values()) trimBefore(s as unknown as Columns, minT);
      for (const s of this.car.values()) trimBefore(s as unknown as Columns, minT);
      this.version++;
    }
    return added;
  }

  /** Same contract as the replay cache: position samples covering time t (all buffered data). */
  at(_t: number): Map<number, PositionSamples> {
    return this.positions;
  }
}

/** One driver's lap as seen live, on the circuit's distance axis. */
export interface LiveLap {
  /** Session ms when the car crossed the start of this lap (first sample after the wrap). */
  startMs: number;
  /** Whether the lap was observed through to the next line crossing. */
  complete: boolean;
  distance: number[];
  /** Session ms of each point. */
  t: number[];
  speed: number[];
  throttle: number[];
  brake: number[];
}

/**
 * Split a car's buffered samples into laps on the circuit distance axis. Each car sample is
 * placed on the track with the interpolated position at its time and projected onto the
 * centreline (`project`, metres from the start line). A lap ends where distance wraps.
 * Samples without a position fix within 2 s are skipped.
 */
export function liveLaps(car: CarSamples, pos: PositionSamples, project: (x: number, y: number) => number, lapLength: number): LiveLap[] {
  const laps: LiveLap[] = [];
  let cur: LiveLap | null = null;
  let prevD = -Infinity;
  for (let i = 0; i < car.t.length; i++) {
    const t = car.t[i]!;
    const p = positionAt(pos, t);
    if (!p) continue;
    const d = project(p.x, p.y);
    // wrap: a big backwards jump in distance is a line crossing (small ones are projection noise)
    if (!cur || d < prevD - lapLength / 2) {
      if (cur) cur.complete = true;
      cur = { startMs: t, complete: false, distance: [], t: [], speed: [], throttle: [], brake: [] };
      laps.push(cur);
    } else if (d < prevD) continue; // projection jitter backwards: keep distance monotonic
    cur.distance.push(d);
    cur.t.push(t);
    cur.speed.push(car.speed[i]!);
    cur.throttle.push(car.throttle[i]!);
    cur.brake.push(car.brake[i]!);
    prevD = d;
  }
  // the first lap usually starts mid-lap (buffer start): it is not a full lap
  if (laps[0] && laps[0].distance[0]! > 30) laps[0].complete = false;
  return laps;
}

/** Time (session ms) at which a car was at distance `d` in a lap, linearly interpolated. */
function timeAtDistance(lap: LiveLap, d: number): number | null {
  const n = lap.distance.length;
  if (n < 2 || d < lap.distance[0]! || d > lap.distance[n - 1]!) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (lap.distance[m]! <= d) lo = m;
    else hi = m;
  }
  const d0 = lap.distance[lo]!;
  const d1 = lap.distance[hi]!;
  const f = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
  return lap.t[lo]! + f * (lap.t[hi]! - lap.t[lo]!);
}

/**
 * On-road gap between two cars from their live laps: how long ago the car ahead passed the point
 * where the car behind is now. Null when the cars' recent laps do not overlap.
 */
export function liveGap(a: LiveLap[], b: LiveLap[]): { ahead: "a" | "b"; seconds: number } | null {
  const now = (laps: LiveLap[]) => {
    const l = laps[laps.length - 1];
    return l && l.t.length ? { d: l.distance[l.distance.length - 1]!, t: l.t[l.t.length - 1]! } : null;
  };
  const passedAt = (laps: LiveLap[], d: number, before: number) => {
    for (let i = laps.length - 1; i >= 0; i--) {
      const t = timeAtDistance(laps[i]!, d);
      if (t !== null && t <= before) return t;
    }
    return null;
  };
  const na = now(a);
  const nb = now(b);
  if (!na || !nb) return null;
  const aPassedB = passedAt(a, nb.d, nb.t);
  const bPassedA = passedAt(b, na.d, na.t);
  const gapBehindA = aPassedB !== null ? nb.t - aPassedB : null; // b is this far behind a
  const gapBehindB = bPassedA !== null ? na.t - bPassedA : null;
  const pick =
    gapBehindA !== null && (gapBehindB === null || gapBehindA <= gapBehindB)
      ? { ahead: "a" as const, seconds: gapBehindA / 1000 }
      : gapBehindB !== null
        ? { ahead: "b" as const, seconds: gapBehindB / 1000 }
        : null;
  // a car whose feed stalled (pits, no fix) more than 10 s ago gives no meaningful gap
  return pick && Math.abs(na.t - nb.t) < 10_000 ? pick : null;
}
