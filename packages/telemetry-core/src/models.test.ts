import { describe, expect, it } from "vitest";
import { FIELD, syntheticPractice, TRUE_FUEL_EFFECT } from "../../../tests/fixtures/synthetic-weekend.ts";
import { classifyLaps, neutralisedPeriods } from "./classify.ts";
import { DEFAULT_PACE_PARAMS, degradationReport, fitStints } from "./degradation.ts";
import { predictQualifying, rankInterval } from "./qualifying.ts";
import { racePace } from "./racepace.ts";
import { bestDeterministicStrategy, DEFAULT_SIM_PARAMS, forecastRaceResult, simulateStrategies, type SimCar, type SimParams } from "./strategy.ts";
import { theilSen, Rng, quantile, normalCdf, zForLevel } from "./stats.ts";

const sessions = ["synthetic:fp1", "synthetic:fp2", "synthetic:fp3"];
const laps = syntheticPractice(sessions);
const classified = sessions.flatMap((s) => classifyLaps(laps.filter((l) => l.sessionId === s), [], new Map()));
const drivers = FIELD.map((d) => ({ driverNumber: d.driverNumber, code: d.code, teamName: d.teamName }));

describe("stats", () => {
  it("Theil-Sen ignores a single outlier", () => {
    const x = [0, 1, 2, 3, 4, 5, 6, 7];
    const y = x.map((v) => 2 * v + 1);
    y[3] = 40;
    expect(theilSen(x, y).slope).toBeCloseTo(2, 6);
  });
  it("Rng is reproducible", () => {
    const a = new Rng(5), b = new Rng(5);
    expect([a.next(), a.normal(), a.next()]).toEqual([b.next(), b.normal(), b.next()]);
  });
  it("normal helpers agree", () => {
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(zForLevel(0.95)).toBeCloseTo(1.96, 2);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe("lap classification", () => {
  it("labels out laps, cooldown, push and long-run laps", () => {
    const d1 = classified.filter((l) => l.driverNumber === 1 && l.sessionId === "synthetic:fp2");
    expect(d1[0]!.primary).toBe("out_lap");
    expect(d1[1]!.classes).toContain("push");
    expect(d1[1]!.classes).toContain("qualifying_simulation");
    expect(d1[2]!.primary).toBe("cooldown");
    expect(d1.filter((l) => l.classes.includes("long_run")).length).toBeGreaterThanOrEqual(10);
  });

  it("marks laps overlapping a neutralisation as interrupted", () => {
    const fp1 = laps.filter((l) => l.sessionId === "synthetic:fp1");
    const target = fp1.find((l) => l.driverNumber === 3 && l.lapNumber === 2)!;
    const periods = neutralisedPeriods(
      [
        { tMs: target.startMs! + 5000, category: "Flag", flag: "YELLOW", message: "YELLOW IN TRACK SECTOR 4" },
        { tMs: target.startMs! + 20000, category: "Flag", flag: "CLEAR", message: "CLEAR IN TRACK SECTOR 4" },
      ],
      10_000_000,
    );
    const c = classifyLaps(fp1, periods, new Map());
    expect(c.find((l) => l.driverNumber === 3 && l.lapNumber === 2)!.primary).toBe("interrupted");
  });
});

describe("degradation", () => {
  const fits = fitStints(classified, { ...DEFAULT_PACE_PARAMS, fuelEffectPerLap: TRUE_FUEL_EFFECT });
  it("finds one long run per driver", () => {
    expect(fits).toHaveLength(FIELD.length);
  });
  it("recovers true degradation within noise when the fuel assumption is right", () => {
    for (const f of fits) {
      const truth = FIELD.find((d) => d.driverNumber === f.driverNumber)!.trueDeg;
      expect(Math.abs(f.degradationSlope - truth)).toBeLessThan(0.05);
    }
    const report = degradationReport(fits);
    const med = report.compounds.find((c) => c.compound === "MEDIUM")!;
    expect(med.slope).toBeGreaterThan(0.04);
    expect(med.slope).toBeLessThan(0.1);
    expect(med.slopeInterval.calibrated).toBe(false);
    expect(report.modelComparison.find((m) => m.model === "pooled_linear")!.stintsEvaluated).toBe(FIELD.length);
  });
  it("a wrong fuel assumption biases degradation (confounding is real)", () => {
    const biased = fitStints(classified, { ...DEFAULT_PACE_PARAMS, fuelEffectPerLap: 0 });
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(biased.map((f) => f.degradationSlope))).toBeLessThan(mean(fits.map((f) => f.degradationSlope)) - 0.04);
  });

  it("race pace ranks faster drivers ahead on average", () => {
    const rp = racePace(fits, drivers);
    const firstHalf = rp.drivers.slice(0, 10).map((d) => d.driverNumber);
    expect(firstHalf.filter((n) => n <= 10).length).toBeGreaterThanOrEqual(6);
    expect(rp.teams.length).toBe(10);
  });
});

describe("qualifying prediction", () => {
  const pred = predictQualifying(classified, drivers, sessions, { seed: 1, iterations: 2000 });
  it("probabilities are coherent", () => {
    const poleSum = pred.drivers.reduce((a, d) => a + d.probabilities.pole, 0);
    expect(poleSum).toBeCloseTo(1, 6);
    for (const d of pred.drivers) {
      expect(d.probabilities.frontRow).toBeGreaterThanOrEqual(d.probabilities.pole);
      expect(d.probabilities.advanceQ1).toBeGreaterThanOrEqual(d.probabilities.advanceQ2);
      expect(d.rankDistribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
      expect(d.interval.low).toBeLessThan(d.projectedLapTime);
    }
    expect(pred.confidenceType).toBe("uncalibrated_probability");
  });
  it("estimates the session evolution offsets (truth: 0.4 s per session)", () => {
    expect(pred.sessionOffsets["synthetic:fp1"]).toBeCloseTo(-0.8, 1);
    expect(pred.sessionOffsets["synthetic:fp2"]).toBeCloseTo(-0.4, 1);
  });
  it("ranking correlates with ground truth", () => {
    const top5 = pred.drivers.slice(0, 5).map((d) => d.driverNumber);
    expect(top5.filter((n) => n <= 7).length).toBeGreaterThanOrEqual(4);
  });
  it("is reproducible for a fixed seed", () => {
    const again = predictQualifying(classified, drivers, sessions, { seed: 1, iterations: 2000 });
    expect(again.drivers.map((d) => d.probabilities)).toEqual(pred.drivers.map((d) => d.probabilities));
  });
  it("rankInterval returns a central interval", () => {
    expect(rankInterval([0.5, 0.3, 0.2], 0.8)).toEqual([1, 3]);
    expect(rankInterval([0, 0, 1], 0.8)).toEqual([3, 3]);
  });
});

describe("strategy simulation", () => {
  const p: SimParams = { ...DEFAULT_SIM_PARAMS, totalLaps: 50 };
  const field: SimCar[] = FIELD.map((d, i) => ({
    driverNumber: d.driverNumber,
    code: d.code,
    grid: i + 1,
    basePace: 90 + i * 0.1,
    paceSd: 0.1,
    strategy: bestDeterministicStrategy(p, 2).stints,
  }));

  it("deterministic optimum respects the two-compound rule and lap count", () => {
    const s = bestDeterministicStrategy(p, 2);
    expect(new Set(s.stints.map((x) => x.compound)).size).toBeGreaterThanOrEqual(2);
    expect(s.stints.reduce((a, x) => a + x.laps, 0)).toBe(50);
  });

  it("is reproducible and favours a faster car", () => {
    const a = forecastRaceResult(field, p, 300, 9);
    const b = forecastRaceResult(field, p, 300, 9);
    expect(a).toEqual(b);
    const p1 = a.drivers.find((d) => d.driverNumber === 1)!;
    const p20 = a.drivers.find((d) => d.driverNumber === 20)!;
    expect(p1.expectedPosition).toBeLessThan(p20.expectedPosition);
    const winSum = a.drivers.reduce((s, d) => s + d.pWin, 0);
    expect(winSum).toBeCloseTo(1, 6);
  });

  it("prefers two stops when degradation is extreme", () => {
    const harsh: SimParams = {
      ...p,
      degradation: { ...p.degradation, MEDIUM: { slope: 0.3, quad: 0.004 }, HARD: { slope: 0.22, quad: 0.003 }, SOFT: { slope: 0.4, quad: 0.006 } },
      scProbabilityPerLap: 0,
      vscProbabilityPerLap: 0,
    };
    const study = simulateStrategies(field, 10, [
      { name: "1-stop M-H", stints: [{ compound: "MEDIUM", laps: 25 }, { compound: "HARD", laps: 25 }] },
      { name: "2-stop M-H-H", stints: [{ compound: "MEDIUM", laps: 16 }, { compound: "HARD", laps: 17 }, { compound: "HARD", laps: 17 }] },
    ], harsh, 300, 4);
    const one = study.results.find((r) => r.name.startsWith("1"))!;
    const two = study.results.find((r) => r.name.startsWith("2"))!;
    expect(two.expectedRaceTime!).toBeLessThan(one.expectedRaceTime!);
    expect(study.headToHead[0]!.pAAheadOfB).toBeLessThan(0.5);
    expect(study.objective).toMatch(/expected finishing position/);
  });
});
