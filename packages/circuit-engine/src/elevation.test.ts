import { describe, expect, it } from "vitest";
import { cleanElevation, fillGaps, plausibleElevation } from "./index.ts";

describe("elevation cleaning", () => {
  it("drops zero (missing) samples instead of treating them as sea level", () => {
    const raw = [0, 2226.4, 2226.6, 0, 2227, 2227.2, 2227.4, 2227.6, 2227.8, 2228];
    const z = cleanElevation(raw)!;
    expect(Number.isNaN(z[0]!)).toBe(true);
    expect(Number.isNaN(z[3]!)).toBe(true);
    const filled = fillGaps(z)!;
    expect(Math.min(...filled)).toBeGreaterThan(2226);
    expect(filled[3]).toBeCloseTo(2226.8, 5);
  });

  it("rejects laps that are mostly missing", () => {
    expect(cleanElevation([0, 0, 0, 0, 2226])).toBeNull();
  });

  it("wraps around the lap when filling a gap at the start", () => {
    expect(fillGaps([Number.NaN, 10, 20, 30])).toEqual([20, 10, 20, 30]);
  });

  it("refuses a cliff (e.g. one zero sample left in) as elevation", () => {
    expect(plausibleElevation([0, 103, 177, 233, 600, 600])).toBe(false);
    expect(plausibleElevation([0, 0.1, 0.2, 0.4, 0.8, 1.2, 1.5])).toBe(true);
    expect(plausibleElevation([0, 0.1, 0.2])).toBe(false); // flat: nothing to draw
  });
});
