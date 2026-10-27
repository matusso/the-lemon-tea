import postgres from "postgres";
import type {
  Driver,
  IntervalRecord,
  Lap,
  PitEvent,
  PositionRecord,
  RaceControlEvent,
  SessionBundle,
  SessionResult,
  Stint,
  TeamRadio,
  TyreCompound,
  WeatherObservation,
} from "@lemon-tea/shared-types";
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
} from "@lemon-tea/domain";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const toIso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/**
 * PostgreSQL implementation of Store and IngestStore. Tenant-scoped reads run inside a
 * transaction that sets `app.tenant_id`, so row-level security decides visibility even if a
 * query forgets a WHERE clause. Connect as the non-owner `lemontea_app` role for RLS to apply.
 */
export class PgStore implements Store, IngestStore {
  constructor(readonly sql: Sql) {}

  static connect(url: string, opts: { max?: number } = {}): PgStore {
    return new PgStore(postgres(url, { max: opts.max ?? 10, idle_timeout: 30, prepare: false, transform: { undefined: null }, onnotice: () => {} }));
  }

  close(): Promise<void> {
    return this.sql.end({ timeout: 5 });
  }

  private scoped<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${scope.tenantId ?? ""}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  // ------------------------------------------------------------------ calendar
  async listSeasons(scope: TenantScope) {
    return this.scoped(scope, async (tx) => {
      const rows = await tx`
        select year, count(*)::int as sessions, count(*) filter (where ingest_status in ('complete','partial'))::int as ingested
        from sessions group by year order by year desc`;
      return rows.map((r) => ({ year: r.year as number, sessions: r.sessions as number, ingested: r.ingested as number }));
    });
  }

