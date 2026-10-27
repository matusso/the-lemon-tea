import { z } from "zod";

/**
 * How a value came to exist. Every number the platform shows carries one of these.
 * - measured:   reported by a data source as an observation (e.g. speed trap, car_data speed)
 * - calculated: deterministic function of measured values (e.g. acceleration from speed)
 * - estimated:  statistical estimate with uncertainty (e.g. fuel-corrected pace)
 * - simulated:  output of a stochastic simulation (e.g. Monte Carlo finishing position)
 * - unavailable: the source does not expose it; no value is shown
 */
export const ValueKind = z.enum(["measured", "calculated", "estimated", "simulated", "unavailable"]);
export type ValueKind = z.infer<typeof ValueKind>;

export const Provenance = z.object({
  source: z.string().describe("Source identifier, e.g. 'openf1'"),
  sourceVersion: z.string().optional(),
  kind: ValueKind,
  processingVersion: z.string().describe("Version of the algorithm that produced or normalized the value"),
  retrievedAt: z.string().datetime().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Visibility = z.enum(["public", "private"]);
export type Visibility = z.infer<typeof Visibility>;

/**
 * Confidence semantics are explicit: a heuristic quality score is never presented as a probability.
 */
export const ConfidenceType = z.enum([
  "algorithmic_quality_score", // 0..1 heuristic, NOT a probability
  "calibrated_probability", // validated against historical outcomes
  "uncalibrated_probability", // model probability without validation evidence yet
]);
export type ConfidenceType = z.infer<typeof ConfidenceType>;

export const Interval = z.object({
  low: z.number(),
  high: z.number(),
  level: z.number().min(0).max(1).describe("Nominal coverage, e.g. 0.8 for an 80% interval"),
  calibrated: z.boolean().describe("True only if coverage has been validated by backtesting"),
});
export type Interval = z.infer<typeof Interval>;

export const DataQuality = z.enum(["high", "medium", "low", "insufficient"]);
export type DataQuality = z.infer<typeof DataQuality>;

export const Warning = z.object({
  code: z.string(),
  message: z.string(),
});
export type Warning = z.infer<typeof Warning>;

/** Envelope shared by every analytical response (REST, WebSocket, MCP). */
export const AnalysisMeta = z.object({
  analysisType: z.string(),
  algorithmVersion: z.string(),
  generatedAt: z.string().datetime(),
  sources: z.array(z.string()),
  dataQuality: DataQuality,
  assumptions: z.array(z.string()),
  warnings: z.array(Warning),
  evidence: z.array(z.string()).describe("Names of metrics/channels the result is derived from"),
});
export type AnalysisMeta = z.infer<typeof AnalysisMeta>;

export const ErrorCode = z.enum([
  "not_found",
  "forbidden",
  "unauthorized",
  "invalid_input",
  "data_unavailable",
  "insufficient_data",
  "rate_limited",
  "quota_exceeded",
  "provider_error",
  "conflict",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export class LemonTeaError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LemonTeaError";
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
  invalid_input: 400,
  data_unavailable: 422,
  insufficient_data: 422,
  rate_limited: 429,
  quota_exceeded: 429,
  provider_error: 502,
  conflict: 409,
  internal: 500,
};
