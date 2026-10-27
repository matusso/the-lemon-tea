import type {
  ChannelAvailability,
  Driver,
  IntervalRecord,
  Lap,
  PitEvent,
  PositionRecord,
  RaceControlEvent,
  SessionBundle,
  SessionResult,
  SessionType,
  Stint,
  TeamRadio,
  TyreCompound,
  WeatherObservation,
} from "@lemon-tea/shared-types";
import { regulationEraForYear } from "@lemon-tea/shared-types";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";
import { ProviderHttpClient, ProviderHttpError, type LiveDelta, type ProviderAdapter, type ProviderCapabilities, type ProviderHealth, type SessionListing } from "@lemon-tea/provider-sdk";
import { F1AuthError } from "./auth.ts";
import { F1LiveFeed, type WebSocketFactory } from "./live.ts";
import { indexed, isObject, parseJsonStream, stripBom, type Json, type JsonObject, type StreamRecord } from "./stream.ts";
import { lapsForDriver, parseGap, splitTimingByDriver, type DriverLapRow, type DriverStreamRow } from "./timing.ts";

export * from "./auth.ts";
export * from "./stream.ts";
export * from "./timing.ts";
export { F1LiveFeed, nodeWebSocketFactory, LIVE_TOPICS, type WebSocketFactory, type WebSocketLike } from "./live.ts";

export const F1LT_SOURCE_ID = "f1lt";
export const F1LT_NORMALIZER_VERSION = "f1lt-normalize-v1";
const BASE = "https://livetiming.formula1.com";
/** Position X/Y/Z are 1/10 m from 2020 onwards (FastF1 docs; same frame OpenF1 republishes). */
const POSITION_SCALE = 0.1;
/** Drivers declared this long after the stream started are ignored, as in FastF1. */
const LATE_DRIVER_MS = 60 * 60_000;

export interface F1LiveTimingOptions {
  /** Returns the F1 TV subscription JWT for the calling tenant, or null when not connected. */
  token: () => Promise<string | null>;
  /** Called when livetiming rejects the token (expired or revoked). */
  onUnauthorized?: () => Promise<void>;
  requestsPerSecond?: number;
  fetchImpl?: typeof fetch;
  /** WebSocket factory for the live feed (Node default: `ws`; Workers pass their own). */
  connect?: WebSocketFactory;
}

interface IndexSession {
  Key: number;
  Type: string;
  Name: string;
  StartDate: string;
  EndDate?: string;
  GmtOffset?: string;
  Path?: string;
}
interface IndexMeeting {
  Key: number;
  Name: string;
  OfficialName?: string;
  Location?: string;
  Country?: { Name?: string };
  Circuit?: { Key?: number; ShortName?: string };
  Sessions: IndexSession[];
}

export function sessionTypeFromLiveTiming(type: string, name: string): SessionType {
  const n = name.toLowerCase();
  if (n.includes("sprint") && (n.includes("qualifying") || n.includes("shootout"))) return "sprint_qualifying";
  if (n === "sprint" || (type === "Race" && n.includes("sprint"))) return "sprint";
  if (type === "Practice" || n.includes("practice") || n.startsWith("day ")) return "practice";
  if (type === "Qualifying" || n.includes("qualifying")) return "qualifying";
  if (type === "Race") return "race";
  return "unknown";
}

/** Local "2025-09-06T16:00:00" + GmtOffset "02:00:00" → UTC ISO. */
export function localToUtc(local: string, gmtOffset: string | undefined): string {
  const m = /^(-)?(\d{2}):(\d{2})/.exec(gmtOffset ?? "00:00");
  const offMin = m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(Date.parse(`${local.replace(/Z$/, "")}Z`) - offMin * 60_000).toISOString();
}

/** Source UTC strings carry up to 7 fractional digits and sometimes no zone designator. */
export function parseUtc(s: unknown): number {
  if (typeof s !== "string") return NaN;
  const norm = s.replace(/(\.\d{3})\d+/, "$1");
  return Date.parse(/Z|[+-]\d{2}:\d{2}$/.test(norm) ? norm : `${norm}Z`);
}

