import type { Lap, SessionBundle, SessionResult } from "@lemon-tea/shared-types";
import { regulationEraForYear } from "@lemon-tea/shared-types";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";
import { ProviderHttpClient, type ProviderAdapter, type ProviderCapabilities, type ProviderHealth, type SessionListing } from "@lemon-tea/provider-sdk";

/**
 * Jolpica-F1 (Ergast-compatible) adapter: calendar, results and lap times for historical
 * validation. It has no telemetry or positions; those methods return empty sample sets and the
 * capabilities mark the channels unavailable.
 *
 * Session keys: `<season>-<round>-<R|Q|S>`, e.g. `2024-5-R`.
 */
type Json = Record<string, any>;

const parseTime = (s: unknown): number | null => {
  if (typeof s !== "string") return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
};

const resultStatus = (kind: "R" | "Q" | "S", status: string): SessionResult["status"] => {
  if (kind === "Q") return "finished";
  if (status === "Finished" || /^\+\d+ Lap/.test(status)) return "finished";
  if (/Disqualified/i.test(status)) return "dsq";
  if (/Did not start|Withdrew/i.test(status)) return "dns";
  return "dnf";
};

export class JolpicaProvider implements ProviderAdapter {
  readonly id = "jolpica";
  private http: ProviderHttpClient;
  private base: string;

