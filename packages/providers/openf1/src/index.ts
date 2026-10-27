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

/** OpenF1 positions are in decimetres (verified: lap path length / speed-integrated distance = 10.0). */
const POSITION_SCALE = 0.1;
export const OPENF1_NORMALIZER_VERSION = "openf1-normalize-v1";

export interface OpenF1Options {
  baseUrl?: string;
  /** Credentials for OpenF1's authenticated (live) tier. Server-side only; never sent to clients. */
  username?: string;
  password?: string;
  requestsPerSecond?: number;
  fetchImpl?: typeof fetch;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const iso = (v: unknown): string => new Date(String(v)).toISOString();
const lastNonNull = (v: unknown): number | null => (Array.isArray(v) ? num(v.filter((x) => x != null).at(-1)) : num(v));

export function sessionTypeFromOpenF1(type: string, name: string): SessionType {
  const n = name.toLowerCase();
  if (n.includes("sprint") && (n.includes("qualifying") || n.includes("shootout"))) return "sprint_qualifying";
  if (n === "sprint") return "sprint";
  if (n.includes("practice") || type === "Practice") return "practice";
  if (n.includes("qualifying")) return "qualifying";
  if (n === "race") return "race";
  return "unknown";
}

function compound(v: unknown): TyreCompound {
  const s = String(v ?? "").toUpperCase();
  if ((["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"] as string[]).includes(s)) return s as TyreCompound;
  return s.startsWith("TEST") ? "TEST_UNKNOWN" : "UNKNOWN";
}

function raceControl(r: Row): RaceControlEvent {
  return {
    date: iso(r.date),
    lapNumber: num(r.lap_number),
    category: String(r.category ?? "Other"),
    flag: str(r.flag),
    scope: str(r.scope),
    sector: num(r.sector),
    driverNumber: num(r.driver_number),
    // Untrusted source text: length-capped, stored verbatim, never interpreted.
    message: String(r.message ?? "").slice(0, 500),
  };
}

function weather(w: Row): WeatherObservation {
  return {
    date: iso(w.date),
    airTemperature: num(w.air_temperature),
    trackTemperature: num(w.track_temperature),
    humidity: num(w.humidity),
    pressure: num(w.pressure),
    rainfall: w.rainfall == null ? null : Boolean(w.rainfall),
    windSpeed: num(w.wind_speed),
    windDirection: num(w.wind_direction),
  };
}

function interval(r: Row): IntervalRecord {
  const gap = r.gap_to_leader;
  const lapsDown = typeof gap === "string" && /(\d+)\s*LAP/i.test(gap) ? Number(/(\d+)/.exec(gap)![1]) : null;
  return { date: iso(r.date), driverNumber: Number(r.driver_number), gapToLeader: num(gap), interval: num(r.interval), lapsDown };
}

export class OpenF1Provider implements ProviderAdapter {
  readonly id = "openf1";
  private http: ProviderHttpClient;
  private base: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly o: OpenF1Options = {}) {
    this.base = (o.baseUrl ?? "https://api.openf1.org").replace(/\/$/, "");
    const host = new URL(this.base).hostname;
    this.http = new ProviderHttpClient({
      allowedHosts: [host],
      allowHttp: host === "localhost",
      requestsPerSecond: o.requestsPerSecond ?? 2.5,
      burst: 3,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      authorization: () => this.authHeader(),
    });
  }

  private get authenticated() {
    return Boolean(this.o.username && this.o.password);
  }

