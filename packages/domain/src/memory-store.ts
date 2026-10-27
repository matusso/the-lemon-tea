import type { SessionBundle } from "@lemon-tea/shared-types";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";
import { sliceByTime } from "@lemon-tea/telemetry-core";
import type {
  AuditEntry,
  AuthorizedSession,
  BacktestRecord,
  CircuitLayoutRecord,
  DataSourceRecord,
  IngestStore,
  JobRecord,
  MeetingRecord,
  ModelVersionRecord,
  PredictionRecord,
  ProviderConnectionRecord,
  SessionRecord,
  Store,
  TenantScope,
} from "./store.ts";

interface SessionData {
  rec: SessionRecord;
  bundle: SessionBundle;
  car: Map<number, CarSamples>;
  pos: Map<number, PositionSamples>;
}

/**
 * In-memory Store used by tests and the integration harness. It applies the same visibility
 * rule as the PostgreSQL row-level-security policies (owner NULL = public, else owner only).
 */
export class MemoryStore implements Store, IngestStore {
  sessions = new Map<string, SessionData>();
  meetings = new Map<string, MeetingRecord>();
  layouts = new Map<string, CircuitLayoutRecord>();
  predictions: PredictionRecord[] = [];
  jobs = new Map<string, JobRecord>();
  auditLog: AuditEntry[] = [];
  models: ModelVersionRecord[] = [];
  sources: DataSourceRecord[] = [];
  connections = new Map<string, ProviderConnectionRecord>();
  private n = 0;

  private visible(scope: TenantScope, r: { ownerTenantId: string | null }) {
    return r.ownerTenantId === null || r.ownerTenantId === scope.tenantId;
  }

  async listSeasons(scope: TenantScope) {
    const m = new Map<number, { sessions: number; ingested: number }>();
    for (const { rec } of this.sessions.values()) {
      if (!this.visible(scope, rec)) continue;
      const y = m.get(rec.year) ?? { sessions: 0, ingested: 0 };
      y.sessions++;
      if (rec.ingestStatus !== "not_ingested") y.ingested++;
      m.set(rec.year, y);
    }
    return [...m].map(([year, v]) => ({ year, ...v }));
  }

  async listMeetings(scope: TenantScope, year?: number) {
    const ids = new Set([...this.sessions.values()].filter((s) => this.visible(scope, s.rec)).map((s) => s.rec.meetingId));
    return [...this.meetings.values()].filter((m) => ids.has(m.id) && (year === undefined || m.year === year));
  }

  async listSessions(scope: TenantScope, q: { year?: number; meetingId?: string; type?: string; ingestedOnly?: boolean; limit: number }) {
    return [...this.sessions.values()]
      .map((s) => s.rec)
      .filter((r) => this.visible(scope, r) && (q.year === undefined || r.year === q.year) && (!q.meetingId || r.meetingId === q.meetingId) && (!q.type || r.type === q.type))
      .slice(0, q.limit);
  }

  async findSessions(scope: TenantScope, id: string) {
    return [...this.sessions.values()].map((s) => s.rec).filter((r) => r.id === id && this.visible(scope, r));
  }

  private data(s: AuthorizedSession) {
    const d = this.sessions.get(s.uid);
    if (!d) throw new Error("unknown session uid");
    return d;
  }

  async drivers(s: AuthorizedSession) { return this.data(s).bundle.drivers; }
  async laps(s: AuthorizedSession, driverNumber?: number) { return this.data(s).bundle.laps.filter((l) => driverNumber === undefined || l.driverNumber === driverNumber); }
  async stints(s: AuthorizedSession) { return this.data(s).bundle.stints; }
  async pitEvents(s: AuthorizedSession) { return this.data(s).bundle.pitEvents; }
  async raceControl(s: AuthorizedSession) { return this.data(s).bundle.raceControl; }
  async weather(s: AuthorizedSession) { return this.data(s).bundle.weather; }
  async teamRadio(s: AuthorizedSession, d?: number) { return this.data(s).bundle.teamRadio.filter((r) => d === undefined || r.driverNumber === d); }
  async positionHistory(s: AuthorizedSession) { return this.data(s).bundle.positionHistory; }
  async intervals(s: AuthorizedSession, until?: string) { return this.data(s).bundle.intervals.filter((i) => !until || i.date <= until); }
  async results(s: AuthorizedSession) { return this.data(s).bundle.results; }

  async carSamples(s: AuthorizedSession, d: number, from?: string, to?: string): Promise<CarSamples> {
    const c = this.data(s).car.get(d) ?? { t: [], speed: [], throttle: [], brake: [] };
    return sliceByTime(c, from ? Date.parse(from) : -Infinity, to ? Date.parse(to) : Infinity);
  }

  async positionSamples(s: AuthorizedSession, ds: number[] | null, from?: string, to?: string) {
    const out = new Map<number, PositionSamples>();
    for (const [d, p] of this.data(s).pos) {
      if (ds && !ds.includes(d)) continue;
      out.set(d, sliceByTime(p, from ? Date.parse(from) : -Infinity, to ? Date.parse(to) : Infinity));
    }
    return out;
  }

  async sampleCounts(s: AuthorizedSession) {
    const d = this.data(s);
    return { car: [...d.car.values()].reduce((a, c) => a + c.t.length, 0), position: [...d.pos.values()].reduce((a, c) => a + c.t.length, 0) };
  }

  async circuitLayout(circuitId: string, year: number) { return this.layouts.get(`${circuitId}:${year}`) ?? null; }
  async saveCircuitLayout(l: CircuitLayoutRecord) { this.layouts.set(`${l.circuitId}:${l.year}`, l); }
  async dataSources() { return this.sources; }