  constructor(o: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.base = (o.baseUrl ?? "https://api.jolpi.ca/ergast/f1").replace(/\/$/, "");
    this.http = new ProviderHttpClient({ allowedHosts: [new URL(this.base).hostname], requestsPerSecond: 2, burst: 2, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      name: "Jolpica-F1",
      historical: true,
      live: false,
      auth: "none",
      sessionDiscovery: true,
      coverage: "1950 onwards (results); lap times from 1996",
      rateLimit: { requestsPerSecond: 2, burst: 2 },
      licensingSourceId: "jolpica",
      channels: [
        { channel: "lap_time", available: true, kind: "measured", unit: "s", nominalHz: null },
        { channel: "results", available: true, kind: "measured", unit: null, nominalHz: null },
        { channel: "car_telemetry", available: false, kind: "unavailable", unit: null, nominalHz: null },
        { channel: "position_xyz", available: false, kind: "unavailable", unit: null, nominalHz: null },
      ],
    };
  }

  async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      await this.http.getJson(`${this.base}/current.json?limit=1`);
      return { ok: true, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, latencyMs: null, checkedAt: new Date().toISOString(), message: (e as Error).message };
    }
  }

  async listSessions(year: number): Promise<SessionListing[]> {
    const j = await this.http.getJson<Json>(`${this.base}/${year}.json?limit=100`);
    const races: Json[] = j.MRData?.RaceTable?.Races ?? [];
    const at = (d?: Json) => (d?.date ? new Date(`${d.date}T${d.time ?? "00:00:00Z"}`).toISOString() : null);
    const out: SessionListing[] = [];
    for (const r of races) {
      const base = { meetingKey: `${year}-${r.round}`, year, circuitShortName: String(r.Circuit?.circuitId ?? ""), countryName: r.Circuit?.Location?.country ?? null, dateEnd: null };
      if (r.Qualifying) out.push({ ...base, sessionKey: `${year}-${r.round}-Q`, name: "Qualifying", type: "qualifying", dateStart: at(r.Qualifying)! });
      if (r.Sprint) out.push({ ...base, sessionKey: `${year}-${r.round}-S`, name: "Sprint", type: "sprint", dateStart: at(r.Sprint)! });
      out.push({ ...base, sessionKey: `${year}-${r.round}-R`, name: "Race", type: "race", dateStart: at(r)! });
    }
    return out;
  }

  async fetchSession(sessionKey: string): Promise<SessionBundle> {
    const m = /^(\d{4})-(\d{1,2})-([RQS])$/.exec(sessionKey);
    if (!m) throw new Error("Jolpica session key must look like 2024-5-R");
    const year = m[1]!;
    const round = m[2]!;
    const kind = m[3] as "R" | "Q" | "S";
    const path = kind === "R" ? "results" : kind === "Q" ? "qualifying" : "sprint";
    const j = await this.http.getJson<Json>(`${this.base}/${year}/${round}/${path}.json?limit=100`);
    const race: Json | undefined = j.MRData?.RaceTable?.Races?.[0];
    if (!race) throw new Error(`No ${path} for ${sessionKey}`);
    const rows: Json[] = race.Results ?? race.QualifyingResults ?? race.SprintResults ?? [];
    const dateStart = new Date(`${race.date}T${race.time ?? "00:00:00Z"}`).toISOString();
    const circuitId = `jolpica:${race.Circuit.circuitId}`;
    const circuitName = String(race.Circuit?.circuitName ?? race.Circuit?.circuitId);
    const drivers = rows.map((r) => ({
      driverNumber: Number(r.number ?? r.Driver?.permanentNumber),
      code: String(r.Driver?.code ?? r.Driver?.driverId ?? "").toUpperCase().slice(0, 3),
      fullName: `${r.Driver?.givenName ?? ""} ${r.Driver?.familyName ?? ""}`.trim(),
      teamName: String(r.Constructor?.name ?? "Unknown"),
      teamColour: "888888",
    }));
    const results: SessionResult[] = rows.map((r) => ({
      driverNumber: Number(r.number),
      position: r.position ? Number(r.position) : null,
      laps: r.laps ? Number(r.laps) : null,
      status: resultStatus(kind, String(r.status ?? "")),
      duration: kind === "Q" ? parseTime(r.Q3 ?? r.Q2 ?? r.Q1) : r.Time?.millis ? Number(r.Time.millis) / 1000 : null,
      gapToLeader: null,
      points: r.points ? Number(r.points) : null,
    }));
    let laps: Lap[] = [];
    if (kind === "R") {
      const lj = await this.http.getJson<Json>(`${this.base}/${year}/${round}/laps.json?limit=2000`);
      const byDriverId = new Map(rows.map((r) => [String(r.Driver?.driverId), Number(r.number)]));
      laps = (lj.MRData?.RaceTable?.Races?.[0]?.Laps ?? []).flatMap((lap: Json) =>
        (lap.Timings ?? [])
          .map(
            (t: Json): Lap => ({
              driverNumber: byDriverId.get(String(t.driverId)) ?? 0,
              lapNumber: Number(lap.number),
              dateStart: null,
              lapTime: parseTime(t.time),
              sector1: null,
              sector2: null,
              sector3: null,
              i1Speed: null,
              i2Speed: null,
              stSpeed: null,
              isPitOutLap: false,
              miniSectors: [],
            }),
          )
          .filter((l: Lap) => l.driverNumber > 0),
      );
    }
    return {
      meeting: {
        id: `jolpica:${year}-${round}`,
        year: Number(year),
        name: String(race.raceName),
        countryName: race.Circuit?.Location?.country ?? null,
        location: race.Circuit?.Location?.locality ?? null,
        circuitId,
        circuitShortName: circuitName,
        dateStart,
      },
      session: {
        id: `jolpica:${sessionKey}`,
        meetingId: `jolpica:${year}-${round}`,
        year: Number(year),
        name: kind === "R" ? "Race" : kind === "Q" ? "Qualifying" : "Sprint",
        type: kind === "R" ? "race" : kind === "Q" ? "qualifying" : "sprint",
        circuitId,
        circuitShortName: circuitName,
        countryName: race.Circuit?.Location?.country ?? null,
        dateStart,
        dateEnd: null,
        regulationEra: regulationEraForYear(Number(year)),
        source: "jolpica",
      },
      drivers,
      laps,
      stints: [],
      pitEvents: [],
      raceControl: [],
      weather: [],
      teamRadio: [],
      positionHistory: [],
      intervals: [],
      results,
    };
  }

  async fetchCarSamples(): Promise<CarSamples> {
    return { t: [], speed: [], throttle: [], brake: [] };
  }

  async fetchPositionSamples(): Promise<PositionSamples> {
    return { t: [], x: [], y: [], z: [] };
  }
}
