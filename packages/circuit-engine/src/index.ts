import type { DistanceTrace } from "@lemon-tea/shared-types";
import { detectCorners, grid, indexAt, interpLinear, median, movingAverage, round } from "@lemon-tea/telemetry-core";

export const CIRCUIT_ENGINE_VERSION = "circuit-geometry-v4";

export interface LapGeometryCheck {
  ok: boolean;
  reason: string | null;
  /** Path length of the measured x/y samples (m). */
  pathLengthM: number;
  /** Distance between the first and last measured position of the lap (m). */
  closureM: number;
}

/**
 * Whether one lap's measured positions can be trusted to describe the circuit.
 *
 * Live-timing feeds regularly carry stretches where car or position data is missing or frozen
 * (the car "parks" in the stream while the lap counter keeps running). Such a lap still has a
 * valid lap time, so the fastest-lap choice alone happily picks it, and the derived line becomes
 * a fragment of the circuit. A usable lap must:
 *  - have a plausible speed-integrated length (mean speed 80–330 km/h over the lap time)
 *  - have x/y samples whose path length agrees with that length within 12 %
 *  - close on itself: start and end positions within 0.8 % of the lap length (min 40 m)
 *  - have car data at ≥ 2 samples/s over the lap (the feed's nominal rate is ~4 Hz)
 */
export function checkLapGeometry(trace: DistanceTrace, integratedLength: number): LapGeometryCheck {
  const bad = (reason: string, pathLengthM = 0, closureM = Number.POSITIVE_INFINITY): LapGeometryCheck => ({ ok: false, reason, pathLengthM, closureM });
  const meanKmh = (integratedLength / Math.max(1, trace.lapTime ?? 0)) * 3.6;
  if (!Number.isFinite(integratedLength) || meanKmh < 80 || meanKmh > 330) return bad(`implausible mean speed ${meanKmh.toFixed(0)} km/h`);
  const xs = trace.x;
  const ys = trace.y;
  if (!xs || !ys || xs.length < 10) return bad("no position samples");
  if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return bad("position samples have gaps");
  let path = 0;
  for (let i = 1; i < xs.length; i++) path += Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!);
  const closure = Math.hypot(xs[0]! - xs[xs.length - 1]!, ys[0]! - ys[ys.length - 1]!);
  if (Math.abs(path / integratedLength - 1) > 0.12) return bad(`position path ${path.toFixed(0)} m vs ${integratedLength.toFixed(0)} m from speed`, path, closure);
  if (closure > Math.max(40, 0.008 * integratedLength)) return bad(`lap does not close (${closure.toFixed(0)} m)`, path, closure);
  // Car data arrives at ~4 Hz; well under 2 Hz means the speed trace (and so distance) is mostly bridged gaps.
  const hz = trace.sourceSampleCount / Math.max(1, trace.lapTime ?? 0);
  if (hz < 2) return bad(`sparse car data (${hz.toFixed(1)} samples/s)`, path, closure);
  return { ok: true, reason: null, pathLengthM: path, closureM: closure };
}

export interface DerivedGeometry {
  x: number[];
  y: number[];
  z?: number[];
  distance: number[];
  corners: { number: number; label: string; distance: number; x: number; y: number; source: "detected" | "official" }[];
  sectorBoundaries: number[];
  startFinish: { x: number; y: number; heading: number };
  origin: { x: number; y: number; z: number };
}

export interface GeometryResult {
  geometry: DerivedGeometry;
  lengthM: number;
  /** RMS lateral scatter of the input laps around the derived centreline (m). */
  accuracyM: number;
  confidence: "high" | "medium" | "low";
  provenance: Record<string, unknown>;
}