  async listMeetings(scope: TenantScope, year?: number): Promise<MeetingRecord[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx`
        select m.*, c.short_name as circuit_short_name
        from meetings m join circuits c on c.id = m.circuit_id
        where exists (select 1 from sessions s where s.meeting_id = m.id)
          ${year === undefined ? tx`` : tx`and m.year = ${year}`}
        order by m.date_start desc`;
      return rows.map((r) => ({
        id: r.id,
        year: r.year,
        name: r.name,
        countryName: r.country_name,
        location: r.location,
        circuitId: r.circuit_id,
        circuitShortName: r.circuit_short_name,
        dateStart: toIso(r.date_start)!,
      }));
    });
  }

  async listSessions(scope: TenantScope, q: { year?: number; meetingId?: string; type?: string; ingestedOnly?: boolean; limit: number }): Promise<SessionRecord[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx`
        select s.*, m.name as meeting_name, c.short_name as circuit_short_name, m.country_name
        from sessions s join meetings m on m.id = s.meeting_id join circuits c on c.id = s.circuit_id
        where true
          ${q.year !== undefined ? tx`and s.year = ${q.year}` : tx``}
          ${q.meetingId ? tx`and s.meeting_id = ${q.meetingId}` : tx``}
          ${q.type ? tx`and s.type = ${q.type}` : tx``}
          ${q.ingestedOnly ? tx`and s.ingest_status in ('complete','partial')` : tx``}
        order by s.date_start desc
        limit ${q.limit}`;
      return rows.map(sessionRow);
    });
  }

  async findSessions(scope: TenantScope, id: string): Promise<SessionRecord[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx`
        select s.*, m.name as meeting_name, c.short_name as circuit_short_name, m.country_name
        from sessions s join meetings m on m.id = s.meeting_id join circuits c on c.id = s.circuit_id
        where s.id = ${id}`;
      return rows.map(sessionRow);
    });
  }

  // ------------------------------------------------------------------ timing
  async drivers(s: AuthorizedSession): Promise<Driver[]> {
    const rows = await this.sql`select * from session_drivers where session_uid = ${s.uid} order by driver_number`;
    return rows.map((r) => ({ driverNumber: r.driver_number, code: r.code, fullName: r.full_name, teamName: r.team_name, teamColour: r.team_colour }));
  }

  async laps(s: AuthorizedSession, driverNumber?: number): Promise<Lap[]> {
    const rows = await this.sql`
      select * from laps where session_uid = ${s.uid}
      ${driverNumber !== undefined ? this.sql`and driver_number = ${driverNumber}` : this.sql``}
      order by driver_number, lap_number`;
    return rows.map((r) => ({
      driverNumber: r.driver_number,
      lapNumber: r.lap_number,
      dateStart: toIso(r.date_start),
      lapTime: r.lap_time,
      sector1: r.sector1,
      sector2: r.sector2,
      sector3: r.sector3,
      i1Speed: r.i1_speed,
      i2Speed: r.i2_speed,
      stSpeed: r.st_speed,
      isPitOutLap: r.is_pit_out_lap,
      miniSectors: r.mini_sectors ?? [],
    }));
  }

  async stints(s: AuthorizedSession): Promise<Stint[]> {
    const rows = await this.sql`select * from stints where session_uid = ${s.uid} order by driver_number, stint_number`;
    return rows.map((r) => ({
      driverNumber: r.driver_number,
      stintNumber: r.stint_number,
      lapStart: r.lap_start,
      lapEnd: r.lap_end,
      compound: r.compound as TyreCompound,
      tyreAgeAtStart: r.tyre_age_at_start,
    }));
  }

  async pitEvents(s: AuthorizedSession): Promise<PitEvent[]> {
    const rows = await this.sql`select * from pit_events where session_uid = ${s.uid} order by date`;
    return rows.map((r) => ({ driverNumber: r.driver_number, lapNumber: r.lap_number, date: toIso(r.date)!, laneDuration: r.lane_duration, stopDuration: r.stop_duration }));
  }

  async raceControl(s: AuthorizedSession): Promise<RaceControlEvent[]> {
    const rows = await this.sql`select * from race_control where session_uid = ${s.uid} order by date, seq`;
    return rows.map((r) => ({
      date: toIso(r.date)!,
      lapNumber: r.lap_number,
      category: r.category,
      flag: r.flag,
      scope: r.scope,
      sector: r.sector,
      driverNumber: r.driver_number,
      message: r.message,
    }));
  }

  async weather(s: AuthorizedSession): Promise<WeatherObservation[]> {
    const rows = await this.sql`select * from weather where session_uid = ${s.uid} order by date`;
    return rows.map((r) => ({
      date: toIso(r.date)!,
      airTemperature: r.air_temperature,
      trackTemperature: r.track_temperature,
      humidity: r.humidity,
      pressure: r.pressure,
      rainfall: r.rainfall,
      windSpeed: r.wind_speed,
      windDirection: r.wind_direction,
    }));
  }

  async teamRadio(s: AuthorizedSession, driverNumber?: number): Promise<TeamRadio[]> {
    const rows = await this.sql`
      select * from team_radio where session_uid = ${s.uid}
      ${driverNumber !== undefined ? this.sql`and driver_number = ${driverNumber}` : this.sql``}
      order by date`;
    return rows.map((r) => ({ date: toIso(r.date)!, driverNumber: r.driver_number, recordingUrl: r.recording_url, redistribution: r.redistribution }));
  }

  async positionHistory(s: AuthorizedSession): Promise<PositionRecord[]> {
    const rows = await this.sql`select * from position_history where session_uid = ${s.uid} order by date`;
    return rows.map((r) => ({ date: toIso(r.date)!, driverNumber: r.driver_number, position: r.position }));
  }

  async intervals(s: AuthorizedSession, untilIso?: string): Promise<IntervalRecord[]> {
    const rows = await this.sql`
      select * from intervals where session_uid = ${s.uid}
      ${untilIso ? this.sql`and date <= ${untilIso}` : this.sql``}
      order by date`;
    return rows.map((r) => ({ date: toIso(r.date)!, driverNumber: r.driver_number, gapToLeader: r.gap_to_leader, interval: r.interval, lapsDown: r.laps_down }));
  }

  async results(s: AuthorizedSession): Promise<SessionResult[]> {
    const rows = await this.sql`select * from session_results where session_uid = ${s.uid} order by position nulls last`;
    return rows.map((r) => ({
      driverNumber: r.driver_number,
      position: r.position,
      laps: r.laps,
      status: r.status,
      duration: r.duration,
      gapToLeader: r.gap_to_leader,
      points: r.points,
    }));
  }

  async carSamples(s: AuthorizedSession, driverNumber: number, fromIso?: string, toIsoArg?: string): Promise<CarSamples> {
    const rows = await this.sql`
      select extract(epoch from t) * 1000 as ms, speed, throttle, brake, rpm, gear, drs
      from car_samples
      where session_uid = ${s.uid} and driver_number = ${driverNumber}
        ${fromIso ? this.sql`and t >= ${fromIso}` : this.sql``}
        ${toIsoArg ? this.sql`and t <= ${toIsoArg}` : this.sql``}
      order by t`;
    const out: CarSamples = { t: [], speed: [], throttle: [], brake: [], rpm: [], gear: [] };
    const drs: (number | null)[] = [];
    let anyDrs = false;
    for (const r of rows) {
      out.t.push(Number(r.ms));
      out.speed.push(r.speed);
      out.throttle.push(r.throttle);
      out.brake.push(r.brake);
      out.rpm!.push(r.rpm ?? Number.NaN);
      out.gear!.push(r.gear ?? Number.NaN);
      drs.push(r.drs);
      if (r.drs !== null) anyDrs = true;
    }
    if (anyDrs) out.drs = drs;
    return out;
  }

  async positionSamples(s: AuthorizedSession, driverNumbers: number[] | null, fromIso?: string, toIsoArg?: string): Promise<Map<number, PositionSamples>> {
    const rows = await this.sql`
      select driver_number, extract(epoch from t) * 1000 as ms, x, y, z
      from position_samples
      where session_uid = ${s.uid}
        ${driverNumbers ? this.sql`and driver_number = any(${driverNumbers})` : this.sql``}
        ${fromIso ? this.sql`and t >= ${fromIso}` : this.sql``}
        ${toIsoArg ? this.sql`and t <= ${toIsoArg}` : this.sql``}
      order by driver_number, t`;
    const m = new Map<number, PositionSamples>();
    for (const r of rows) {
      let p = m.get(r.driver_number);
      if (!p) m.set(r.driver_number, (p = { t: [], x: [], y: [], z: [] }));
      p.t.push(Number(r.ms));
      p.x.push(r.x);
      p.y.push(r.y);
      p.z.push(r.z);
    }
    return m;
  }

  async sampleCounts(s: AuthorizedSession) {
    const [c] = await this.sql`
      select (select count(*) from car_samples where session_uid = ${s.uid})::int as car,
             (select count(*) from position_samples where session_uid = ${s.uid})::int as position`;
    return { car: c!.car as number, position: c!.position as number };
  }

  // ------------------------------------------------------------------ circuits
  async circuitLayout(circuitId: string, year: number): Promise<CircuitLayoutRecord | null> {
    const [r] = await this.sql`select * from circuit_layouts where circuit_id = ${circuitId} and year = ${year}`;
    if (!r) return null;
    return { circuitId: r.circuit_id, year: r.year, lengthM: r.length_m, geometry: r.geometry, provenance: r.provenance, accuracyM: r.accuracy_m, confidence: r.confidence };
  }

  async saveCircuitLayout(l: CircuitLayoutRecord, sourceSessionUid: string | null): Promise<void> {
    await this.sql`
      insert into circuit_layouts (circuit_id, year, source_session_uid, geometry, length_m, provenance, accuracy_m, confidence)
      values (${l.circuitId}, ${l.year}, ${sourceSessionUid}, ${this.sql.json(l.geometry as never)}, ${l.lengthM},
              ${this.sql.json(l.provenance as never)}, ${l.accuracyM}, ${l.confidence})
      on conflict (circuit_id, year) do update set geometry = excluded.geometry, length_m = excluded.length_m,
        provenance = excluded.provenance, accuracy_m = excluded.accuracy_m, confidence = excluded.confidence,
        source_session_uid = excluded.source_session_uid`;
  }

  async dataSources(): Promise<DataSourceRecord[]> {
    const rows = await this.sql`select * from data_sources order by id`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      apiVersion: r.api_version,
      license: r.license,
      permittedUse: r.permitted_use,
      redistribution: r.redistribution,
      attribution: r.attribution,
      publicDisplayAllowed: r.public_display_allowed,
      enabled: r.enabled,
      missingChannels: r.missing_channels,
      rateLimit: r.rate_limit,
      accuracyNotes: r.accuracy_notes,
      historicalCoverage: r.historical_coverage,
      updateFrequency: r.update_frequency,
      retention: r.retention,
    }));
  }

  // ------------------------------------------------------------------ predictions & models
  async savePrediction(scope: TenantScope, p: Omit<PredictionRecord, "id" | "createdAt">): Promise<PredictionRecord> {
    return this.scoped(scope, async (tx) => {
      const [r] = await tx`
        insert into predictions (owner_tenant_id, kind, meeting_id, input_session_ids, target_session_id, model_version, params_version, input_hash, as_of, output)
        values (${p.ownerTenantId}, ${p.kind}, ${p.meetingId}, ${p.inputSessionIds}, ${p.targetSessionId}, ${p.modelVersion},
                ${p.paramsVersion}, ${p.inputHash}, ${p.asOf}, ${tx.json(p.output as never)})
        returning *`;
      return predictionRow(r!);
    });
  }

  async listPredictions(scope: TenantScope, q: { meetingId?: string; kind?: string; limit: number }): Promise<PredictionRecord[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx`
        select * from predictions where true
          ${q.meetingId ? tx`and meeting_id = ${q.meetingId}` : tx``}
          ${q.kind ? tx`and kind = ${q.kind}` : tx``}
        order by created_at desc limit ${q.limit}`;
      return rows.map(predictionRow);
    });
  }

  async getPrediction(scope: TenantScope, id: string): Promise<PredictionRecord | null> {
    return this.scoped(scope, async (tx) => {
      const [r] = await tx`select * from predictions where id = ${id}`;
      return r ? predictionRow(r) : null;
    });
  }

  async activeModel(family: string): Promise<ModelVersionRecord | null> {
    const [r] = await this.sql`select * from model_versions where family = ${family} and status = 'active' order by created_at desc limit 1`;
    return r ? modelRow(r) : null;
  }

  async modelVersions(family?: string): Promise<ModelVersionRecord[]> {
    const rows = await this.sql`select * from model_versions ${family ? this.sql`where family = ${family}` : this.sql``} order by created_at desc`;
    return rows.map(modelRow);
  }

  async backtests(q: { family?: string; modelVersion?: string; limit: number }): Promise<BacktestRecord[]> {
    const rows = await this.sql`
      select * from backtest_runs where true
        ${q.family ? this.sql`and family = ${q.family}` : this.sql``}
        ${q.modelVersion ? this.sql`and model_version = ${q.modelVersion}` : this.sql``}
      order by created_at desc limit ${q.limit}`;
    return rows.map((r) => ({ id: r.id, modelVersion: r.model_version, family: r.family, windowDesc: r.window_desc, metrics: r.metrics, details: r.details, createdAt: toIso(r.created_at)! }));
  }

  // ------------------------------------------------------------------ jobs
  async createJob(scope: TenantScope, j: { userId: string | null; kind: string; input: Record<string, unknown>; idempotencyKey: string | null }) {
    return this.scoped(scope, async (tx) => {
      if (j.idempotencyKey) {
        const [existing] = await tx`select * from jobs where tenant_id = ${scope.tenantId} and idempotency_key = ${j.idempotencyKey}`;
        if (existing) return { job: jobRow(existing), created: false };
      }
      const [r] = await tx`
        insert into jobs (tenant_id, user_id, kind, input, idempotency_key)
        values (${scope.tenantId}, ${j.userId}, ${j.kind}, ${tx.json(j.input as never)}, ${j.idempotencyKey})
        returning *`;
      return { job: jobRow(r!), created: true };
    });
  }

  async getJob(scope: TenantScope, id: string): Promise<JobRecord | null> {
    return this.scoped(scope, async (tx) => {
      const [r] = await tx`select * from jobs where id = ${id}`;
      return r ? jobRow(r) : null;
    });
  }

  async jobByIdempotencyKey(scope: TenantScope, key: string): Promise<JobRecord | null> {
    return this.scoped(scope, async (tx) => {
      const [r] = await tx`select * from jobs where tenant_id = ${scope.tenantId} and idempotency_key = ${key}`;
      return r ? jobRow(r) : null;
    });
  }

  async countActiveJobs(scope: TenantScope): Promise<number> {
    return this.scoped(scope, async (tx) => {
      const [r] = await tx`select count(*)::int as n from jobs where tenant_id = ${scope.tenantId} and status in ('queued','running')`;
      return r!.n as number;
    });
  }

  async requestJobCancel(scope: TenantScope, id: string): Promise<JobRecord | null> {
    return this.scoped(scope, async (tx) => {
      const [r] = await tx`
        update jobs set cancel_requested = true,
          status = case when status = 'queued' then 'cancelled' else status end,
          finished_at = case when status = 'queued' then now() else finished_at end
        where id = ${id} returning *`;
      return r ? jobRow(r) : null;
    });
  }

  async claimJob(): Promise<JobRecord | null> {
    return this.system(async (tx) => {
      const [r] = await tx`
        update jobs set status = 'running', started_at = now(), attempts = attempts + 1
        where id = (select id from jobs where status = 'queued' order by created_at for update skip locked limit 1)
        returning *`;
      return r ? jobRow(r) : null;
    });
  }

  async updateJob(id: string, patch: Partial<Pick<JobRecord, "status" | "progress" | "result" | "error">>): Promise<JobRecord | null> {
    return this.system(async (tx) => {
      const terminal = patch.status !== undefined && ["succeeded", "failed", "cancelled"].includes(patch.status);
      const [r] = await tx`
        update jobs set
          status = coalesce(${patch.status ?? null}, status),
          progress = coalesce(${patch.progress ?? null}, progress),
          result = coalesce(${patch.result === undefined ? null : tx.json(patch.result as never)}, result),
          error = coalesce(${patch.error === undefined ? null : tx.json(patch.error as never)}, error),
          finished_at = ${terminal ? tx`now()` : tx`finished_at`}
        where id = ${id} returning *`;
      return r ? jobRow(r) : null;
    });
  }

  async audit(e: AuditEntry): Promise<void> {
    await this.sql`
      insert into audit_log (user_id, tenant_id, via, client_id, action, resource, outcome, details)
      values (${e.userId}, ${e.tenantId}, ${e.via}, ${e.clientId ?? null}, ${e.action}, ${e.resource ?? null}, ${e.outcome},
              ${e.details ? this.sql.json(e.details as never) : null})`;
  }

  // ------------------------------------------------------------------ provider connections (RLS: tenant only)
  async getProviderConnection(scope: TenantScope, provider: string): Promise<ProviderConnectionRecord | null> {
    if (!scope.tenantId) return null;
    return this.scoped(scope, async (tx) => {
      const [r] = await tx`select provider, status, config, secret_ciphertext, created_at from provider_connections where provider = ${provider}`;
      if (!r) return null;
      return {
        provider: r.provider as string,
        status: r.status === "connected" ? "connected" : "expired",
        config: (r.config ?? {}) as Record<string, unknown>,
        secret: r.secret_ciphertext ? new Uint8Array(r.secret_ciphertext as Buffer) : null,
        createdAt: new Date(r.created_at as string).toISOString(),
      };
    });
  }

  async saveProviderConnection(scope: TenantScope, c: Omit<ProviderConnectionRecord, "createdAt">): Promise<void> {
    if (!scope.tenantId) throw new Error("Provider connections require a tenant");
    await this.scoped(scope, (tx) => tx`
      insert into provider_connections (tenant_id, provider, config, secret_ciphertext, status)
      values (${scope.tenantId}, ${c.provider}, ${tx.json(c.config as never)}, ${c.secret ? Buffer.from(c.secret) : null}, ${c.status})
      on conflict (tenant_id, provider) do update
        set config = excluded.config, secret_ciphertext = excluded.secret_ciphertext, status = excluded.status`);
  }

  async deleteProviderConnection(scope: TenantScope, provider: string): Promise<boolean> {
    if (!scope.tenantId) return false;
    return this.scoped(scope, async (tx) => (await tx`delete from provider_connections where provider = ${provider}`).count > 0);
  }

  // ------------------------------------------------------------------ ingestion
  async upsertSession(owner: string | null, b: Pick<SessionBundle, "meeting" | "session">): Promise<string> {
    return this.scoped({ tenantId: owner }, async (tx) => {
      await tx`
        insert into circuits (id, short_name, country, location)
        values (${b.meeting.circuitId}, ${b.meeting.circuitShortName}, ${b.meeting.countryName}, ${b.meeting.location})
        on conflict (id) do update set short_name = excluded.short_name`;
      await tx`
        insert into meetings (id, year, name, country_name, location, circuit_id, date_start, source)
        values (${b.meeting.id}, ${b.meeting.year}, ${b.meeting.name}, ${b.meeting.countryName}, ${b.meeting.location},
                ${b.meeting.circuitId}, ${b.meeting.dateStart}, ${b.session.source})
        on conflict (id) do update set name = excluded.name`;
      const s = b.session;
      const [existing] = owner
        ? await tx`select uid from sessions where id = ${s.id} and owner_tenant_id = ${owner}`
        : await tx`select uid from sessions where id = ${s.id} and owner_tenant_id is null`;
      if (existing) {
        await tx`update sessions set name = ${s.name}, type = ${s.type}, date_start = ${s.dateStart}, date_end = ${s.dateEnd} where uid = ${existing.uid}`;
        return existing.uid as string;
      }
      const [r] = await tx`
        insert into sessions (id, owner_tenant_id, meeting_id, year, name, type, circuit_id, date_start, date_end, regulation_era, source)
        values (${s.id}, ${owner}, ${s.meetingId}, ${s.year}, ${s.name}, ${s.type}, ${s.circuitId}, ${s.dateStart}, ${s.dateEnd}, ${s.regulationEra}, ${s.source})
        returning uid`;
      return r!.uid as string;
    });
  }

  async writeTiming(uid: string, b: SessionBundle, source: string, processingVersion: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Source corrections replace earlier rows: timing tables are rewritten on every ingest.
      for (const t of ["session_drivers", "laps", "stints", "pit_events", "race_control", "weather", "team_radio", "position_history", "intervals", "session_results"]) {
        await tx`delete from ${tx(t)} where session_uid = ${uid}`;
      }
      const ins = async <T>(table: string, rows: T[], map: (r: T) => Record<string, unknown>) => {
        for (let i = 0; i < rows.length; i += 2000) {
          const chunk = rows.slice(i, i + 2000).map(map);
          if (chunk.length) await tx`insert into ${tx(table)} ${tx(chunk as never)}`;
        }
      };
      await ins("session_drivers", dedupe(b.drivers, (d) => String(d.driverNumber)), (d) => ({
        session_uid: uid, driver_number: d.driverNumber, code: d.code, full_name: d.fullName, team_name: d.teamName, team_colour: d.teamColour,
      }));
      await ins("laps", dedupe(b.laps, (l) => `${l.driverNumber}:${l.lapNumber}`), (l) => ({
        session_uid: uid, driver_number: l.driverNumber, lap_number: l.lapNumber, date_start: l.dateStart, lap_time: l.lapTime,
        sector1: l.sector1, sector2: l.sector2, sector3: l.sector3, i1_speed: l.i1Speed, i2_speed: l.i2Speed, st_speed: l.stSpeed,
        is_pit_out_lap: l.isPitOutLap, mini_sectors: l.miniSectors.map((v) => v ?? 0), source, processing_version: processingVersion,
      }));
      await ins("stints", dedupe(b.stints, (s) => `${s.driverNumber}:${s.stintNumber}`), (s) => ({
        session_uid: uid, driver_number: s.driverNumber, stint_number: s.stintNumber, lap_start: s.lapStart, lap_end: s.lapEnd,
        compound: s.compound, tyre_age_at_start: s.tyreAgeAtStart,
      }));
      await ins("pit_events", dedupe(b.pitEvents, (p) => `${p.driverNumber}:${p.lapNumber}`), (p) => ({
        session_uid: uid, driver_number: p.driverNumber, lap_number: p.lapNumber, date: p.date, lane_duration: p.laneDuration, stop_duration: p.stopDuration,
      }));
      await ins("race_control", b.raceControl.map((r, i) => ({ r, i })), ({ r, i }) => ({
        session_uid: uid, seq: i, date: r.date, lap_number: r.lapNumber, category: r.category, flag: r.flag, scope: r.scope,
        sector: r.sector, driver_number: r.driverNumber, message: r.message,
      }));
      await ins("weather", dedupe(b.weather, (w) => w.date), (w) => ({
        session_uid: uid, date: w.date, air_temperature: w.airTemperature, track_temperature: w.trackTemperature, humidity: w.humidity,
        pressure: w.pressure, rainfall: w.rainfall, wind_speed: w.windSpeed, wind_direction: w.windDirection,
      }));
      await ins("team_radio", dedupe(b.teamRadio, (r) => `${r.driverNumber}:${r.date}`), (r) => ({
        session_uid: uid, date: r.date, driver_number: r.driverNumber, recording_url: r.recordingUrl, redistribution: r.redistribution,
      }));
      await ins("position_history", dedupe(b.positionHistory, (p) => `${p.driverNumber}:${p.date}`), (p) => ({
        session_uid: uid, date: p.date, driver_number: p.driverNumber, position: p.position,
      }));
      await ins("intervals", dedupe(b.intervals, (p) => `${p.driverNumber}:${p.date}`), (p) => ({
        session_uid: uid, date: p.date, driver_number: p.driverNumber, gap_to_leader: p.gapToLeader, interval: p.interval, laps_down: p.lapsDown,
      }));
      await ins("session_results", dedupe(b.results, (r) => String(r.driverNumber)), (r) => ({
        session_uid: uid, driver_number: r.driverNumber, position: r.position, laps: r.laps, status: r.status, duration: r.duration,
        gap_to_leader: r.gapToLeader, points: r.points,
      }));
    });
  }

  async writeCarSamples(uid: string, driverNumber: number, s: CarSamples): Promise<number> {
    const nul = (v: number | null | undefined) => (v === undefined || v === null || Number.isNaN(v) ? null : v);
    let written = 0;
    for (let i = 0; i < s.t.length; i += 10_000) {
      const end = Math.min(s.t.length, i + 10_000);
      const ts = s.t.slice(i, end).map((ms) => new Date(ms).toISOString());
      const pad = <T>(a: T[] | undefined) => (a ? a.slice(i, end) : new Array(end - i).fill(null));
      const res = await this.sql`
        insert into car_samples (session_uid, driver_number, t, speed, throttle, brake, rpm, gear, drs)
        select ${uid}::uuid, ${driverNumber}::smallint, u.t, u.speed, u.throttle, u.brake, u.rpm, u.gear, u.drs
        from unnest(${ts}::timestamptz[], ${s.speed.slice(i, end)}::smallint[], ${s.throttle.slice(i, end)}::smallint[],
                    ${s.brake.slice(i, end)}::smallint[], ${pad(s.rpm).map(nul)}::int[], ${pad(s.gear).map(nul)}::smallint[],
                    ${pad(s.drs).map(nul)}::smallint[])
          as u(t, speed, throttle, brake, rpm, gear, drs)
        on conflict do nothing`;
      written += res.count;
    }
    return written;
  }

  async writePositionSamples(uid: string, driverNumber: number, s: PositionSamples): Promise<number> {
    let written = 0;
    for (let i = 0; i < s.t.length; i += 10_000) {
      const end = Math.min(s.t.length, i + 10_000);
      const ts = s.t.slice(i, end).map((ms) => new Date(ms).toISOString());
      const res = await this.sql`
        insert into position_samples (session_uid, driver_number, t, x, y, z)
        select ${uid}::uuid, ${driverNumber}::smallint, u.t, u.x, u.y, u.z
        from unnest(${ts}::timestamptz[], ${s.x.slice(i, end)}::real[], ${s.y.slice(i, end)}::real[],
                    ${s.z.slice(i, end).map((v) => (Number.isNaN(v) ? 0 : v))}::real[]) as u(t, x, y, z)
        on conflict do nothing`;
      written += res.count;
    }
    return written;
  }

  async markIngested(uid: string, status: "partial" | "complete" | "failed", channels: string[]): Promise<void> {
    await this.system((tx) => tx`update sessions set ingest_status = ${status}, ingested_channels = ${channels}, ingested_at = now() where uid = ${uid}`);
  }

  async saveQualityReport(uid: string, processingVersion: string, report: Record<string, unknown>): Promise<void> {
    await this.sql`insert into data_quality_reports (session_uid, processing_version, report) values (${uid}, ${processingVersion}, ${this.sql.json(report as never)})`;
  }
}

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of xs) m.set(key(x), x);
  return [...m.values()];
}

