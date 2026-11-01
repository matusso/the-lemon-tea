import type { AuthContext, DistanceTrace, Lap } from "@lemon-tea/shared-types";
import { LemonTeaError } from "@lemon-tea/shared-types";
import { checkLapGeometry, CIRCUIT_ENGINE_VERSION, deriveGeometry, findPositionLoops } from "@lemon-tea/circuit-engine";
import { buildLapTrace, interpLinearClamped, type CarSamples, type PositionSamples } from "@lemon-tea/telemetry-core";
import type { AccessPolicy } from "../access.ts";
import type { AuthorizedSession, CircuitLayoutRecord, Store } from "../store.ts";
import type { TelemetryService } from "./telemetry.ts";

export class CircuitService {
  private building = new Map<string, Promise<CircuitLayoutRecord>>();
  private privateLayouts = new Map<string, CircuitLayoutRecord>();

  constructor(
    private readonly store: Store,
    private readonly access: AccessPolicy,
    private readonly telemetry: TelemetryService,
  ) {}

  async circuit(ctx: AuthContext, sessionId: string) {
    const s = await this.access.session(ctx, sessionId);
    const layout = await this.layoutFor(s);
    return {
      circuitId: s.circuitId,
      name: s.circuitShortName,
      year: s.year,
      lengthM: layout.lengthM,
      accuracyM: layout.accuracyM,
      confidence: layout.confidence,
      provenance: layout.provenance,
      geometry: layout.geometry,
      units: "metres, origin-shifted source frame",
    };
  }

  /**
   * Layouts are derived from the first session of a circuit/year that has position data. Layouts
   * derived from public sessions are persisted and shared; layouts derived from a tenant's private
   * data are kept in memory for that tenant only, so private telemetry never leaks via geometry.
   */
  async layoutFor(s: AuthorizedSession): Promise<CircuitLayoutRecord> {
    // Layouts from an older derivation algorithm are rebuilt (they may come from unvalidated laps).
    const current = (l: CircuitLayoutRecord | null | undefined): l is CircuitLayoutRecord => !!l && l.provenance.algorithmVersion === CIRCUIT_ENGINE_VERSION;
    const cached = await this.store.circuitLayout(s.circuitId, s.year);
    if (current(cached)) return cached;
    const key = `${s.circuitId}:${s.year}:${s.ownerTenantId ?? "public"}`;
    const mem = this.privateLayouts.get(key);
    if (current(mem)) return mem;
    try {
      return await this.buildShared(key, s);
    } catch (e) {
      // A session without usable positions (e.g. live and not ingested yet) borrows the layout of
      // another session at the same circuit; a stale layout is still better than none.
      const borrowed = await this.borrowLayout(s, key);
      if (borrowed) return borrowed;
      if (cached) return cached;
      throw e;
    }
  }

  /**
   * Layout from another ingested session at the same circuit with the same owner (this season
   * first, then last season). Only same-owner sessions are used, so private positions never
   * shape a layout served to someone else.
   */
  private async borrowLayout(s: AuthorizedSession, key: string): Promise<CircuitLayoutRecord | null> {
    for (const year of [s.year, s.year - 1]) {
      const sibs = (await this.store.listSessions({ tenantId: s.ownerTenantId }, { year, limit: 200 }))
        .filter((r) => r.circuitId === s.circuitId && r.ownerTenantId === s.ownerTenantId && r.id !== s.id && (r.ingestStatus === "complete" || r.ingestStatus === "partial"))
        .sort((a, b) => b.dateStart.localeCompare(a.dateStart))
        .slice(0, 3);
      for (const sib of sibs) {
        try {
          const rec = await this.buildShared(`${sib.circuitId}:${sib.year}:${sib.ownerTenantId ?? "public"}`, sib as AuthorizedSession);
          const out = { ...rec, provenance: { ...rec.provenance, borrowedFrom: sib.id } };
          this.privateLayouts.set(key, out);
          return out;
        } catch {
          // try the next session
        }
      }
    }
    return null;
  }

  private buildShared(key: string, s: AuthorizedSession): Promise<CircuitLayoutRecord> {
    let p = this.building.get(key);
    if (!p) {
      p = this.build(s).finally(() => this.building.delete(key));
      this.building.set(key, p);
    }
    return p;
  }

  /** Laps worth trying, fastest first: every timed, non-out lap within 115 % of the session best. */
  static candidateLaps(laps: Lap[]): Lap[] {
    const timed = laps.filter((l) => l.lapTime !== null && l.dateStart !== null && !l.isPitOutLap && l.lapTime > 30);
    if (!timed.length) return [];
    const best = Math.min(...timed.map((l) => l.lapTime!));
    return timed.filter((l) => l.lapTime! <= best * 1.15).sort((a, b) => a.lapTime! - b.lapTime!);
  }