/**
 * Derive a circuit "driven line" from measured car positions of several clean laps.
 *
 * The fastest lap's x/y samples define the line: its path is resampled every 5 m of *path length*
 * (not speed-integrated distance, which drifts along-track) and lightly smoothed (25 m window).
 * The line's distance axis is then scaled to the median speed-integrated lap length so that lap
 * distance from telemetry maps onto it. Accuracy is the RMS *lateral* distance of the other laps'
 * raw samples to this line, i.e. how well independent measurements agree with it.
 *
 * This is not surveyed geometry: track width is unknown and not drawn. Elevation is kept only if
 * per-lap z agrees within 1 m; otherwise it is omitted rather than invented.
 */
export function deriveGeometry(
  laps: { trace: DistanceTrace; z?: number[] }[],
  sectorBoundaries: number[],
  meta: { source: string; sessionId: string; laps: string[] },
): GeometryResult {
  const usable = laps.filter((l) => l.trace.x && l.trace.y && l.trace.x.every(Number.isFinite) && l.trace.y.every(Number.isFinite));
  if (usable.length === 0) throw new Error("No laps with complete position data");
  const lapLen = (t: DistanceTrace) => t.distance[t.distance.length - 1]!;
  const L = median(usable.map((l) => lapLen(l.trace)));
  const ref = usable[0]!;

  // Path-length parameterisation of the reference lap.
  const rx = ref.trace.x!;
  const ry = ref.trace.y!;
  const arc = [0];
  for (let i = 1; i < rx.length; i++) arc.push(arc[i - 1]! + Math.hypot(rx[i]! - rx[i - 1]!, ry[i]! - ry[i - 1]!));
  const pathLen = arc[arc.length - 1]!;
  const ga = grid(0, pathLen, 5);
  let x = movingAverage(ga.map((a) => interpLinear(arc, rx, a)), 5);
  let y = movingAverage(ga.map((a) => interpLinear(arc, ry, a)), 5);
  const scale = L / pathLen;
  const distance = ga.map((a) => a * scale);

  // Lateral agreement of the other laps with the reference line.
  let ss = 0;
  let n = 0;
  for (const l of usable.slice(1)) {
    for (let i = 0; i < l.trace.x!.length; i += 4) {
      const { offset } = nearestDistance({ x, y, distance }, l.trace.x![i]!, l.trace.y![i]!);
      ss += offset * offset;
      n++;
    }
  }
  const accuracyM = n ? Math.sqrt(ss / n) : Number.NaN;

  let z: number[] | undefined;
  const zs = usable
    .filter((l) => l.z)
    .map((l) => cleanElevation(ga.map((a) => interpLinear(l.trace.distance, l.z!, Math.min((a * scale * lapLen(l.trace)) / L, lapLen(l.trace))))))
    .filter((zz): zz is number[] => zz !== null);
  if (zs.length >= 2) {
    const zMed = fillGaps(ga.map((_, i) => median(zs.map((zz) => zz[i]!).filter(Number.isFinite))));
    if (zMed) {
      const zDev = Math.sqrt(median(zs.flatMap((zz) => zz.map((v, i) => (v - zMed[i]!) ** 2)).filter(Number.isFinite)));
      const smooth = movingAverage(zMed, 9);
      if (zDev < 1 && plausibleElevation(smooth)) z = smooth;
    }
  }

  const origin = { x: median(x), y: median(y), z: z ? Math.min(...z) : 0 };
  x = x.map((v) => round(v - origin.x, 2));
  y = y.map((v) => round(v - origin.y, 2));
  if (z) z = z.map((v) => round(v - origin.z, 2));

  const traces = usable.map((l) => l.trace);
  const toGeo = L / lapLen(traces[0]!);
  const corners = detectCorners(traces).map((c) => {
    const i = indexAt(distance, c.minSpeedDistance * toGeo);
    return { number: c.index, label: c.label, distance: round(distance[i]!, 1), x: x[i]!, y: y[i]!, source: "detected" as const };
  });

  const heading = Math.atan2(y[2]! - y[0]!, x[2]! - x[0]!);
  const confidence = usable.length >= 3 && accuracyM < 2.5 ? "high" : usable.length >= 2 && accuracyM < 5 ? "medium" : "low";
  return {
    geometry: {
      x,
      y,
      ...(z ? { z } : {}),
      distance: distance.map((d) => round(d, 1)),
      corners,
      sectorBoundaries: sectorBoundaries.map((d) => round(d * toGeo, 1)),
      startFinish: { x: x[0]!, y: y[0]!, heading: round(heading, 4) },
      origin,
    },
    lengthM: round(L, 1),
    accuracyM: round(accuracyM, 2),
    confidence,
    provenance: {
      method: "fastest clean lap's measured positions resampled every 5 m of path length; accuracy = RMS lateral distance of other laps' samples",
      algorithmVersion: CIRCUIT_ENGINE_VERSION,
      source: meta.source,
      sessionId: meta.sessionId,
      laps: meta.laps,
      pathLengthM: round(pathLen, 1),
      elevation: z ? "from source z, per-lap agreement < 1 m" : "omitted: source z not consistent enough",
      trackWidth: "unavailable",
      corners: "detected from speed minima; not official turn numbers",
      kind: "estimated",
    },
  };
}