function sessionRow(r: postgres.Row): SessionRecord {
  return {
    uid: r.uid,
    id: r.id,
    ownerTenantId: r.owner_tenant_id,
    meetingId: r.meeting_id,
    meetingName: r.meeting_name,
    year: r.year,
    name: r.name,
    type: r.type,
    circuitId: r.circuit_id,
    circuitShortName: r.circuit_short_name,
    countryName: r.country_name ?? null,
    dateStart: toIso(r.date_start)!,
    dateEnd: toIso(r.date_end),
    regulationEra: r.regulation_era,
    visibility: r.owner_tenant_id ? "private" : "public",
    source: r.source,
    ingestStatus: r.ingest_status,
    ingestedChannels: r.ingested_channels ?? [],
  };
}

function predictionRow(r: postgres.Row): PredictionRecord {
  return {
    id: r.id,
    ownerTenantId: r.owner_tenant_id,
    kind: r.kind,
    meetingId: r.meeting_id,
    inputSessionIds: r.input_session_ids,
    targetSessionId: r.target_session_id,
    modelVersion: r.model_version,
    paramsVersion: r.params_version,
    inputHash: r.input_hash,
    asOf: toIso(r.as_of)!,
    createdAt: toIso(r.created_at)!,
    output: r.output,
  };
}

function modelRow(r: postgres.Row): ModelVersionRecord {
  return { id: r.id, family: r.family, params: r.params, metrics: r.metrics, status: r.status, createdAt: toIso(r.created_at)! };
}

function jobRow(r: postgres.Row): JobRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    kind: r.kind,
    input: r.input,
    status: r.status,
    progress: r.progress,
    result: r.result,
    error: r.error,
    idempotencyKey: r.idempotency_key,
    cancelRequested: r.cancel_requested,
    createdAt: toIso(r.created_at)!,
    startedAt: toIso(r.started_at),
    finishedAt: toIso(r.finished_at),
  };
}
