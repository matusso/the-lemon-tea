import type { DistanceTrace } from "@lemon-tea/shared-types";
import { detectCorners, grid, indexAt, interpLinear, median, movingAverage, round } from "@lemon-tea/telemetry-core";

export const CIRCUIT_ENGINE_VERSION = "circuit-geometry-v2";

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
  const zs = usable.filter((l) => l.z).map((l) => ga.map((a) => interpLinear(l.trace.distance, l.z!, Math.min((a * scale * lapLen(l.trace)) / L, lapLen(l.trace)))));
  if (zs.length >= 2) {
    const zMed = ga.map((_, i) => median(zs.map((zz) => zz[i]!).filter(Number.isFinite)));
    const zDev = Math.sqrt(median(zs.flatMap((zz) => zz.map((v, i) => (v - zMed[i]!) ** 2)).filter(Number.isFinite)));
    const range = Math.max(...zMed) - Math.min(...zMed);
    if (zDev < 1 && range > 1) z = movingAverage(zMed, 9);
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
