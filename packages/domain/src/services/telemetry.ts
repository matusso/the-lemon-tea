import type { AuthContext, Lap } from "@lemon-tea/shared-types";
import { LemonTeaError } from "@lemon-tea/shared-types";
import { buildLapTrace, decimateIndices, type LapInput, type LapTiming } from "@lemon-tea/telemetry-core";
import type { AccessPolicy } from "../access.ts";
import type { AuthorizedSession, Store } from "../store.ts";

export function lapTiming(l: Lap): LapTiming {
  return {
    driverNumber: l.driverNumber,
    lapNumber: l.lapNumber,
    startMs: l.dateStart ? Date.parse(l.dateStart) : null,
    lapTime: l.lapTime,
    sector1: l.sector1,
    sector2: l.sector2,
    sector3: l.sector3,
    isPitOutLap: l.isPitOutLap,
    stSpeed: l.stSpeed,
  };
}

/** Fastest lap with a start time that is not an out-lap. */
export function fastestLap(laps: Lap[]): Lap | null {
  let best: Lap | null = null;
  for (const l of laps) {
    if (l.lapTime === null || l.dateStart === null || l.isPitOutLap) continue;
    if (!best || l.lapTime < best.lapTime!) best = l;
  }
  return best;
}

export class TelemetryService {
  constructor(private readonly store: Store, private readonly access: AccessPolicy) {}

  /** Load raw samples for one lap (with 3 s margins) as an analytics input. */
  async lapInput(s: AuthorizedSession, driverNumber: number, lapNumber?: number, withPositions = true): Promise<LapInput> {
    const laps = await this.store.laps(s, driverNumber);
    if (!laps.length) throw new LemonTeaError("not_found", `No laps for #${driverNumber} in ${s.id}`);
    const lap = lapNumber === undefined ? fastestLap(laps) : laps.find((l) => l.lapNumber === lapNumber) ?? null;
    if (!lap) throw new LemonTeaError("not_found", lapNumber === undefined ? `No valid timed lap for #${driverNumber}` : `Lap ${lapNumber} not found for #${driverNumber}`);
    if (lap.dateStart === null || lap.lapTime === null) throw new LemonTeaError("data_unavailable", `Lap ${lap.lapNumber} of #${driverNumber} has no start time or lap time`);
    const from = new Date(Date.parse(lap.dateStart) - 3000).toISOString();
    const to = new Date(Date.parse(lap.dateStart) + lap.lapTime * 1000 + 3000).toISOString();
    const [car, pos, drivers] = await Promise.all([
      this.store.carSamples(s, driverNumber, from, to),
      withPositions ? this.store.positionSamples(s, [driverNumber], from, to) : Promise.resolve(new Map()),
      this.store.drivers(s),
    ]);
    if (car.t.length < 10) throw new LemonTeaError("data_unavailable", `Car telemetry not ingested for #${driverNumber} lap ${lap.lapNumber}`);
    return {
      sessionId: s.id,
      driverCode: drivers.find((d) => d.driverNumber === driverNumber)?.code ?? String(driverNumber),
      timing: lapTiming(lap),
      car,
      pos: pos.get(driverNumber) ?? null,
    };
  }

  /**
   * Bounded telemetry: a single lap (with distance axis) or a session-time window, decimated
   * with min/max bucketing so peaks survive. Only channels present in the source are returned.
   */
  async telemetry(ctx: AuthContext, q: { sessionId: string; driverNumber: number; lapNumber?: number; fromMs?: number; toMs?: number; maxPoints: number }) {
    const s = await this.access.session(ctx, q.sessionId, "telemetry:read");
    const epoch = Date.parse(s.dateStart);
    if (q.lapNumber !== undefined) {
      const input = await this.lapInput(s, q.driverNumber, q.lapNumber, false);
      const { trace } = buildLapTrace(input.car, null, {
        sessionId: s.id,
        driverNumber: q.driverNumber,
        lapNumber: q.lapNumber,
        lapStartMs: input.timing.startMs!,
        lapTime: input.timing.lapTime!,
        stepMetres: 5,
      });
      const idx = decimateIndices(trace.speed, q.maxPoints);
      const pick = <T>(a: T[] | undefined) => (a ? idx.map((i) => a[i]!) : undefined);
      return {
        sessionId: s.id,
        driverNumber: q.driverNumber,
        lapNumber: q.lapNumber,
        lapTime: input.timing.lapTime,
        axis: "lap_distance_m",
        points: idx.length,
        sourceSamples: input.car.t.length,
        channels: {
          distance: { unit: "m", kind: "calculated", values: pick(trace.distance) },
          time: { unit: "s since lap start", kind: "calculated", values: pick(trace.time) },
          speed: { unit: "km/h", kind: "measured", values: pick(trace.speed) },
          throttle: { unit: "%", kind: "measured", values: pick(trace.throttle) },
          brake: { unit: "on/off", kind: "measured", values: pick(trace.brake) },
          ...(trace.gear ? { gear: { unit: "gear", kind: "measured", values: pick(trace.gear) } } : {}),
          ...(trace.rpm ? { rpm: { unit: "rpm", kind: "measured", values: pick(trace.rpm) } } : {}),
          acceleration: { unit: "m/s^2", kind: "calculated", values: pick(trace.acceleration) },
        },
        note: "Values on the distance grid are interpolated from samples (linear for continuous channels, step for gear/brake). See measured sample count.",
      };
    }
    const fromMs = q.fromMs ?? 0;
    const toMs = q.toMs ?? fromMs + 120_000;
    if (toMs <= fromMs) throw new LemonTeaError("invalid_input", "toMs must be greater than fromMs");
    if (toMs - fromMs > 30 * 60_000) throw new LemonTeaError("invalid_input", "Time windows are limited to 30 minutes; request a lap or a narrower window");
    const car = await this.store.carSamples(s, q.driverNumber, new Date(epoch + fromMs).toISOString(), new Date(epoch + toMs).toISOString());
    const idx = decimateIndices(car.speed, q.maxPoints);
    const pick = <T>(a: T[] | undefined) => (a ? idx.map((i) => a[i]!) : undefined);
    return {
      sessionId: s.id,
      driverNumber: q.driverNumber,
      axis: "session_time_ms",
      points: idx.length,
      sourceSamples: car.t.length,
      channels: {
        t: { unit: "ms since session start", kind: "measured", values: idx.map((i) => car.t[i]! - epoch) },
        speed: { unit: "km/h", kind: "measured", values: pick(car.speed) },
        throttle: { unit: "%", kind: "measured", values: pick(car.throttle) },
        brake: { unit: "on/off", kind: "measured", values: pick(car.brake) },
        ...(car.gear ? { gear: { unit: "gear", kind: "measured", values: pick(car.gear) } } : {}),
        ...(car.rpm ? { rpm: { unit: "rpm", kind: "measured", values: pick(car.rpm) } } : {}),
        ...(car.drs ? { drs: { unit: "source code", kind: "measured", values: pick(car.drs) } } : {}),
      },
      note: idx.length < car.t.length ? "Decimated with min/max bucketing; raw samples are available at a narrower window." : "All raw samples in window.",
    };
  }
}
