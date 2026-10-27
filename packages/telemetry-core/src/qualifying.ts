import type { AnalysisMeta, Interval, Warning } from "@lemon-tea/shared-types";
import type { ClassifiedLap } from "./classify.ts";
import { DEFAULT_PACE_PARAMS, groupBy, type PaceModelParams } from "./degradation.ts";
import { mean, median, Rng, round, zForLevel } from "./stats.ts";

export const QUALIFYING_MODEL_VERSION = "quali-practice-v2";

export interface DriverInfo {
  driverNumber: number;
  code: string;
  teamName: string;
}

export interface QualifyingDriverPrediction {
  driverNumber: number;
  code: string;
  teamName: string;
  projectedLapTime: number;
  interval: Interval;
  sigma: number;
  expectedRank: number;
  rankDistribution: number[];
  probabilities: { pole: number; frontRow: number; advanceQ1: number; advanceQ2: number; top10: number };
  evidence: {
    bestRawLap: number;
    bestLapSession: string;
    bestLapNumber: number;
    compound: string;
    tyreAge: number | null;
    adjustments: { sessionEvolution: number; compound: number; qualifyingImprovement: number };
    representativeLaps: number;
    bestSectors: [number | null, number | null, number | null];
  };
  explanation: string;
}

export interface QualifyingPrediction {
  meta: AnalysisMeta;
  modelVersion: string;
  paramsVersion: string;
  confidenceType: "uncalibrated_probability" | "calibrated_probability";
  sessionIds: string[];
  sessionOffsets: Record<string, number>;
  compoundOffsets: Record<string, { value: number; source: "estimated_from_data" | "prior" }>;
  drivers: QualifyingDriverPrediction[];
  teammateGaps: { teamName: string; driverA: string; driverB: string; expectedGap: number; sd: number }[];
  iterations: number;
  seed: number;
}

/**
 * Practice -> qualifying projection.
 *
 *  1. candidate laps: push / qualifying-simulation laps that are not interrupted, traffic-affected,
 *     out or in laps
 *  2. session evolution: each session is put on the scale of the latest session using the median
 *     over drivers present in both of (best lap difference)
 *  3. compound: non-soft bests are adjusted by a compound offset estimated from drivers who set
 *     push laps on both compounds, else a documented prior
 *  4. per session, the driver's best adjusted lap; these are combined with recency weights
 *     (session index + 1), minus the expected practice-to-qualifying improvement, as the point estimate; sigma combines run-to-run spread, adjustment uncertainty and the
 *     unknown fuel/engine-mode state of practice laps (latent, not measured)
 *  5. Monte Carlo over independent normal errors plus a shared improvement term gives ranking
 *     probabilities
 */