  async savePrediction(scope: TenantScope, p: Omit<PredictionRecord, "id" | "createdAt">) {
    if (p.ownerTenantId !== null && p.ownerTenantId !== scope.tenantId) throw new Error("RLS: owner mismatch");
    const rec = { ...p, id: crypto.randomUUID(), createdAt: new Date(Date.now() + this.n++).toISOString() };
    this.predictions.push(rec);
    return rec;
  }
  async listPredictions(scope: TenantScope, q: { meetingId?: string; kind?: string; limit: number }) {
    return this.predictions
      .filter((p) => this.visible(scope, p) && (!q.meetingId || p.meetingId === q.meetingId) && (!q.kind || p.kind === q.kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit);
  }
  async getPrediction(scope: TenantScope, id: string) { return this.predictions.find((p) => p.id === id && this.visible(scope, p)) ?? null; }
  async activeModel(family: string) { return this.models.find((m) => m.family === family && m.status === "active") ?? null; }
  async modelVersions(family?: string) { return this.models.filter((m) => !family || m.family === family); }
  async backtests(): Promise<BacktestRecord[]> { return []; }

  async createJob(scope: TenantScope, j: { userId: string | null; kind: string; input: Record<string, unknown>; idempotencyKey: string | null }) {
    if (j.idempotencyKey) {
      const ex = [...this.jobs.values()].find((x) => x.tenantId === scope.tenantId && x.idempotencyKey === j.idempotencyKey);
      if (ex) return { job: ex, created: false };
    }
    const job: JobRecord = {
      id: crypto.randomUUID(), tenantId: scope.tenantId, userId: j.userId, kind: j.kind, input: j.input, status: "queued", progress: 0, result: null, error: null,
      idempotencyKey: j.idempotencyKey, cancelRequested: false, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    };
    this.jobs.set(job.id, job);
    return { job, created: true };
  }
  async getJob(scope: TenantScope, id: string) {
    const j = this.jobs.get(id);
    return j && j.tenantId === scope.tenantId ? j : null;
  }
  async jobByIdempotencyKey(scope: TenantScope, key: string) {
    return [...this.jobs.values()].find((j) => j.tenantId === scope.tenantId && j.idempotencyKey === key) ?? null;
  }
  async countActiveJobs(scope: TenantScope) {
    return [...this.jobs.values()].filter((j) => j.tenantId === scope.tenantId && (j.status === "queued" || j.status === "running")).length;
  }
  async requestJobCancel(scope: TenantScope, id: string) {
    const j = await this.getJob(scope, id);
    if (!j) return null;
    j.cancelRequested = true;
    if (j.status === "queued") j.status = "cancelled";
    return j;
  }
  async claimJob() {
    const j = [...this.jobs.values()].find((x) => x.status === "queued");
    if (!j) return null;
    j.status = "running";
    j.startedAt = new Date().toISOString();
    return j;
  }
  async updateJob(id: string, patch: Partial<Pick<JobRecord, "status" | "progress" | "result" | "error">>) {
    const j = this.jobs.get(id);
    if (!j) return null;
    Object.assign(j, patch);
    return j;
  }
  async audit(e: AuditEntry) { this.auditLog.push(e); }

  async getProviderConnection(scope: TenantScope, provider: string) {
    return scope.tenantId ? this.connections.get(`${scope.tenantId}:${provider}`) ?? null : null;
  }
  async saveProviderConnection(scope: TenantScope, c: Omit<ProviderConnectionRecord, "createdAt">) {
    if (!scope.tenantId) throw new Error("Provider connections require a tenant");
    const key = `${scope.tenantId}:${c.provider}`;
    this.connections.set(key, { ...c, createdAt: this.connections.get(key)?.createdAt ?? new Date().toISOString() });
  }
  async deleteProviderConnection(scope: TenantScope, provider: string) {
    return scope.tenantId ? this.connections.delete(`${scope.tenantId}:${provider}`) : false;
  }

  // ---- ingest side
  async upsertSession(owner: string | null, b: Pick<SessionBundle, "meeting" | "session">) {
    this.meetings.set(b.meeting.id, b.meeting);
    const existing = [...this.sessions.values()].find((s) => s.rec.id === b.session.id && s.rec.ownerTenantId === owner);
    if (existing) return existing.rec.uid;
    const uid = crypto.randomUUID();
    this.sessions.set(uid, {
      rec: { ...b.session, uid, ownerTenantId: owner, visibility: owner ? "private" : "public", ingestStatus: "not_ingested", ingestedChannels: [], meetingName: b.meeting.name },
      bundle: { ...b, drivers: [], laps: [], stints: [], pitEvents: [], raceControl: [], weather: [], teamRadio: [], positionHistory: [], intervals: [], results: [] } as SessionBundle,
      car: new Map(),
      pos: new Map(),
    });
    return uid;
  }
  async writeTiming(uid: string, b: SessionBundle) { this.sessions.get(uid)!.bundle = b; }
  async writeCarSamples(uid: string, d: number, s: CarSamples) { this.sessions.get(uid)!.car.set(d, s); return s.t.length; }
  async writePositionSamples(uid: string, d: number, s: PositionSamples) { this.sessions.get(uid)!.pos.set(d, s); return s.t.length; }
  async markIngested(uid: string, status: "partial" | "complete" | "failed", channels: string[]) {
    const r = this.sessions.get(uid)!.rec;
    r.ingestStatus = status;
    r.ingestedChannels = channels;
  }
  async saveQualityReport() {}
}
