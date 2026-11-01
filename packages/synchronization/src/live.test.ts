import { describe, expect, it } from "vitest";
import { LiveBuffer, liveGap, liveLaps } from "./live.ts";

const EPOCH = 1_800_000_000_000;
const R = 500;
const L = 2 * Math.PI * R;
const V = 50; // m/s

/** Car on a circle; `lead` metres ahead of the line at t=0. Times are epoch ms. */
function feed(fromS: number, toS: number, lead = 0) {
  const t: number[] = [], x: number[] = [], y: number[] = [], speed: number[] = [], throttle: number[] = [], brake: number[] = [], z: number[] = [];
  for (let s = fromS; s < toS; s += 0.25) {
    const a = (lead + V * s) / R;
    t.push(EPOCH + s * 1000);
    x.push(R * Math.cos(a));
    y.push(R * Math.sin(a));
    z.push(0);
    speed.push(V * 3.6);
    throttle.push(100);
    brake.push(0);
  }
  return { car: { t, speed, throttle, brake }, pos: { t, x, y, z } };
}
const project = (x: number, y: number) => ((Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI)) * R;

describe("LiveBuffer", () => {
  it("stores samples in session time, merges overlapping deltas and trims old data", () => {
    const b = new LiveBuffer(EPOCH, 60_000);
    const f1 = feed(0, 30);
    const f2 = feed(20, 90); // overlaps the first delta by 10 s
    b.ingest({ car: { "1": f1.car }, position: { "1": f1.pos } });
    b.ingest({ car: { "1": f2.car }, position: { "1": f2.pos } });
    const p = b.positions.get(1)!;
    expect(p.t[0]).toBeGreaterThanOrEqual(b.latestMs - 60_000);
    expect(b.latestMs).toBeCloseTo(89_750, 0);
    expect(p.t.every((v, i) => i === 0 || v > p.t[i - 1]!)).toBe(true);
    expect(b.car.get(1)!.t.length).toBe(p.t.length);
    expect(b.revision).toBe(2);
  });
});

describe("liveLaps / liveGap", () => {
  it("splits a car's samples into laps at the line and measures the on-road gap", () => {
    const lapS = L / V; // ≈ 62.8 s
    const a = feed(0, lapS * 2.5, 100);
    const b = feed(0, lapS * 2.5, 0); // 100 m behind a → 2 s at 50 m/s
    const la = liveLaps({ ...a.car, t: a.car.t.map((t) => t - EPOCH) }, { ...a.pos, t: a.pos.t.map((t) => t - EPOCH) }, project, L);
    const lb = liveLaps({ ...b.car, t: b.car.t.map((t) => t - EPOCH) }, { ...b.pos, t: b.pos.t.map((t) => t - EPOCH) }, project, L);
    expect(la.length).toBe(3);
    expect(la.filter((l) => l.complete).length).toBe(1); // first lap starts mid-lap, last is in progress
    const g = liveGap(la, lb)!;
    expect(g.ahead).toBe("a");
    expect(g.seconds).toBeCloseTo(2, 1);
  });
});
