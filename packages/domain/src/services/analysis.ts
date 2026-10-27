import type { AuthContext, DistanceTrace } from "@lemon-tea/shared-types";
import { LemonTeaError } from "@lemon-tea/shared-types";
import {
  buildLapTrace,
  compareLaps,
  DELTA_CONVENTION,
  DOMINANCE_VERSION,
  driverFingerprint,
  indexAt,
  mad,
  median,
  round,
  theoreticalBestLap,
  trackDominance,
  type LapComparison,
} from "@lemon-tea/telemetry-core";
import type { AccessPolicy } from "../access.ts";
import type { Store } from "../store.ts";
import { fastestLap, lapTiming, type TelemetryService } from "./telemetry.ts";
import type { TimingService } from "./timing.ts";

interface LapRefIn {
  sessionId: string;
  driverNumber: number;
  lapNumber?: number | undefined;
}

/** Thin a trace for transport: every k-th grid point. */
function thinTrace(t: DistanceTrace, everyMetres: number) {
  const step = t.distance[1]! - t.distance[0]!;
  const k = Math.max(1, Math.round(everyMetres / step));
  const pick = <T>(a: T[] | undefined) => (a ? a.filter((_, i) => i % k === 0 || i === a.length - 1) : undefined);
  return {
    distance: pick(t.distance),
    time: pick(t.time),
    speed: pick(t.speed),
    throttle: pick(t.throttle),
    brake: pick(t.brake),
    gear: pick(t.gear),
    rpm: pick(t.rpm),
    acceleration: pick(t.acceleration),
    x: pick(t.x),
    y: pick(t.y),
  };
}

export class LapComparisonService {
  constructor(
    private readonly store: Store,
    private readonly access: AccessPolicy,
    private readonly telemetry: TelemetryService,
  ) {}

  /** Full comparison (internal shape, includes full traces). */
  async compareRaw(ctx: AuthContext, a: LapRefIn, b: LapRefIn, stepMetres = 5): Promise<LapComparison> {
    const sa = await this.access.session(ctx, a.sessionId, "analytics:read");
    const sb = a.sessionId === b.sessionId ? sa : await this.access.session(ctx, b.sessionId, "analytics:read");
    const [ia, ib] = await Promise.all([this.telemetry.lapInput(sa, a.driverNumber, a.lapNumber), this.telemetry.lapInput(sb, b.driverNumber, b.lapNumber)]);
    const cmp = compareLaps(ia, ib, stepMetres);
    if (sa.circuitId !== sb.circuitId) {
      cmp.meta.warnings.push({ code: "different_circuits", message: "Laps are from different circuits; a distance-aligned comparison is not meaningful." });
      cmp.meta.dataQuality = "insufficient";
    } else if (sa.year !== sb.year) {
      cmp.meta.warnings.push({ code: "different_seasons", message: "Laps are from different seasons; car, regulations and possibly layout differ." });
    }
    return cmp;
  }

  /** Public contract shared by REST and MCP. */
  async compare(ctx: AuthContext, q: { a: LapRefIn; b: LapRefIn; stepMetres: number; includeTraces: boolean; traceResolutionMetres: number }) {
    const c = await this.compareRaw(ctx, q.a, q.b, q.stepMetres);
    return {
      analysis_type: "lap_comparison",
      meta: c.meta,
      delta_convention: DELTA_CONVENTION,
      delta_semantics: "time_delta_seconds = lapTime(A) - lapTime(B); negative means A was faster. Section deltas use the same sign: negative = A gained.",
      a: c.a,
      b: c.b,
      reference_length_m: round(c.referenceLength, 1),
      time_delta_seconds: c.timeDeltaSeconds,
      max_gain_for_a: { distance_m: round(c.maxGained.distance, 0), delta_seconds: round(c.maxGained.delta, 3) },
      max_loss_for_a: { distance_m: round(c.maxLost.distance, 0), delta_seconds: round(c.maxLost.delta, 3) },
      sectors: c.sectors,
      mini_sectors: c.miniSectors.map((m) => ({ ...m, from: round(m.from, 0), to: round(m.to, 0), deltaChange: round(m.deltaChange, 3) })),
      corners: c.corners.map((cc) => ({
        corner: cc.corner,
        delta_change_seconds: round(cc.deltaChange, 3),
        dominant_phase: cc.dominantPhase,
        phases: cc.phases.map((p) => ({ ...p, from: round(p.from, 0), to: round(p.to, 0), deltaChange: round(p.deltaChange, 3) })),
        a: roundMetrics(cc.a),
        b: roundMetrics(cc.b),
        apex_assessment: cc.apexAssessment,
      })),
      straights: c.straights.map((s) => ({ ...s, from: round(s.from, 0), to: round(s.to, 0), deltaChange: round(s.deltaChange, 3) })),
      findings: c.findings,
      summary: c.summary,
      dominant_factor: c.dominantFactor,
      confidence: c.confidence,
      confidence_type: c.confidenceType,
      noise_floor_seconds: c.noiseFloorSeconds,
      ...(q.includeTraces
        ? {
            traces: {
              resolution_m: q.traceResolutionMetres,
              a: thinTrace(c.traces.a, q.traceResolutionMetres),
              b: thinTrace(c.traces.b, q.traceResolutionMetres),
              delta: c.delta.delta.filter((_, i) => i % Math.max(1, Math.round(q.traceResolutionMetres / q.stepMetres)) === 0).map((v) => round(v, 4)),
            },
          }
        : {}),
    };
  }

