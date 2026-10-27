import { describe, expect, it } from "vitest";
import { syntheticLap, TRACK_LENGTH, CORNERS } from "../../../tests/fixtures/synthetic.ts";
import { compareLaps } from "./comparison.ts";
import { buildLapTrace, integrateDistance } from "./distance.ts";
import { computeDelta, DELTA_NOISE_FLOOR_SECONDS } from "./delta.ts";
import { detectCorners } from "./corners.ts";

const base = syntheticLap(1, 5, 600_000, {}, 11);
const lateBraker = syntheticLap(2, 7, 900_000, { corners: [{}, { brakeDistance: 85 }] }, 23);

describe("distance integration", () => {
  it("integrates constant speed exactly", () => {
    const { d } = integrateDistance([0, 1000, 2000], [36, 36, 36]);
    expect(d[2]).toBeCloseTo(20, 9);
  });

  it("recovers the synthetic track length within 0.5%", () => {
    const { integratedLength } = buildLapTrace(base.car, null, {
      sessionId: "synthetic:1",
      driverNumber: 1,
      lapNumber: 5,
      lapStartMs: base.timing.startMs!,
      lapTime: base.timing.lapTime!,
      stepMetres: 5,
    });
    expect(Math.abs(integratedLength - TRACK_LENGTH) / TRACK_LENGTH).toBeLessThan(0.005);
  });
});

describe("time delta", () => {
  const cmp = compareLaps(
    { sessionId: "synthetic:1", driverCode: "AAA", ...base },
    { sessionId: "synthetic:1", driverCode: "BBB", ...lateBraker },
  );

  it("final delta equals the lap-time difference by construction", () => {
    expect(cmp.timeDeltaSeconds).toBeCloseTo(base.timing.lapTime! - lateBraker.timing.lapTime!, 3);
  });

  it("is zero at the start line and uses A_minus_B convention", () => {
    expect(cmp.delta.delta[0]).toBeCloseTo(0, 6);
    expect(cmp.deltaConvention).toBe("A_minus_B");
    // B brakes later into corner 2, so B is faster -> delta positive (A behind)
    expect(cmp.timeDeltaSeconds).toBeGreaterThan(0);
  });

  it("is flat (within the noise floor) through a corner both drivers take identically", () => {
    expect(Math.abs(cmp.corners[0]!.deltaChange)).toBeLessThan(DELTA_NOISE_FLOOR_SECONDS);
  });

  it("identical laps produce ~zero delta everywhere", () => {
    const twin = syntheticLap(3, 2, 50_000, {}, 99);
    const r = compareLaps({ sessionId: "synthetic:1", driverCode: "AAA", ...base }, { sessionId: "synthetic:1", driverCode: "CCC", ...twin });
    expect(Math.max(...r.delta.delta.map(Math.abs))).toBeLessThan(DELTA_NOISE_FLOOR_SECONDS);
  });
});

describe("corner analysis and explanations", () => {
  const cmp = compareLaps(
    { sessionId: "synthetic:1", driverCode: "AAA", ...base },
    { sessionId: "synthetic:1", driverCode: "BBB", ...lateBraker },
  );

  it("detects every synthetic corner near its true apex", () => {
    expect(cmp.corners).toHaveLength(CORNERS.length);
    cmp.corners.forEach((c, i) => expect(Math.abs(c.corner.minSpeedDistance - CORNERS[i]!.apex)).toBeLessThan(30));
  });

  it("attributes the corner-2 difference to braking point, in entry phase", () => {
    const c2 = cmp.corners[1]!;
    expect(c2.deltaChange).toBeGreaterThan(0.02);
    expect(c2.dominantPhase).toBe("entry");
    const f = cmp.findings.find((x) => x.scope === c2.corner.label)!;
    expect(f.factor).toBe("braking_point");
    expect(f.text).toMatch(/BBB gained/);
    // ground truth: 25 m later braking
    expect(Math.abs((f.evidence.brake_start_difference_m as number) - 25)).toBeLessThan(10);
  });

  it("never claims an apex hit", () => {
    for (const c of cmp.corners) expect(c.apexAssessment.status).toBe("not_determinable");
  });

  it("labels confidence as a heuristic score", () => {
    expect(cmp.confidenceType).toBe("algorithmic_quality_score");
    expect(cmp.confidence).toBeGreaterThan(0);
    expect(cmp.confidence).toBeLessThanOrEqual(1);
  });

  it("corner + straight deltas partition the lap delta", () => {
    const sum = cmp.corners.reduce((a, c) => a + c.deltaChange, 0) + cmp.straights.reduce((a, s) => a + s.deltaChange, 0);
    expect(sum).toBeCloseTo(cmp.delta.finalDelta, 2);
  });
});

describe("exit traction", () => {
  it("identifies exit advantage when acceleration is stronger", () => {
    const strongExit = syntheticLap(4, 3, 10_000, { accelFactor: 1.15 }, 5);
    const cmp = compareLaps({ sessionId: "synthetic:1", driverCode: "EXT", ...strongExit }, { sessionId: "synthetic:1", driverCode: "AAA", ...base });
    expect(cmp.timeDeltaSeconds).toBeLessThan(0);
    expect(cmp.corners.filter((c) => c.deltaChange < -DELTA_NOISE_FLOOR_SECONDS / 2 && c.dominantPhase === "exit").length).toBeGreaterThan(0);
  });
});

describe("detectCorners", () => {
  it("returns no corners on a flat-out lap", () => {
    const tr = buildLapTrace(base.car, null, { sessionId: "s:1", driverNumber: 1, lapNumber: 1, lapStartMs: base.timing.startMs!, lapTime: base.timing.lapTime!, stepMetres: 5 }).trace;
    const flat = { ...tr, speed: tr.speed.map(() => 300), throttle: tr.throttle.map(() => 100) };
    expect(detectCorners([flat])).toHaveLength(0);
    expect(computeDelta(flat, flat).finalDelta).toBe(0);
  });
});