  private async build(s: AuthorizedSession): Promise<CircuitLayoutRecord> {
    const laps = await this.store.laps(s);
    const rejected: string[] = [];
    const derive = (ts: LapForGeometry[]) =>
      deriveGeometry(
        ts.map((t) => ({ trace: t.trace, z: t.z })),
        ts[0]!.sectorTimes.map((t) => interpLinearClamped(ts[0]!.trace.time, ts[0]!.trace.distance, t)),
        { source: s.source, sessionId: s.id, laps: ts.map((t) => t.label) },
      );
    // 1) Laps as the source times them. Live feeds have stretches of missing or frozen samples,
    //    so the fastest laps are not necessarily usable: each is validated.
    const timed = await this.timedLapTraces(s, laps, rejected);
    let best = timed.length ? { g: derive(timed), method: "timed laps" } : null;
    // 2) Unless that is already a tight, multi-lap fit, also find laps as closed loops in the
    //    position traces themselves (independent of the source's lap timing) and keep the result
    //    whose laps agree better with each other.
    if (!best || best.g.confidence !== "high") {
      const loops = await this.positionLoopTraces(s, laps, rejected);
      if (loops.length >= 2 || (!best && loops.length)) {
        const g = derive(loops);
        const score = (x: { accuracyM: number; confidence: string }) => (x.confidence === "low" ? 1e6 : 0) + (Number.isFinite(x.accuracyM) ? x.accuracyM : 1e5);
        if (!best || score(g) < score(best.g)) best = { g, method: "closed loops in position data (source lap timing not consistent with samples)" };
      }
    }
    if (!best) {
      throw new LemonTeaError("data_unavailable", `No lap with complete, consistent position data in ${s.id}; circuit geometry cannot be derived`, {
        rejected: rejected.slice(0, 10),
      });
    }
    const g = best.g;
    g.provenance.lapSelection = best.method;
    const record: CircuitLayoutRecord = {
      circuitId: s.circuitId,
      year: s.year,
      lengthM: g.lengthM,
      geometry: g.geometry,
      provenance: g.provenance,
      accuracyM: Number.isFinite(g.accuracyM) ? g.accuracyM : null,
      confidence: g.confidence,
    };
    if (s.ownerTenantId === null) await this.store.saveCircuitLayout(record, s.uid);
    else this.privateLayouts.set(`${s.circuitId}:${s.year}:${s.ownerTenantId}`, record);
    return record;
  }

  private traceFrom(s: AuthorizedSession, car: CarSamples, pos: PositionSamples, driverNumber: number, lapNumber: number, startMs: number, lapTime: number) {
    const { trace, integratedLength } = buildLapTrace(car, pos, { sessionId: s.id, driverNumber, lapNumber, lapStartMs: startMs, lapTime, stepMetres: 5 });
    const check = checkLapGeometry(trace, integratedLength);
    const z = trace.time.map((sec) => interpLinearClamped(pos.t, pos.z, startMs + sec * 1000));
    return { trace, z, check };
  }

  private async timedLapTraces(s: AuthorizedSession, laps: Lap[], rejected: string[]): Promise<LapForGeometry[]> {
    const WANT = 5;
    const MAX_TRIES = 40;
    const perDriver = new Map<number, number>();
    const out: LapForGeometry[] = [];
    let tried = 0;
    for (const lap of CircuitService.candidateLaps(laps)) {
      if (out.length >= WANT || tried >= MAX_TRIES) break;
      if ((perDriver.get(lap.driverNumber) ?? 0) >= 2) continue; // spread over several cars
      tried++;
      const label = `#${lap.driverNumber} L${lap.lapNumber}`;
      try {
        const input = await this.telemetry.lapInput(s, lap.driverNumber, lap.lapNumber, true);
        if (!input.pos || input.pos.t.length < 50) {
          rejected.push(`${label}: no position samples`);
          continue;
        }
        const r = this.traceFrom(s, input.car, input.pos, lap.driverNumber, lap.lapNumber, input.timing.startMs!, input.timing.lapTime!);
        if (!r.check.ok) {
          rejected.push(`${label}: ${r.check.reason}`);
          continue;
        }
        const sectorTimes = lap.sector1 !== null ? [lap.sector1, ...(lap.sector2 !== null ? [lap.sector1 + lap.sector2] : [])] : [];
        out.push({ trace: r.trace, z: r.z, label, sectorTimes });
        perDriver.set(lap.driverNumber, (perDriver.get(lap.driverNumber) ?? 0) + 1);
      } catch {
        rejected.push(`${label}: samples not ingested`);
      }
    }
    return out;
  }

  private async positionLoopTraces(s: AuthorizedSession, laps: Lap[], rejected: string[]): Promise<LapForGeometry[]> {
    const lapCount = new Map<number, number>();
    for (const l of laps) lapCount.set(l.driverNumber, (lapCount.get(l.driverNumber) ?? 0) + 1);
    const drivers = [...lapCount].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d]) => d);
    const out: LapForGeometry[] = [];
    let anchor: { x: number; y: number } | null = null;
    for (const dn of drivers) {
      if (out.length >= 5) break;
      const pos = (await this.store.positionSamples(s, [dn])).get(dn);
      if (!pos || pos.t.length < 200) continue;
      const car = await this.store.carSamples(s, dn);
      if (car.t.length < 200) continue;
      const loops = findPositionLoops(pos, { anchor, max: 6 });
      let taken = 0;
      for (const [k, loop] of loops.entries()) {
        if (taken >= 2) break;
        const r = this.traceFrom(s, car, pos, dn, 0, loop.startMs, (loop.endMs - loop.startMs) / 1000);
        if (!r.check.ok) {
          rejected.push(`#${dn} loop ${k + 1}: ${r.check.reason}`);
          continue;
        }
        // every later loop starts where the first accepted one did, so laps share one origin
        anchor ??= { x: r.trace.x![0]!, y: r.trace.y![0]! };
        out.push({ trace: r.trace, z: r.z, label: `#${dn} loop@${new Date(loop.startMs).toISOString().slice(11, 19)}`, sectorTimes: [] });
        taken++;
      }
    }
    return out;
  }
}

interface LapForGeometry {
  trace: DistanceTrace;
  z: number[];
  label: string;
  /** Sector boundary times measured from the lap start (s); empty when unknown. */
  sectorTimes: number[];
}