  async lapDelta(ctx: AuthContext, q: { a: LapRefIn; b: LapRefIn; stepMetres: number; traceResolutionMetres: number }) {
    const c = await this.compareRaw(ctx, q.a, q.b, q.stepMetres);
    const k = Math.max(1, Math.round(q.traceResolutionMetres / q.stepMetres));
    return {
      analysis_type: "lap_delta",
      meta: c.meta,
      delta_convention: DELTA_CONVENTION,
      a: c.a,
      b: c.b,
      time_delta_seconds: c.timeDeltaSeconds,
      distance_m: c.delta.distance.filter((_, i) => i % k === 0).map((v) => round(v, 0)),
      delta_seconds: c.delta.delta.filter((_, i) => i % k === 0).map((v) => round(v, 4)),
      noise_floor_seconds: c.noiseFloorSeconds,
    };
  }

  async corner(ctx: AuthContext, q: { a: LapRefIn; b: LapRefIn; stepMetres: number; corner?: number | undefined }) {
    const c = await this.compareRaw(ctx, q.a, q.b, q.stepMetres);
    const corners = q.corner === undefined ? c.corners : c.corners.filter((x) => x.corner.index === q.corner);
    if (!corners.length) throw new LemonTeaError("not_found", `Corner ${q.corner} not detected; ${c.corners.length} corners were detected on these laps`);
    return {
      analysis_type: "corner_analysis",
      meta: c.meta,
      delta_convention: DELTA_CONVENTION,
      a: c.a,
      b: c.b,
      corners: corners.map((cc) => ({
        corner: cc.corner,
        delta_change_seconds: round(cc.deltaChange, 3),
        dominant_phase: cc.dominantPhase,
        phases: cc.phases.map((p) => ({ ...p, deltaChange: round(p.deltaChange, 3) })),
        a: roundMetrics(cc.a),
        b: roundMetrics(cc.b),
        apex_assessment: cc.apexAssessment,
        explanation: c.findings.find((f) => f.scope === cc.corner.label) ?? null,
      })),
      definitions: {
        brakeStart: "first brake-on sample in the corner window (binary brake channel)",
        minSpeedDistance: "speed-minimum point ('speed apex'); NOT a measured racing-line apex",
        throttleOn: "first point after the speed minimum with throttle > 20% and rising",
        exitAcceleration: "mean longitudinal acceleration from speed minimum to window end, from speed",
      },
    };
  }

  async braking(ctx: AuthContext, q: { a: LapRefIn; b: LapRefIn; stepMetres: number }) {
    const c = await this.compareRaw(ctx, q.a, q.b, q.stepMetres);
    return {
      analysis_type: "braking_analysis",
      meta: { ...c.meta, assumptions: [...c.meta.assumptions, "Braking intensity/pressure is not available; only on/off timing, distances and speed loss are compared."] },
      a: c.a,
      b: c.b,
      zones: c.corners
        .filter((cc) => cc.a.brakeStart !== null || cc.b.brakeStart !== null)
        .map((cc) => ({
          corner: cc.corner.label,
          band: cc.corner.band,
          a: { brakeStart: round1(cc.a.brakeStart), brakingDistance: round1(cc.a.brakingDistance), brakingDuration: round3(cc.a.brakingDuration), entrySpeed: round1(cc.a.entrySpeed), minSpeed: round1(cc.a.minSpeed), speedLoss: round1(cc.a.entrySpeed - cc.a.minSpeed) },
          b: { brakeStart: round1(cc.b.brakeStart), brakingDistance: round1(cc.b.brakingDistance), brakingDuration: round3(cc.b.brakingDuration), entrySpeed: round1(cc.b.entrySpeed), minSpeed: round1(cc.b.minSpeed), speedLoss: round1(cc.b.entrySpeed - cc.b.minSpeed) },
          brake_point_difference_m: cc.a.brakeStart !== null && cc.b.brakeStart !== null ? round(cc.a.brakeStart - cc.b.brakeStart, 1) : null,
          entry_phase_delta_seconds: round(cc.phases[0]!.deltaChange, 3),
        })),
      semantics: "brake_point_difference_m > 0 means A started braking later (further along the lap).",
    };
  }

