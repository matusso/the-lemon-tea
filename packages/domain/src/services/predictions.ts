import type { AuthContext, TyreCompound } from "@lemon-tea/shared-types";
import { LemonTeaError } from "@lemon-tea/shared-types";
import {
  bestDeterministicStrategy,
  classifyLaps,
  CLASSIFIER_VERSION,
  DEFAULT_PACE_PARAMS,
  DEFAULT_SIM_PARAMS,
  degradationReport,
  fitStints,
  forecastRaceResult,
  median,
  neutralisedPeriods,
  predictQualifying,
  QUALIFYING_MODEL_VERSION,
  racePace,
  RACE_PACE_VERSION,
  round,
  simulateStrategies,
  STRATEGY_SIM_VERSION,
  DEGRADATION_VERSION,
  type ClassifiedLap,
  type Compound,
  type ContextLap,
  type PaceModelParams,
  type SimCar,
  type SimParams,
  type StrategyCandidate,
} from "@lemon-tea/telemetry-core";
import { sha256 } from "@lemon-tea/auth";
import { weatherAt, type TimingBundle } from "@lemon-tea/synchronization";
import type { AccessPolicy } from "../access.ts";
import type { AuthorizedSession, Store } from "../store.ts";
import type { TimingService } from "./timing.ts";

/** Active model parameters: trained values when a version is active, documented priors otherwise. */
export async function paceParams(store: Store): Promise<PaceModelParams> {
  const m = await store.activeModel("pace");
  if (!m) return DEFAULT_PACE_PARAMS;
  return { ...DEFAULT_PACE_PARAMS, ...(m.params as Partial<PaceModelParams>), version: m.id };
}

export class PracticeAnalysisService {
  constructor(
    private readonly access: AccessPolicy,
    private readonly timing: TimingService,
  ) {}

  async sessions(ctx: AuthContext, ids: string[]): Promise<{ s: AuthorizedSession; b: TimingBundle }[]> {
    const out = [];
    for (const id of ids) {
      const s = await this.access.session(ctx, id, "analytics:read");
      out.push({ s, b: await this.timing.bundleFor(s) });
    }
    // Chronological order matters for session-evolution offsets.
    out.sort((x, y) => Date.parse(x.s.dateStart) - Date.parse(y.s.dateStart));
    const meetings = new Set(out.map((x) => x.s.meetingId));
    if (meetings.size > 1) throw new LemonTeaError("invalid_input", "All sessions must belong to the same race weekend");
    return out;
  }

  static contextLaps(b: TimingBundle): ContextLap[] {
    return b.laps.map((l) => {
      const st = b.stints.find((s) => s.driverNumber === l.driverNumber && l.lapNumber >= s.lapStart && l.lapNumber <= s.lapEnd);
      const startMs = l.dateStart ? Date.parse(l.dateStart) : null;
      const wx = startMs !== null ? weatherAt(b, startMs - b.epochMs) : null;
      return {
        driverNumber: l.driverNumber,
        lapNumber: l.lapNumber,
        startMs,
        lapTime: l.lapTime,
        sector1: l.sector1,
        sector2: l.sector2,
        sector3: l.sector3,
        isPitOutLap: l.isPitOutLap,
        stSpeed: l.stSpeed,
        sessionId: b.sessionId,
        compound: (st?.compound ?? "UNKNOWN") as TyreCompound,
        stintNumber: st?.stintNumber ?? null,
        tyreAge: st && st.tyreAgeAtStart !== null ? st.tyreAgeAtStart + (l.lapNumber - st.lapStart) : null,
        trackTemperature: wx?.trackTemperature ?? null,
      };
    });
  }

  static classify(b: TimingBundle): ClassifiedLap[] {
    const periods = neutralisedPeriods(
      b.raceControl.map((e) => ({ tMs: Date.parse(e.date), category: e.category, flag: e.flag, message: e.message })),
      b.endMs !== null ? b.epochMs + b.endMs : Number.MAX_SAFE_INTEGER,
    );
    const pitLaps = new Map<number, Set<number>>();
    for (const p of b.pitEvents) {
      if (!pitLaps.has(p.driverNumber)) pitLaps.set(p.driverNumber, new Set());
      pitLaps.get(p.driverNumber)!.add(p.lapNumber);
    }
    return classifyLaps(PracticeAnalysisService.contextLaps(b), periods, pitLaps);
  }

