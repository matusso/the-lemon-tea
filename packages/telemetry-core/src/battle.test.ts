import { describe, expect, it } from "vitest";
import { analysePair, buildTrackFrame, carAt, DEFAULT_BATTLE_OPTIONS, detectApexes, lateralResolution, pointOnFrame, projectToFrame, scanBattles, smoothTrack, trackCar, withSide, type TrackFrame } from "./battle.ts";

// SYNTHETIC circuit (not real F1 data): a stadium with two 500 m straights and two 60 m-radius hairpins.
function stadium(clockwise = false) {
  const x: number[] = [];
  const y: number[] = [];
  const push = (px: number, py: number) => (x.push(px), y.push(clockwise ? -py : py));
  for (let s = 0; s < 500; s += 2) push(s, 0);
  for (let a = -Math.PI / 2; a < Math.PI / 2; a += 2 / 60) push(500 + 60 * Math.cos(a), 60 + 60 * Math.sin(a));
  for (let s = 500; s > 0; s -= 2) push(s, 120);
  for (let a = Math.PI / 2; a < (3 * Math.PI) / 2; a += 2 / 60) push(60 * Math.cos(a), 60 + 60 * Math.sin(a));
  const distance = x.map((_, i) => i * 2);
  return { x, y, distance };
}

/** Samples at 4 Hz for a car whose progress is `p(t)` and lateral offset `lat` (+ = left). */
function car(f: TrackFrame, p: (t: number) => number, lat: number, t0: number, t1: number) {
  const s = { t: [] as number[], x: [] as number[], y: [] as number[] };
  for (let t = t0; t <= t1; t += 250) {
    const q = pointOnFrame(f, p(t));
    s.t.push(t);
    s.x.push(q.x - q.ty * lat);
    s.y.push(q.y + q.tx * lat);
  }
  return s;
}

const V = 0.05; // 50 m/s in m/ms
/** Defender B at constant speed; attacker A's gap to B goes linearly from g0 (100 m before the apex) to g1 (at the apex). */
function duel(f: TrackFrame, apexD: number, g0: number, g1: number, latA: number, latB: number) {
  const tApex = 20_000;
  const pB = (t: number) => apexD + V * (t - tApex);
  const gap = (t: number) => {
    const before = apexD - pB(t);
    const u = Math.max(0, Math.min(1, 1 - before / 100));
    return g0 + (g1 - g0) * u;
  };
  const A = trackCar(f, 1, car(f, (t) => pB(t) + gap(t), latA, 14_000, 24_000));
  const B = trackCar(f, 2, car(f, pB, latB, 14_000, 24_000));
  return { A, B };
}

describe("track frame and apexes", () => {
  const f = buildTrackFrame(stadium());
  it("projects a point to progress and a signed lateral offset", () => {
    const q = projectToFrame(f, 250, 4);
    expect(q.s).toBeCloseTo(250, 0);
    expect(q.lat).toBeCloseTo(4, 1); // left of travel (+x heading → +y is left)
  });
  it("finds both hairpins as left-handers of about 180°", () => {
    const ap = detectApexes(f);
    expect(ap).toHaveLength(2);
    for (const a of ap) {
      expect(a.direction).toBe("left");
      expect(a.turnDeg).toBeGreaterThan(160);
      expect(a.radiusM).toBeGreaterThan(45);
      expect(a.radiusM).toBeLessThan(80);
    }
    expect(ap.map((a) => a.label)).toEqual(["T1", "T2"]);
  });
  it("reports right-handers on a clockwise circuit", () => {
    const g = buildTrackFrame(stadium(true));
    expect(detectApexes(g).every((a) => a.direction === "right")).toBe(true);
  });
});

