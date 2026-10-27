import type { Interval, TyreCompound } from "@lemon-tea/shared-types";
import type { ClassifiedLap } from "./classify.ts";
import { mad, mean, median, olsFit, quadraticFit, round, theilSen, zForLevel } from "./stats.ts";

export const DEGRADATION_VERSION = "tyre-degradation-v1";

/**
 * Model assumptions. Fuel is never measured: its effect is a stated prior that can be
 * replaced by values fitted offline (services/analytics) and loaded as model parameters.
 */
export interface PaceModelParams {
  version: string;
  /** Lap-time reduction per lap from fuel burn (s/lap). Prior: ~1.7 kg/lap x ~0.035 s/kg. */
  fuelEffectPerLap: number;
  /** Uncertainty of the fuel effect (s/lap, 1 sd). */
  fuelEffectSd: number;
  /** Additive pace offset relative to SOFT (s), used only when the data cannot estimate it. */
  compoundOffsetPrior: Record<string, number>;
  /** Default degradation slope prior per compound (s/lap) for partial pooling. */
  degradationPrior: Record<string, { slope: number; sd: number }>;
  /** Typical practice-best to qualifying-lap improvement (s). */
  qualifyingImprovement: { mean: number; sd: number };
  /** Lap-time sensitivity to track temperature (s per deg C), sign: positive = slower when hotter. */
  trackTempSensitivity: number;
  calibrated: boolean;
}

export const DEFAULT_PACE_PARAMS: PaceModelParams = {
  version: "priors-2026.1",
  fuelEffectPerLap: 0.06,
  fuelEffectSd: 0.015,
  compoundOffsetPrior: { SOFT: 0, MEDIUM: 0.45, HARD: 0.85, INTERMEDIATE: 0, WET: 0 },
  degradationPrior: {
    SOFT: { slope: 0.09, sd: 0.06 },
    MEDIUM: { slope: 0.06, sd: 0.04 },
    HARD: { slope: 0.04, sd: 0.03 },
    INTERMEDIATE: { slope: 0.08, sd: 0.08 },
    WET: { slope: 0.08, sd: 0.08 },
  },
  qualifyingImprovement: { mean: 0.6, sd: 0.35 },
  trackTempSensitivity: 0.015,
  calibrated: false,
};

export interface StintFit {
  runId: string;
  sessionId: string;
  driverNumber: number;
  compound: TyreCompound;
  laps: number;
  tyreAgeStart: number | null;
  tyreAges: number[];
  lapTimes: number[];
  fuelCorrected: number[];
  meanPace: number;
  medianPace: number;
  robustSd: number;
  /** Raw Theil-Sen slope of lap time vs lap index (s/lap): fuel and tyre effects mixed. */
  rawSlope: number;
  /** Fuel-corrected Theil-Sen slope (s/lap): estimated degradation. */
  degradationSlope: number;
  degradationSlopeSe: number;
  /** Partial-pooled slope (shrunk toward the compound mean). */
  pooledSlope: number;
  quadratic: { b: number; c: number };
  /** Fuel-corrected pace extrapolated to tyre age 1 (fresh tyre baseline). */
  paceAtAge1: number;
  meanTrackTemperature: number | null;
}