export function predictQualifying(
  laps: ClassifiedLap[],
  drivers: DriverInfo[],
  sessionOrder: string[],
  opts: { params?: PaceModelParams; iterations?: number; seed?: number; level?: number } = {},
): QualifyingPrediction {
  const params = opts.params ?? DEFAULT_PACE_PARAMS;
  const iterations = opts.iterations ?? 5000;
  const seed = opts.seed ?? 7;
  const level = opts.level ?? 0.8;
  const warnings: Warning[] = [];

  const eligible = laps.filter(
    (l) =>
      l.lapTime !== null &&
      (l.classes.includes("push") || l.classes.includes("qualifying_simulation")) &&
      !l.classes.some((c) => c === "interrupted" || c === "traffic_affected" || c === "out_lap" || c === "in_lap"),
  );
  if (!eligible.length) throw new Error("No representative push laps in the supplied sessions");

  // 2. session evolution offsets relative to the latest session that has push laps
  const sessionsWithLaps = sessionOrder.filter((s) => eligible.some((l) => l.sessionId === s));
  const ref = sessionsWithLaps[sessionsWithLaps.length - 1]!;
  const bestBy = (sid: string, compoundFilter?: string) => {
    const m = new Map<number, number>();
    for (const l of eligible) {
      if (l.sessionId !== sid || (compoundFilter && l.compound !== compoundFilter)) continue;
      m.set(l.driverNumber, Math.min(m.get(l.driverNumber) ?? Infinity, l.lapTime!));
    }
    return m;
  };
  const refBest = bestBy(ref);
  const sessionOffsets: Record<string, number> = { [ref]: 0 };
  for (const sid of sessionsWithLaps) {
    if (sid === ref) continue;
    const b = bestBy(sid);
    const diffs = [...b].filter(([d]) => refBest.has(d)).map(([d, t]) => refBest.get(d)! - t);
    sessionOffsets[sid] = diffs.length >= 3 ? round(median(diffs), 3) : 0;
    if (diffs.length < 3) warnings.push({ code: "session_offset_unestimated", message: `Too few common drivers to estimate evolution between ${sid} and ${ref}; offset set to 0.` });
  }

  // 3. compound offsets vs SOFT from drivers with both
  const compoundOffsets: QualifyingPrediction["compoundOffsets"] = { SOFT: { value: 0, source: "estimated_from_data" } };
  for (const comp of ["MEDIUM", "HARD"]) {
    const diffs: number[] = [];
    for (const sid of sessionsWithLaps) {
      const soft = bestBy(sid, "SOFT");
      const other = bestBy(sid, comp);
      for (const [d, t] of other) if (soft.has(d)) diffs.push(t - soft.get(d)!);
    }
    compoundOffsets[comp] =
      diffs.length >= 4 && median(diffs) > 0
        ? { value: round(median(diffs), 3), source: "estimated_from_data" }
        : { value: params.compoundOffsetPrior[comp] ?? 0.5, source: "prior" };
  }

  const improvement = params.qualifyingImprovement;
  type Cand = { lap: ClassifiedLap; adjusted: number; sessionAdj: number; compoundAdj: number };
  const perDriver = new Map<number, Cand[]>();
  for (const l of eligible) {
    const sessionAdj = sessionOffsets[l.sessionId] ?? 0;
    const comp = compoundOffsets[l.compound];
    const compoundAdj = comp ? -comp.value : 0;
    const c = { lap: l, adjusted: l.lapTime! + sessionAdj + compoundAdj, sessionAdj, compoundAdj };
    if (!perDriver.has(l.driverNumber)) perDriver.set(l.driverNumber, []);
    perDriver.get(l.driverNumber)!.push(c);
  }

  // Best sectors per driver (raw, latest-scale not applied) for explanation
  const bestSector = (d: number, k: "sector1" | "sector2" | "sector3") => {
    const v = eligible.filter((l) => l.driverNumber === d && l[k] !== null).map((l) => l[k]!);
    return v.length ? Math.min(...v) : null;
  };

  const z = zForLevel(level);
  const base: Omit<QualifyingDriverPrediction, "expectedRank" | "rankDistribution" | "probabilities" | "explanation">[] = [];
  for (const d of drivers) {
    const cands = perDriver.get(d.driverNumber);
    if (!cands?.length) continue;
    cands.sort((a, b) => a.adjusted - b.adjusted);
    const best = cands[0]!;
    // Per-session best adjusted lap, combined with recency weights (FP3 > FP2 > FP1). Taking the
    // single minimum over all laps is biased toward drivers with more attempts and toward
    // outliers (e.g. slipstream-assisted laps), so it is deliberately not used.
    const perSession = new Map<string, number>();
    for (const c of cands) perSession.set(c.lap.sessionId, Math.min(perSession.get(c.lap.sessionId) ?? Infinity, c.adjusted));
    let wSum = 0;
    let acc = 0;
    for (const [sid, v] of perSession) {
      const w = sessionOrder.indexOf(sid) + 1;
      wSum += w;
      acc += w * v;
    }
    const estimate = acc / wSum;
    const vals = [...perSession.values()];
    const between = vals.length > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - estimate) ** 2, 0) / (vals.length - 1)) : 0.25;
    const sigma = Math.sqrt(
      0.12 ** 2 + // irreducible lap-to-lap variation of a qualifying lap
        Math.min(0.5, between) ** 2 / Math.max(1, vals.length) +
        (best.compoundAdj !== 0 ? 0.15 ** 2 : 0) +
        (vals.length > 1 ? 0.1 ** 2 : 0) + // session-evolution offsets are estimated
        0.15 ** 2, // latent fuel load / engine mode of the practice lap, unknown
    );
    const point = estimate - improvement.mean;
    base.push({
      driverNumber: d.driverNumber,
      code: d.code,
      teamName: d.teamName,
      projectedLapTime: round(point, 3),
      sigma: round(sigma, 3),
      interval: {
        low: round(point - z * Math.sqrt(sigma ** 2 + improvement.sd ** 2), 3),
        high: round(point + z * Math.sqrt(sigma ** 2 + improvement.sd ** 2), 3),
        level,
        calibrated: params.calibrated,
      },
      evidence: {
        bestRawLap: best.lap.lapTime!,
        bestLapSession: best.lap.sessionId,
        bestLapNumber: best.lap.lapNumber,
        compound: best.lap.compound,
        tyreAge: best.lap.tyreAge,
        adjustments: { sessionEvolution: round(best.sessionAdj, 3), compound: round(best.compoundAdj, 3), qualifyingImprovement: -improvement.mean },
        representativeLaps: cands.length,
        bestSectors: [bestSector(d.driverNumber, "sector1"), bestSector(d.driverNumber, "sector2"), bestSector(d.driverNumber, "sector3")],
      },
    });
  }
  if (base.length < 2) throw new Error("Need at least two drivers with representative laps");

  // 5. Monte Carlo ranking. The improvement term is shared by all drivers, so it does not
  // affect ranks; it only widens absolute lap-time intervals.
  const n = base.length;
  const rng = new Rng(seed);
  const rankCounts = base.map(() => new Array<number>(n).fill(0));
  const q2Cut = 10 + Math.floor(Math.max(0, n - 10) / 2);
  const draws = new Array<number>(n);
  const order = Array.from({ length: n }, (_, i) => i);
  const teamGapsSamples = new Map<string, number[]>();
  const teams = groupBy(base.map((b, i) => ({ ...b, i })), (b) => b.teamName);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) draws[i] = base[i]!.projectedLapTime + rng.normal(0, base[i]!.sigma);
    order.sort((a, b) => draws[a]! - draws[b]!);
    for (let r = 0; r < n; r++) rankCounts[order[r]!]![r]!++;
    for (const [team, members] of teams) {
      if (members.length !== 2) continue;
      if (!teamGapsSamples.has(team)) teamGapsSamples.set(team, []);
      teamGapsSamples.get(team)!.push(draws[members[0]!.i]! - draws[members[1]!.i]!);
    }
  }

  const fieldMedianSectors = [0, 1, 2].map((k) => median(base.map((b) => b.evidence.bestSectors[k]).filter((v): v is number => v !== null)));
  const result: QualifyingDriverPrediction[] = base.map((b, i) => {
    const dist = rankCounts[i]!.map((c) => c / iterations);
    const cum = (k: number) => dist.slice(0, k).reduce((a, x) => a + x, 0);
    return {
      ...b,
      rankDistribution: dist.map((p) => round(p, 4)),
      expectedRank: round(dist.reduce((a, p, r) => a + p * (r + 1), 0), 2),
      probabilities: {
        pole: round(cum(1), 4),
        frontRow: round(cum(2), 4),
        advanceQ1: round(cum(Math.min(n, q2Cut)), 4),
        advanceQ2: round(cum(Math.min(n, 10)), 4),
        top10: round(cum(Math.min(n, 10)), 4),
      },
      explanation: "",
    };
  });
  result.sort((a, b) => a.expectedRank - b.expectedRank);
  result.forEach((r, i) => (r.explanation = explainQuali(r, result[i - 1], fieldMedianSectors)));

  const teammateGaps = [...teamGapsSamples].map(([teamName, s]) => {
    const members = teams.get(teamName)!;
    return {
      teamName,
      driverA: members[0]!.code,
      driverB: members[1]!.code,
      expectedGap: round(mean(s), 3),
      sd: round(Math.sqrt(mean(s.map((x) => (x - mean(s)) ** 2))), 3),
    };
  });

  return {
    meta: {
      analysisType: "qualifying_prediction",
      algorithmVersion: QUALIFYING_MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      sources: [...new Set(sessionOrder.map((s) => s.split(":")[0]!))],
      dataQuality: base.length >= 15 ? "medium" : "low",
      assumptions: [
        "Practice fuel loads and engine modes are unknown; treated as a latent error term (0.15 s sd), not corrected.",
        `Practice-to-qualifying improvement prior: ${improvement.mean} ± ${improvement.sd} s (params ${params.version}).`,
        "Driver errors are independent; a shared track-evolution term does not change the ranking.",
      ],
      warnings,
      evidence: ["push_laps", "sector_times", "compound", "tyre_age", "session_evolution"],
    },
    modelVersion: QUALIFYING_MODEL_VERSION,
    paramsVersion: params.version,
    confidenceType: params.calibrated ? "calibrated_probability" : "uncalibrated_probability",
    sessionIds: sessionOrder,
    sessionOffsets,
    compoundOffsets,
    drivers: result,
    teammateGaps,
    iterations,
    seed,
  };
}

