import type { AnalysisMeta, DataQuality, DistanceTrace, Warning } from "@lemon-tea/shared-types";
import { buildLapTrace, DISTANCE_ALGORITHM_VERSION } from "./distance.ts";
import { computeDelta, DELTA_CONVENTION, DELTA_NOISE_FLOOR_SECONDS, DELTA_ALGORITHM_VERSION, equalSections, indexAt, sectionDelta, type DeltaResult, type SectionDelta } from "./delta.ts";
import { compareCorner, CORNER_ALGORITHM_VERSION, detectCorners, type CornerComparison, type DetectedCorner } from "./corners.ts";
import { explainCorner, explainStraight, summarize, EXPLANATION_VERSION, type Finding } from "./explain.ts";
import { interpLinearClamped } from "./interpolate.ts";
import type { CarSamples, LapTiming, PositionSamples } from "./samples.ts";
import { round } from "./stats.ts";

export const COMPARISON_VERSION = `lap-comparison-v1(${DISTANCE_ALGORITHM_VERSION},${DELTA_ALGORITHM_VERSION},${CORNER_ALGORITHM_VERSION},${EXPLANATION_VERSION})`;

export interface LapInput {
  sessionId: string;
  driverCode: string;
  timing: LapTiming;
  car: CarSamples;
  pos: PositionSamples | null;
}

export interface LapComparison {
  meta: AnalysisMeta;
  deltaConvention: typeof DELTA_CONVENTION;
  a: { sessionId: string; driverNumber: number; driverCode: string; lapNumber: number; lapTime: number };
  b: { sessionId: string; driverNumber: number; driverCode: string; lapNumber: number; lapTime: number };
  referenceLength: number;
  /** A_minus_B; negative = A faster. Equals the lap-time difference by construction. */
  timeDeltaSeconds: number;
  traces: { a: DistanceTrace; b: DistanceTrace };
  delta: DeltaResult;
  sectors: { sector: number; measuredDelta: number | null; boundaryDistance: number | null }[];
  miniSectors: SectionDelta[];
  corners: CornerComparison[];
  straights: SectionDelta[];
  findings: Finding[];
  summary: string;
  dominantFactor: Finding["factor"] | null;
  maxGained: { distance: number; delta: number };
  maxLost: { distance: number; delta: number };
  confidence: number;
  confidenceType: "algorithmic_quality_score";
  noiseFloorSeconds: number;
}

function trace(L: LapInput, stepMetres: number, referenceLength?: number) {
  return buildLapTrace(L.car, L.pos, {
    sessionId: L.sessionId,
    driverNumber: L.timing.driverNumber,
    lapNumber: L.timing.lapNumber,
    lapStartMs: L.timing.startMs!,
    lapTime: L.timing.lapTime!,
    stepMetres,
    ...(referenceLength !== undefined ? { referenceLength } : {}),
  });
}

/**
 * Two-lap comparison on normalised lap distance. Both laps are scaled to the mean integrated
 * length so start/finish coincide; corner windows are detected on both laps jointly.
 */
