import type { DistanceTrace } from "@lemon-tea/shared-types";
import { indexAt } from "./delta.ts";
import type { LapTiming } from "./samples.ts";
import { round } from "./stats.ts";
import { cornerMetrics, detectCorners } from "./corners.ts";

export const DOMINANCE_VERSION = "track-dominance-v1";

export interface DominanceSegment {
  segment: number;
  from: number;
  to: number;
  fastestDriver: number;
  /** Segment time per driver (s), from the distance-aligned traces. */
  times: Record<number, number>;
  /** Margin over the second-fastest driver (s). */
  margin: number;
}

/**
 * Segment-level dominance from each driver's fastest lap, all aligned to one reference length.
 * Comparable conditions are the caller's responsibility (same session; fastest valid laps).
 */
export function trackDominance(traces: DistanceTrace[], segments: number): DominanceSegment[] {
  const L = traces[0]!.distance[traces[0]!.distance.length - 1]!;
  const out: DominanceSegment[] = [];
  for (let k = 0; k < segments; k++) {
    const from = (L * k) / segments;
    const to = (L * (k + 1)) / segments;
    const times: Record<number, number> = {};
    for (const t of traces) times[t.driverNumber] = t.time[indexAt(t.distance, to)]! - t.time[indexAt(t.distance, from)]!;
    const ranked = Object.entries(times).sort((a, b) => a[1] - b[1]);
    out.push({
      segment: k + 1,
      from,
      to,
      fastestDriver: Number(ranked[0]![0]),
      times: Object.fromEntries(Object.entries(times).map(([d, v]) => [d, round(v, 3)])),
      margin: round((ranked[1]?.[1] ?? ranked[0]![1]) - ranked[0]![1], 3),
    });
  }
  return out;
}

export interface TheoreticalBest {
  driverNumber: number | null;
  bestLap: number | null;
  /** Sum of best individual sector times. Mathematically combined; not shown to be achievable in one lap. */
  theoreticalBest: number | null;
  potentialGain: number | null;
  sectors: { sector: number; time: number; lapNumber: number; driverNumber: number }[];
  kind: "calculated";
  note: string;
}

export function theoreticalBestLap(laps: LapTiming[], driverNumber: number | null): TheoreticalBest {
  const pool = laps.filter((l) => (driverNumber === null || l.driverNumber === driverNumber) && !l.isPitOutLap);
  const sectors: TheoreticalBest["sectors"] = [];
  const keys = ["sector1", "sector2", "sector3"] as const;
  keys.forEach((k, i) => {
    let best: LapTiming | null = null;
    for (const l of pool) if (l[k] !== null && (best === null || l[k]! < best[k]!)) best = l;
    if (best) sectors.push({ sector: i + 1, time: best[k]!, lapNumber: best.lapNumber, driverNumber: best.driverNumber });
  });
  const timed = pool.filter((l) => l.lapTime !== null);
  const bestLap = timed.length ? Math.min(...timed.map((l) => l.lapTime!)) : null;
  const tb = sectors.length === 3 ? round(sectors.reduce((a, s) => a + s.time, 0), 3) : null;
  return {
    driverNumber,
    bestLap,
    theoreticalBest: tb,
    potentialGain: tb !== null && bestLap !== null ? round(bestLap - tb, 3) : null,
    sectors,
    kind: "calculated",
    note: "Sum of best sectors from different laps. Tyre state, fuel, track evolution and traffic differ between those laps, so it is not a physically demonstrated lap.",
  };
}

export interface DriverFingerprint {
  driverNumber: number;
  laps: number;
  /** Mean distance from brake start to speed minimum, by corner band (m). */
  brakingToApex: Record<"low" | "medium" | "high", number | null>;
  minSpeedRatio: Record<"low" | "medium" | "high", number | null>;
  /** Mean exit acceleration (m/s^2) by band. */
  exitAcceleration: Record<"low" | "medium" | "high", number | null>;
  /** Share of lap distance at >=99% throttle. */
  fullThrottleShare: number;
  /** Share of lap distance with brake applied. */
  brakeShare: number;
  topSpeed: number;
  /** Robust sd of the driver's push lap times (s). */
  lapConsistency: number | null;
  kind: "calculated";
}

/**
 * Data-derived characterisation. Values are relative descriptors from telemetry, not labels
 * like "aggressive"; comparisons are only meaningful within one session/circuit.
 */
export function driverFingerprint(traces: DistanceTrace[], fieldReference: DistanceTrace[], lapConsistency: number | null): DriverFingerprint {
  const corners = detectCorners(fieldReference.length ? fieldReference : traces);
  const bands = { low: [] as number[][], medium: [] as number[][], high: [] as number[][] };
  for (const t of traces) {
    for (const c of corners) {
      const m = cornerMetrics(t, c);
      bands[c.band].push([
        m.brakeStart !== null ? m.minSpeedDistance - m.brakeStart : Number.NaN,
        m.minSpeed / Math.max(1, m.approachSpeed),
        m.exitAcceleration,
      ]);
    }
  }
  const avgCol = (rows: number[][], k: number) => {
    const v = rows.map((r) => r[k]!).filter(Number.isFinite);
    return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 3) : null;
  };
  const share = (pred: (t: DistanceTrace, i: number) => boolean) => {
    let hit = 0, tot = 0;
    for (const t of traces) for (let i = 0; i < t.distance.length; i++) { tot++; if (pred(t, i)) hit++; }
    return tot ? round(hit / tot, 3) : 0;
  };
  return {
    driverNumber: traces[0]!.driverNumber,
    laps: traces.length,
    brakingToApex: { low: avgCol(bands.low, 0), medium: avgCol(bands.medium, 0), high: avgCol(bands.high, 0) },
    minSpeedRatio: { low: avgCol(bands.low, 1), medium: avgCol(bands.medium, 1), high: avgCol(bands.high, 1) },
    exitAcceleration: { low: avgCol(bands.low, 2), medium: avgCol(bands.medium, 2), high: avgCol(bands.high, 2) },
    fullThrottleShare: share((t, i) => t.throttle[i]! >= 99),
    brakeShare: share((t, i) => t.brake[i]! > 0),
    topSpeed: Math.max(...traces.flatMap((t) => t.speed)),
    lapConsistency,
    kind: "calculated",
  };
}