/** Largest elevation change on any current F1 circuit is ~100 m (Spa); allow some margin. */
const MAX_ELEVATION_RANGE_M = 150;
/** Steepest plausible grade between 5 m samples after smoothing (Eau Rouge is ~18 %). */
const MAX_GRADE = 0.3;

/**
 * One lap's elevation on the 5 m grid with missing samples removed. Live feeds encode a missing
 * z as exactly 0 (circuits sit far above or below sea level by more than noise), and spikes appear
 * where a sample is interpolated against such a zero. Values far from the lap median are dropped.
 * Returns null when too little of the lap is left to trust.
 */
export function cleanElevation(zs: readonly number[]): number[] | null {
  const valid = zs.filter((v) => Number.isFinite(v) && v !== 0);
  if (valid.length < zs.length * 0.8) return null;
  const m = median(valid);
  const out = zs.map((v) => (Number.isFinite(v) && v !== 0 && Math.abs(v - m) <= MAX_ELEVATION_RANGE_M ? v : Number.NaN));
  return out.filter(Number.isFinite).length >= zs.length * 0.8 ? out : null;
}

/** Linear interpolation over NaN gaps, wrapping around the closed lap; null when nothing is finite. */
export function fillGaps(xs: readonly number[]): number[] | null {
  const n = xs.length;
  const idx = xs.flatMap((v, i) => (Number.isFinite(v) ? [i] : []));
  if (!idx.length) return null;
  const out = [...xs];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(out[i]!)) continue;
    const k = idx.findIndex((j) => j > i);
    const next = k === -1 ? idx[0]! + n : idx[k]!;
    const prev = k <= 0 ? idx[idx.length - 1]! - (k === 0 ? n : 0) : idx[k - 1]!;
    const a = xs[((prev % n) + n) % n]!;
    const b = xs[next % n]!;
    out[i] = next === prev ? a : a + ((b - a) * (i - prev)) / (next - prev);
  }
  return out;
}

/** Elevation worth drawing: a real variation, within circuit-plausible range and grade. */
export function plausibleElevation(z: readonly number[], stepM = 5): boolean {
  const range = Math.max(...z) - Math.min(...z);
  if (!(range > 1 && range < MAX_ELEVATION_RANGE_M)) return false;
  for (let i = 1; i < z.length; i++) if (Math.abs(z[i]! - z[i - 1]!) > MAX_GRADE * stepM) return false;
  return true;
}

/**
 * Closed laps found in one car's position trace alone, without lap timing.
 *
 * Used when the source's lap timing cannot be aligned with its samples. A lap is the span
 * between two consecutive passes of the car close to an anchor point (default: the first point
 * where the car is running), as long as the path between them is circuit-length, contiguous
 * (no sample gap above `maxGapMs`) and driven at racing speed. Passes are local minima of the
 * distance to the anchor below `passRadiusM`.
 */