  /** OAuth2 password grant against OpenF1's token endpoint, cached until shortly before expiry. */
  private async authHeader(): Promise<string | null> {
    if (!this.authenticated) return null;
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return `Bearer ${this.token.value}`;
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(`${this.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: this.o.username!, password: this.o.password! }),
    });
    if (!res.ok) throw new Error(`OpenF1 authentication failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in?: number | string };
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return `Bearer ${this.token.value}`;
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
      name: "OpenF1",
      historical: true,
      live: this.authenticated,
      auth: this.authenticated ? "oauth_password_grant" : "none",
      sessionDiscovery: true,
      coverage: "2023 onwards",
      rateLimit: { requestsPerSecond: this.o.requestsPerSecond ?? 2.5, burst: 3 },
      licensingSourceId: "openf1",
      channels: [
        ch("speed", "measured", "km/h", 3.7, "Quantised to 1 km/h"),
        ch("throttle", "measured", "%", 3.7),
        ch("brake", "measured", "on/off", 3.7, "Binary; not brake pressure"),
        ch("rpm", "measured", "rpm", 3.7),
        ch("gear", "measured", null, 3.7),
        ch("drs", "measured", "code", 3.7, "Raw source code; absent from 2026"),
        ch("position_xyz", "measured", "m", 3.7, "Source decimetres converted to metres; metre-level noise"),
        ch("lap_distance", "calculated", "m", null, "Integrated from speed"),
        ch("acceleration", "calculated", "m/s^2", null, "Derived from speed"),
        ch("brake_pressure", "unavailable", null, null),
        ch("steering", "unavailable", null, null),
        ch("tyre_temperature", "unavailable", null, null),
        ch("fuel", "unavailable", null, null),
        ch("active_aero_state", "unavailable", null, null, "2026 concept; not exposed by this source"),
        ch("overtake_mode_state", "unavailable", null, null, "2026 concept; not exposed by this source"),
      ],
    };
  }

  async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      await this.get("/v1/sessions?session_key=latest");
      return { ok: true, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, latencyMs: null, checkedAt: new Date().toISOString(), message: (e as Error).message };
    }
  }

  /** OpenF1 answers 404 when a filter matches no rows (e.g. an empty time window): that is an empty result. */
  private async get<T = Row[]>(path: string): Promise<T> {
    try {
      return await this.http.getJson<T>(`${this.base}${path}`);
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 404) return [] as T;
      throw e;
    }
  }

  async listSessions(year: number): Promise<SessionListing[]> {
    const rows = await this.get(`/v1/sessions?year=${encodeURIComponent(year)}`);
    return rows
      .filter((r) => !r.is_cancelled)
      .map((r) => ({
        sessionKey: String(r.session_key),
        meetingKey: String(r.meeting_key),
        year: Number(r.year),
        name: String(r.session_name),
        type: sessionTypeFromOpenF1(String(r.session_type), String(r.session_name)),
        circuitShortName: String(r.circuit_short_name),
        countryName: str(r.country_name),
        dateStart: iso(r.date_start),
        dateEnd: r.date_end ? iso(r.date_end) : null,
      }));
  }

  async fetchSession(sessionKey: string): Promise<SessionBundle> {
    const k = encodeURIComponent(sessionKey);
    const [s] = await this.get(`/v1/sessions?session_key=${k}`);
    if (!s) throw new Error(`OpenF1 session ${sessionKey} not found`);
    const [m] = await this.get(`/v1/meetings?meeting_key=${encodeURIComponent(String(s.meeting_key))}`);
    const type = sessionTypeFromOpenF1(String(s.session_type), String(s.session_name));
    const isRace = type === "race" || type === "sprint";
    // Sequential on purpose: the rate limiter serialises anyway and this keeps ordering simple.
    const drivers = await this.get(`/v1/drivers?session_key=${k}`);
    const laps = await this.get(`/v1/laps?session_key=${k}`);
    const stints = await this.get(`/v1/stints?session_key=${k}`);
    const pit = await this.get(`/v1/pit?session_key=${k}`);
    const rc = await this.get(`/v1/race_control?session_key=${k}`);
    const wx = await this.get(`/v1/weather?session_key=${k}`);
    const radio = await this.get(`/v1/team_radio?session_key=${k}`);
    const position = await this.get(`/v1/position?session_key=${k}`);
    const intervals = isRace ? await this.get(`/v1/intervals?session_key=${k}`) : [];
    const results = await this.get(`/v1/session_result?session_key=${k}`).catch(() => [] as Row[]);

    const circuitId = `openf1:${s.circuit_key}`;
    const year = Number(s.year);
    return {
      meeting: {
        id: `openf1:${s.meeting_key}`,
        year,
        name: String(m?.meeting_name ?? m?.meeting_official_name ?? s.location),
        countryName: str(s.country_name),
        location: str(s.location),
        circuitId,
        circuitShortName: String(s.circuit_short_name),
        dateStart: iso(m?.date_start ?? s.date_start),
      },
      session: {
        id: `openf1:${s.session_key}`,
        meetingId: `openf1:${s.meeting_key}`,
        year,
        name: String(s.session_name),
        type,
        circuitId,
        circuitShortName: String(s.circuit_short_name),
        countryName: str(s.country_name),
        dateStart: iso(s.date_start),
        dateEnd: s.date_end ? iso(s.date_end) : null,
        regulationEra: regulationEraForYear(year),
        source: "openf1",
      },
      drivers: dedupeBy(drivers, (d) => String(d.driver_number)).map(
        (d): Driver => ({
          driverNumber: Number(d.driver_number),
          code: String(d.name_acronym ?? d.driver_number),
          fullName: String(d.full_name ?? d.broadcast_name ?? d.driver_number),
          teamName: String(d.team_name ?? "Unknown"),
          teamColour: /^[0-9a-fA-F]{6}$/.test(String(d.team_colour)) ? String(d.team_colour).toUpperCase() : "888888",
        }),
      ),
      laps: laps.map(
        (l): Lap => ({
          driverNumber: Number(l.driver_number),
          lapNumber: Number(l.lap_number),
          dateStart: l.date_start ? iso(l.date_start) : null,
          lapTime: num(l.lap_duration),
          sector1: num(l.duration_sector_1),
          sector2: num(l.duration_sector_2),
          sector3: num(l.duration_sector_3),
          i1Speed: num(l.i1_speed),
          i2Speed: num(l.i2_speed),
          stSpeed: num(l.st_speed),
          isPitOutLap: Boolean(l.is_pit_out_lap),
          miniSectors: [l.segments_sector_1, l.segments_sector_2, l.segments_sector_3].flatMap((a) => (Array.isArray(a) ? a.map(num) : [])),
        }),
      ),
      stints: stints
        .filter((x) => num(x.lap_start) !== null && num(x.lap_end) !== null)
        .map(
          (x): Stint => ({
            driverNumber: Number(x.driver_number),
            stintNumber: Number(x.stint_number),
            lapStart: Number(x.lap_start),
            lapEnd: Number(x.lap_end),
            compound: compound(x.compound),
            tyreAgeAtStart: num(x.tyre_age_at_start),
          }),
        ),
      pitEvents: pit.map(
        (p): PitEvent => ({
          driverNumber: Number(p.driver_number),
          lapNumber: Number(p.lap_number),
          date: iso(p.date),
          laneDuration: num(p.lane_duration) ?? num(p.pit_duration),
          stopDuration: num(p.stop_duration),
        }),
      ),
      raceControl: rc.map(raceControl),
      weather: wx.map(weather),
      teamRadio: radio.map(
        (r): TeamRadio => ({
          date: iso(r.date),
          driverNumber: Number(r.driver_number),
          recordingUrl: str(r.recording_url),
          // Audio is linked to the source, never re-hosted or transcribed.
          redistribution: "link_only",
        }),
      ),
      positionHistory: position.map((p): PositionRecord => ({ date: iso(p.date), driverNumber: Number(p.driver_number), position: Number(p.position) })),
      intervals: intervals.map(interval),
      results: results.map(
        (r): SessionResult => ({
          driverNumber: Number(r.driver_number),
          position: num(r.position),
          laps: num(r.number_of_laps),
          status: r.dsq ? "dsq" : r.dns ? "dns" : r.dnf ? "dnf" : r.position != null ? "finished" : "unknown",
          duration: lastNonNull(r.duration),
          gapToLeader: lastNonNull(r.gap_to_leader),
          points: num(r.points),
        }),
      ),
    };
  }

  async fetchCarSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<CarSamples> {
    const rows = await this.get(`/v1/car_data?${this.windowQuery(sessionKey, driverNumber, fromIso, toIso)}`);
    return toCarSamples(rows);
  }

  async fetchPositionSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<PositionSamples> {
    const rows = await this.get(`/v1/location?${this.windowQuery(sessionKey, driverNumber, fromIso, toIso)}`);
    return toPositionSamples(rows);
  }

  private windowQuery(sessionKey: string, driverNumber: number, fromIso: string, toIso: string) {
    return `session_key=${encodeURIComponent(sessionKey)}&driver_number=${driverNumber}&date%3E=${encodeURIComponent(fromIso)}&date%3C${encodeURIComponent(toIso)}`;
  }

  /**
   * Incremental poll for an in-progress session. Requires the authenticated tier. The cursor is
   * the latest source timestamp seen; every endpoint is queried with date > cursor.
   */
  async pollLive(sessionKey: string, cursor: string | null): Promise<LiveDelta> {
    if (!this.authenticated) throw new Error("OpenF1 live data requires configured credentials for an authorised account");
    const since = cursor ?? new Date(Date.now() - 60_000).toISOString();
    const q = `session_key=${encodeURIComponent(sessionKey)}&date%3E${encodeURIComponent(since)}`;
    const car = await this.get(`/v1/car_data?${q}`);
    const loc = await this.get(`/v1/location?${q}`);
    const rc = await this.get(`/v1/race_control?${q}`);
    const pos = await this.get(`/v1/position?${q}`);
    const iv = await this.get(`/v1/intervals?${q}`).catch(() => [] as Row[]);
    const wx = await this.get(`/v1/weather?${q}`);
    const dates = [...car, ...loc, ...rc, ...pos, ...iv, ...wx].map((r) => Date.parse(String(r.date))).filter(Number.isFinite);
    const latest = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
    return {
      cursor: latest ?? since,
      sourceTimestamp: latest,
      car: groupByDriver(car, toCarSamples),
      position: groupByDriver(loc, toPositionSamples),
      bundle: {
        raceControl: rc.map(raceControl),
        positionHistory: pos.map((p) => ({ date: iso(p.date), driverNumber: Number(p.driver_number), position: Number(p.position) })),
        intervals: iv.map(interval),
        weather: wx.map(weather),
      },
    };
  }
}