export function fitStints(laps: ClassifiedLap[], params: PaceModelParams = DEFAULT_PACE_PARAMS): StintFit[] {
  const runs = new Map<string, ClassifiedLap[]>();
  for (const l of laps) {
    if (!l.runId || !l.classes.includes("long_run") || l.classes.includes("unrepresentative")) continue;
    if (!runs.has(l.runId)) runs.set(l.runId, []);
    runs.get(l.runId)!.push(l);
  }
  const fits: StintFit[] = [];
  for (const [runId, rl] of runs) {
    rl.sort((a, b) => a.lapNumber - b.lapNumber);
    const times = rl.map((l) => l.lapTime!);
    const idx = rl.map((l) => l.lapNumber - rl[0]!.lapNumber);
    const ages = rl.map((l, i) => (l.tyreAge ?? (rl[0]!.tyreAge ?? 0) + i));
    // Later laps are lighter: adding back fuelEffect * lapsIntoRun removes the fuel-burn improvement.
    const fc = times.map((t, i) => t + params.fuelEffectPerLap * idx[i]!);
    const raw = theilSen(idx, times);
    const ts = theilSen(ages, fc);
    const q = quadraticFit(ages, fc);
    const temps = rl.map((l) => l.trackTemperature).filter((t): t is number => t != null);
    fits.push({
      runId,
      sessionId: rl[0]!.sessionId,
      driverNumber: rl[0]!.driverNumber,
      compound: rl[0]!.compound,
      laps: rl.length,
      tyreAgeStart: rl[0]!.tyreAge,
      tyreAges: ages,
      lapTimes: times,
      fuelCorrected: fc,
      meanPace: mean(times),
      medianPace: median(times),
      robustSd: mad(times),
      rawSlope: raw.slope,
      degradationSlope: ts.slope,
      degradationSlopeSe: Number.isFinite(ts.slopeStdErr) ? ts.slopeStdErr : 0.05,
      pooledSlope: ts.slope,
      quadratic: { b: q.b, c: q.c },
      paceAtAge1: ts.intercept + ts.slope * 1,
      meanTrackTemperature: temps.length ? mean(temps) : null,
    });
  }
  applyPartialPooling(fits, params);
  return fits;
}

/**
 * Empirical-Bayes partial pooling per compound: each stint slope is shrunk toward the
 * compound mean with weight tau^2 / (tau^2 + se^2). tau (between-stint sd) is estimated
 * by method of moments and floored at the prior sd when few stints exist.
 */
function applyPartialPooling(fits: StintFit[], params: PaceModelParams) {
  const byCompound = groupBy(fits, (f) => f.compound);
  for (const [compound, group] of byCompound) {
    const prior = params.degradationPrior[compound] ?? { slope: 0.06, sd: 0.05 };
    const slopes = group.map((f) => f.degradationSlope);
    const ses = group.map((f) => f.degradationSlopeSe);
    const w = ses.map((se) => 1 / (se * se + 1e-6));
    const sw = w.reduce((a, b) => a + b, 0);
    const pooledMean = group.length >= 3 ? slopes.reduce((a, s, i) => a + s * w[i]!, 0) / sw : (prior.slope + mean(slopes) * group.length) / (1 + group.length);
    const obsVar = group.length > 1 ? slopes.reduce((a, s) => a + (s - pooledMean) ** 2, 0) / (group.length - 1) : prior.sd ** 2;
    const tau2 = Math.max(prior.sd ** 2 * (group.length < 4 ? 1 : 0.25), obsVar - mean(ses.map((s) => s * s)));
    for (const f of group) {
      const k = tau2 / (tau2 + f.degradationSlopeSe ** 2);
      f.pooledSlope = k * f.degradationSlope + (1 - k) * pooledMean;
    }
  }
}

export interface CompoundDegradation {
  compound: TyreCompound;
  stints: number;
  laps: number;
  /** s/lap, fuel corrected, estimated. */
  slope: number;
  slopeInterval: Interval;
  /** Heuristic share of stints whose quadratic term indicates accelerating degradation. */
  cliffIndicatorShare: number;
  /** Laps until the tyre is 1.0 s slower than fresh, from the pooled slope (estimate). */
  lapsToOneSecondLoss: number | null;
  /** Estimated pace change vs a fresh tyre at given ages (s); signed, never clamped. */
  lossCurve: { age: number; loss: number }[];
  /** Set when the fuel-corrected slope is negative: tyre loss is not identifiable from these runs. */
  warning: string | null;
}

export interface ModelComparisonRow {
  model: "linear_ols" | "linear_theil_sen" | "quadratic" | "pooled_linear";
  /** Mean absolute error predicting the final laps of each stint from the earlier laps (s). */
  holdoutMae: number;
  stintsEvaluated: number;
}

export interface DegradationReport {
  version: string;
  params: { version: string; fuelEffectPerLap: number; calibrated: boolean };
  compounds: CompoundDegradation[];
  stints: StintFit[];
  modelComparison: ModelComparisonRow[];
  assumptions: string[];
}

