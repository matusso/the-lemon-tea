import { clamp, mean, Rng, round } from "./stats.ts";

export const STRATEGY_SIM_VERSION = "race-sim-v1";

export type DryCompound = "SOFT" | "MEDIUM" | "HARD";
export type Compound = DryCompound | "INTERMEDIATE" | "WET";

export interface StintPlan {
  compound: Compound;
  laps: number;
}

export interface SimCar {
  driverNumber: number;
  code: string;
  /** 1-based starting position. */
  grid: number;
  /** Clean-air lap time on fresh MEDIUM tyres with race-start fuel (s). Estimated. */
  basePace: number;
  /** Uncertainty of basePace across iterations (s, 1 sd). */
  paceSd: number;
  strategy: StintPlan[];
  /** Tyre age of the starting set (laps). */
  startTyreAge?: number;
}

export interface SimParams {
  totalLaps: number;
  /** Time lost driving through the pit lane vs. a racing lap, excluding the stop (s). */
  pitLaneLoss: number;
  stationaryMedian: number;
  stationaryLogSd: number;
  scProbabilityPerLap: number;
  vscProbabilityPerLap: number;
  scDurationLaps: [number, number];
  vscDurationLaps: [number, number];
  /** Pit-loss multipliers under neutralisation (the field slows, the pit lane does not). */
  scPitLossFactor: number;
  vscPitLossFactor: number;
  fuelEffectPerLap: number;
  /** Offset vs MEDIUM (s). */
  compoundOffset: Record<Compound, number>;
  /** Linear degradation (s/lap of tyre age) and quadratic term per compound. */
  degradation: Record<Compound, { slope: number; quad: number }>;
  /** Log-sd of the per-race degradation multiplier (track/temperature uncertainty). */
  degradationLogSd: number;
  lapNoiseSd: number;
  /** 0 = easy to pass (Monza), 1 = near impossible (Monaco). */
  overtakeDifficulty: number;
  /** Extra time when following within 1 s and unable to pass (s/lap). */
  dirtyAirLoss: number;
  outLapPenalty: number;
  /** Probability a given car retires during the race. */
  dnfProbability: number;
  /** Box under SC/VSC if a planned stop is within this many laps. */
  opportunisticWindow: number;
  /** Additive pace change per +1 C track temperature (s). */
  trackTempSensitivity: number;
  trackTempDeltaC: number;
}

export const DEFAULT_SIM_PARAMS: Omit<SimParams, "totalLaps"> = {
  pitLaneLoss: 20,
  stationaryMedian: 2.6,
  stationaryLogSd: 0.25,
  scProbabilityPerLap: 0.012,
  vscProbabilityPerLap: 0.008,
  scDurationLaps: [3, 6],
  vscDurationLaps: [1, 3],
  scPitLossFactor: 0.45,
  vscPitLossFactor: 0.6,
  fuelEffectPerLap: 0.06,
  compoundOffset: { SOFT: -0.45, MEDIUM: 0, HARD: 0.4, INTERMEDIATE: 4, WET: 8 },
  degradation: {
    SOFT: { slope: 0.09, quad: 0.0015 },
    MEDIUM: { slope: 0.06, quad: 0.0006 },
    HARD: { slope: 0.04, quad: 0.0003 },
    INTERMEDIATE: { slope: 0.08, quad: 0.001 },
    WET: { slope: 0.08, quad: 0.001 },
  },
  degradationLogSd: 0.25,
  lapNoiseSd: 0.25,
  overtakeDifficulty: 0.5,
  dirtyAirLoss: 0.25,
  outLapPenalty: 0.6,
  dnfProbability: 0.06,
  opportunisticWindow: 6,
  trackTempSensitivity: 0.015,
  trackTempDeltaC: 0,
};

export function tyreLoss(p: SimParams, c: Compound, age: number, mult = 1): number {
  const d = p.degradation[c];
  return mult * (d.slope * age + d.quad * age * age);
}

/** Expand stint lengths into pit laps; the last stint absorbs any mismatch with totalLaps. */
export function pitLaps(strategy: StintPlan[], totalLaps: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < strategy.length - 1; i++) {
    acc += strategy[i]!.laps;
    if (acc < totalLaps) out.push(acc);
  }
  return out;
}

interface CarState {
  car: SimCar;
  pace: number;
  cum: number;
  stint: number;
  age: number;
  compound: Compound;
  plannedStops: number[];
  stopsDone: number;
  alive: boolean;
  lapsDone: number;
  outLap: boolean;
  trafficAfterPit: boolean;
  pitLapsTaken: number[];
}

