import { describe, expect, it } from "vitest";
import { buildTimeline, PlaybackClock, positionAt, timingTower, trackStatusAt, type TimingBundle } from "./index.ts";

// SYNTHETIC timing bundle (not real F1 data): 3 drivers, a pit stop, a safety car and a retirement.
const epoch = Date.parse("2026-01-01T12:00:00Z");
const iso = (s: number) => new Date(epoch + s * 1000).toISOString();
const lap = (d: number, n: number, start: number, t: number, out = false) => ({
  driverNumber: d, lapNumber: n, dateStart: iso(start), lapTime: t, sector1: t * 0.3, sector2: t * 0.4, sector3: t * 0.3,
  i1Speed: null, i2Speed: null, stSpeed: null, isPitOutLap: out, miniSectors: [],
});

const race: TimingBundle = {
  sessionId: "synthetic:r",
  sessionType: "race",
  epochMs: epoch,
  endMs: 400_000,
  drivers: [1, 2, 3].map((d) => ({ driverNumber: d, code: `D${d}`, fullName: `D${d}`, teamName: "T", teamColour: "FFFFFF" })),
  laps: [lap(1, 1, 0, 90), lap(1, 2, 90, 89), lap(1, 3, 179, 88), lap(2, 1, 0, 91), lap(2, 2, 91, 110), lap(2, 3, 201, 95, true), lap(3, 1, 0, 92), lap(3, 2, 92, 90)],
  stints: [
    { driverNumber: 2, stintNumber: 1, lapStart: 1, lapEnd: 2, compound: "MEDIUM", tyreAgeAtStart: 0 },
    { driverNumber: 2, stintNumber: 2, lapStart: 3, lapEnd: 3, compound: "HARD", tyreAgeAtStart: 0 },
  ],
  pitEvents: [{ driverNumber: 2, lapNumber: 2, date: iso(195), laneDuration: 22, stopDuration: 2.4 }],
  raceControl: [
    { date: iso(100), lapNumber: 2, category: "SafetyCar", flag: null, scope: "Track", sector: null, driverNumber: null, message: "SAFETY CAR DEPLOYED" },
    { date: iso(170), lapNumber: 2, category: "SafetyCar", flag: null, scope: "Track", sector: null, driverNumber: null, message: "SAFETY CAR IN THIS LAP" },
  ],
  weather: [{ date: iso(0), airTemperature: 25, trackTemperature: 40, humidity: 50, pressure: 1000, rainfall: false, windSpeed: 1, windDirection: 90 }],
  teamRadio: [],
  positionHistory: [
    { date: iso(0), driverNumber: 1, position: 2 },
    { date: iso(0), driverNumber: 2, position: 1 },
    { date: iso(0), driverNumber: 3, position: 3 },
    { date: iso(200), driverNumber: 1, position: 1 },
    { date: iso(200), driverNumber: 2, position: 3 },
    { date: iso(200), driverNumber: 3, position: 2 },
  ],
  intervals: [{ date: iso(200), driverNumber: 3, gapToLeader: 3.2, interval: 3.2, lapsDown: null }],
  results: [{ driverNumber: 3, position: null, laps: 2, status: "dnf", duration: null, gapToLeader: null, points: 0 }],
};

describe("timingTower", () => {
  it("uses only data at or before t", () => {
    const early = timingTower(race, 50_000);
    expect(early.map((r) => r.code)).toEqual(["D2", "D1", "D3"]);
    expect(early.every((r) => r.lastLap === null)).toBe(true);
  });

  it("tracks pit status, compound change, positions gained and retirements", () => {
    const t = timingTower(race, 205_000);
    const d2 = t.find((r) => r.driverNumber === 2)!;
    expect(d2.status).toBe("in_pit");
    expect(d2.pitStops).toBe(1);
    expect(d2.compound).toBe("HARD");
    expect(d2.positionsGained).toBe(-2);
    expect(t.find((r) => r.driverNumber === 1)!.positionsGained).toBe(1);
    expect(t.find((r) => r.driverNumber === 3)!.gapToLeader).toBe(3.2);
    expect(timingTower(race, 390_000).find((r) => r.driverNumber === 3)!.status).toBe("retired");
  });

  it("orders practice/qualifying by best lap with calculated gaps", () => {
    const q = timingTower({ ...race, sessionType: "qualifying", positionHistory: [], intervals: [] }, 400_000);
    expect(q.map((r) => r.code)).toEqual(["D1", "D3", "D2"]); // 88, 90, 91 (D2's 95 was an out-lap)
    expect(q[0]!.gapKind).toBe("calculated");
    expect(q[1]!.gapToLeader).toBeCloseTo(2, 6);
  });
});

describe("track status and timeline", () => {
  it("follows safety car deployment and withdrawal", () => {
    expect(trackStatusAt(race, 120_000).status).toBe("sc");
    expect(trackStatusAt(race, 175_000).status).toBe("green");
  });

  it("builds a sorted timeline including start, pit stop, safety car and retirement", () => {
    const tl = buildTimeline(race);
    expect(tl.map((e) => e.tMs)).toEqual([...tl.map((e) => e.tMs)].sort((a, b) => a - b));
    for (const kind of ["start", "pit_stop", "safety_car", "retirement"]) expect(tl.some((e) => e.kind === kind)).toBe(true);
  });
});

describe("positionAt", () => {
  const s = { t: [0, 250, 500, 4000], x: [0, 10, 20, 30], y: [0, 0, 0, 0], z: [0, 0, 0, 0] };
  it("labels near-sample frames measured and in-between frames interpolated", () => {
    expect(positionAt(s, 250)!.kind).toBe("measured");
    const mid = positionAt(s, 125)!;
    expect(mid.kind).toBe("interpolated");
    expect(mid.x).toBeCloseTo(5);
  });
  it("refuses to bridge gaps larger than maxGap", () => {
    expect(positionAt(s, 2000)).toBeNull();
  });
});

describe("PlaybackClock", () => {
  it("advances at the selected rate, clamps to range and steps between events", () => {
    let now = 0;
    const c = new PlaybackClock(() => now);
    c.setRange(0, 10_000);
    c.setRate(4);
    c.play();
    now = 1000;
    expect(c.now()).toBe(4000);
    now = 5000;
    expect(c.now()).toBe(10_000);
    expect(c.playing).toBe(false);
    c.stepEvent([1000, 6000], -1);
    expect(c.now()).toBe(6000);
  });
});
