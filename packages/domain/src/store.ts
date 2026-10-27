import type {
  Driver,
  Meeting,
  SessionBundle,
  IntervalRecord,
  Lap,
  PitEvent,
  PositionRecord,
  RaceControlEvent,
  Session,
  SessionResult,
  Stint,
  TeamRadio,
  WeatherObservation,
} from "@lemon-tea/shared-types";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";

export type { SessionBundle };

/**
 * Who the storage layer acts for. `tenantId: null` means "public data only".
 * Implementations MUST enforce this at the storage level (PostgreSQL uses RLS).
 */
export interface TenantScope {
  tenantId: string | null;
}

export interface SessionRecord extends Session {
  uid: string;
  ownerTenantId: string | null;
  ingestedChannels: string[];
  meetingName: string;
}

declare const resolvedBrand: unique symbol;
/**
 * A session that passed an authorisation check. Telemetry reads take only this type, so
 * code cannot read samples for a session uid it merely guessed.
 */
export type AuthorizedSession = SessionRecord & { readonly [resolvedBrand]: true };

export type MeetingRecord = Meeting;

export interface CircuitGeometry {
  /** Centreline points in metres (origin-shifted source frame), evenly spaced along distance. */
  x: number[];
  y: number[];
  /** Elevation in metres, only when source z quality is acceptable; otherwise absent. */
  z?: number[];
  distance: number[];
  corners: { number: number; label: string; distance: number; x: number; y: number; source: "detected" | "official" }[];
  sectorBoundaries: number[];
  startFinish: { x: number; y: number; heading: number };
  /** Offsets subtracted from source coordinates (metres). */
  origin: { x: number; y: number; z: number };
}

export interface CircuitLayoutRecord {
  circuitId: string;
  year: number;
  lengthM: number;
  geometry: CircuitGeometry;
  provenance: Record<string, unknown>;
  accuracyM: number | null;
  confidence: "high" | "medium" | "low";
}

export interface PredictionRecord {
  id: string;
  ownerTenantId: string | null;
  kind: string;
  meetingId: string | null;
  inputSessionIds: string[];
  targetSessionId: string | null;
  modelVersion: string;
  paramsVersion: string;
  inputHash: string;
  asOf: string;
  createdAt: string;
  output: unknown;
}

export interface ModelVersionRecord {
  id: string;
  family: string;
  params: Record<string, unknown>;
  metrics: Record<string, unknown> | null;
  status: "candidate" | "active" | "retired";
  createdAt: string;
}

export interface BacktestRecord {
  id: string;
  modelVersion: string;
  family: string;
  windowDesc: string;
  metrics: Record<string, unknown>;
  details: Record<string, unknown>;
  createdAt: string;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  tenantId: string | null;
  userId: string | null;
  kind: string;
  input: Record<string, unknown>;
  status: JobStatus;
  progress: number;
  result: unknown;
  error: unknown;
  idempotencyKey: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AuditEntry {
  userId: string | null;
  tenantId: string | null;
  via: string;
  clientId?: string | null;
  action: string;
  resource?: string | null;
  outcome: "allowed" | "denied" | "error" | "ok";
  details?: Record<string, unknown>;
}

export interface DataSourceRecord {
  id: string;
  name: string;
  apiVersion: string | null;
  license: string;
  permittedUse: string;
  redistribution: string;
  attribution: string | null;
  publicDisplayAllowed: boolean;
  enabled: boolean;
  missingChannels: string[] | null;
  rateLimit: string | null;
  accuracyNotes: string | null;
  historicalCoverage: string | null;
  updateFrequency: string | null;
  retention: string | null;
}

/** Read side. Every method is tenant-scoped or takes an AuthorizedSession. */
/** A tenant's connection to a provider account. `secret` is AES-GCM ciphertext, never plaintext. */
export interface ProviderConnectionRecord {
  provider: string;
  status: "connected" | "expired";
  /** Non-secret metadata only (expiry, method, timestamps). */
  config: Record<string, unknown>;
  secret: Uint8Array | null;
  createdAt: string;
}

export interface Store {
  listSeasons(scope: TenantScope): Promise<{ year: number; sessions: number; ingested: number }[]>;
  listMeetings(scope: TenantScope, year?: number): Promise<MeetingRecord[]>;
  listSessions(scope: TenantScope, q: { year?: number; meetingId?: string; type?: string; ingestedOnly?: boolean; limit: number }): Promise<SessionRecord[]>;
  /** All rows visible to the scope with this public id (private copy and/or public row). */
  findSessions(scope: TenantScope, id: string): Promise<SessionRecord[]>;