  async acceleration(ctx: AuthContext, q: { a: LapRefIn; b: LapRefIn; stepMetres: number }) {
    const c = await this.compareRaw(ctx, q.a, q.b, q.stepMetres);
    return {
      analysis_type: "acceleration_analysis",
      meta: c.meta,
      a: c.a,
      b: c.b,
      exits: c.corners.map((cc) => ({
        corner: cc.corner.label,
        band: cc.corner.band,
        a: { throttleOn: round1(cc.a.throttleOn), fullThrottle: round1(cc.a.fullThrottle), exitSpeed: round1(cc.a.exitSpeed), exitAcceleration: round3(cc.a.exitAcceleration) },
        b: { throttleOn: round1(cc.b.throttleOn), fullThrottle: round1(cc.b.fullThrottle), exitSpeed: round1(cc.b.exitSpeed), exitAcceleration: round3(cc.b.exitAcceleration) },
        exit_phase_delta_seconds: round(cc.phases[2]!.deltaChange, 3),
      })),
      straights: c.straights.map((s) => {
        const i0 = indexAt(c.traces.a.distance, s.from);
        const i1 = indexAt(c.traces.a.distance, s.to);
        return {
          label: s.label,
          from: round(s.from, 0),
          to: round(s.to, 0),
          delta_seconds: round(s.deltaChange, 3),
          a_top_speed: Math.max(...c.traces.a.speed.slice(i0, i1 + 1)),
          b_top_speed: Math.max(...c.traces.b.speed.slice(i0, i1 + 1)),
        };
      }),
      caveat: "Straight-line differences can stem from power deployment, drag, slipstream or DRS/active aero, which are not separable with this data.",
    };
  }

  async dominance(ctx: AuthContext, q: { sessionId: string; driverNumbers: number[]; segments: number }) {
    const s = await this.access.session(ctx, q.sessionId, "analytics:read");
    const inputs = await Promise.all(q.driverNumbers.map((d) => this.telemetry.lapInput(s, d, undefined, true)));
    const pre = inputs.map((i) =>
      buildLapTrace(i.car, null, { sessionId: s.id, driverNumber: i.timing.driverNumber, lapNumber: i.timing.lapNumber, lapStartMs: i.timing.startMs!, lapTime: i.timing.lapTime!, stepMetres: 5 }),
    );
    const L = median(pre.map((p) => p.integratedLength));
    const traces = inputs.map(
      (i) =>
        buildLapTrace(i.car, i.pos, { sessionId: s.id, driverNumber: i.timing.driverNumber, lapNumber: i.timing.lapNumber, lapStartMs: i.timing.startMs!, lapTime: i.timing.lapTime!, stepMetres: 5, referenceLength: L }).trace,
    );
    const segs = trackDominance(traces, q.segments);
    return {
      analysis_type: "track_dominance",
      algorithm_version: DOMINANCE_VERSION,
      sessionId: s.id,
      laps: inputs.map((i) => ({ driverNumber: i.timing.driverNumber, code: i.driverCode, lapNumber: i.timing.lapNumber, lapTime: i.timing.lapTime })),
      reference_length_m: round(L, 1),
      segments: segs.map((g) => ({ ...g, from: round(g.from, 0), to: round(g.to, 0) })),
      share: Object.fromEntries(q.driverNumbers.map((d) => [d, round(segs.filter((g) => g.fastestDriver === d).length / segs.length, 3)])),
      assumptions: ["Each driver's fastest valid lap of the session is used.", "Margins below ~0.02 s per segment are within measurement noise."],
    };
  }

  async theoreticalBest(ctx: AuthContext, sessionId: string, driverNumber?: number) {
    const s = await this.access.session(ctx, sessionId, "analytics:read");
    const laps = await this.store.laps(s);
    return { analysis_type: "theoretical_best_lap", sessionId, ...theoreticalBestLap(laps.map(lapTiming), driverNumber ?? null) };
  }