function compound(v: unknown): TyreCompound {
  const s = String(v ?? "").toUpperCase();
  if ((["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"] as string[]).includes(s)) return s as TyreCompound;
  return s.startsWith("TEST") ? "TEST_UNKNOWN" : "UNKNOWN";
}

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const msToS = (v: number | null): number | null => (v === null || Number.isNaN(v) ? null : v / 1000);
const nanToNull = (v: number): number | null => (Number.isNaN(v) ? null : v);

interface LoadedSamples {
  car: Map<number, CarSamples>;
  position: Map<number, PositionSamples>;
}

export class F1LiveTimingProvider implements ProviderAdapter {
  readonly id = F1LT_SOURCE_ID;
  private http: ProviderHttpClient;
  private indexCache = new Map<number, IndexMeeting[]>();
  private cars = new Map<string, Promise<{ t0: number; car: Map<number, CarSamples> }>>();
  private positions = new Map<string, Promise<Map<number, PositionSamples>>>();
  private quality: Record<string, unknown> = {};
  private live: F1LiveFeed | null = null;

  constructor(private readonly o: F1LiveTimingOptions) {
    this.http = new ProviderHttpClient({
      allowedHosts: ["livetiming.formula1.com"],
      requestsPerSecond: o.requestsPerSecond ?? 2,
      burst: 2,
      timeoutMs: 180_000,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      authorization: async () => `Bearer ${await this.requireToken()}`,
    });
  }

  private async requireToken(): Promise<string> {
    const t = await this.o.token();
    if (!t) throw new F1AuthError("No Formula 1 account is connected. Sign in under Settings → Formula 1 account.");
    return t;
  }

  capabilities(): ProviderCapabilities {
    const ch = (channel: string, kind: ChannelAvailability["kind"], unit: string | null, hz: number | null, note?: string): ChannelAvailability => ({
      channel,
      available: kind !== "unavailable",
      kind,
      unit,
      nominalHz: hz,
      ...(note ? { note } : {}),
    });
    return {
      id: this.id,
      name: "F1 Live Timing (Formula 1 account)",
      historical: true,
      live: true,
      auth: "bearer_token",
      sessionDiscovery: true,
      coverage: "2018 onwards (archive); live sessions while running",
      rateLimit: { requestsPerSecond: this.o.requestsPerSecond ?? 2, burst: 2 },
      licensingSourceId: F1LT_SOURCE_ID,
      channels: [
        ch("speed", "measured", "km/h", 3.7, "Quantised to 1 km/h"),
        ch("throttle", "measured", "%", 3.7),
        ch("brake", "measured", "on/off", 3.7, "Binary; not brake pressure"),
        ch("rpm", "measured", "rpm", 3.7),
        ch("gear", "measured", null, 3.7),
        ch("drs", "measured", "code", 3.7, "Raw source code; absent from 2026"),
        ch("position_xyz", "measured", "m", 4.5, "Source 1/10 m converted to metres"),
        ch("lap_distance", "calculated", "m", null, "Integrated from speed"),
        ch("brake_pressure", "unavailable", null, null),
        ch("steering", "unavailable", null, null),
        ch("tyre_temperature", "unavailable", null, null),
        ch("fuel", "unavailable", null, null),
        ch("active_aero_state", "unavailable", null, null, "Not exposed by the live timing feed"),
        ch("overtake_mode_state", "unavailable", null, null, "Not exposed by the live timing feed"),
      ],
    };
  }

