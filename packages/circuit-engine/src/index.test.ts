import { describe, expect, it } from "vitest";
import type { DistanceTrace } from "@lemon-tea/shared-types";
import { checkLapGeometry, findPositionLoops } from "./index.ts";

const R = 700; // m, circumference ≈ 4398 m
const V = 60; // m/s
const HZ = 4;

/** A car circling at constant speed; optional parked stretch (no movement) and data gap. */
function circling(laps: number, o: { parkFromS?: number; parkForS?: number; gapAtS?: number } = {}) {
  const t: number[] = [], x: number[] = [], y: number[] = [];
  const period = (2 * Math.PI * R) / V;
  let along = 0;
  for (let k = 0; k <= laps * period * HZ; k++) {
    const sec = k / HZ;
    if (o.gapAtS !== undefined && sec > o.gapAtS && sec < o.gapAtS + 5) continue;
    const parked = o.parkFromS !== undefined && sec >= o.parkFromS && sec < o.parkFromS + (o.parkForS ?? 0);
    if (!parked && k > 0) along += V / HZ;
    const a = along / R;
    t.push(1_000_000 + sec * 1000);
    x.push(R * Math.cos(a));
    y.push(R * Math.sin(a));
  }
  return { t, x, y, period };
}

function traceOf(xs: number[], ys: number[], lapTime: number, hz = 4): DistanceTrace {
  return {
    sessionId: "s", driverNumber: 1, lapNumber: 1, lapTime,
    distance: xs.map((_, i) => i * 5), time: xs.map((_, i) => i), speed: [], throttle: [], brake: [], acceleration: [],
    x: xs, y: ys, sourceSampleCount: Math.round(lapTime * hz), measuredMask: xs.map(() => true),
  } as unknown as DistanceTrace;
}

describe("findPositionLoops", () => {
  it("finds consecutive circuit-length loops from position data only", () => {
    const p = circling(3.2);
    const loops = findPositionLoops(p, { max: 5 });
    expect(loops.length).toBe(3);
    for (const l of loops) {
      expect(l.pathLengthM).toBeGreaterThan(2 * Math.PI * R * 0.98);
      expect(l.pathLengthM).toBeLessThan(2 * Math.PI * R * 1.02);
      expect((l.endMs - l.startMs) / 1000).toBeCloseTo(p.period, 0);
    }
  });

  it("never bridges a data gap and skips loops driven too slowly", () => {
    const gap = circling(3.2, { gapAtS: 100 });
    expect(findPositionLoops(gap, { max: 5 }).length).toBe(2);
    const parked = circling(5, { parkFromS: 100, parkForS: 120 }); // passes at ~0, 73, 266, 339 s
    // the loop containing a 2-minute stop has a mean speed far below racing pace
    expect(findPositionLoops(parked, { max: 5 }).length).toBe(2);
  });
});

describe("checkLapGeometry", () => {
  const n = 880;
  const ring = Array.from({ length: n + 1 }, (_, i) => (2 * Math.PI * i) / n);
  const L = 2 * Math.PI * R;

  it("accepts a closed, fully measured lap whose path matches its speed-integrated length", () => {
    const r = checkLapGeometry(traceOf(ring.map((a) => R * Math.cos(a)), ring.map((a) => R * Math.sin(a)), L / V), L);
    expect(r.ok).toBe(true);
  });

  it("rejects frozen positions, unclosed laps, implausible speed and sparse car data", () => {
    const frozen = checkLapGeometry(traceOf(ring.map(() => R), ring.map(() => 0), L / V), L);
    expect(frozen.ok).toBe(false);
    const half = ring.map((a) => a * 0.9);
    const open = checkLapGeometry(traceOf(half.map((a) => R * Math.cos(a)), half.map((a) => R * Math.sin(a)), L / V), L * 0.9);
    expect(open.reason).toMatch(/does not close/);
    const slow = checkLapGeometry(traceOf(ring.map((a) => R * Math.cos(a)), ring.map((a) => R * Math.sin(a)), 600), 300);
    expect(slow.reason).toMatch(/mean speed/);
    const sparse = checkLapGeometry(traceOf(ring.map((a) => R * Math.cos(a)), ring.map((a) => R * Math.sin(a)), L / V, 1), L);
    expect(sparse.reason).toMatch(/sparse car data/);
  });
});