export interface RaceOutcome {
  order: number[];
  times: Map<number, number>;
  lapsDone: Map<number, number>;
  pitLaps: Map<number, number[]>;
  trafficAfterPit: Map<number, boolean>;
  scLaps: number;
  vscLaps: number;
}

/** One stochastic race. All randomness comes from `rng`, so a seed reproduces the race exactly. */
export function simulateRace(cars: SimCar[], p: SimParams, rng: Rng): RaceOutcome {
  const degMult: Record<string, number> = {};
  for (const c of Object.keys(p.degradation)) degMult[c] = Math.exp(rng.normal(0, p.degradationLogSd));
  const tempShift = p.trackTempSensitivity * p.trackTempDeltaC;
  const hazard = 1 - Math.pow(1 - p.dnfProbability, 1 / p.totalLaps);

  const st: CarState[] = cars
    .slice()
    .sort((a, b) => a.grid - b.grid)
    .map((car, i) => ({
      car,
      pace: car.basePace + rng.normal(0, car.paceSd) + tempShift,
      cum: i * 0.25, // grid spacing at the start line
      stint: 0,
      age: car.startTyreAge ?? 0,
      compound: car.strategy[0]!.compound,
      plannedStops: pitLaps(car.strategy, p.totalLaps),
      stopsDone: 0,
      alive: true,
      lapsDone: 0,
      outLap: false,
      trafficAfterPit: false,
      pitLapsTaken: [],
    }));

  let neutral: { kind: "sc" | "vsc"; remaining: number } | null = null;
  let scLaps = 0, vscLaps = 0;
  const fieldPace = mean(st.map((s) => s.pace));

  for (let lap = 1; lap <= p.totalLaps; lap++) {
    if (!neutral && lap > 1 && lap < p.totalLaps - 1) {
      if (rng.bernoulli(p.scProbabilityPerLap)) neutral = { kind: "sc", remaining: Math.round(p.scDurationLaps[0] + rng.next() * (p.scDurationLaps[1] - p.scDurationLaps[0])) };
      else if (rng.bernoulli(p.vscProbabilityPerLap)) neutral = { kind: "vsc", remaining: Math.round(p.vscDurationLaps[0] + rng.next() * (p.vscDurationLaps[1] - p.vscDurationLaps[0])) };
    }
    if (neutral?.kind === "sc") scLaps++;
    if (neutral?.kind === "vsc") vscLaps++;

    const running = st.filter((s) => s.alive).sort((a, b) => a.cum - b.cum);
    const tentative = new Map<CarState, { t: number; lapTime: number; pitting: boolean }>();
    for (const s of running) {
      if (rng.bernoulli(hazard)) { s.alive = false; continue; }
      const nextStop = s.plannedStops[s.stopsDone];
      let pitting = nextStop === lap;
      if (!pitting && neutral && nextStop !== undefined && nextStop - lap <= p.opportunisticWindow && nextStop - lap > 0) {
        pitting = true; // box under neutralisation; later stops shift accordingly
        const shift = nextStop - lap;
        for (let k = s.stopsDone; k < s.plannedStops.length; k++) s.plannedStops[k] = Math.min(p.totalLaps - 1, s.plannedStops[k]! - shift);
      }
      let lt = s.pace + p.compoundOffset[s.compound] + tyreLoss(p, s.compound, s.age, degMult[s.compound]) - p.fuelEffectPerLap * (lap - 1) + rng.normal(0, p.lapNoiseSd);
      if (s.outLap) lt += p.outLapPenalty;
      if (lap === 1) lt += 1.5; // standing start
      if (neutral?.kind === "sc") lt = fieldPace * 1.4;
      else if (neutral?.kind === "vsc") lt *= 1.35;
      if (pitting) {
        const factor = neutral?.kind === "sc" ? p.scPitLossFactor : neutral?.kind === "vsc" ? p.vscPitLossFactor : 1;
        lt += p.pitLaneLoss * factor + rng.lognormal(p.stationaryMedian, p.stationaryLogSd);
      }
      tentative.set(s, { t: s.cum + lt, lapTime: lt, pitting });
    }

    // Track interaction in running order: a faster car must pass the car ahead.
    const alive = running.filter((s) => s.alive);
    for (let i = 1; i < alive.length; i++) {
      const me = tentative.get(alive[i]!)!;
      const ahead = tentative.get(alive[i - 1]!)!;
      if (neutral?.kind === "sc" || me.pitting || ahead.pitting) continue;
      if (me.t < ahead.t + 0.2) {
        const advantage = ahead.lapTime - me.lapTime;
        const threshold = 0.2 + p.overtakeDifficulty * 0.8;
        const pPass = clamp(1 - Math.exp(-Math.max(0, advantage - threshold) / (0.3 + p.overtakeDifficulty)), 0, 0.95);
        if (!rng.bernoulli(pPass)) me.t = ahead.t + 0.3 + p.dirtyAirLoss;
      }
    }

    for (const s of alive) {
      const r = tentative.get(s)!;
      s.cum = r.t;
      s.lapsDone = lap;
      s.outLap = false;
      if (r.pitting) {
        s.stopsDone++;
        s.stint = Math.min(s.stint + 1, s.car.strategy.length - 1);
        s.compound = s.car.strategy[s.stint]!.compound;
        s.age = 0;
        s.outLap = true;
        s.pitLapsTaken.push(lap);
      } else s.age++;
    }

    // After the lap, check whether cars that just pitted rejoined into traffic.
    for (const s of alive) {
      if (!s.outLap) continue;
      if (alive.some((o) => o !== s && s.cum - o.cum > 0 && s.cum - o.cum < 1.5)) s.trafficAfterPit = true;
    }

    if (neutral) {
      neutral.remaining--;
      if (neutral.remaining <= 0) {
        if (neutral.kind === "sc") {
          // Field bunches behind the safety car: order kept, gaps compressed to ~0.6 s.
          const ord = st.filter((s) => s.alive).sort((a, b) => a.cum - b.cum);
          const lead = ord[0]?.cum ?? 0;
          ord.forEach((s, i) => (s.cum = lead + i * 0.6));
        }
        neutral = null;
      }
    }
  }

  const order = st
    .slice()
    .sort((a, b) => b.lapsDone - a.lapsDone || a.cum - b.cum)
    .map((s) => s.car.driverNumber);
  return {
    order,
    times: new Map(st.map((s) => [s.car.driverNumber, s.alive ? s.cum : Number.NaN])),
    lapsDone: new Map(st.map((s) => [s.car.driverNumber, s.lapsDone])),
    pitLaps: new Map(st.map((s) => [s.car.driverNumber, s.pitLapsTaken])),
    trafficAfterPit: new Map(st.map((s) => [s.car.driverNumber, s.trafficAfterPit])),
    scLaps,
    vscLaps,
  };
}