function groupByDriver<T>(rows: Row[], f: (rows: Row[]) => T): Map<number, T> {
  const m = new Map<number, Row[]>();
  for (const r of rows) {
    const d = Number(r.driver_number);
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(r);
  }
  return new Map([...m].map(([d, rs]) => [d, f(rs)]));
}

export function toCarSamples(rows: Row[]): CarSamples {
  const sorted = rows.map((r) => ({ r, t: Date.parse(String(r.date)) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const out: CarSamples = { t: [], speed: [], throttle: [], brake: [], rpm: [], gear: [], drs: [] };
  let last = -Infinity;
  for (const { r, t } of sorted) {
    if (t === last) continue; // duplicate timestamp
    const speed = num(r.speed);
    const throttle = num(r.throttle);
    if (speed === null || throttle === null) continue; // incomplete sample: dropped, never filled
    last = t;
    out.t.push(t);
    out.speed.push(speed);
    out.throttle.push(Math.min(100, Math.max(0, throttle)));
    out.brake.push((num(r.brake) ?? 0) > 0 ? 1 : 0); // source reports 0/100
    out.rpm!.push(num(r.rpm) ?? Number.NaN);
    out.gear!.push(num(r.n_gear) ?? Number.NaN);
    out.drs!.push(num(r.drs));
  }
  if (out.drs!.every((v) => v === null)) delete out.drs; // e.g. 2026: channel does not exist
  return out;
}

export function toPositionSamples(rows: Row[]): PositionSamples {
  const sorted = rows.map((r) => ({ r, t: Date.parse(String(r.date)) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const out: PositionSamples = { t: [], x: [], y: [], z: [] };
  let last = -Infinity;
  for (const { r, t } of sorted) {
    const x = num(r.x);
    const y = num(r.y);
    const z = num(r.z);
    if (t === last || x === null || y === null) continue;
    if (x === 0 && y === 0 && (z ?? 0) === 0) continue; // (0,0,0) is the source's "no fix" value
    last = t;
    out.t.push(t);
    out.x.push(x * POSITION_SCALE);
    out.y.push(y * POSITION_SCALE);
    out.z.push((z ?? Number.NaN) * POSITION_SCALE);
  }
  return out;
}

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of xs) m.set(key(x), x);
  return [...m.values()];
}
