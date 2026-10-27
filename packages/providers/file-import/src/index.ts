import { z } from "zod";
import { parquetReadObjects } from "hyparquet";
import type { SessionBundle } from "@lemon-tea/shared-types";
import { regulationEraForYear, SessionType } from "@lemon-tea/shared-types";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";
import { normalizeSamples, sliceByTime } from "@lemon-tea/telemetry-core";
import type { ProviderAdapter, ProviderCapabilities, ProviderHealth, SessionListing } from "@lemon-tea/provider-sdk";

/**
 * User-supplied telemetry import. An import package is a manifest (JSON) plus tables given as
 * JSON arrays, CSV text or Parquet bytes. Rows are validated; invalid rows are rejected with a
 * report, never repaired by guessing. Imported sessions are always private to the importer.
 *
 * Units: time ISO-8601 UTC, speed km/h, throttle 0-100, brake 0/1 (or 0/100), positions in
 * metres, lap/sector times in seconds.
 */
export const ImportManifest = z.object({
  importId: z.string().regex(/^[a-z0-9-]{4,40}$/),
  session: z.object({
    name: z.string().min(1).max(60),
    type: SessionType,
    year: z.number().int().min(1950).max(2100),
    meetingName: z.string().min(1).max(100),
    circuitName: z.string().min(1).max(100),
    countryName: z.string().max(60).nullable().default(null),
    dateStart: z.string().datetime(),
    dateEnd: z.string().datetime().nullable().default(null),
  }),
  drivers: z
    .array(
      z.object({
        driverNumber: z.number().int().min(1).max(999),
        code: z.string().min(1).max(4),
        fullName: z.string().max(100),
        teamName: z.string().max(100),
        teamColour: z.string().regex(/^[0-9A-Fa-f]{6}$/).default("888888"),
      }),
    )
    .min(1)
    .max(40),
  laps: z
    .array(
      z.object({
        driverNumber: z.number().int(),
        lapNumber: z.number().int().min(1),
        dateStart: z.string().datetime().nullable(),
        lapTime: z.number().positive().nullable(),
        sector1: z.number().positive().nullable().default(null),
        sector2: z.number().positive().nullable().default(null),
        sector3: z.number().positive().nullable().default(null),
        isPitOutLap: z.boolean().default(false),
      }),
    )
    .max(20000)
    .default([]),
});
export type ImportManifest = z.infer<typeof ImportManifest>;

const CarRow = z.object({
  date: z.string().datetime({ offset: true }),
  driver_number: z.coerce.number().int(),
  speed: z.coerce.number().min(0).max(450),
  throttle: z.coerce.number().min(0).max(104),
  brake: z.coerce.number().min(0).max(100),
  rpm: z.coerce.number().optional(),
  n_gear: z.coerce.number().min(0).max(9).optional(),
});
const PosRow = z.object({
  date: z.string().datetime({ offset: true }),
  driver_number: z.coerce.number().int(),
  x: z.coerce.number(),
  y: z.coerce.number(),
  z: z.coerce.number().optional(),
});

export type TableInput = { format: "json"; rows: unknown[] } | { format: "csv"; text: string } | { format: "parquet"; bytes: ArrayBuffer };

export interface ImportReport {
  carRows: number;
  positionRows: number;
  rejected: { table: string; row: number; message: string }[];
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

async function rowsOf(t: TableInput | undefined): Promise<unknown[]> {
  if (!t) return [];
  if (t.format === "json") return t.rows;
  if (t.format === "csv") return parseCsv(t.text);
  const objs = await parquetReadObjects({ file: t.bytes });
  return objs.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v])));
}

interface Staged {
  manifest: ImportManifest;
  car: Map<number, CarSamples>;
  pos: Map<number, PositionSamples>;
}