/**
 * Deterministic tyre-only optimum: minimises sum of compound offset + degradation + stops
 * ignoring traffic and neutralisations. Used as the default strategy for the rest of the field
 * and as a candidate for the user; never presented as "the optimal strategy".
 */
export function bestDeterministicStrategy(p: SimParams, maxStops = 2, minStint = 6, dryOnly = true): { stints: StintPlan[]; expectedTime: number } {
  const comps: DryCompound[] = ["SOFT", "MEDIUM", "HARD"];
  const T = p.totalLaps;
  const stintCost = (c: Compound, n: number) => {
    let s = 0;
    for (let a = 0; a < n; a++) s += p.compoundOffset[c] + tyreLoss(p, c, a);
    return s;
  };
  const stopCost = p.pitLaneLoss + p.stationaryMedian + p.outLapPenalty;
  let best: { stints: StintPlan[]; expectedTime: number } | null = null;
  const consider = (stints: StintPlan[]) => {
    if (dryOnly && new Set(stints.map((s) => s.compound)).size < 2) return; // two-compound rule
    const t = stints.reduce((a, s) => a + stintCost(s.compound, s.laps), 0) + (stints.length - 1) * stopCost;
    if (!best || t < best.expectedTime) best = { stints, expectedTime: t };
  };
  for (const c1 of comps) for (const c2 of comps) {
    for (let l1 = minStint; l1 <= T - minStint; l1++) consider([{ compound: c1, laps: l1 }, { compound: c2, laps: T - l1 }]);
    if (maxStops >= 2) for (const c3 of comps) {
      for (let l1 = minStint; l1 <= T - 2 * minStint; l1 += 1) {
        for (let l2 = minStint; l1 + l2 <= T - minStint; l2 += 2) consider([{ compound: c1, laps: l1 }, { compound: c2, laps: l2 }, { compound: c3, laps: T - l1 - l2 }]);
      }
    }
  }
  return best!;
}

export interface StrategyCandidate {
  name: string;
  stints: StintPlan[];
}