  async classified(ctx: AuthContext, ids: string[]) {
    const ss = await this.sessions(ctx, ids);
    return { ss, laps: ss.flatMap(({ b }) => PracticeAnalysisService.classify(b)) };
  }

  async longRuns(ctx: AuthContext, ids: string[], params: PaceModelParams) {
    const { ss, laps } = await this.classified(ctx, ids);
    const fits = fitStints(laps, params);
    const drivers = uniqueDrivers(ss.map((x) => x.b));
    const pace = racePace(fits, drivers, params);
    return {
      analysis_type: "long_runs",
      classifierVersion: CLASSIFIER_VERSION,
      sessions: ss.map((x) => x.s.id),
      lapClassCounts: countBy(laps.map((l) => l.primary)),
      ...pace,
    };
  }
}

export class TyreModelService {
  constructor(private readonly store: Store, private readonly practice: PracticeAnalysisService) {}

  async degradation(ctx: AuthContext, q: { sessionIds: string[]; compound?: string | undefined }) {
    const params = await paceParams(this.store);
    const { laps } = await this.practice.classified(ctx, q.sessionIds);
    const fits = fitStints(laps, params).filter((f) => !q.compound || f.compound === q.compound);
    if (!fits.length) throw new LemonTeaError("insufficient_data", "No representative long runs found in these sessions");
    const r = degradationReport(fits, params);
    return {
      analysis_type: "tyre_degradation",
      kind: "estimated",
      ...r,
      stints: r.stints.map(({ tyreAges: _a, fuelCorrected: _f, ...rest }) => ({ ...rest, degradationSlope: round(rest.degradationSlope, 4), pooledSlope: round(rest.pooledSlope, 4) })),
      inferred_tyre_state_note: "Tyre temperatures and pressures are not available from connected sources; no measured temperatures are shown.",
    };
  }

  async compareTyres(ctx: AuthContext, q: { sessionIds: string[] }) {
    const d = await this.degradation(ctx, q);
    const params = await paceParams(this.store);
    return {
      analysis_type: "tyre_comparison",
      kind: "estimated",
      compounds: d.compounds.map((c) => ({
        compound: c.compound,
        paceOffsetVsSoft: params.compoundOffsetPrior[c.compound] ?? null,
        paceOffsetSource: "prior (see PREDICTION_MODELS.md); estimated offsets appear in predict_qualifying when data allows",
        degradationPerLap: c.slope,
        degradationInterval: c.slopeInterval,
        lapsToOneSecondLoss: c.lapsToOneSecondLoss,
        stints: c.stints,
        cliffIndicatorShare: c.cliffIndicatorShare,
      })),
      modelComparison: d.modelComparison,
      assumptions: d.assumptions,
    };
  }
}

export class QualifyingPredictionService {
  constructor(
    private readonly store: Store,
    private readonly access: AccessPolicy,
    private readonly practice: PracticeAnalysisService,
  ) {}

  async predict(ctx: AuthContext, q: { sessionIds: string[]; persist: boolean }) {
    this.access.require(ctx, "predictions:read");
    const params = await paceParams(this.store);
    const { ss, laps } = await this.practice.classified(ctx, q.sessionIds);
    const drivers = uniqueDrivers(ss.map((x) => x.b));
    let pred;
    try {
      pred = predictQualifying(laps, drivers, ss.map((x) => x.s.id), { params, seed: 7, iterations: 5000 });
    } catch (e) {
      throw new LemonTeaError("insufficient_data", (e as Error).message);
    }
    const asOf = latestDataTime(ss.map((x) => x.b));
    let predictionId: string | null = null;
    let changes = null;
    if (q.persist && !ctx.anonymous) {
      const prev = (await this.store.listPredictions(this.access.scope(ctx), { meetingId: ss[0]!.s.meetingId, kind: "qualifying", limit: 1 }))[0];
      const saved = await this.store.savePrediction(this.access.scope(ctx), {
        ownerTenantId: ctx.tenantId,
        kind: "qualifying",
        meetingId: ss[0]!.s.meetingId,
        inputSessionIds: ss.map((x) => x.s.id),
        targetSessionId: null,
        modelVersion: QUALIFYING_MODEL_VERSION,
        paramsVersion: params.version,
        inputHash: await sha256(JSON.stringify({ s: ss.map((x) => x.s.id), asOf, params: params.version })),
        asOf,
        output: pred,
      });
      predictionId = saved.id;
      if (prev) changes = diffQuali(prev.output as typeof pred, pred);
    }
    return { analysis_type: "qualifying_prediction", predictionId, asOf, changesSincePrevious: changes, ...pred };
  }
}

