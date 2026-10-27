import type { AuthContext } from "@lemon-tea/shared-types";
import { LemonTeaError } from "@lemon-tea/shared-types";
import type { AccessPolicy } from "../access.ts";
import type { AuthorizedSession, Store } from "../store.ts";
import type { TelemetryService } from "./telemetry.ts";

/** Redistribution classes for which a user may download data they can already see. */
const EXPORTABLE = new Set(["permitted", "attribution_required", "non_commercial"]);

function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return "";
    const s = String(v);
    // Neutralise spreadsheet formula injection from source text fields.
    const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export class ExportService {
  constructor(
    private readonly store: Store,
    private readonly access: AccessPolicy,
    private readonly telemetry: TelemetryService,
  ) {}

  /** Export is allowed when the source's terms permit it, or the data is the caller's own import. */
  private async check(ctx: AuthContext, s: AuthorizedSession): Promise<string | null> {
    if (s.ownerTenantId !== null && s.ownerTenantId === ctx.tenantId && s.source === "file_import") return null;
    const src = (await this.store.dataSources()).find((d) => d.id === s.source);
    if (!src || !EXPORTABLE.has(src.redistribution)) {
      throw new LemonTeaError("forbidden", `Export is not permitted for source '${s.source}' (redistribution: ${src?.redistribution ?? "unknown"})`);
    }
    return src.attribution;
  }

  async laps(ctx: AuthContext, sessionId: string, format: "csv" | "json") {
    const s = await this.access.session(ctx, sessionId);
    const attribution = await this.check(ctx, s);
    const laps = await this.store.laps(s);
    const columns = ["driverNumber", "lapNumber", "dateStart", "lapTime", "sector1", "sector2", "sector3", "i1Speed", "i2Speed", "stSpeed", "isPitOutLap"];
    return this.wrap(format, attribution, s, "laps", laps as unknown as Record<string, unknown>[], columns);
  }

  async lapTelemetry(ctx: AuthContext, sessionId: string, driverNumber: number, lapNumber: number | undefined, format: "csv" | "json") {
    const s = await this.access.session(ctx, sessionId, "telemetry:read");
    const attribution = await this.check(ctx, s);
    const input = await this.telemetry.lapInput(s, driverNumber, lapNumber, false);
    const epoch = Date.parse(s.dateStart);
    const rows = input.car.t.map((t, i) => ({
      utc: new Date(t).toISOString(),
      sessionMs: t - epoch,
      speedKmh: input.car.speed[i],
      throttlePct: input.car.throttle[i],
      brakeOnOff: input.car.brake[i],
      rpm: input.car.rpm?.[i],
      gear: input.car.gear?.[i],
    }));
    const columns = ["utc", "sessionMs", "speedKmh", "throttlePct", "brakeOnOff", "rpm", "gear"];
    return this.wrap(format, attribution, s, `telemetry_${driverNumber}_lap${input.timing.lapNumber}`, rows, columns);
  }

  private wrap(format: "csv" | "json", attribution: string | null, s: AuthorizedSession, name: string, rows: Record<string, unknown>[], columns: string[]) {
    const filename = `${s.id.replace(":", "_")}_${name}.${format}`;
    const provenance = { sessionId: s.id, source: s.source, kind: "measured (raw source samples)", exportedAt: new Date().toISOString(), attribution };
    if (format === "json") return { filename, contentType: "application/json", body: JSON.stringify({ provenance, columns, rows }) };
    const header = `# ${JSON.stringify(provenance)}\n`;
    return { filename, contentType: "text/csv; charset=utf-8", body: header + csv(rows, columns) };
  }
}