export interface StrategyResult {
  name: string;
  stints: StintPlan[];
  plannedPitLaps: number[];
  positionDistribution: number[];
  expectedPosition: number;
  expectedRaceTime: number | null;
  pWin: number;
  pPodium: number;
  pPoints: number;
  dnfShare: number;
  expectedPositionsGained: number;
  trafficRiskAfterPit: number;
  undercutGainFirstLap: number | null;
  sensitivity: { scenario: string; expectedPosition: number; change: number }[];
}

export interface StrategyStudy {
  version: string;
  driverNumber: number;
  iterations: number;
  seed: number;
  objective: string;
  results: StrategyResult[];
  headToHead: { a: string; b: string; pAAheadOfB: number }[];
  recommendation: { name: string; reason: string; distinguishable: boolean };
  assumptions: string[];
}

function runStrategy(field: SimCar[], target: number, cand: StrategyCandidate, p: SimParams, iterations: number, seed: number) {
  const cars = field.map((c) => (c.driverNumber === target ? { ...c, strategy: cand.stints } : c));
  const positions: number[] = [];
  const times: number[] = [];
  let traffic = 0, dnf = 0, pitted = 0;
  for (let it = 0; it < iterations; it++) {
    // Common random numbers: iteration `it` uses the same stream for every candidate.
    const out = simulateRace(cars, p, new Rng(seed * 100003 + it));
    const pos = out.order.indexOf(target) + 1;
    positions.push(pos);
    const t = out.times.get(target)!;
    if (Number.isFinite(t) && out.lapsDone.get(target) === p.totalLaps) times.push(t);
    else dnf++;
    if (out.pitLaps.get(target)!.length) pitted++;
    if (out.trafficAfterPit.get(target)) traffic++;
  }
  return { positions, times, traffic: pitted ? traffic / pitted : 0, dnf: dnf / iterations };
}

export function simulateStrategies(
  field: SimCar[],
  target: number,
  candidates: StrategyCandidate[],
  p: SimParams,
  iterations = 2000,
  seed = 42,
): StrategyStudy {
  const me = field.find((c) => c.driverNumber === target);
  if (!me) throw new Error(`Driver ${target} not in field`);
  const n = field.length;
  const raw = candidates.map((c) => ({ c, r: runStrategy(field, target, c, p, iterations, seed) }));
  const sensIters = Math.max(100, Math.floor(iterations / 4));
  const scenarios: { name: string; p: SimParams }[] = [
    { name: "degradation x1.3", p: scaleDeg(p, 1.3) },
    { name: "degradation x0.7", p: scaleDeg(p, 0.7) },
    { name: "no neutralisations", p: { ...p, scProbabilityPerLap: 0, vscProbabilityPerLap: 0 } },
    { name: "SC probability x2", p: { ...p, scProbabilityPerLap: p.scProbabilityPerLap * 2 } },
  ];

  const results: StrategyResult[] = raw.map(({ c, r }) => {
    const dist = new Array<number>(n).fill(0);
    for (const pos of r.positions) dist[pos - 1]! += 1 / iterations;
    const expected = mean(r.positions);
    const first = c.stints[0]!;
    const second = c.stints[1];
    return {
      name: c.name,
      stints: c.stints,
      plannedPitLaps: pitLaps(c.stints, p.totalLaps),
      positionDistribution: dist.map((x) => round(x, 4)),
      expectedPosition: round(expected, 2),
      expectedRaceTime: r.times.length ? round(mean(r.times), 1) : null,
      pWin: round(dist[0]!, 4),
      pPodium: round(dist.slice(0, 3).reduce((a, b) => a + b, 0), 4),
      pPoints: round(dist.slice(0, 10).reduce((a, b) => a + b, 0), 4),
      dnfShare: round(r.dnf, 4),
      expectedPositionsGained: round(me.grid - expected, 2),
      trafficRiskAfterPit: round(r.traffic, 3),
      undercutGainFirstLap: second
        ? round(p.compoundOffset[first.compound] + tyreLoss(p, first.compound, first.laps) - (p.compoundOffset[second.compound] + tyreLoss(p, second.compound, 0) + p.outLapPenalty), 3)
        : null,
      sensitivity: scenarios.map((s) => {
        const e = mean(runStrategy(field, target, c, s.p, sensIters, seed + 1).positions);
        return { scenario: s.name, expectedPosition: round(e, 2), change: round(e - expected, 2) };
      }),
    };
  });

  const headToHead: StrategyStudy["headToHead"] = [];
  for (let i = 0; i < raw.length; i++) for (let j = i + 1; j < raw.length; j++) {
    let ahead = 0;
    for (let it = 0; it < iterations; it++) if (raw[i]!.r.positions[it]! < raw[j]!.r.positions[it]!) ahead++;
    else if (raw[i]!.r.positions[it]! === raw[j]!.r.positions[it]!) ahead += 0.5;
    headToHead.push({ a: raw[i]!.c.name, b: raw[j]!.c.name, pAAheadOfB: round(ahead / iterations, 3) });
  }

  const sorted = [...results].sort((a, b) => a.expectedPosition - b.expectedPosition);
  const best = sorted[0]!;
  const runnerUp = sorted[1];
  const h = runnerUp ? headToHead.find((x) => (x.a === best.name && x.b === runnerUp.name) || (x.b === best.name && x.a === runnerUp.name)) : undefined;
  const pBetter = h ? (h.a === best.name ? h.pAAheadOfB : 1 - h.pAAheadOfB) : 1;
  const distinguishable = pBetter >= 0.6;

  return {
    version: STRATEGY_SIM_VERSION,
    driverNumber: target,
    iterations,
    seed,
    objective: "Minimise expected finishing position (ties broken by P(podium)). Other objectives (max P(win), min variance) can rank differently.",
    results,
    headToHead,
    recommendation: {
      name: best.name,
      distinguishable,
      reason: runnerUp
        ? `${best.name} has the best expected position (${best.expectedPosition} vs ${runnerUp.expectedPosition} for ${runnerUp.name}); it finishes ahead in ${Math.round(pBetter * 100)}% of paired simulations${distinguishable ? "" : ", which is not a clear separation under current uncertainty"}.`
        : `Only one strategy evaluated.`,
    },
    assumptions: [
      "Lap time = base pace + compound offset + degradation(age) - fuel burn + noise; parameters are estimates, see PREDICTION_MODELS.md.",
      `SC ${p.scProbabilityPerLap}/lap and VSC ${p.vscProbabilityPerLap}/lap are default priors unless calibrated per circuit.`,
      "Overtaking is a probabilistic function of pace advantage and circuit difficulty; dirty air applies when a pass fails.",
      "Other cars follow the deterministic tyre-only optimum unless their strategy is specified.",
    ],
  };
}

