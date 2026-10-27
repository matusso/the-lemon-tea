import type { AuthContext } from "@lemon-tea/shared-types";
import { LemonTeaError } from "@lemon-tea/shared-types";
import { deriveGeometry } from "@lemon-tea/circuit-engine";
import { buildLapTrace, interpLinearClamped } from "@lemon-tea/telemetry-core";
import type { AccessPolicy } from "../access.ts";
import type { AuthorizedSession, CircuitLayoutRecord, Store } from "../store.ts";
import { fastestLap, type TelemetryService } from "./telemetry.ts";

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
    const cached = await this.store.circuitLayout(s.circuitId, s.year);
    if (cached) return cached;
    const key = `${s.circuitId}:${s.year}:${s.ownerTenantId ?? "public"}`;
    const mem = this.privateLayouts.get(key);
    if (mem) return mem;
    let p = this.building.get(key);
    if (!p) {
      p = this.build(s).finally(() => this.building.delete(key));
      this.building.set(key, p);
    }
    return p;
  }

  private async build(s: AuthorizedSession): Promise<CircuitLayoutRecord> {
    const laps = await this.store.laps(s);
    const drivers = [...new Set(laps.map((l) => l.driverNumber))];
    const candidates = drivers
      .map((d) => fastestLap(laps.filter((l) => l.driverNumber === d)))
      .filter((l): l is NonNullable<typeof l> => l !== null)
      .sort((a, b) => a.lapTime! - b.lapTime!)
      .slice(0, 5);
    if (!candidates.length) throw new LemonTeaError("data_unavailable", "No timed laps to derive circuit geometry from");
    const traces = [];
    for (const lap of candidates) {
      try {
        const input = await this.telemetry.lapInput(s, lap.driverNumber, lap.lapNumber, true);
        if (!input.pos || input.pos.t.length < 50) continue;
        const { trace } = buildLapTrace(input.car, input.pos, {
          sessionId: s.id,
          driverNumber: lap.driverNumber,
          lapNumber: lap.lapNumber,
          lapStartMs: input.timing.startMs!,
          lapTime: input.timing.lapTime!,
          stepMetres: 5,
        });
        const tAt = trace.time.map((sec) => input.timing.startMs! + sec * 1000);
        const z = tAt.map((ms) => interpLinearClamped(input.pos!.t, input.pos!.z, ms));
        traces.push({ trace, z, lap });
      } catch {
        // skip laps whose samples were not ingested
      }
    }
    if (!traces.length) throw new LemonTeaError("data_unavailable", "Position data not ingested for this session; circuit geometry cannot be derived");
    const ref = traces[0]!;
    const s1 = ref.lap.sector1;
    const s2 = ref.lap.sector2;
    const boundaries = [s1, s1 !== null && s2 !== null ? s1 + s2 : null]
      .filter((v): v is number => v !== null)
      .map((t) => interpLinearClamped(ref.trace.time, ref.trace.distance, t));
    const g = deriveGeometry(
      traces.map((t) => ({ trace: t.trace, z: t.z })),
      boundaries,
      { source: s.source, sessionId: s.id, laps: traces.map((t) => `#${t.lap.driverNumber} L${t.lap.lapNumber}`) },
    );
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
}