export function compareLaps(A: LapInput, B: LapInput, stepMetres = 5): LapComparison {
  const warnings: Warning[] = [];
  for (const L of [A, B]) {
    if (L.timing.startMs === null || L.timing.lapTime === null) {
      throw new Error(`Lap ${L.timing.lapNumber} of #${L.timing.driverNumber} has no start time or lap time`);
    }
  }
  const pre = [trace(A, stepMetres), trace(B, stepMetres)];
  const referenceLength = (pre[0]!.integratedLength + pre[1]!.integratedLength) / 2;
  const lengthMismatch = Math.abs(pre[0]!.integratedLength - pre[1]!.integratedLength) / referenceLength;
  if (lengthMismatch > 0.02) {
    warnings.push({ code: "length_mismatch", message: `Integrated lap lengths differ by ${round(lengthMismatch * 100, 1)}%; laps may include a pit lane pass or different layouts.` });
  }
  const built = [trace(A, stepMetres, referenceLength), trace(B, stepMetres, referenceLength)];
  const ta = built[0]!.trace;
  const tb = built[1]!.trace;
  const gaps = built[0]!.gaps + built[1]!.gaps;
  if (gaps > 0) warnings.push({ code: "sample_gaps", message: `${gaps} gaps >1.5 s between car samples were integrated with mean speed.` });
  if (A.sessionId !== B.sessionId) {
    warnings.push({ code: "cross_session", message: "Laps come from different sessions; track evolution, weather and fuel load differ." });
  }

  const delta = computeDelta(ta, tb);
  const corners = detectCorners([ta, tb]);
  const cornerCmp = corners.map((c) => compareCorner(ta, tb, delta, c));
  const straights = straightsBetween(corners, referenceLength).map((s) => ({ ...s, deltaChange: sectionDelta(delta, s.from, s.to) }));

  // Sector boundaries: where lap B (reference) reached its sector-1 and sector-1+2 times
  const s12 = B.timing.sector1 !== null && B.timing.sector2 !== null ? B.timing.sector1 + B.timing.sector2 : null;
  const boundaries = [B.timing.sector1, s12].map((t) => (t === null ? null : interpLinearClamped(tb.time, tb.distance, t)));
  const keys = ["sector1", "sector2", "sector3"] as const;
  const sectors = keys.map((k, i) => {
    const va = A.timing[k];
    const vb = B.timing[k];
    return {
      sector: i + 1,
      measuredDelta: va !== null && vb !== null ? round(va - vb, 3) : null,
      boundaryDistance: i < 2 ? boundaries[i] ?? null : referenceLength,
    };
  });

  const sameDriver = A.driverCode === B.driverCode;
  const nameA = sameDriver ? `${A.driverCode} (lap ${A.timing.lapNumber})` : A.driverCode;
  const nameB = sameDriver ? `${B.driverCode} (lap ${B.timing.lapNumber})` : B.driverCode;
  const findings: Finding[] = [];
  for (const cc of cornerCmp) if (Math.abs(cc.deltaChange) >= DELTA_NOISE_FLOOR_SECONDS) findings.push(explainCorner(cc, nameA, nameB));
  for (const s of straights) {
    if (Math.abs(s.deltaChange) < DELTA_NOISE_FLOOR_SECONDS) continue;
    const i0 = indexAt(ta.distance, s.from);
    const i1 = indexAt(ta.distance, s.to);
    const top = (t: DistanceTrace) => Math.max(...t.speed.slice(i0, i1 + 1));
    findings.push(explainStraight(s.label, s.deltaChange, top(ta), top(tb), nameA, nameB));
  }
  findings.sort((x, y) => Math.abs(y.deltaChange) - Math.abs(x.deltaChange));

  // Heuristic quality score in [0,1]. NOT a probability. Penalises sparse sampling, gaps, length mismatch.
  const sampleDensity = Math.min(ta.sourceSampleCount, tb.sourceSampleCount) / Math.max(1, Math.min(ta.lapTime ?? 1, tb.lapTime ?? 1));
  const densityScore = Math.min(1, sampleDensity / 3.5); // ~3.7 Hz is the typical public feed rate
  const confidence = round(Math.max(0, Math.min(1, densityScore - gaps * 0.05 - lengthMismatch * 5)), 2);
  const dataQuality: DataQuality = confidence > 0.8 ? "high" : confidence > 0.6 ? "medium" : confidence > 0.3 ? "low" : "insufficient";

  return {
    meta: {
      analysisType: "lap_comparison",
      algorithmVersion: COMPARISON_VERSION,
      generatedAt: new Date().toISOString(),
      sources: [...new Set([A.sessionId.split(":")[0]!, B.sessionId.split(":")[0]!])],
      dataQuality,
      assumptions: [
        "Distance is integrated from measured speed and scaled so both laps share one reference length.",
        "Brake channel is binary on/off; braking intensity is not available.",
        "Corners are detected from speed minima; numbering is sequential, not official turn numbers.",
        `Section deltas below ${DELTA_NOISE_FLOOR_SECONDS} s are within the method's noise floor and are not explained.`,
      ],
      warnings,
      evidence: ["lap_distance_delta", "speed", "throttle", "brake", "sector_times"],
    },
    deltaConvention: DELTA_CONVENTION,
    a: { sessionId: A.sessionId, driverNumber: A.timing.driverNumber, driverCode: A.driverCode, lapNumber: A.timing.lapNumber, lapTime: A.timing.lapTime! },
    b: { sessionId: B.sessionId, driverNumber: B.timing.driverNumber, driverCode: B.driverCode, lapNumber: B.timing.lapNumber, lapTime: B.timing.lapTime! },
    referenceLength,
    timeDeltaSeconds: round(delta.finalDelta, 3),
    traces: { a: ta, b: tb },
    delta,
    sectors,
    miniSectors: equalSections(delta, 25),
    corners: cornerCmp,
    straights,
    findings,
    summary: summarize(findings, delta.finalDelta, nameA, nameB),
    dominantFactor: findings[0]?.factor ?? null,
    maxGained: delta.maxLeadForA,
    maxLost: delta.maxDeficitForA,
    confidence,
    confidenceType: "algorithmic_quality_score",
    noiseFloorSeconds: DELTA_NOISE_FLOOR_SECONDS,
  };
}

/** Segments between corner windows; together with corner windows they partition the lap. */
export function straightsBetween(corners: DetectedCorner[], length: number): { label: string; from: number; to: number }[] {
  const out: { label: string; from: number; to: number }[] = [];
  let cursor = 0;
  let k = 1;
  for (const c of corners) {
    if (c.windowStart - cursor > 50) out.push({ label: `straight S${k++}`, from: cursor, to: c.windowStart });
    cursor = Math.max(cursor, c.windowEnd);
  }
  if (length - cursor > 50) out.push({ label: `straight S${k}`, from: cursor, to: length });
  return out;
}
