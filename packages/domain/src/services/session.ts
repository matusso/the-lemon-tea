import type { AuthContext, ChannelAvailability, Driver } from "@lemon-tea/shared-types";
import { regulationEraForYear } from "@lemon-tea/shared-types";
import type { ProviderRegistry } from "@lemon-tea/provider-sdk";
import type { AccessPolicy } from "../access.ts";
import type { SessionRecord, Store } from "../store.ts";

export type PublicSession = Omit<SessionRecord, "uid" | "ownerTenantId">;

export interface SessionInfo {
  session: PublicSession;
  drivers: Driver[];
  laps: number;
  samples: { car: number; position: number };
  regulationNotes: string[];
  attribution: string | null;
}

export class SessionService {
  constructor(
    private readonly store: Store,
    private readonly access: AccessPolicy,
    private readonly providers: ProviderRegistry,
  ) {}

  private async visible(ctx: AuthContext, rows: SessionRecord[]): Promise<SessionRecord[]> {
    if (!ctx.anonymous) return rows;
    const out: SessionRecord[] = [];
    for (const r of rows) if (r.ownerTenantId === null && (await this.access.canAnonymousSee(r.source))) out.push(r);
    return out;
  }

  async listSeasons(ctx: AuthContext) {
    this.access.require(ctx, "sessions:read");
    if (!ctx.anonymous) return this.store.listSeasons(this.access.scope(ctx));
    const years = new Map<number, { sessions: number; ingested: number }>();
    for (const s of await this.listSessions(ctx, { limit: 200 })) {
      const y = years.get(s.year) ?? { sessions: 0, ingested: 0 };
      y.sessions++;
      if (s.ingestStatus !== "not_ingested") y.ingested++;
      years.set(s.year, y);
    }
    return [...years].map(([year, v]) => ({ year, ...v })).sort((a, b) => b.year - a.year);
  }

  async listMeetings(ctx: AuthContext, year?: number) {
    this.access.require(ctx, "sessions:read");
    const meetings = await this.store.listMeetings(this.access.scope(ctx), year);
    if (!ctx.anonymous) return meetings;
    const sessions = await this.listSessions(ctx, { ...(year !== undefined ? { year } : {}), limit: 200 });
    const ids = new Set(sessions.map((s) => s.meetingId));
    return meetings.filter((m) => ids.has(m.id));
  }

  async listSessions(ctx: AuthContext, q: { year?: number; meetingId?: string; type?: string; ingestedOnly?: boolean; limit: number }): Promise<PublicSession[]> {
    this.access.require(ctx, "sessions:read");
    const rows = await this.store.listSessions(this.access.scope(ctx), q);
    // A tenant's private copy hides the public row with the same id.
    const byId = new Map<string, SessionRecord>();
    for (const r of await this.visible(ctx, rows)) {
      const prev = byId.get(r.id);
      if (!prev || (prev.ownerTenantId === null && r.ownerTenantId !== null)) byId.set(r.id, r);
    }
    return [...byId.values()].map(strip);
  }

  async info(ctx: AuthContext, sessionId: string): Promise<SessionInfo> {
    const s = await this.access.session(ctx, sessionId);
    const [drivers, laps, samples, sources] = await Promise.all([this.store.drivers(s), this.store.laps(s), this.store.sampleCounts(s), this.store.dataSources()]);
    return {
      session: strip(s),
      drivers,
      laps: laps.length,
      samples,
      regulationNotes:
        regulationEraForYear(s.year) === "active_aero_2026"
          ? ["2026 rules: active aerodynamics and Overtake Mode replace DRS. The connected source does not expose their activation state, so those channels are reported as unavailable."]
          : ["DRS era: raw DRS codes are shown where the source provides them."],
      attribution: sources.find((x) => x.id === s.source)?.attribution ?? null,
    };
  }

  async drivers(ctx: AuthContext, sessionId: string): Promise<Driver[]> {
    return this.store.drivers(await this.access.session(ctx, sessionId));
  }

  async dataAvailability(ctx: AuthContext, sessionId: string) {
    const s = await this.access.session(ctx, sessionId);
    const [samples, laps, drivers] = await Promise.all([this.store.sampleCounts(s), this.store.laps(s), this.store.drivers(s)]);
    let channels: ChannelAvailability[] = [];
    try {
      channels = this.providers.get(s.source).capabilities().channels;
    } catch {
      channels = [];
    }
    if (s.year >= 2026) {
      channels = channels.map((c) => (c.channel === "drs" ? { ...c, available: false, kind: "unavailable" as const, note: "DRS does not exist under 2026 regulations" } : c));
    }
    const durationS = s.dateEnd ? (Date.parse(s.dateEnd) - Date.parse(s.dateStart)) / 1000 : null;
    const hz = durationS && drivers.length ? samples.car / drivers.length / durationS : null;
    const timed = laps.filter((l) => l.lapTime !== null).length;
    return {
      sessionId: s.id,
      source: s.source,
      ingestStatus: s.ingestStatus,
      ingestedChannels: s.ingestedChannels,
      channels,
      observed: {
        drivers: drivers.length,
        laps: laps.length,
        timedLapShare: laps.length ? timed / laps.length : 0,
        carSamples: samples.car,
        positionSamples: samples.position,
        approxCarSampleHzPerDriver: hz,
      },
      quality: samples.car === 0 ? "insufficient" : hz !== null && hz > 3 ? "high" : hz !== null && hz > 1.5 ? "medium" : "low",
    };
  }

  async dataSources(ctx: AuthContext) {
    this.access.require(ctx, "sessions:read");
    return this.store.dataSources();
  }
}

function strip(s: SessionRecord): PublicSession {
  const { uid: _uid, ownerTenantId: _owner, ...rest } = s;
  return rest;
}