export class RacePacePredictionService {
  constructor(private readonly store: Store, private readonly access: AccessPolicy, private readonly practice: PracticeAnalysisService) {}

  async predict(ctx: AuthContext, q: { sessionIds: string[] }) {
    this.access.require(ctx, "predictions:read");
    const params = await paceParams(this.store);
    const r = await this.practice.longRuns(ctx, q.sessionIds, params);
    if (!r.drivers.length) throw new LemonTeaError("insufficient_data", "No representative long runs found in these sessions");
    return { ...r, analysis_type: "race_pace_prediction", modelVersion: RACE_PACE_VERSION, paramsVersion: params.version, kind: "estimated" };
  }
}

export interface FieldBuild {
  field: SimCar[];
  params: SimParams;
  notes: string[];
  raceSession: AuthorizedSession;
}

export class StrategySimulationService {
  constructor(
    private readonly store: Store,
    private readonly access: AccessPolicy,
    private readonly timing: TimingService,
    private readonly practice: PracticeAnalysisService,
  ) {}

  /** Assemble field and parameters from data: pace from long runs, grid from qualifying/race. */
  async buildField(ctx: AuthContext, raceSessionId: string, paceSessionIds: string[], gridSessionId?: string, totalLapsIn?: number): Promise<FieldBuild> {
    const race = await this.access.session(ctx, raceSessionId, "simulations:execute");
    const rb = await this.timing.bundleFor(race);
    const notes: string[] = [];
    const pp = await paceParams(this.store);

    const paceIds = paceSessionIds.length ? paceSessionIds : [];
    const pace = paceIds.length ? await this.practice.longRuns(ctx, paceIds, pp) : null;
    let deg: Partial<SimParams["degradation"]> = {};
    if (pace) {
      const { laps } = await this.practice.classified(ctx, paceIds);
      const rep = degradationReport(fitStints(laps, pp), pp);
      for (const c of rep.compounds) {
        if (c.compound === "SOFT" || c.compound === "MEDIUM" || c.compound === "HARD") {
          deg[c.compound] = { slope: Math.max(0.01, c.slope), quad: DEFAULT_SIM_PARAMS.degradation[c.compound].quad };
        }
      }
    } else {
      notes.push("No pace sessions supplied: all drivers use equal pace; results reflect grid order and randomness only.");
      deg = {};
    }

    const maxLap = rb.laps.reduce((m, l) => Math.max(m, l.lapNumber), 0);
    const totalLaps = totalLapsIn ?? (maxLap > 5 ? maxLap : 0);
    if (!totalLaps) throw new LemonTeaError("invalid_input", "totalLaps is required when the race session has no lap data yet");

    // Grid: qualifying classification if given, else the race's first recorded positions.
    let gridOrder: number[] = [];
    /** One-lap pace gap to the fastest driver in the grid session (s), from measured best laps. */
    const qualiGap = new Map<number, number>();
    if (gridSessionId) {
      const g = await this.access.session(ctx, gridSessionId, "sessions:read");
      const gb = await this.timing.bundleFor(g);
      gridOrder = gb.results.filter((r) => r.position !== null).sort((a, b) => a.position! - b.position!).map((r) => r.driverNumber);
      const best = new Map<number, number>();
      for (const l of gb.laps) if (l.lapTime !== null && !l.isPitOutLap) best.set(l.driverNumber, Math.min(best.get(l.driverNumber) ?? Infinity, l.lapTime));
      const pole = Math.min(...best.values());
      for (const [d, t] of best) qualiGap.set(d, t - pole);
    }
    if (!gridOrder.length) {
      const first = new Map<number, number>();
      for (const p of rb.positionHistory) if (!first.has(p.driverNumber)) first.set(p.driverNumber, p.position);
      gridOrder = [...first].sort((a, b) => a[1] - b[1]).map(([d]) => d);
    }
    if (!gridOrder.length) {
      gridOrder = rb.drivers.map((d) => d.driverNumber);
      notes.push("No grid information found; car number order used as grid.");
    }

    const laneLoss = rb.pitEvents.map((p) => p.laneDuration).filter((v): v is number => v !== null && v > 10 && v < 60);
    const params: SimParams = {
      ...DEFAULT_SIM_PARAMS,
      totalLaps,
      fuelEffectPerLap: pp.fuelEffectPerLap,
      degradation: { ...DEFAULT_SIM_PARAMS.degradation, ...deg },
      // pit lane time minus the racing lap it replaces is approximated as lane duration - 3 s
      pitLaneLoss: laneLoss.length >= 3 ? round(median(laneLoss) - 3, 2) : DEFAULT_SIM_PARAMS.pitLaneLoss,
    };
    if (laneLoss.length < 3) notes.push(`Pit-lane loss uses default ${DEFAULT_SIM_PARAMS.pitLaneLoss} s (no measured stops in race data).`);
    else notes.push(`Pit-lane loss ${params.pitLaneLoss} s from ${laneLoss.length} measured stops in this session.`);
    notes.push(`Overtaking difficulty ${params.overtakeDifficulty} and SC/VSC rates are uncalibrated defaults.`);

    const paceBy = new Map((pace?.drivers ?? []).map((d) => [d.driverNumber, d]));
    const known = [...paceBy.values()].map((d) => d.referencePace - d.meanDegradation * 5);
    const fieldBase = known.length ? median(known) : 90;
    const fuelOffset = pp.fuelEffectPerLap * (totalLaps / 2); // practice runs assumed ~half race fuel
    const defaultStrategy = bestDeterministicStrategy(params, 2).stints;
    // Pace relative to the field, fusing two noisy measurements by inverse-variance weighting:
    //  - long-run gap (fuel-corrected practice pace; sd from its interval, includes unknown fuel load)
    //  - qualifying one-lap gap (measured; QUALI_TO_RACE_SD for how imperfectly it transfers to race pace)
    const QUALI_TO_RACE_SD = 0.3;
    const qMedian = qualiGap.size ? median([...qualiGap.values()].filter((v) => v < 3)) : 0;
    const fused = (dn: number): { gap: number; sd: number } | null => {
      const p = paceBy.get(dn);
      const q = qualiGap.get(dn);
      const lr = p ? { g: p.referencePace - p.meanDegradation * 5 - fieldBase, v: Math.max(0.15, (p.interval.high - p.interval.low) / 2.56) ** 2 } : null;
      const qq = q !== undefined && q < 3 ? { g: q - qMedian, v: QUALI_TO_RACE_SD ** 2 } : null;
      if (lr && qq) {
        const w = 1 / lr.v + 1 / qq.v;
        return { gap: (lr.g / lr.v + qq.g / qq.v) / w, sd: Math.sqrt(1 / w) };
      }
      if (lr) return { gap: lr.g, sd: Math.sqrt(lr.v) };
      if (qq) return { gap: qq.g, sd: Math.sqrt(qq.v + 0.2 ** 2) };
      return null;
    };
    if (qualiGap.size && pace) notes.push(`Driver pace fuses practice long-run pace with qualifying one-lap pace (inverse-variance weights; qualifying-to-race sd ${QUALI_TO_RACE_SD} s).`);
    else if (qualiGap.size) notes.push("No long runs supplied: pace relative to the field comes from qualifying one-lap pace only.");
    const field: SimCar[] = gridOrder
      .map((dn, i): SimCar | null => {
        const d = rb.drivers.find((x) => x.driverNumber === dn);
        if (!d) return null;
        const f = fused(dn);
        return {
          driverNumber: dn,
          code: d.code,
          grid: i + 1,
          basePace: fieldBase + (f ? f.gap : 1.0) + fuelOffset,
          paceSd: f ? Math.max(0.15, f.sd) : 0.6,
          strategy: defaultStrategy,
        };
      })
      .filter((c): c is SimCar => c !== null);
    const missing = field.filter((c) => fused(c.driverNumber) === null).map((c) => c.code);
    if (missing.length) notes.push(`No pace data for ${missing.join(", ")}: field median + 1.0 s with wide uncertainty.`);
    return { field, params, notes, raceSession: race };
  }