  async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      await this.index(new Date().getUTCFullYear());
      return { ok: true, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, latencyMs: null, checkedAt: new Date().toISOString(), message: (e as Error).message };
    }
  }

  lastQuality(): Record<string, unknown> {
    return this.quality;
  }

  private async getText(path: string): Promise<string | null> {
    try {
      return stripBom(await this.http.getText(`${BASE}${path}`));
    } catch (e) {
      if (e instanceof ProviderHttpError && (e.status === 401 || e.status === 403)) {
        await this.o.onUnauthorized?.();
        throw new F1AuthError("livetiming.formula1.com rejected the F1 account token (expired, revoked or no active F1 TV subscription). Sign in again.");
      }
      if (e instanceof ProviderHttpError && e.status === 404) return null; // stream not published for this session
      throw e;
    }
  }

  private async stream(path: string, file: string, zipped = false): Promise<StreamRecord[]> {
    const raw = await this.getText(`/static/${path}${file}`);
    if (raw === null) return [];
    const { records, decodeErrors } = await parseJsonStream(raw, zipped);
    if (decodeErrors) this.quality[`${file}_decodeErrors`] = decodeErrors;
    return records;
  }

  private async index(year: number): Promise<IndexMeeting[]> {
    const hit = this.indexCache.get(year);
    if (hit) return hit;
    const raw = await this.getText(`/static/${year}/Index.json`);
    const doc = raw ? (JSON.parse(raw) as { Meetings?: IndexMeeting[] }) : {};
    const meetings = Array.isArray(doc.Meetings) ? doc.Meetings : [];
    this.indexCache.set(year, meetings);
    return meetings;
  }

  /** Session keys are "<year>-<F1 session key>", e.g. "2025-9908" (keys match OpenF1's session_key). */
  private async locate(sessionKey: string): Promise<{ year: number; meeting: IndexMeeting; session: IndexSession; path: string }> {
    const m = /^(\d{4})-(\d+)$/.exec(sessionKey);
    if (!m) throw new Error(`Invalid live timing session key '${sessionKey}' (expected <year>-<key>)`);
    const year = Number(m[1]);
    for (const meeting of await this.index(year)) {
      const session = meeting.Sessions?.find((s) => String(s.Key) === m[2]);
      if (session) return { year, meeting, session, path: session.Path ?? makePath(meeting, session) };
    }
    throw new Error(`Live timing session ${sessionKey} not found in the ${year} index`);
  }

  async listSessions(year: number): Promise<SessionListing[]> {
    return (await this.index(year)).flatMap((meeting) =>
      (meeting.Sessions ?? [])
        .filter((s) => s.Key > 0)
        .map((s) => ({
          sessionKey: `${year}-${s.Key}`,
          meetingKey: String(meeting.Key),
          year,
          name: s.Name,
          type: sessionTypeFromLiveTiming(s.Type, s.Name),
          circuitShortName: meeting.Circuit?.ShortName ?? meeting.Location ?? meeting.Name,
          countryName: meeting.Country?.Name ?? null,
          dateStart: localToUtc(s.StartDate, s.GmtOffset),
          dateEnd: s.EndDate ? localToUtc(s.EndDate, s.GmtOffset) : null,
        })),
    );
  }

  async fetchSession(sessionKey: string): Promise<SessionBundle> {
    this.quality = {};
    const { year, meeting, session, path } = await this.locate(sessionKey);
    const type = sessionTypeFromLiveTiming(session.Type, session.Name);
    const isRace = type === "race" || type === "sprint";

    const heartbeat = await this.stream(path, "Heartbeat.jsonStream");
    const driverList = await this.stream(path, "DriverList.jsonStream");
    const timingData = await this.stream(path, "TimingData.jsonStream");
    const appData = await this.stream(path, "TimingAppData.jsonStream");
    const rcm = await this.stream(path, "RaceControlMessages.jsonStream");
    const weatherStream = await this.stream(path, "WeatherData.jsonStream");
    const status = await this.stream(path, "SessionStatus.jsonStream");
    const radio = await this.stream(path, "TeamRadio.jsonStream");
    if (!timingData.length) throw new Error(`No timing data published for live timing session ${sessionKey}`);

    // Stream offsets are relative to the start of the recording. As in FastF1, the origin is the
    // latest (least delayed) value of Utc - offset over timestamped records.
    let t0 = timeOrigin(heartbeat.map((r) => ({ offsetMs: r.offsetMs, utc: isObject(r.data) ? parseUtc(r.data.Utc) : NaN })));
    if (!Number.isFinite(t0)) t0 = (await this.loadCar(path)).t0;
    if (!Number.isFinite(t0)) throw new Error("Could not determine the time origin of the live timing streams");
    const abs = (offset: number) => new Date(t0 + offset).toISOString();

    const startedAt = status.find((r) => isObject(r.data) && r.data.Status === "Started")?.offsetMs ?? null;
    const drivers = parseDrivers(driverList);
    const byDriver = splitTimingByDriver(timingData);
    const stintRecords = parseStints(appData);

    const laps: Lap[] = [];
    const stints: Stint[] = [];
    const pitEvents: PitEvent[] = [];
    const positionHistory: PositionRecord[] = [];
    const intervals: IntervalRecord[] = [];
    const results: SessionResult[] = [];
    const integrity: Record<string, number[]> = {};

    for (const [drv, raw] of byDriver) {
      const dn = Number(drv);
      if (!Number.isInteger(dn)) continue;
      const t = lapsForDriver(raw);
      if (!t) continue;
      if (t.integrityErrors.length) integrity[drv] = t.integrityErrors;
      const rows = t.laps;
      rows.forEach((r, i) => laps.push(toLap(dn, r, i ? rows[i - 1]! : null, isRace ? startedAt : null, abs)));
      stints.push(...toStints(dn, rows, stintRecords.get(drv) ?? []));
      pitEvents.push(...toPitEvents(dn, rows, abs));
      positionHistory.push(...toPositions(dn, t.stream, abs));
      if (isRace) intervals.push(...toIntervals(dn, t.stream, abs));
      results.push(toResult(dn, rows, t.stream, t.retired, type));
    }
    if (Object.keys(integrity).length) this.quality.timingIntegrityErrors = integrity;
    finishResults(results, type);

    const circuitId = `${F1LT_SOURCE_ID}:${meeting.Circuit?.Key ?? meeting.Location ?? meeting.Key}`;
    const shortName = meeting.Circuit?.ShortName ?? meeting.Location ?? meeting.Name;
    const dateStart = localToUtc(session.StartDate, session.GmtOffset);
    const race = meeting.Sessions.find((s) => s.Type === "Race") ?? session;
    return {
      meeting: {
        id: `${F1LT_SOURCE_ID}:${meeting.Key}`,
        year,
        name: meeting.Name,
        countryName: meeting.Country?.Name ?? null,
        location: meeting.Location ?? null,
        circuitId,
        circuitShortName: shortName,
        dateStart: localToUtc(meeting.Sessions[0]?.StartDate ?? race.StartDate, meeting.Sessions[0]?.GmtOffset ?? race.GmtOffset),
      },
      session: {
        id: `${F1LT_SOURCE_ID}:${sessionKey}`,
        meetingId: `${F1LT_SOURCE_ID}:${meeting.Key}`,
        year,
        name: session.Name,
        type,
        circuitId,
        circuitShortName: shortName,
        countryName: meeting.Country?.Name ?? null,
        dateStart,
        dateEnd: session.EndDate ? localToUtc(session.EndDate, session.GmtOffset) : null,
        regulationEra: regulationEraForYear(year),
        source: F1LT_SOURCE_ID,
      },
      drivers: drivers.filter((d) => byDriver.has(String(d.driverNumber))),
      laps,
      stints,
      pitEvents,
      raceControl: parseRaceControl(rcm),
      weather: weatherStream.filter((r) => isObject(r.data)).map((r) => toWeather(r.data as JsonObject, abs(r.offsetMs))),
      teamRadio: parseTeamRadio(radio),
      positionHistory,
      intervals,
      results,
    };
  }

  private loadCar(path: string): Promise<{ t0: number; car: Map<number, CarSamples> }> {
    if (!this.cars.has(path)) this.cars.set(path, this.stream(path, "CarData.z.jsonStream", true).then((r) => carSamplesFromStream(r)));
    return this.cars.get(path)!;
  }

  private loadPositions(path: string): Promise<Map<number, PositionSamples>> {
    if (!this.positions.has(path)) this.positions.set(path, this.stream(path, "Position.z.jsonStream", true).then((r) => positionSamplesFromStream(r)));
    return this.positions.get(path)!;
  }

  /** The archive serves a whole session per stream, so it is decoded once and sliced per window. */
  async fetchCarSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<CarSamples> {
    const { path } = await this.locate(sessionKey);
    const s = (await this.loadCar(path)).car.get(driverNumber);
    return s ? sliceSamples(s, Date.parse(fromIso), Date.parse(toIso)) : { t: [], speed: [], throttle: [], brake: [] };
  }

  async fetchPositionSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<PositionSamples> {
    const { path } = await this.locate(sessionKey);
    const s = (await this.loadPositions(path)).get(driverNumber);
    return s ? sliceSamples(s, Date.parse(fromIso), Date.parse(toIso)) : { t: [], x: [], y: [], z: [] };
  }

  /** Live data comes from the SignalR feed; one connection per provider instance (per tenant). */
  async pollLive(sessionKey: string, _cursor: string | null): Promise<LiveDelta> {
    const m = /^(\d{4})-(\d+)$/.exec(sessionKey);
    if (!m) throw new Error(`Invalid live timing session key '${sessionKey}'`);
    if (!this.live) {
      const feed = new F1LiveFeed({
        token: () => this.requireToken(),
        ...(this.o.onUnauthorized ? { onUnauthorized: this.o.onUnauthorized } : {}),
        ...(this.o.connect ? { connect: this.o.connect } : {}),
      });
      await feed.start();
      this.live = feed;
    }
    try {
      return await this.live.drain(Number(m[2]));
    } catch (e) {
      // A dropped connection is rebuilt on the coordinator's next (backed-off) poll.
      if (/connection closed/i.test((e as Error).message)) await this.close();
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.live?.stop();
    this.live = null;
  }
}

