import { bisectRight, type PositionSamples } from "@lemon-tea/telemetry-core";

export interface InterpolatedPosition {
  x: number;
  y: number;
  z: number;
  /** "measured" when a raw sample lies within `measuredToleranceMs`; else "interpolated". */
  kind: "measured" | "interpolated";
  /** Age of the nearest real sample, ms. */
  sampleAgeMs: number;
}

/**
 * Position at time `t` (same clock as samples). Linear between samples no more than `maxGapMs`
 * apart; beyond that the car is treated as unknown (null) rather than drawn on a guessed path.
 * Interpolated frames are visual smoothing and are labelled as such.
 */
export function positionAt(s: PositionSamples, t: number, maxGapMs = 2000, measuredToleranceMs = 60): InterpolatedPosition | null {
  const n = s.t.length;
  if (!n || t < s.t[0]! - measuredToleranceMs || t > s.t[n - 1]! + measuredToleranceMs) return null;
  const i = bisectRight(s.t, t);
  if (i < 0) return { x: s.x[0]!, y: s.y[0]!, z: s.z[0]!, kind: "measured", sampleAgeMs: s.t[0]! - t };
  if (i >= n - 1) return { x: s.x[n - 1]!, y: s.y[n - 1]!, z: s.z[n - 1]!, kind: "measured", sampleAgeMs: t - s.t[n - 1]! };
  const t0 = s.t[i]!;
  const t1 = s.t[i + 1]!;
  if (t1 - t0 > maxGapMs) return null;
  const f = (t - t0) / (t1 - t0);
  const age = Math.min(t - t0, t1 - t);
  return {
    x: s.x[i]! + (s.x[i + 1]! - s.x[i]!) * f,
    y: s.y[i]! + (s.y[i + 1]! - s.y[i]!) * f,
    z: s.z[i]! + (s.z[i + 1]! - s.z[i]!) * f,
    kind: age <= measuredToleranceMs ? "measured" : "interpolated",
    sampleAgeMs: age,
  };
}