  async simulate(ctx: AuthContext, q: {
    sessionId: string;
    paceSessionIds?: string[] | undefined;
    driverNumber: number;
    totalLaps?: number | undefined;
    strategies: StrategyCandidate[];
    iterations: number;
    seed: number;
    scenario: { safetyCarProbabilityPerLap?: number | undefined; vscProbabilityPerLap?: number | undefined; pitLossSeconds?: number | undefined; trackTempDeltaC?: number | undefined };
  }) {
    this.access.require(ctx, "simulations:execute");
    const { field, params, notes } = await this.buildField(ctx, q.sessionId, q.paceSessionIds ?? [], undefined, q.totalLaps);
    if (!field.some((c) => c.driverNumber === q.driverNumber)) throw new LemonTeaError("not_found", `Driver #${q.driverNumber} not in the race field`);
    const p: SimParams = {
      ...params,
      ...(q.scenario.safetyCarProbabilityPerLap !== undefined ? { scProbabilityPerLap: q.scenario.safetyCarProbabilityPerLap } : {}),
      ...(q.scenario.vscProbabilityPerLap !== undefined ? { vscProbabilityPerLap: q.scenario.vscProbabilityPerLap } : {}),
      ...(q.scenario.pitLossSeconds !== undefined ? { pitLaneLoss: q.scenario.pitLossSeconds } : {}),
      ...(q.scenario.trackTempDeltaC !== undefined ? { trackTempDeltaC: q.scenario.trackTempDeltaC } : {}),
    };
    const candidates = q.strategies.map((s) => ({ name: s.name, stints: normaliseStints(s.stints as { compound: Compound; laps: number }[], p.totalLaps) }));
    const study = simulateStrategies(field, q.driverNumber, candidates, p, q.iterations, q.seed);
    return {
      analysis_type: "strategy_simulation",
      kind: "simulated",
      modelVersion: STRATEGY_SIM_VERSION,
      sessionId: q.sessionId,
      totalLaps: p.totalLaps,
      parameters: { pitLaneLoss: p.pitLaneLoss, scProbabilityPerLap: p.scProbabilityPerLap, vscProbabilityPerLap: p.vscProbabilityPerLap, degradation: p.degradation, fuelEffectPerLap: p.fuelEffectPerLap, overtakeDifficulty: p.overtakeDifficulty },
      fieldStrategy: field[0]?.strategy,
      notes,
      ...study,
    };
  }