export function findPositionLoops(
  pos: { t: readonly number[]; x: readonly number[]; y: readonly number[] },
  o: { anchor?: { x: number; y: number } | null; minLengthM?: number; maxLengthM?: number; maxGapMs?: number; passRadiusM?: number; minMeanKmh?: number; max?: number } = {},
): { startMs: number; endMs: number; pathLengthM: number }[] {
  const minLen = o.minLengthM ?? 2500;
  const maxLen = o.maxLengthM ?? 8000;
  const maxGap = o.maxGapMs ?? 2000;
  const radius = o.passRadiusM ?? 25;
  const minMean = o.minMeanKmh ?? 120;
  const max = o.max ?? 3;
  const n = pos.t.length;
  if (n < 50) return [];
  // cumulative path; NaN across gaps so a loop can never bridge one
  const cum = new Array<number>(n).fill(0);
  const seg = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const gap = pos.t[i]! - pos.t[i - 1]! > maxGap;
    seg[i] = gap ? seg[i - 1]! + 1 : seg[i - 1]!;
    cum[i] = cum[i - 1]! + (gap ? 0 : Math.hypot(pos.x[i]! - pos.x[i - 1]!, pos.y[i]! - pos.y[i - 1]!));
  }
  let anchor = o.anchor ?? null;
  if (!anchor) {
    // first sample that starts a stretch of fast running (≥ 80 m, i.e. 144 km/h, in the next 2 s)
    for (let i = 0, j = 0; i < n && !anchor; i++) {
      while (j < n - 1 && pos.t[j]! - pos.t[i]! < 2000) j++;
      if (seg[j] === seg[i] && cum[j]! - cum[i]! > 80) anchor = { x: pos.x[i]!, y: pos.y[i]! };
    }
  }
  if (!anchor) return [];
  const d = (i: number) => Math.hypot(pos.x[i]! - anchor!.x, pos.y[i]! - anchor!.y);
  const passes: number[] = [];
  for (let i = 0; i < n; i++) {
    const di = d(i);
    const prev = i > 0 && seg[i - 1] === seg[i] ? d(i - 1) : Infinity;
    const next = i < n - 1 && seg[i + 1] === seg[i] ? d(i + 1) : Infinity;
    if (di < radius && di <= prev && di < next) {
      const last = passes[passes.length - 1];
      if (last !== undefined && pos.t[i]! - pos.t[last]! < 20_000) {
        if (di < d(last)) passes[passes.length - 1] = i; // same pass, closer sample
      } else passes.push(i);
    }
  }
  const out: { startMs: number; endMs: number; pathLengthM: number }[] = [];
  for (let k = 1; k < passes.length && out.length < max; k++) {
    const a = passes[k - 1]!;
    const b = passes[k]!;
    if (seg[a] !== seg[b]) continue;
    const len = cum[b]! - cum[a]!;
    const sec = (pos.t[b]! - pos.t[a]!) / 1000;
    if (len < minLen || len > maxLen || (len / sec) * 3.6 < minMean) continue;
    out.push({ startMs: pos.t[a]!, endMs: pos.t[b]!, pathLengthM: len });
  }
  return out;
}

/** Distance along the centreline nearest to a point (used for map clicks). */
export function nearestDistance(geo: Pick<DerivedGeometry, "x" | "y" | "distance">, px: number, py: number): { distance: number; offset: number } {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < geo.x.length; i++) {
    const d = (geo.x[i]! - px) ** 2 + (geo.y[i]! - py) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { distance: geo.distance[best]!, offset: Math.sqrt(bd) };
}

/** Point on the centreline at a given distance (wraps around the lap). */
export function pointAtDistance(geo: Pick<DerivedGeometry, "x" | "y" | "distance">, d: number): { x: number; y: number } {
  const L = geo.distance[geo.distance.length - 1]!;
  const dd = ((d % L) + L) % L;
  return { x: interpLinear(geo.distance, geo.x, dd), y: interpLinear(geo.distance, geo.y, dd) };
}