/** FastF1's `make_path` fallback when the index has no Path. */
export function makePath(meeting: IndexMeeting, session: IndexSession): string {
  const race = meeting.Sessions.find((s) => s.Type === "Race") ?? session;
  const wdate = race.StartDate.slice(0, 10);
  const sdate = session.StartDate.slice(0, 10);
  return `${wdate.slice(0, 4)}/${wdate} ${meeting.Name}/${sdate} ${session.Name}/`.replaceAll(" ", "_");
}

export function timeOrigin(rows: { offsetMs: number; utc: number }[]): number {
  let best = NaN;
  for (const r of rows) {
    const v = r.utc - r.offsetMs;
    if (Number.isFinite(v) && (Number.isNaN(best) || v > best)) best = v;
  }
  return Number.isNaN(best) ? NaN : Math.round(best);
}

export function parseDrivers(records: StreamRecord[]): Driver[] {
  const acc = new Map<string, JsonObject>();
  for (const { offsetMs, data } of records) {
    if (!isObject(data)) continue;
    for (const [num, patch] of Object.entries(data)) {
      if (!/^\d+$/.test(num) || !isObject(patch)) continue;
      if (!acc.has(num) && offsetMs > LATE_DRIVER_MS) continue; // delayed declaration, as in FastF1
      acc.set(num, { ...(acc.get(num) ?? {}), ...patch });
    }
  }
  return [...acc].map(([num, d]) => ({
    driverNumber: Number(num),
    code: String(d.Tla ?? num),
    fullName: String(d.FullName ?? d.BroadcastName ?? num),
    teamName: String(d.TeamName ?? "Unknown"),
    teamColour: /^[0-9a-fA-F]{6}$/.test(String(d.TeamColour)) ? String(d.TeamColour).toUpperCase() : "888888",
  }));
}