export function degradationReport(fits: StintFit[], params: PaceModelParams = DEFAULT_PACE_PARAMS, level = 0.8): DegradationReport {
  const z = zForLevel(level);
  const compounds: CompoundDegradation[] = [];
  for (const [compound, g] of groupBy(fits, (f) => f.compound)) {
    const slopes = g.map((f) => f.pooledSlope);
    const w = g.map((f) => f.laps);
    const sw = w.reduce((a, b) => a + b, 0);
    const slope = slopes.reduce((a, s, i) => a + s * w[i]!, 0) / sw;
    const se = g.length > 1 ? Math.sqrt(slopes.reduce((a, s) => a + (s - slope) ** 2, 0) / (g.length - 1) / g.length) : g[0]!.degradationSlopeSe;
    const fuelSe = params.fuelEffectSd; // fuel prior uncertainty passes straight into the slope
    const totalSe = Math.sqrt(se * se + fuelSe * fuelSe);
    const cliff = g.filter((f) => f.quadratic.c > 0.004).length / g.length;
    compounds.push({
      compound,
      stints: g.length,
      laps: g.reduce((a, f) => a + f.laps, 0),
      slope: round(slope, 4),
      slopeInterval: { low: round(slope - z * totalSe, 4), high: round(slope + z * totalSe, 4), level, calibrated: false },
      cliffIndicatorShare: round(cliff, 2),
      lapsToOneSecondLoss: slope > 0.005 ? Math.round(1 / slope) : null,
      lossCurve: Array.from({ length: 41 }, (_, age) => ({ age, loss: round(slope * age, 3) })),
      warning:
        slope < 0
          ? "Negative fuel-corrected slope: track evolution (and/or a larger fuel effect than assumed) outweighs tyre loss in these runs, so degradation is not identifiable here. Do not read it as tyres getting faster."
          : null,
    });
  }
  return {
    version: DEGRADATION_VERSION,
    params: { version: params.version, fuelEffectPerLap: params.fuelEffectPerLap, calibrated: params.calibrated },
    compounds,
    stints: fits,
    modelComparison: compareDegradationModels(fits),
    assumptions: [
      `Fuel burn effect assumed ${params.fuelEffectPerLap} s/lap (±${params.fuelEffectSd}); starting fuel load is unknown.`,
      "Track evolution within a run is not separated from tyre degradation; in practice sessions it biases slopes downward.",
      "Only laps classified as long_run are used; traffic, out/in laps and neutralised laps are excluded.",
    ],
  };
}

/** Hold out the last 3 laps of each stint (>= 8 laps) and score each model's forecast. */
export function compareDegradationModels(fits: StintFit[]): ModelComparisonRow[] {
  const rows: Record<ModelComparisonRow["model"], number[]> = { linear_ols: [], linear_theil_sen: [], quadratic: [], pooled_linear: [] };
  for (const f of fits) {
    if (f.laps < 8) continue;
    const k = f.laps - 3;
    const x = f.tyreAges.slice(0, k);
    const y = f.fuelCorrected.slice(0, k);
    const xt = f.tyreAges.slice(k);
    const yt = f.fuelCorrected.slice(k);
    const ols = olsFit(x, y);
    const ts = theilSen(x, y);
    const q = quadraticFit(x, y);
    const pooledIntercept = median(y.map((yi, i) => yi - f.pooledSlope * x[i]!));
    const err = (pred: (a: number) => number) => mean(xt.map((a, i) => Math.abs(pred(a) - yt[i]!)));
    rows.linear_ols.push(err((a) => ols.intercept + ols.slope * a));
    rows.linear_theil_sen.push(err((a) => ts.intercept + ts.slope * a));
    rows.quadratic.push(err((a) => q.a + q.b * a + q.c * a * a));
    rows.pooled_linear.push(err((a) => pooledIntercept + f.pooledSlope * a));
  }
  return (Object.keys(rows) as ModelComparisonRow["model"][]).map((model) => ({
    model,
    holdoutMae: rows[model].length ? round(mean(rows[model]), 4) : Number.NaN,
    stintsEvaluated: rows[model].length,
  }));
}

export function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}
