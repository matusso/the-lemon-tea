import type { AnalysisMeta, Interval } from "@lemon-tea/shared-types";
import type { DriverInfo } from "./qualifying.ts";
import { DEFAULT_PACE_PARAMS, groupBy, type PaceModelParams, type StintFit } from "./degradation.ts";
import { mean, median, round, zForLevel } from "./stats.ts";

export const RACE_PACE_VERSION = "race-pace-v1";

export interface DriverRacePace {
  driverNumber: number;
  code: string;
  teamName: string;
  /** Fuel-corrected, compound-normalised (to MEDIUM) clean-air pace at tyre age 5, s. Estimated. */
  referencePace: number;
  interval: Interval;
  runs: number;
  laps: number;
  consistency: number;
  meanDegradation: number;
  /** Pace at tyre ages 1..30 on the driver's most-used compound, estimated. */
  paceByAge: { age: number; pace: number }[];
  primaryCompound: string;
}

export interface RacePaceReport {
  meta: AnalysisMeta;
  drivers: DriverRacePace[];
  teams: { teamName: string; referencePace: number; interval: Interval; drivers: string[] }[];
  runs: Omit<StintFit, "tyreAges" | "lapTimes" | "fuelCorrected">[];
}

const REFERENCE_AGE = 5;
export const FUEL_LOAD_SD = 0.5;

/**
 * Race-pace projection from long runs. Each run's fuel-corrected pace is expressed at a common
 * tyre age and compound so runs on different tyres become comparable. Starting fuel is unknown,
 * so a between-driver fuel-load uncertainty (FUEL_LOAD_SD) is added to every interval.
 * Practice fuel loads plausibly differ by 20-40 kg between teams (~0.7-1.4 s), hence 0.5 s.
 */
export function racePace(fits: StintFit[], drivers: DriverInfo[], params: PaceModelParams = DEFAULT_PACE_PARAMS, level = 0.8): RacePaceReport {
  const z = zForLevel(level);
  const compoundShift = (c: string) => (params.compoundOffsetPrior.MEDIUM ?? 0) - (params.compoundOffsetPrior[c] ?? 0);
  const out: DriverRacePace[] = [];
  for (const d of drivers) {
    const runs = fits.filter((f) => f.driverNumber === d.driverNumber);
    if (!runs.length) continue;
    const refPaces = runs.map((r) => {
      const intercept = r.paceAtAge1 - r.pooledSlope;
      return intercept + r.pooledSlope * REFERENCE_AGE + compoundShift(r.compound);
    });
    const w = runs.map((r) => r.laps);
    const sw = w.reduce((a, b) => a + b, 0);
    const pace = refPaces.reduce((a, p, i) => a + p * w[i]!, 0) / sw;
    const consistency = median(runs.map((r) => r.robustSd));
    const se = Math.sqrt(consistency ** 2 / sw + (runs.length > 1 ? 0 : 0.1 ** 2) + FUEL_LOAD_SD ** 2);
    const primary = [...groupBy(runs, (r) => r.compound)].sort((a, b) => b[1].length - a[1].length)[0]!;
    const pr = primary[1].sort((a, b) => b.laps - a.laps)[0]!;
    const prIntercept = pr.paceAtAge1 - pr.pooledSlope;
    out.push({
      driverNumber: d.driverNumber,
      code: d.code,
      teamName: d.teamName,
      referencePace: round(pace, 3),
      interval: { low: round(pace - z * se, 3), high: round(pace + z * se, 3), level, calibrated: false },
      runs: runs.length,
      laps: sw,
      consistency: round(consistency, 3),
      meanDegradation: round(mean(runs.map((r) => r.pooledSlope)), 4),
      paceByAge: Array.from({ length: 30 }, (_, i) => ({ age: i + 1, pace: round(prIntercept + pr.pooledSlope * (i + 1), 3) })),
      primaryCompound: primary[0],
    });
  }
  out.sort((a, b) => a.referencePace - b.referencePace);

  const teams = [...groupBy(out, (d) => d.teamName)].map(([teamName, ds]) => {
    const p = mean(ds.map((d) => d.referencePace));
    const half = mean(ds.map((d) => (d.interval.high - d.interval.low) / 2)) / Math.sqrt(ds.length);
    return { teamName, referencePace: round(p, 3), interval: { low: round(p - half, 3), high: round(p + half, 3), level, calibrated: false }, drivers: ds.map((d) => d.code) };
  });
  teams.sort((a, b) => a.referencePace - b.referencePace);

  return {
    meta: {
      analysisType: "race_pace",
      algorithmVersion: RACE_PACE_VERSION,
      generatedAt: new Date().toISOString(),
      sources: [...new Set(fits.map((f) => f.sessionId.split(":")[0]!))],
      dataQuality: out.length >= 12 ? "medium" : out.length >= 4 ? "low" : "insufficient",
      assumptions: [
        `Fuel burn ${params.fuelEffectPerLap} s/lap removed; absolute fuel load unknown (${FUEL_LOAD_SD} s sd added between drivers).`,
        `Compounds normalised to MEDIUM using offsets ${JSON.stringify(params.compoundOffsetPrior)} (params ${params.version}).`,
        `Reference pace is evaluated at tyre age ${REFERENCE_AGE}.`,
        "Engine and tyre management levels in practice are unknown and not corrected.",
      ],
      warnings: [],
      evidence: ["long_run_laps", "tyre_age", "compound", "degradation_slope"],
    },
    drivers: out,
    teams,
    runs: fits.map(({ tyreAges: _a, lapTimes: _b, fuelCorrected: _c, ...rest }) => rest),
  };
}