interface StintState {
  firstSeen: number;
  compound: TyreCompound;
  startLaps: number | null;
}

/** Final per-driver stint state from TimingAppData (stints may arrive as a list or index-keyed object). */
export function parseStints(records: StreamRecord[]): Map<string, StintState[]> {
  const out = new Map<string, Map<number, StintState>>();
  for (const { offsetMs, data } of records) {
    const lines = isObject(data) ? data.Lines : undefined;
    if (!isObject(lines)) continue;
    for (const [drv, line] of Object.entries(lines)) {
      if (!isObject(line) || line.Stints === undefined) continue;
      const st = isObject(line.Stints) ? line.Stints : Object.fromEntries(indexed(line.Stints).map((x, i) => [String(i), x]));
      if (!out.has(drv)) out.set(drv, new Map());
      const m = out.get(drv)!;
      for (const [k, patch] of Object.entries(st)) {
        if (!/^\d+$/.test(k) || !isObject(patch)) continue;
        const cur = m.get(Number(k)) ?? { firstSeen: offsetMs, compound: "UNKNOWN" as TyreCompound, startLaps: null };
        if (patch.Compound !== undefined) cur.compound = compound(patch.Compound);
        if (patch.StartLaps !== undefined) cur.startLaps = numOrNull(patch.StartLaps);
        m.set(Number(k), cur);
      }
    }
  }
  return new Map([...out].map(([d, m]) => [d, [...m].sort((a, b) => a[0] - b[0]).map(([, v]) => v)]));
}