function explainQuali(r: QualifyingDriverPrediction, ahead: QualifyingDriverPrediction | undefined, fieldMedianSectors: number[]): string {
  const strengths = r.evidence.bestSectors
    .map((s, k) => (s !== null && Number.isFinite(fieldMedianSectors[k]!) ? { k: k + 1, d: s - fieldMedianSectors[k]! } : null))
    .filter((x): x is { k: number; d: number } => x !== null)
    .sort((a, b) => a.d - b.d);
  const parts = [`${r.code} projected ${r.projectedLapTime.toFixed(3)} s (P${Math.round(r.expectedRank)} expected).`];
  if (strengths[0]) parts.push(`Strongest relative sector: S${strengths[0].k} (${strengths[0].d <= 0 ? "-" : "+"}${Math.abs(strengths[0].d).toFixed(3)} s vs field median best).`);
  if (ahead) parts.push(`Gap to ${ahead.code}: ${(r.projectedLapTime - ahead.projectedLapTime).toFixed(3)} s.`);
  const unc: string[] = ["unknown fuel load"];
  if (r.evidence.adjustments.compound !== 0) unc.push(`best lap on ${r.evidence.compound} (compound-adjusted)`);
  if (r.evidence.adjustments.sessionEvolution !== 0) unc.push("best lap from an earlier session");
  if (r.evidence.representativeLaps < 2) unc.push("single representative lap");
  parts.push(`Uncertainty drivers: ${unc.join(", ")}.`);
  return parts.join(" ");
}

/** Central rank interval (1-based, inclusive) from a rank probability distribution. */
export function rankInterval(dist: number[], level = 0.8): [number, number] {
  const lo = (1 - level) / 2;
  let c = 0;
  let a: number | null = null;
  for (let r = 0; r < dist.length; r++) {
    c += dist[r]!;
    if (a === null && c >= lo) a = r + 1;
    if (c >= 1 - lo) return [a ?? r + 1, r + 1];
  }
  return [a ?? 1, dist.length];
}
