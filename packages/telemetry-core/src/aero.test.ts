import { describe, expect, it } from "vitest";
import { estimateWingsOpen } from "./aero.ts";

const lap = (rows: [number, number, number, number][]) => ({ t: rows.map((r) => r[0]), speed: rows.map((r) => r[1]), throttle: rows.map((r) => r[2]), brake: rows.map((r) => r[3]) });

describe("estimateWingsOpen", () => {
  it("opens only after flat-out running is held, and closes on braking", () => {
    const s = lap([
      [0, 150, 100, 0], // too slow
      [250, 190, 100, 0], // run starts
      [750, 210, 100, 0],
      [1250, 230, 100, 0], // held 1 s
      [1500, 250, 100, 0],
      [1750, 240, 0, 1], // braking
      [2000, 200, 100, 0], // new run, not held yet
    ]);
    expect(estimateWingsOpen(s)).toEqual([0, 0, 0, 1, 1, 0, 0]);
  });

  it("treats a lift as closing the flaps", () => {
    const s = lap([
      [0, 250, 100, 0],
      [1200, 260, 100, 0],
      [1400, 255, 80, 0],
      [1600, 255, 100, 0],
    ]);
    expect(estimateWingsOpen(s)).toEqual([0, 1, 0, 0]);
  });
});