  drivers(s: AuthorizedSession): Promise<Driver[]>;
  laps(s: AuthorizedSession, driverNumber?: number): Promise<Lap[]>;
  stints(s: AuthorizedSession): Promise<Stint[]>;
  pitEvents(s: AuthorizedSession): Promise<PitEvent[]>;
  raceControl(s: AuthorizedSession): Promise<RaceControlEvent[]>;
  weather(s: AuthorizedSession): Promise<WeatherObservation[]>;
  teamRadio(s: AuthorizedSession, driverNumber?: number): Promise<TeamRadio[]>;
  positionHistory(s: AuthorizedSession): Promise<PositionRecord[]>;
  intervals(s: AuthorizedSession, untilIso?: string): Promise<IntervalRecord[]>;
  results(s: AuthorizedSession): Promise<SessionResult[]>;
  /** Times are epoch milliseconds. */
  carSamples(s: AuthorizedSession, driverNumber: number, fromIso?: string, toIso?: string): Promise<CarSamples>;
  positionSamples(s: AuthorizedSession, driverNumbers: number[] | null, fromIso?: string, toIso?: string): Promise<Map<number, PositionSamples>>;
  sampleCounts(s: AuthorizedSession): Promise<{ car: number; position: number }>;

  circuitLayout(circuitId: string, year: number): Promise<CircuitLayoutRecord | null>;
  saveCircuitLayout(layout: CircuitLayoutRecord, sourceSessionUid: string | null): Promise<void>;

  dataSources(): Promise<DataSourceRecord[]>;

  savePrediction(scope: TenantScope, p: Omit<PredictionRecord, "id" | "createdAt">): Promise<PredictionRecord>;
  listPredictions(scope: TenantScope, q: { meetingId?: string; kind?: string; limit: number }): Promise<PredictionRecord[]>;
  getPrediction(scope: TenantScope, id: string): Promise<PredictionRecord | null>;
  activeModel(family: string): Promise<ModelVersionRecord | null>;
  modelVersions(family?: string): Promise<ModelVersionRecord[]>;
  backtests(q: { family?: string; modelVersion?: string; limit: number }): Promise<BacktestRecord[]>;

  createJob(scope: TenantScope, j: { userId: string | null; kind: string; input: Record<string, unknown>; idempotencyKey: string | null }): Promise<{ job: JobRecord; created: boolean }>;
  getJob(scope: TenantScope, id: string): Promise<JobRecord | null>;
  countActiveJobs(scope: TenantScope): Promise<number>;
  jobByIdempotencyKey(scope: TenantScope, key: string): Promise<JobRecord | null>;
  requestJobCancel(scope: TenantScope, id: string): Promise<JobRecord | null>;
  /** System-level: claim the oldest queued job (SKIP LOCKED in PostgreSQL). */
  claimJob(): Promise<JobRecord | null>;
  updateJob(id: string, patch: Partial<Pick<JobRecord, "status" | "progress" | "result" | "error">>): Promise<JobRecord | null>;

  audit(e: AuditEntry): Promise<void>;

  /** Tenant-scoped (RLS in PostgreSQL); a scope without a tenant sees nothing. */
  getProviderConnection(scope: TenantScope, provider: string): Promise<ProviderConnectionRecord | null>;
  saveProviderConnection(scope: TenantScope, c: Omit<ProviderConnectionRecord, "createdAt">): Promise<void>;
  deleteProviderConnection(scope: TenantScope, provider: string): Promise<boolean>;
}

export interface IngestStore {
  /** Creates or returns the session row for this owner; returns its uid. */
  upsertSession(owner: string | null, bundle: Pick<SessionBundle, "meeting" | "session">): Promise<string>;
  writeTiming(uid: string, b: SessionBundle, source: string, processingVersion: string): Promise<void>;
  /** Times are epoch ms. Idempotent: duplicates are ignored. Returns rows written. */
  writeCarSamples(uid: string, driverNumber: number, s: CarSamples): Promise<number>;
  writePositionSamples(uid: string, driverNumber: number, s: PositionSamples): Promise<number>;
  markIngested(uid: string, status: "partial" | "complete" | "failed", channels: string[]): Promise<void>;
  saveQualityReport(uid: string, processingVersion: string, report: Record<string, unknown>): Promise<void>;
}
