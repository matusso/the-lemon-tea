import type { TimingBundle, TimelineEvent } from "@lemon-tea/synchronization";
import type { Driver } from "@lemon-tea/shared-types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * Same-origin JSON client. Mutating requests carry the CSRF header the API requires for
 * cookie-authenticated calls; credentials are always included.
 */
export async function api<T>(path: string, opts: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    headers["x-requested-with"] = "lemon-tea";
    headers["content-type"] = "application/json";
  }
  const res = await fetch(path, { method, headers, credentials: "include", ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const enc = (id: string) => encodeURIComponent(id);

// ---------------------------------------------------------------- response shapes (subset used by the UI)

export interface Me {
  anonymous: boolean;
  user?: { id: string; email: string; role: string };
  scopes: string[];
}

export interface SessionRow {
  id: string;
  meetingId: string;
  meetingName: string;
  year: number;
  name: string;
  type: string;
  circuitShortName: string;
  dateStart: string;
  dateEnd: string | null;
  ingestStatus: string;
  source: string;
  visibility: string;
  regulationEra: string;
}

export interface MeetingRow {
  id: string;
  year: number;
  name: string;
  circuitShortName: string;
  dateStart: string;
}

export interface SessionInfo {
  session: SessionRow;
  drivers: Driver[];
  laps: number;
  samples: { car: number; position: number };
  regulationNotes: string[];
  attribution: string | null;
}

export interface Corner {
  number: number;
  label: string;
  distance: number;
  x: number;
  y: number;
  source: string;
}

export interface CircuitResponse {
  circuitId: string;
  name: string;
  year: number;
  lengthM: number;
  accuracyM: number | null;
  confidence: "high" | "medium" | "low";
  provenance: Record<string, unknown>;
  geometry: {
    x: number[];
    y: number[];
    z?: number[];
    distance: number[];
    corners: Corner[];
    sectorBoundaries: number[];
    startFinish: { x: number; y: number; heading: number };
    origin: { x: number; y: number; z: number };
  };
}

export interface ReplayWindow {
  fromMs: number;
  toMs: number;
  cars: Record<string, { t: number[]; x: number[]; y: number[] }>;
}

export interface LapRow {
  driverNumber: number;
  lapNumber: number;
  lapTime: number | null;
  sector1: number | null;
  sector2: number | null;
  sector3: number | null;
  isPitOutLap: boolean;
  compound: string | null;
  tyreAge: number | null;
  tStartMs: number | null;
}

export interface Finding {
  scope: string;
  deltaChange: number;
  factor: string;
  text: string;
  evidence: Record<string, number | string | null>;
}

export interface CornerMetricsOut {
  brakeStart: number | null;
  brakeEnd: number | null;
  brakingDistance: number | null;
  brakingDuration: number | null;
  approachSpeed: number;
  entrySpeed: number;
  minSpeed: number;
  minSpeedDistance: number;
  throttleOn: number | null;
  fullThrottle: number | null;
  exitSpeed: number;
  exitAcceleration: number;
  minThrottle: number;
  timeInWindow: number;
}

export interface TraceOut {
  distance: number[];
  time: number[];
  speed: number[];
  throttle: number[];
  brake: number[];
  gear?: number[];
  rpm?: number[];
  acceleration: number[];
  x?: number[];
  y?: number[];
}

export interface CompareResponse {
  analysis_type: string;
  meta: { algorithmVersion: string; dataQuality: string; assumptions: string[]; warnings: { code: string; message: string }[]; sources: string[] };
  delta_convention: string;
  delta_semantics: string;
  a: { sessionId: string; driverNumber: number; driverCode: string; lapNumber: number; lapTime: number };
  b: { sessionId: string; driverNumber: number; driverCode: string; lapNumber: number; lapTime: number };
  reference_length_m: number;
  time_delta_seconds: number;
  max_gain_for_a: { distance_m: number; delta_seconds: number };
  max_loss_for_a: { distance_m: number; delta_seconds: number };
  sectors: { sector: number; measuredDelta: number | null; boundaryDistance: number | null }[];
  mini_sectors: { label: string; from: number; to: number; deltaChange: number }[];
  corners: {
    corner: { index: number; label: string; minSpeedDistance: number; windowStart: number; windowEnd: number; band: string; minSpeed: number };
    delta_change_seconds: number;
    dominant_phase: string;
    phases: { phase: string; from: number; to: number; deltaChange: number }[];
    a: CornerMetricsOut;
    b: CornerMetricsOut;
    apex_assessment: { status: string; reason: string };
  }[];
  straights: { label: string; from: number; to: number; deltaChange: number }[];
  findings: Finding[];
  summary: string;
  dominant_factor: string | null;
  confidence: number;
  confidence_type: string;
  noise_floor_seconds: number;
  traces?: { resolution_m: number; a: TraceOut; b: TraceOut; delta: number[] };
}

export type { TimingBundle, TimelineEvent };

export const get = {
  me: () => api<Me>("/api/auth/me"),
  seasons: () => api<{ year: number; sessions: number; ingested: number }[]>("/api/seasons"),
  meetings: (year: number) => api<MeetingRow[]>(`/api/meetings?year=${year}`),
  sessions: (meetingId: string, ingestedOnly = true) => api<SessionRow[]>(`/api/sessions?meetingId=${enc(meetingId)}&ingestedOnly=${ingestedOnly}&limit=50`),
  info: (id: string) => api<SessionInfo>(`/api/sessions/${enc(id)}`),
  bundle: (id: string) => api<TimingBundle>(`/api/sessions/${enc(id)}/bundle`),
  circuit: (id: string) => api<CircuitResponse>(`/api/sessions/${enc(id)}/circuit`),
  laps: (id: string, driver: number) => api<LapRow[]>(`/api/sessions/${enc(id)}/laps/${driver}`),
  replay: (id: string, from: number, to: number) => api<ReplayWindow>(`/api/sessions/${enc(id)}/replay?from=${Math.floor(from)}&to=${Math.ceil(to)}&hz=4`),
  sources: () => api<Record<string, unknown>[]>("/api/sources"),
};
