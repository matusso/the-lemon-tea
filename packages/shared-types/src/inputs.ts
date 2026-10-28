import { z } from "zod";

/**
 * Input schemas shared by REST handlers and MCP tools. Defining them once guarantees that
 * both interfaces validate identically and call the same domain service with the same arguments.
 */

export const SessionId = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+:[A-Za-z0-9_-]+$/, "Expected '<source>:<key>', e.g. 'openf1:9912'")
  .describe("Session id in the form '<source>:<key>', e.g. 'openf1:9912'");

export const DriverNumber = z.number().int().min(1).max(99).describe("Car number");
export const LapNumber = z.number().int().min(1).max(200);

export const ListSessionsInput = z.object({
  year: z.number().int().min(1950).max(2100).optional(),
  meetingId: z.string().max(64).optional(),
  type: z.enum(["practice", "qualifying", "sprint_qualifying", "sprint", "race"]).optional(),
  ingestedOnly: z.boolean().optional().describe("Only sessions with stored data"),
  limit: z.number().int().min(1).max(200).default(100),
});

export const SessionInput = z.object({ sessionId: SessionId });

export const DriverLapsInput = z.object({
  sessionId: SessionId,
  driverNumber: DriverNumber,
});

export const TelemetryInput = z.object({
  sessionId: SessionId,
  driverNumber: DriverNumber,
  lapNumber: LapNumber.optional().describe("Return a single lap; otherwise use fromMs/toMs"),
  fromMs: z.number().min(0).optional().describe("Session-relative start, ms"),
  toMs: z.number().min(0).optional(),
  maxPoints: z.number().int().min(10).max(5000).default(1000).describe("Output is decimated to at most this many samples"),
});

export const PositionAtInput = z.object({
  sessionId: SessionId,
  tMs: z.number().min(0).describe("Session-relative time in ms"),
  driverNumber: DriverNumber.optional(),
});

export const TimingInput = z.object({
  sessionId: SessionId,
  tMs: z.number().min(0).optional().describe("Session-relative time; defaults to end of session"),
});

export const LapRef = z.object({
  sessionId: SessionId,
  driverNumber: DriverNumber,
  lapNumber: LapNumber.optional().describe("Defaults to the driver's fastest valid lap"),
});

export const CompareLapsInput = z.object({
  a: LapRef,
  b: LapRef,
  stepMetres: z.number().min(1).max(50).default(5),
  includeTraces: z
    .boolean()
    .default(false)
    .describe("Include distance-aligned channel arrays (large). Summaries and findings are always returned."),
  traceResolutionMetres: z.number().min(5).max(200).default(25).describe("Spacing of returned trace points when includeTraces is true"),
});

export const CornerInput = CompareLapsInput.extend({
  corner: z.number().int().min(1).max(40).optional().describe("Detected corner number; omit for all corners"),
});

export const TrackDominanceInput = z.object({
  sessionId: SessionId,
  driverNumbers: z.array(DriverNumber).min(2).max(10),
  segments: z.number().int().min(5).max(100).default(25),
});

export const DriverStyleInput = z.object({
  sessionId: SessionId,
  driverNumber: DriverNumber,
});

export const CompareTeamsInput = z.object({
  sessionId: SessionId,
  teams: z.array(z.string().max(64)).min(2).max(10).optional(),
});

export const PracticeInput = z.object({
  sessionIds: z.array(SessionId).min(1).max(6).describe("Practice / sprint sessions of one weekend"),
});

export const PredictQualifyingInput = PracticeInput.extend({
  persist: z.boolean().default(true).describe("Store a prediction snapshot for history/backtesting"),
});

export const DegradationInput = z.object({
  sessionIds: z.array(SessionId).min(1).max(6),
  compound: z.enum(["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"]).optional(),
});

export const StrategyStint = z.object({
  compound: z.enum(["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"]),
  laps: z.number().int().min(1).max(100),
});

export const SimulateStrategyInput = z.object({
  sessionId: SessionId.describe("Race session for circuit/field context"),
  paceSessionIds: z.array(SessionId).max(6).optional().describe("Sessions used to estimate pace and degradation"),
  driverNumber: DriverNumber,
  totalLaps: z.number().int().min(5).max(100).optional(),
  strategies: z.array(z.object({ name: z.string().max(40), stints: z.array(StrategyStint).min(1).max(5) })).min(1).max(6),
  iterations: z.number().int().min(100).max(20000).default(2000),
  seed: z.number().int().default(42),
  scenario: z
    .object({
      safetyCarProbabilityPerLap: z.number().min(0).max(0.2).optional(),
      vscProbabilityPerLap: z.number().min(0).max(0.2).optional(),
      pitLossSeconds: z.number().min(5).max(60).optional(),
      trackTempDeltaC: z.number().min(-20).max(20).optional(),
    })
    .default({}),
});

export const PredictRaceResultInput = z.object({
  raceSessionId: SessionId,
  paceSessionIds: z.array(SessionId).min(1).max(6),
  gridSessionId: SessionId.optional().describe("Qualifying session used for the starting order"),
  iterations: z.number().int().min(100).max(20000).default(2000),
  seed: z.number().int().default(42),
});

export const JobKind = z.enum(["simulate_strategy", "predict_race_result", "predict_qualifying", "ingest_session", "ingest_weekend"]);

export const CreateJobInput = z.object({
  kind: JobKind,
  input: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const JobIdInput = z.object({ jobId: z.string().uuid() });

export const IngestInput = z.object({
  sessionId: SessionId,
  channels: z.array(z.enum(["timing", "car_data", "location"])).default(["timing", "car_data", "location"]),
  visibility: z.enum(["public", "private"]).default("private"),
});

/** A whole race weekend (all practice, qualifying, sprint and race sessions of one meeting) as one job. */
export const IngestWeekendInput = z.object({
  source: z.string().min(2).max(32).regex(/^[a-z0-9]+$/),
  year: z.number().int().min(1950).max(2100),
  meetingKey: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/),
  channels: z.array(z.enum(["timing", "car_data", "location"])).default(["timing", "car_data", "location"]),
  visibility: z.enum(["public", "private"]).default("private"),
});