function toLap(dn: number, r: DriverLapRow, prev: DriverLapRow | null, raceStart: number | null, abs: (o: number) => string): Lap {
  let start: number = NaN;
  if (prev) start = !Number.isNaN(r.pitOutTime) && r.pitOutTime > prev.time ? r.pitOutTime : prev.time;
  else if (raceStart !== null) start = raceStart;
  else if (!Number.isNaN(r.pitOutTime)) start = r.pitOutTime;
  else if (typeof r.lapTime === "number" && !Number.isNaN(r.lapTime) && !Number.isNaN(r.time)) start = r.time - r.lapTime;
  return {
    driverNumber: dn,
    lapNumber: r.numberOfLaps,
    dateStart: Number.isNaN(start) ? null : abs(start),
    lapTime: msToS(r.lapTime),
    sector1: msToS(r.sector[0]),
    sector2: msToS(r.sector[1]),
    sector3: msToS(r.sector[2]),
    i1Speed: nanToNull(r.speedI1),
    i2Speed: nanToNull(r.speedI2),
    stSpeed: nanToNull(r.speedST),
    isPitOutLap: !Number.isNaN(r.pitOutTime),
    miniSectors: [],
  };
}

/** A stint starts on the lap in progress when its tyre set first appears in TimingAppData. */
function toStints(dn: number, rows: DriverLapRow[], states: StintState[]): Stint[] {
  if (!rows.length || !states.length) return [];
  const lastLap = rows.at(-1)!.numberOfLaps;
  const starts = states.map((s, i) => (i === 0 ? rows[0]!.numberOfLaps : rows.find((r) => r.time > s.firstSeen)?.numberOfLaps ?? lastLap + 1));
  const out: Stint[] = [];
  states.forEach((s, i) => {
    const lapStart = starts[i]!;
    const lapEnd = i + 1 < states.length ? starts[i + 1]! - 1 : lastLap;
    if (lapEnd < lapStart) return; // tyre set fitted but no lap driven on it
    out.push({ driverNumber: dn, stintNumber: out.length + 1, lapStart, lapEnd, compound: s.compound, tyreAgeAtStart: s.startLaps === null ? null : Math.round(s.startLaps) });
  });
  return out;
}

function toPitEvents(dn: number, rows: DriverLapRow[], abs: (o: number) => string): PitEvent[] {
  const out: PitEvent[] = [];
  rows.forEach((r, i) => {
    if (Number.isNaN(r.pitInTime)) return;
    const out_ = rows[i + 1]?.pitOutTime ?? NaN;
    const lane = Number.isNaN(out_) ? null : (out_ - r.pitInTime) / 1000;
    // Long "lane" times are garage visits (practice/qualifying), not pit stops.
    out.push({ driverNumber: dn, lapNumber: r.numberOfLaps, date: abs(r.pitInTime), laneDuration: lane !== null && lane > 0 && lane < 120 ? lane : null, stopDuration: null });
  });
  return out;
}

function toPositions(dn: number, stream: DriverStreamRow[], abs: (o: number) => string): PositionRecord[] {
  const out: PositionRecord[] = [];
  let last: number | null = null;
  for (const s of stream) {
    if (s.position === null || s.position === last) continue;
    last = s.position;
    out.push({ date: abs(s.time), driverNumber: dn, position: s.position });
  }
  return out;
}

