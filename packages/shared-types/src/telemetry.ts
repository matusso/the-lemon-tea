import { z } from "zod";

/**
 * Telemetry is transported column-wise. Arrays share an index; `t` is milliseconds since
 * the session epoch (session.dateStart). Columns that a source does not provide are absent,
 * never zero-filled.
 */
export const CarTelemetryColumns = z.object({
  t: z.array(z.number()).describe("ms since session start (UTC-derived)"),
  speed: z.array(z.number()).describe("km/h, measured"),
  throttle: z.array(z.number()).describe("%, measured (0-100; >100 is a source artefact and is clipped)"),
  brake: z.array(z.number()).describe("Binary 0/1 brake application, measured. NOT pressure."),
  rpm: z.array(z.number()).optional(),
  gear: z.array(z.number()).optional(),
  drs: z.array(z.number().nullable()).optional().describe("Raw source DRS code, pre-2026 only"),
});
export type CarTelemetryColumns = z.infer<typeof CarTelemetryColumns>;

export const PositionColumns = z.object({
  t: z.array(z.number()),
  x: z.array(z.number()).describe("metres, source frame"),
  y: z.array(z.number()).describe("metres, source frame"),
  z: z.array(z.number()).describe("metres, source frame; accuracy not guaranteed"),
});
export type PositionColumns = z.infer<typeof PositionColumns>;

export const Channel = z.enum([
  "speed",
  "throttle",
  "brake",
  "rpm",
  "gear",
  "drs",
  "acceleration",
  "distance",
  "delta",
]);
export type Channel = z.infer<typeof Channel>;

export const ChannelAvailability = z.object({
  channel: z.string(),
  available: z.boolean(),
  kind: z.enum(["measured", "calculated", "estimated", "unavailable"]),
  unit: z.string().nullable(),
  nominalHz: z.number().nullable(),
  note: z.string().optional(),
});
export type ChannelAvailability = z.infer<typeof ChannelAvailability>;

/** A lap resampled onto a common distance grid. */
export const DistanceTrace = z.object({
  driverNumber: z.number().int(),
  lapNumber: z.number().int(),
  sessionId: z.string(),
  lapTime: z.number().nullable(),
  distance: z.array(z.number()).describe("metres from lap start"),
  time: z.array(z.number()).describe("seconds since lap start, interpolated from samples"),
  speed: z.array(z.number()),
  throttle: z.array(z.number()),
  brake: z.array(z.number()),
  gear: z.array(z.number()).optional(),
  rpm: z.array(z.number()).optional(),
  acceleration: z.array(z.number()).describe("m/s^2 longitudinal, calculated from speed"),
  x: z.array(z.number()).optional(),
  y: z.array(z.number()).optional(),
  sourceSampleCount: z.number().int(),
  measuredMask: z.array(z.boolean()).describe("true where a raw sample lies within half a grid step"),
});
export type DistanceTrace = z.infer<typeof DistanceTrace>;