  async raceResult(ctx: AuthContext, q: { raceSessionId: string; paceSessionIds: string[]; gridSessionId?: string | undefined; iterations: number; seed: number }) {
    this.access.require(ctx, "simulations:execute");
    const { field, params, notes } = await this.buildField(ctx, q.raceSessionId, q.paceSessionIds, q.gridSessionId);
    const f = forecastRaceResult(field, params, q.iterations, q.seed);
    return {
      analysis_type: "race_result_forecast",
      kind: "simulated",
      confidenceType: "uncalibrated_probability",
      raceSessionId: q.raceSessionId,
      totalLaps: params.totalLaps,
      notes,
      ...f,
    };
  }
}

export class ModelEvaluationService {
  constructor(private readonly store: Store, private readonly access: AccessPolicy, private readonly timing: TimingService) {}

  async modelMetrics(ctx: AuthContext, family?: string) {
    this.access.require(ctx, "predictions:read");
    const [versions, backtests] = await Promise.all([this.store.modelVersions(family), this.store.backtests({ ...(family ? { family } : {}), limit: 50 })]);
    return {
      versions,
      backtests,
      builtin: [
        { family: "qualifying", version: QUALIFYING_MODEL_VERSION },
        { family: "race_pace", version: RACE_PACE_VERSION },
        { family: "degradation", version: DEGRADATION_VERSION },
        { family: "strategy", version: STRATEGY_SIM_VERSION },
      ],
      note: versions.length ? undefined : "No trained model versions registered yet: predictions use documented priors (uncalibrated). Run services/analytics backtests to populate.",
    };
  }