function toIntervals(dn: number, stream: DriverStreamRow[], abs: (o: number) => string): IntervalRecord[] {
  return stream
    .filter((s) => s.gapToLeader !== null || s.interval !== null)
    .map((s) => {
      const g = parseGap(s.gapToLeader);
      const iv = parseGap(s.interval);
      return { date: abs(s.time), driverNumber: dn, gapToLeader: g.seconds, interval: iv.seconds, lapsDown: g.lapsDown };
    });
}

function toResult(dn: number, rows: DriverLapRow[], stream: DriverStreamRow[], retired: boolean, type: SessionType): SessionResult {
  const isRace = type === "race" || type === "sprint";
  const final = stream.at(-1);
  const times = rows.map((r) => r.lapTime).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const status: SessionResult["status"] = isRace ? (retired ? "dnf" : rows.length ? "finished" : "dns") : rows.length ? "finished" : "unknown";
  return {
    driverNumber: dn,
    position: final?.position ?? null,
    laps: rows.length,
    status,
    duration: !isRace && times.length ? Math.min(...times) / 1000 : null,
    gapToLeader: isRace ? parseGap(final?.gapToLeader ?? null).seconds : null,
    points: null,
  };
}

function finishResults(results: SessionResult[], type: SessionType) {
  if (type === "race" || type === "sprint") return;
  const best = Math.min(...results.map((r) => r.duration ?? Infinity));
  if (Number.isFinite(best)) for (const r of results) r.gapToLeader = r.duration === null ? null : Math.round((r.duration - best) * 1000) / 1000;
}

export function parseRaceControl(records: StreamRecord[]): RaceControlEvent[] {
  const out: RaceControlEvent[] = [];
  for (const { data } of records) {
    if (!isObject(data)) continue;
    for (const m of indexed<JsonObject>(data.Messages)) {
      if (!isObject(m)) continue;
      const t = parseUtc(m.Utc);
      if (!Number.isFinite(t)) continue;
      out.push({
        date: new Date(t).toISOString(),
        lapNumber: numOrNull(m.Lap),
        category: String(m.Category ?? "Other"),
        flag: typeof m.Flag === "string" ? m.Flag : null,
        scope: typeof m.Scope === "string" ? m.Scope : null,
        sector: numOrNull(m.Sector),
        driverNumber: numOrNull(m.RacingNumber),
        // Untrusted source text: length-capped, stored verbatim, never interpreted.
        message: String(m.Message ?? "").slice(0, 500),
      });
    }
  }
  return out;
}

function toWeather(w: JsonObject, date: string): WeatherObservation {
  return {
    date,
    airTemperature: numOrNull(w.AirTemp),
    trackTemperature: numOrNull(w.TrackTemp),
    humidity: numOrNull(w.Humidity),
    pressure: numOrNull(w.Pressure),
    rainfall: w.Rainfall === undefined ? null : String(w.Rainfall) === "1",
    windSpeed: numOrNull(w.WindSpeed),
    windDirection: numOrNull(w.WindDirection),
  };
}

/** Radio clips sit behind the same subscription token, so only the timing of each clip is kept. */
export function parseTeamRadio(records: StreamRecord[]): TeamRadio[] {
  const out: TeamRadio[] = [];
  for (const { data } of records) {
    if (!isObject(data)) continue;
    for (const c of indexed<JsonObject>(data.Captures)) {
      if (!isObject(c)) continue;
      const t = parseUtc(c.Utc);
      const dn = numOrNull(c.RacingNumber);
      if (!Number.isFinite(t) || dn === null) continue;
      out.push({ date: new Date(t).toISOString(), driverNumber: dn, recordingUrl: null, redistribution: "forbidden" });
    }
  }
  return out;
}

const CH = { rpm: "0", speed: "2", gear: "3", throttle: "4", brake: "5", drs: "45" } as const;