describe("2026 inside / outside tests", () => {
  const f = buildTrackFrame(stadium());
  const t1 = detectApexes(f)[0]!;
  const judge = (g0: number, g1: number, latA: number, latB: number) => {
    const { A, B } = duel(f, t1.distance, g0, g1, latA, latB);
    return analysePair(f, [t1], A, B).find((e) => e.apex.label === "T1")!;
  };

  it("inside car level with the mirror before and at the apex is entitled to room", () => {
    const e = judge(-2, 2, 3, -3);
    expect(e.attacker).toBe(1);
    expect(e.attackerSide).toBe("inside");
    expect(e.insideCar).toBe(1);
    expect(e.rule).toBe("inside");
    expect(e.verdict).toBe("entitled");
    expect(e.firstToApex).toBe(1);
  });

  it("inside car that only reaches the mirror at the apex is not entitled (prior-to-apex test)", () => {
    const e = judge(-8, -1, 3, -3);
    expect(e.attackerSide).toBe("inside");
    expect(e.minGapPreApexM).toBeLessThan(-3);
    expect(e.verdict).toBe("not_entitled");
    expect(e.notes.join(" ")).toMatch(/only at the apex/);
  });

  it("outside car behind the defender's front axle at the apex is not entitled", () => {
    const e = judge(-6, -2.5, -3, 3);
    expect(e.attackerSide).toBe("outside");
    expect(e.insideCar).toBe(2);
    expect(e.rule).toBe("outside");
    expect(e.gapAtApexM).toBeCloseTo(-2.5, 0);
    expect(e.verdict).toBe("not_entitled");
    expect(e.firstToApex).toBe(2);
  });

  it("outside car ahead at the apex is entitled", () => {
    const e = judge(-4, 3, -3, 3);
    expect(e.attackerSide).toBe("outside");
    expect(e.verdict).toBe("entitled");
  });

  it("a margin inside the measurement band is too close to call", () => {
    const e = judge(-3, 0.3, -3, 3);
    expect(e.verdict).toBe("too_close");
    expect(e.uncertaintyM).toBeGreaterThan(0.5);
  });

  const measured = { ...DEFAULT_BATTLE_OPTIONS, lateral: "measured" as const };

  it("with measured lateral data, cars in line are not a side-by-side claim and are left out of the field scan", () => {
    const { A, B } = duel(f, t1.distance, -4, -3, 0, 0);
    const e = analysePair(f, [t1], A, B, measured)[0]!;
    expect(e.attackerSide).toBe("in_line");
    expect(e.verdict).toBe("not_alongside");
    expect(scanBattles(f, [t1], [A, B], measured)).toHaveLength(0);
  });

  it("detects positions snapped to one line and leaves the side to the user", () => {
    // both cars reported on the same line (as the official feed does), overlapping by a fraction of a car
    const { A, B } = duel(f, t1.distance, -0.2, -0.2, 0, 0);
    expect(lateralResolution([A, B]).resolved).toBe(false);
    const e = analysePair(f, [t1], A, B)[0]!;
    expect(e.sideSource).toBe("unknown");
    expect(e.attackerSide).toBe("unknown");
    expect(e.overlapped).toBe(true);
    expect(e.tests.inside.verdict).toBe("entitled"); // front axle well past the mirror
    expect(e.tests.outside.verdict).toBe("too_close"); // level with the front axle, within the band
    expect(e.verdict).toBe("side_unknown");
    const inside = withSide(e, "inside");
    expect(inside.verdict).toBe("entitled");
    expect(inside.insideCar).toBe(e.attacker);
    expect(inside.sideSource).toBe("user");
    expect(withSide(e, "outside").insideCar).toBe(e.defender);
    expect(scanBattles(f, [t1], [A, B])).toHaveLength(1);
  });

  it("reports real lateral spread as measured", () => {
    const { A, B } = duel(f, t1.distance, -2, 2, 3, -3);
    expect(lateralResolution([A, B])).toMatchObject({ resolved: true });
  });
});

describe("speed-fused smoothing", () => {
  const f = buildTrackFrame(stadium());
  // deterministic pseudo-random normal noise
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

  // Truth: a car braking hard from 85 m/s to 25 m/s (≈ −4 g) then holding speed, on the start straight.
  const truthP = (t: number) => {
    const s = t / 1000;
    if (s < 1) return 20 + 85 * s;
    if (s < 2.5) return 20 + 85 + 85 * (s - 1) - 20 * (s - 1) ** 2;
    return 20 + 85 + 85 * 1.5 - 20 * 2.25 + 25 * (s - 2.5);
  };
  const truthV = (t: number) => (t < 1000 ? 85 : t < 2500 ? 85 - 40 * (t / 1000 - 1) : 25);
  const raw = { t: [] as number[], x: [] as number[], y: [] as number[] };
  for (let t = 0; t <= 4000; t += 250) {
    const q = pointOnFrame(f, truthP(t));
    raw.t.push(t);
    raw.x.push(q.x + gauss() * 0.7);
    raw.y.push(q.y + gauss() * 0.7);
  }
  const speed = { t: [] as number[], speed: [] as number[] };
  for (let t = 120; t <= 4000; t += 250) (speed.t.push(t), speed.speed.push((truthV(t) + gauss() * 0.4) * 3.6));

  it("tracks a braking car between samples better than linear interpolation", () => {
    const linear = trackCar(f, 1, raw);
    const fused = smoothTrack(f, linear, speed);
    let eLin = 0;
    let eFus = 0;
    let n = 0;
    for (let t = 300; t <= 3700; t += 37) {
      eLin += (carAt(linear, t)!.p - truthP(t)) ** 2;
      eFus += (carAt(fused, t)!.p - truthP(t)) ** 2;
      n++;
    }
    const rmsLin = Math.sqrt(eLin / n);
    const rmsFus = Math.sqrt(eFus / n);
    expect(rmsFus).toBeLessThan(rmsLin);
    expect(rmsFus).toBeLessThan(0.45);
    // the posterior sigma is honest: same order as the actual error
    const sig = carAt(fused, 2000)!.sigmaP!;
    expect(sig).toBeGreaterThan(0.1);
    expect(sig).toBeLessThan(0.8);
  });

  it("rejects a single 'teleport' glitch", () => {
    const glitched = { t: raw.t.slice(), x: raw.x.slice(), y: raw.y.slice() };
    glitched.x[8] = glitched.x[8]! + 30; // 30 m jump along the straight at t = 2000
    const fused = smoothTrack(f, trackCar(f, 1, glitched), speed);
    expect(fused.rejected).toBeGreaterThanOrEqual(1);
    expect(Math.abs(carAt(fused, 2000)!.p - truthP(2000))).toBeLessThan(1);
  });

  it("uses the posterior sigma as the verdict uncertainty", () => {
    const t1 = detectApexes(f)[0]!;
    const { A, B } = duel(f, t1.distance, -2, 2, 3, -3);
    const sA = smoothTrack(f, A);
    const sB = smoothTrack(f, B);
    const e = analysePair(f, [t1], sA, sB)[0]!;
    expect(e.verdict).toBe("entitled");
    expect(e.uncertaintyM).toBeGreaterThanOrEqual(0.4);
    expect(e.uncertaintyM).toBeLessThan(1.2);
  });
});
