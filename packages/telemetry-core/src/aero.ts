/**
 * Estimated 2026 active-aero state ("straight-line mode": front and rear wing flaps open).
 *
 * The live timing feed publishes no aero channel from 2026 (the old DRS channel 45 is gone), so
 * the state can only be inferred. Under the 2026 rules the low-drag mode is available on the
 * designated straights to every car on every lap and closes as soon as the driver brakes or
 * lifts. It is therefore estimated as: full throttle, no brake, at straight-line speed, held for
 * at least `minHoldMs`. This marks *where the wings are most likely open*; it cannot see where a
 * team chooses not to use it, nor the exact activation points of each zone.
 */
export interface AeroEstimateOptions {
  /** Throttle at or above which the car counts as flat out (%). */
  minThrottle?: number;
  /** Speed at or above which the car is on a straight (km/h). */
  minSpeedKmh?: number;
  /** How long the condition must hold before the flaps count as open (ms). */
  minHoldMs?: number;
}

export const AERO_ESTIMATE_DEFAULTS: Required<AeroEstimateOptions> = { minThrottle: 98, minSpeedKmh: 180, minHoldMs: 1000 };

/** Per-sample estimate: 1 = wings likely open (straight-line mode), 0 = closed (corner mode). */
export function estimateWingsOpen(
  s: { t: readonly number[]; speed: readonly number[]; throttle: readonly number[]; brake: readonly number[] },
  o: AeroEstimateOptions = {},
): number[] {
  const { minThrottle, minSpeedKmh, minHoldMs } = { ...AERO_ESTIMATE_DEFAULTS, ...o };
  const n = s.t.length;
  const out = new Array<number>(n).fill(0);
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const flat = s.throttle[i]! >= minThrottle && !(s.brake[i]! > 0) && s.speed[i]! >= minSpeedKmh;
    if (!flat) {
      runStart = -1;
      continue;
    }
    if (runStart < 0) runStart = i;
    if (s.t[i]! - s.t[runStart]! >= minHoldMs) out[i] = 1;
  }
  return out;
}