export class FileImportProvider implements ProviderAdapter {
  readonly id = "file_import";
  private imports = new Map<string, Staged>();

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      name: "File import",
      historical: true,
      live: false,
      auth: "none",
      sessionDiscovery: false,
      coverage: "User supplied",
      rateLimit: { requestsPerSecond: 1000, burst: 1000 },
      licensingSourceId: "file_import",
      channels: [
        { channel: "speed", available: true, kind: "measured", unit: "km/h", nominalHz: null, note: "As supplied by the importer" },
        { channel: "throttle", available: true, kind: "measured", unit: "%", nominalHz: null },
        { channel: "brake", available: true, kind: "measured", unit: "on/off", nominalHz: null },
        { channel: "rpm", available: true, kind: "measured", unit: "rpm", nominalHz: null },
        { channel: "gear", available: true, kind: "measured", unit: null, nominalHz: null },
        { channel: "position_xyz", available: true, kind: "measured", unit: "m", nominalHz: null },
      ],
    };
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, latencyMs: 0, checkedAt: new Date().toISOString() };
  }

  /** Validate and stage an import; the ingestion service then pulls it like any provider session. */
  async stage(manifestRaw: unknown, tables: { car?: TableInput; location?: TableInput }): Promise<{ sessionKey: string; report: ImportReport }> {
    const manifest = ImportManifest.parse(manifestRaw);
    const report: ImportReport = { carRows: 0, positionRows: 0, rejected: [] };
    const reject = (table: string, row: number, message: string) => {
      if (report.rejected.length < 100) report.rejected.push({ table, row, message });
    };
    const car = new Map<number, CarSamples>();
    const pos = new Map<number, PositionSamples>();
    (await rowsOf(tables.car)).forEach((raw, i) => {
      const r = CarRow.safeParse(raw);
      if (!r.success) return reject("car", i, r.error.issues[0]?.message ?? "invalid");
      const v = r.data;
      let s = car.get(v.driver_number);
      if (!s) car.set(v.driver_number, (s = { t: [], speed: [], throttle: [], brake: [], rpm: [], gear: [] }));
      s.t.push(Date.parse(v.date));
      s.speed.push(v.speed);
      s.throttle.push(Math.min(100, v.throttle));
      s.brake.push(v.brake > 0 ? 1 : 0);
      s.rpm!.push(v.rpm ?? Number.NaN);
      s.gear!.push(v.n_gear ?? Number.NaN);
      report.carRows++;
    });
    (await rowsOf(tables.location)).forEach((raw, i) => {
      const r = PosRow.safeParse(raw);
      if (!r.success) return reject("location", i, r.error.issues[0]?.message ?? "invalid");
      const v = r.data;
      let s = pos.get(v.driver_number);
      if (!s) pos.set(v.driver_number, (s = { t: [], x: [], y: [], z: [] }));
      s.t.push(Date.parse(v.date));
      s.x.push(v.x);
      s.y.push(v.y);
      s.z.push(v.z ?? Number.NaN);
      report.positionRows++;
    });
    for (const [d, s] of car) car.set(d, normalizeSamples(s));
    for (const [d, s] of pos) pos.set(d, normalizeSamples(s));
    this.imports.set(manifest.importId, { manifest, car, pos });
    return { sessionKey: manifest.importId, report };
  }

  private staged(key: string): Staged {
    const s = this.imports.get(key);
    if (!s) throw new Error(`Import ${key} is not staged`);
    return s;
  }

  async listSessions(): Promise<SessionListing[]> {
    return [];
  }

  async fetchSession(sessionKey: string): Promise<SessionBundle> {
    const { manifest: m } = this.staged(sessionKey);
    const circuitId = `file_import:${m.session.circuitName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const meetingId = `file_import:${sessionKey}-meeting`;
    return {
      meeting: { id: meetingId, year: m.session.year, name: m.session.meetingName, countryName: m.session.countryName, location: null, circuitId, circuitShortName: m.session.circuitName, dateStart: m.session.dateStart },
      session: {
        id: `file_import:${sessionKey}`,
        meetingId,
        year: m.session.year,
        name: m.session.name,
        type: m.session.type,
        circuitId,
        circuitShortName: m.session.circuitName,
        countryName: m.session.countryName,
        dateStart: m.session.dateStart,
        dateEnd: m.session.dateEnd,
        regulationEra: regulationEraForYear(m.session.year),
        source: "file_import",
      },
      drivers: m.drivers.map((d) => ({ ...d, code: d.code.toUpperCase(), teamColour: d.teamColour.toUpperCase() })),
      laps: m.laps.map((l) => ({ ...l, i1Speed: null, i2Speed: null, stSpeed: null, miniSectors: [] })),
      stints: [],
      pitEvents: [],
      raceControl: [],
      weather: [],
      teamRadio: [],
      positionHistory: [],
      intervals: [],
      results: [],
    };
  }

  async fetchCarSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<CarSamples> {
    const s = this.staged(sessionKey).car.get(driverNumber);
    return s ? sliceByTime(s, Date.parse(fromIso), Date.parse(toIso) - 1) : { t: [], speed: [], throttle: [], brake: [] };
  }

  async fetchPositionSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<PositionSamples> {
    const s = this.staged(sessionKey).pos.get(driverNumber);
    return s ? sliceByTime(s, Date.parse(fromIso), Date.parse(toIso) - 1) : { t: [], x: [], y: [], z: [] };
  }

  release(sessionKey: string) {
    this.imports.delete(sessionKey);
  }
}