  /** Prior forecasts for a weekend, scored against the actual qualifying result when available. */
  async predictionHistory(ctx: AuthContext, q: { meetingId?: string | undefined; qualifyingSessionId?: string | undefined; limit?: number }) {
    this.access.require(ctx, "predictions:read");
    let meetingId = q.meetingId;
    let actual: Map<number, { position: number | null; duration: number | null }> | null = null;
    let actualSessionEnd: number | null = null;
    if (q.qualifyingSessionId) {
      const s = await this.access.session(ctx, q.qualifyingSessionId);
      meetingId = s.meetingId;
      const b = await this.timing.bundleFor(s);
      actualSessionEnd = Date.parse(s.dateStart);
      actual = new Map(b.results.map((r) => [r.driverNumber, { position: r.position, duration: r.duration }]));
    }
    const preds = await this.store.listPredictions(this.access.scope(ctx), { ...(meetingId ? { meetingId } : {}), limit: q.limit ?? 50 });
    return preds.map((p) => {
      const out = p.output as { drivers?: { driverNumber: number; projectedLapTime: number; expectedRank: number; probabilities: { pole: number } }[] };
      let score = null;
      if (actual && p.kind === "qualifying" && out.drivers) {
        // Leakage guard: only score forecasts made from data strictly before the target session.
        const valid = actualSessionEnd === null || Date.parse(p.asOf) < actualSessionEnd;
        const pairs = out.drivers.map((d) => ({ d, a: actual!.get(d.driverNumber) })).filter((x) => x.a?.position != null);
        const errs = pairs.filter((x) => x.a!.duration != null).map((x) => Math.abs(x.d.projectedLapTime - x.a!.duration!));
        const brierPole = pairs.reduce((s, x) => s + (x.d.probabilities.pole - (x.a!.position === 1 ? 1 : 0)) ** 2, 0) / Math.max(1, pairs.length);
        score = {
          validForEvaluation: valid,
          drivers: pairs.length,
          lapTimeMae: errs.length ? round(errs.reduce((a, b) => a + b, 0) / errs.length, 3) : null,
          rankSpearman: pairs.length > 2 ? round(spearman(pairs.map((x) => x.d.expectedRank), pairs.map((x) => x.a!.position!)), 3) : null,
          poleBrier: round(brierPole, 4),
        };
      }
      return { id: p.id, kind: p.kind, createdAt: p.createdAt, asOf: p.asOf, modelVersion: p.modelVersion, paramsVersion: p.paramsVersion, inputSessionIds: p.inputSessionIds, score, output: p.output };
    });
  }
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const r = new Array<number>(xs.length);
    idx.forEach((e, k) => (r[e.i] = k + 1));
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const n = a.length;
  const d2 = ra.reduce((s, v, i) => s + (v - rb[i]!) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function diffQuali(prev: { drivers: { driverNumber: number; code: string; expectedRank: number; projectedLapTime: number }[] }, next: { drivers: { driverNumber: number; code: string; expectedRank: number; projectedLapTime: number }[] }) {
  return next.drivers
    .map((d) => {
      const p = prev.drivers.find((x) => x.driverNumber === d.driverNumber);
      return p ? { code: d.code, rankChange: round(p.expectedRank - d.expectedRank, 2), lapTimeChange: round(d.projectedLapTime - p.projectedLapTime, 3) } : { code: d.code, rankChange: null, lapTimeChange: null };
    })
    .filter((x) => x.rankChange === null || Math.abs(x.rankChange) >= 0.5 || Math.abs(x.lapTimeChange ?? 0) >= 0.05);
}

function normaliseStints(stints: { compound: Compound; laps: number }[], totalLaps: number) {
  const sum = stints.reduce((a, s) => a + s.laps, 0);
  if (sum === totalLaps) return stints;
  const out = stints.map((s) => ({ ...s }));
  out[out.length - 1]!.laps = Math.max(1, out[out.length - 1]!.laps + (totalLaps - sum));
  return out;
}

export function uniqueDrivers(bundles: TimingBundle[]) {
  const m = new Map<number, { driverNumber: number; code: string; teamName: string }>();
  for (const b of bundles) for (const d of b.drivers) m.set(d.driverNumber, { driverNumber: d.driverNumber, code: d.code, teamName: d.teamName });
  return [...m.values()];
}

function latestDataTime(bundles: TimingBundle[]): string {
  let t = 0;
  for (const b of bundles) for (const l of b.laps) if (l.dateStart) t = Math.max(t, Date.parse(l.dateStart) + (l.lapTime ?? 0) * 1000);
  return new Date(t || Date.now()).toISOString();
}

function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}