export function carSamplesFromStream(records: StreamRecord<Json>[]): { t0: number; car: Map<number, CarSamples> } {
  const rows = new Map<number, { t: number; ch: JsonObject }[]>();
  const origin: { offsetMs: number; utc: number }[] = [];
  for (const { offsetMs, data } of records) {
    if (!isObject(data)) continue;
    for (const e of indexed<JsonObject>(data.Entries)) {
      if (!isObject(e) || !isObject(e.Cars)) continue;
      const t = parseUtc(e.Utc);
      if (!Number.isFinite(t)) continue;
      origin.push({ offsetMs, utc: t });
      for (const [num, car] of Object.entries(e.Cars)) {
        if (!isObject(car) || !isObject(car.Channels)) continue;
        const dn = Number(num);
        if (!rows.has(dn)) rows.set(dn, []);
        rows.get(dn)!.push({ t, ch: car.Channels });
      }
    }
  }
  const car = new Map<number, CarSamples>();
  for (const [dn, rs] of rows) {
    rs.sort((a, b) => a.t - b.t);
    const s: CarSamples = { t: [], speed: [], throttle: [], brake: [], rpm: [], gear: [], drs: [] };
    let last = -Infinity;
    let anyDrs = false;
    for (const { t, ch } of rs) {
      const speed = numOrNull(ch[CH.speed]);
      const throttle = numOrNull(ch[CH.throttle]);
      if (t === last || speed === null || throttle === null) continue; // duplicate or incomplete: dropped, never filled
      last = t;
      s.t.push(t);
      s.speed.push(speed);
      s.throttle.push(Math.min(100, Math.max(0, throttle)));
      s.brake.push((numOrNull(ch[CH.brake]) ?? 0) > 0 ? 1 : 0); // source reports 0/100
      s.rpm!.push(numOrNull(ch[CH.rpm]) ?? Number.NaN);
      s.gear!.push(numOrNull(ch[CH.gear]) ?? Number.NaN);
      const drs = numOrNull(ch[CH.drs]);
      if (drs !== null) anyDrs = true;
      s.drs!.push(drs);
    }
    if (!anyDrs) delete s.drs; // e.g. 2026: channel does not exist
    car.set(dn, s);
  }
  return { t0: timeOrigin(origin), car };
}

export function positionSamplesFromStream(records: StreamRecord<Json>[]): Map<number, PositionSamples> {
  const rows = new Map<number, { t: number; x: number; y: number; z: number | null }[]>();
  for (const { data } of records) {
    if (!isObject(data)) continue;
    for (const p of indexed<JsonObject>(data.Position)) {
      if (!isObject(p) || !isObject(p.Entries)) continue;
      const t = parseUtc(p.Timestamp);
      if (!Number.isFinite(t)) continue;
      for (const [num, e] of Object.entries(p.Entries)) {
        if (!isObject(e)) continue;
        const x = numOrNull(e.X);
        const y = numOrNull(e.Y);
        const z = numOrNull(e.Z);
        if (x === null || y === null) continue;
        if (x === 0 && y === 0 && (z ?? 0) === 0) continue; // "no fix"
        const dn = Number(num);
        if (!rows.has(dn)) rows.set(dn, []);
        rows.get(dn)!.push({ t, x, y, z });
      }
    }
  }
  const out = new Map<number, PositionSamples>();
  for (const [dn, rs] of rows) {
    rs.sort((a, b) => a.t - b.t);
    const s: PositionSamples = { t: [], x: [], y: [], z: [] };
    let last = -Infinity;
    for (const r of rs) {
      if (r.t === last) continue;
      last = r.t;
      s.t.push(r.t);
      s.x.push(r.x * POSITION_SCALE);
      s.y.push(r.y * POSITION_SCALE);
      s.z.push((r.z ?? Number.NaN) * POSITION_SCALE);
    }
    out.set(dn, s);
  }
  return out;
}

/** Copy the samples with from <= t < to (arrays are time-sorted). */
export function sliceSamples<T extends { t: number[] }>(s: T, from: number, to: number): T {
  let lo = 0;
  while (lo < s.t.length && s.t[lo]! < from) lo++;
  let hi = lo;
  while (hi < s.t.length && s.t[hi]! < to) hi++;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) out[k] = Array.isArray(v) ? v.slice(lo, hi) : v;
  return out as T;
}