function scaleDeg(p: SimParams, k: number): SimParams {
  const degradation = { ...p.degradation };
  for (const c of Object.keys(degradation) as Compound[]) degradation[c] = { slope: degradation[c].slope * k, quad: degradation[c].quad * k };
  return { ...p, degradation };
}

export interface RaceResultForecast {
  version: string;
  iterations: number;
  seed: number;
  drivers: { driverNumber: number; code: string; grid: number; expectedPosition: number; positionDistribution: number[]; pWin: number; pPodium: number; pPoints: number; dnfShare: number }[];
}

export function forecastRaceResult(field: SimCar[], p: SimParams, iterations = 2000, seed = 42): RaceResultForecast {
  const n = field.length;
  const counts = new Map(field.map((c) => [c.driverNumber, new Array<number>(n).fill(0)]));
  const dnfs = new Map(field.map((c) => [c.driverNumber, 0]));
  for (let it = 0; it < iterations; it++) {
    const out = simulateRace(field, p, new Rng(seed * 100003 + it));
    out.order.forEach((d, i) => counts.get(d)![i]!++);
    for (const [d, l] of out.lapsDone) if (l < p.totalLaps) dnfs.set(d, dnfs.get(d)! + 1);
  }
  const drivers = field.map((c) => {
    const dist = counts.get(c.driverNumber)!.map((x) => x / iterations);
    return {
      driverNumber: c.driverNumber,
      code: c.code,
      grid: c.grid,
      expectedPosition: round(dist.reduce((a, q, i) => a + q * (i + 1), 0), 2),
      positionDistribution: dist.map((x) => round(x, 4)),
      pWin: round(dist[0]!, 4),
      pPodium: round(dist.slice(0, 3).reduce((a, b) => a + b, 0), 4),
      pPoints: round(dist.slice(0, 10).reduce((a, b) => a + b, 0), 4),
      dnfShare: round(dnfs.get(c.driverNumber)! / iterations, 4),
    };
  });
  drivers.sort((a, b) => a.expectedPosition - b.expectedPosition);
  return { version: STRATEGY_SIM_VERSION, iterations, seed, drivers };
}