  async driverStyle(ctx: AuthContext, q: { sessionId: string; driverNumber: number }) {
    const s = await this.access.session(ctx, q.sessionId, "analytics:read");
    const laps = await this.store.laps(s, q.driverNumber);
    const best = fastestLap(laps);
    if (!best) throw new LemonTeaError("insufficient_data", "No valid laps");
    const pushLaps = laps.filter((l) => l.lapTime !== null && l.dateStart && !l.isPitOutLap && l.lapTime <= best.lapTime! * 1.02).slice(0, 5);
    const traces: DistanceTrace[] = [];
    for (const l of pushLaps) {
      try {
        const i = await this.telemetry.lapInput(s, q.driverNumber, l.lapNumber, false);
        traces.push(buildLapTrace(i.car, null, { sessionId: s.id, driverNumber: q.driverNumber, lapNumber: l.lapNumber, lapStartMs: i.timing.startMs!, lapTime: i.timing.lapTime!, stepMetres: 5 }).trace);
      } catch {
        // missing telemetry for this lap
      }
    }
    if (!traces.length) throw new LemonTeaError("data_unavailable", "Telemetry not available for representative laps");
    const times = pushLaps.map((l) => l.lapTime!);
    return {
      analysis_type: "driver_fingerprint",
      sessionId: s.id,
      ...driverFingerprint(traces, [], times.length >= 3 ? round(mad(times), 3) : null),
      lapsUsed: pushLaps.map((l) => l.lapNumber),
      note: "Descriptive, data-derived characteristics within this session only; not causal and not comparable across circuits without normalisation.",
    };
  }

  async compareTeams(ctx: AuthContext, q: { sessionId: string; teams?: string[] | undefined }, timing: TimingService) {
    const s = await this.access.session(ctx, q.sessionId, "analytics:read");
    const b = await timing.bundleFor(s);
    const teams = q.teams ?? [...new Set(b.drivers.map((d) => d.teamName))];
    const rows = [];
    for (const team of teams) {
      const ds = b.drivers.filter((d) => d.teamName === team);
      if (!ds.length) continue;
      const best = ds
        .map((d) => fastestLap(b.laps.filter((l) => l.driverNumber === d.driverNumber)))
        .filter((l): l is NonNullable<typeof l> => l !== null)
        .sort((x, y) => x.lapTime! - y.lapTime!)[0];
      if (!best) continue;
      let bands: Record<string, number | null> = { low: null, medium: null, high: null };
      let top: number | null = null;
      try {
        const fp = await this.driverStyle(ctx, { sessionId: q.sessionId, driverNumber: best.driverNumber });
        bands = { low: fp.minSpeedRatio.low, medium: fp.minSpeedRatio.medium, high: fp.minSpeedRatio.high };
        top = fp.topSpeed;
      } catch {
        // telemetry missing: timing-only row
      }
      const st = b.laps.filter((l) => ds.some((d) => d.driverNumber === l.driverNumber) && l.stSpeed !== null).map((l) => l.stSpeed!);
      rows.push({
        team,
        drivers: ds.map((d) => d.code),
        bestLap: best.lapTime,
        bestLapDriver: best.driverNumber,
        bestSectors: [best.sector1, best.sector2, best.sector3],
        speedTrapMax: st.length ? Math.max(...st) : null,
        telemetryTopSpeed: top,
        cornerSpeedRatio: bands,
      });
    }
    rows.sort((x, y) => (x.bestLap ?? Infinity) - (y.bestLap ?? Infinity));
    const leader = rows[0]?.bestLap ?? null;
    return {
      analysis_type: "team_comparison",
      sessionId: s.id,
      teams: rows.map((r) => ({ ...r, gapToFastest: r.bestLap !== null && leader !== null ? round(r.bestLap - leader, 3) : null })),
      definitions: { cornerSpeedRatio: "mean of (minimum corner speed / approach speed) by corner speed band, from the team's fastest lap" },
      caveats: ["Single-session comparison: fuel loads and run plans are unknown in practice.", "Corner bands come from detected corners, not official turn lists."],
    };
  }
}

function round1(v: number | null) {
  return v === null ? null : round(v, 1);
}
function round3(v: number | null) {
  return v === null ? null : round(v, 3);
}
function roundMetrics<T extends object>(m: T): T {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? round(v, 3) : v])) as T;
}
