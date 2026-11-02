import { LemonTeaError, SessionType, type AuthContext, type SessionBundle } from "@lemon-tea/shared-types";
import type { ProviderAdapter, ProviderRegistry } from "@lemon-tea/provider-sdk";
import type { AccessPolicy } from "./access.ts";
import type { IngestStore } from "./store.ts";

export const INGEST_PROCESSING_VERSION = "normalize-v1";

export interface IngestProgress {
  stage: string;
  done: number;
  total: number;
}

export interface WeekendIngestResult {
  meetingKey: string;
  sessions: ({ sessionId: string; name: string; type: string } & ({ ok: true; result: IngestResult } | { ok: false; error: string }))[];
}

export interface IngestResult {
  sessionId: string;
  owner: "public" | "private";
  drivers: number;
  laps: number;
  carSamples: number;
  positionSamples: number;
  quality: Record<string, unknown>;
}

/**
 * Pulls one session from a provider and stores normalised rows. Idempotent: timing tables are
 * replaced (picking up source corrections), samples are de-duplicated on (session, driver, t).
 * Telemetry is fetched in 20-minute windows per driver to bound response sizes.
 */
export class IngestionService {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly store: IngestStore,
    private readonly access: AccessPolicy,
  ) {}

  async ingest(
    ctx: AuthContext,
    q: { sessionId: string; channels: ("timing" | "car_data" | "location")[]; visibility: "public" | "private" },
    onProgress: (p: IngestProgress) => void = () => {},
    shouldCancel: () => Promise<boolean> | boolean = () => false,
  ): Promise<IngestResult> {
    this.access.require(ctx, "ingest:write");
    if (q.visibility === "public") this.access.require(ctx, "admin");
    const owner = q.visibility === "public" ? null : ctx.tenantId;
    if (q.visibility === "private" && !owner) throw new LemonTeaError("forbidden", "Private ingestion requires a tenant");
    const [source, key] = q.sessionId.split(":") as [string, string];
    // Data fetched with a tenant's own provider account is licensed to that tenant only.
    if (this.providers.isScoped(source) && q.visibility === "public") {
      throw new LemonTeaError("forbidden", `Data from '${source}' is tied to your own provider account and can only be ingested privately`);
    }
    const provider = this.providers.resolve(source, ctx.tenantId);

    onProgress({ stage: "timing", done: 0, total: 1 });
    const bundle: SessionBundle = await provider.fetchSession(key);
    const uid = await this.store.upsertSession(owner, bundle);
    await this.store.writeTiming(uid, bundle, source, INGEST_PROCESSING_VERSION);
    onProgress({ stage: "timing", done: 1, total: 1 });

    const start = Date.parse(bundle.session.dateStart) - 15 * 60_000;
    const lastLapEnd = Math.max(
      ...bundle.laps.filter((l) => l.dateStart).map((l) => Date.parse(l.dateStart!) + (l.lapTime ?? 150) * 1000),
      bundle.session.dateEnd ? Date.parse(bundle.session.dateEnd) : 0,
    );
    const end = Math.min(lastLapEnd + 5 * 60_000, Date.now());
    const windows: [string, string][] = [];
    for (let t = start; t < end; t += 20 * 60_000) windows.push([new Date(t).toISOString(), new Date(Math.min(end, t + 20 * 60_000)).toISOString()]);

    let car = 0;
    let pos = 0;
    const perDriver: Record<number, { car: number; position: number }> = {};
    const total = bundle.drivers.length * windows.length * (Number(q.channels.includes("car_data")) + Number(q.channels.includes("location")));
    let done = 0;
    for (const d of bundle.drivers) {
      perDriver[d.driverNumber] = { car: 0, position: 0 };
      for (const [from, to] of windows) {
        if (await shouldCancel()) {
          await this.store.markIngested(uid, "partial", ["timing"]);
          throw new LemonTeaError("conflict", "Ingestion cancelled");
        }
        if (q.channels.includes("car_data")) {
          const s = await provider.fetchCarSamples(key, d.driverNumber, from, to);
          await this.store.writeCarSamples(uid, d.driverNumber, s);
          car += s.t.length;
          perDriver[d.driverNumber]!.car += s.t.length;
          onProgress({ stage: `car_data #${d.driverNumber}`, done: ++done, total });
        }
        if (q.channels.includes("location")) {
          const s = await provider.fetchPositionSamples(key, d.driverNumber, from, to);
          await this.store.writePositionSamples(uid, d.driverNumber, s);
          pos += s.t.length;
          perDriver[d.driverNumber]!.position += s.t.length;
          onProgress({ stage: `location #${d.driverNumber}`, done: ++done, total });
        }
      }
    }

    const quality = {
      ...(provider.lastQuality ? { source: provider.lastQuality() } : {}),
      drivers: bundle.drivers.length,
      laps: bundle.laps.length,
      lapsWithoutTime: bundle.laps.filter((l) => l.lapTime === null).length,
      lapsWithoutStart: bundle.laps.filter((l) => l.dateStart === null).length,
      driversWithoutCarData: q.channels.includes("car_data") ? Object.entries(perDriver).filter(([, v]) => v.car === 0).map(([k]) => Number(k)) : [],
      driversWithoutPosition: q.channels.includes("location") ? Object.entries(perDriver).filter(([, v]) => v.position === 0).map(([k]) => Number(k)) : [],
      carSamples: car,
      positionSamples: pos,
      perDriver,
    };
    await this.store.saveQualityReport(uid, INGEST_PROCESSING_VERSION, quality);
    const complete = q.channels.length === 3 && quality.driversWithoutCarData.length === 0;
    await this.store.markIngested(uid, complete ? "complete" : "partial", q.channels);
    // a pre-race placeholder of this session (same meeting and type) is replaced by the real one
    await this.store.removeSupersededSessions(owner, bundle.session.meetingId, bundle.session.type, bundle.session.id);
    await this.registerUpcoming(ctx, provider, source, key, bundle, owner);
    return { sessionId: q.sessionId, owner: owner ? "private" : "public", drivers: bundle.drivers.length, laps: bundle.laps.length, carSamples: car, positionSamples: pos, quality };
  }

  /**
   * Adds the meeting's sessions that have not started yet (e.g. the race on Sunday morning) as
   * calendar rows, so they can be selected, simulated before they run and watched live. They take
   * the meeting and circuit of the session just loaded; no data is stored for them. Best effort:
   * a calendar lookup failure never fails the ingest.
   */
  private async registerUpcoming(ctx: AuthContext, provider: ProviderAdapter, source: string, key: string, bundle: SessionBundle, owner: string | null): Promise<void> {
    try {
      const year = bundle.session.year;
      const listings = await provider.listSessions(year);
      const me = listings.find((l) => l.sessionKey === key);
      if (!me) return;
      const ours = listings.filter((l) => l.meetingKey === me.meetingKey);
      const register = async (id: string, name: string, type: SessionType, dateStart: string, dateEnd: string | null) => {
        await this.store.upsertSession(owner, { meeting: bundle.meeting, session: { ...bundle.session, id: `${source}:${id}`, name, type, dateStart, dateEnd } });
      };
      for (const l of ours.filter((x) => x.sessionKey !== key && Date.parse(x.dateStart) > Date.now())) {
        const type = SessionType.safeParse(l.type);
        if (type.success) await register(l.sessionKey, l.name, type.data, l.dateStart, l.dateEnd);
      }
      // Some calendars (F1 live timing) only list a session once it starts. The race and sprint are
      // then taken from the season calendar and registered under a placeholder key that the
      // provider resolves to the real session when it is published.
      if (!provider.pendingSessionKey) return;
      const listed = new Set(ours.map((l) => l.type));
      const weekendStart = Math.min(...ours.map((l) => Date.parse(l.dateStart)));
      for (const c of await this.seasonCalendar(ctx, year)) {
        const t = Date.parse(c.dateStart);
        if ((c.type !== "race" && c.type !== "sprint") || listed.has(c.type) || t <= Date.now()) continue;
        if (t < weekendStart || t > weekendStart + 4 * 86_400_000) continue; // another weekend
        const hours = c.type === "race" ? 2 : 1;
        await register(provider.pendingSessionKey(year, me.meetingKey, c.type), c.type === "race" ? "Race" : "Sprint", c.type, new Date(t).toISOString(), new Date(t + hours * 3_600_000).toISOString());
      }
    } catch {
      // calendar unavailable: upcoming sessions appear once they are loaded themselves
    }
  }

  /** Race and sprint start times of a season from the public calendar provider (empty if unavailable). */
  private async seasonCalendar(ctx: AuthContext, year: number): Promise<{ type: string; dateStart: string }[]> {
    try {
      return (await this.providers.resolve("jolpica", ctx.tenantId).listSessions(year)).map((l) => ({ type: l.type, dateStart: l.dateStart }));
    } catch {
      return [];
    }
  }

  /**
   * Re-registers the not-yet-started sessions of the meeting of an already loaded session (e.g.
   * for weekends loaded before the race could be placed in the calendar).
   */
  async registerUpcomingFor(ctx: AuthContext, sessionId: string, bundle: SessionBundle, owner: string | null): Promise<void> {
    const [source, key] = sessionId.split(":") as [string, string];
    await this.registerUpcoming(ctx, this.providers.resolve(source, ctx.tenantId), source, key, bundle, owner);
  }

  /**
   * Ingests every session of one meeting that has already started (practice → qualifying → race,
   * in calendar order). A session that fails (e.g. cancelled, nothing published) is reported and
   * the rest continue; the job only fails when no session could be loaded.
   */
  async ingestWeekend(
    ctx: AuthContext,
    q: { source: string; year: number; meetingKey: string; channels: ("timing" | "car_data" | "location")[]; visibility: "public" | "private" },
    onProgress: (p: IngestProgress) => void = () => {},
    shouldCancel: () => Promise<boolean> | boolean = () => false,
  ): Promise<WeekendIngestResult> {
    const sessions = (await this.discover(ctx, q.source, q.year))
      .filter((s) => s.meetingKey === q.meetingKey && Date.parse(s.dateStart) < Date.now())
      .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    if (!sessions.length) throw new LemonTeaError("not_found", `No started sessions for meeting ${q.meetingKey} in ${q.year}`);
    const out: WeekendIngestResult = { meetingKey: q.meetingKey, sessions: [] };
    for (const [i, s] of sessions.entries()) {
      if (await shouldCancel()) throw new LemonTeaError("conflict", "Ingestion cancelled");
      const sessionId = `${q.source}:${s.sessionKey}`;
      const base = { sessionId, name: s.name, type: s.type };
      try {
        const result = await this.ingest(ctx, { sessionId, channels: q.channels, visibility: q.visibility }, (p) =>
          onProgress({ stage: `${s.name}: ${p.stage}`, done: i * 1000 + Math.round((p.total ? p.done / p.total : 0) * 1000), total: sessions.length * 1000 }), shouldCancel);
        out.sessions.push({ ...base, ok: true, result });
      } catch (e) {
        if (e instanceof LemonTeaError && (e.code === "conflict" || e.code === "forbidden" || e.code === "unauthorized")) throw e;
        out.sessions.push({ ...base, ok: false, error: (e as Error).message });
      }
      onProgress({ stage: s.name, done: (i + 1) * 1000, total: sessions.length * 1000 });
    }
    if (!out.sessions.some((s) => s.ok)) throw new LemonTeaError("data_unavailable", `No session of meeting ${q.meetingKey} could be loaded: ${out.sessions.map((s) => `${s.name}: ${s.ok ? "ok" : s.error}`).join("; ")}`);
    return out;
  }

  async discover(ctx: AuthContext, source: string, year: number) {
    this.access.require(ctx, "sessions:read");
    return this.providers.resolve(source, ctx.tenantId).listSessions(year);
  }
}
