/**
 * SYNTHETIC DEVELOPMENT FIXTURE — NOT REAL FORMULA 1 TELEMETRY.
 *
 * Generates physically plausible laps on a fictional 4.2 km circuit so that algorithms can be
 * tested against known ground truth (e.g. "driver B brakes 25 m earlier into corner 2").
 */
import type { CarSamples, LapTiming, PositionSamples } from "@lemon-tea/telemetry-core";
import { Rng } from "@lemon-tea/telemetry-core";

export const SYNTHETIC_SOURCE = "synthetic";

export interface CornerSpec {
  /** Distance of the speed minimum (m). */
  apex: number;
  minSpeed: number;
  /** Distance before apex where braking starts (m). */
  brakeDistance: number;
  /** Distance after apex to reach full throttle (m). */
  throttleDistance: number;
}

export const TRACK_LENGTH = 4200;
export const TOP_SPEED = 320;

export const CORNERS: CornerSpec[] = [
  { apex: 600, minSpeed: 95, brakeDistance: 140, throttleDistance: 60 },
  { apex: 1500, minSpeed: 160, brakeDistance: 110, throttleDistance: 80 },
  { apex: 2350, minSpeed: 230, brakeDistance: 70, throttleDistance: 60 },
  { apex: 3300, minSpeed: 120, brakeDistance: 130, throttleDistance: 90 },
];

export interface DriverVariant {
  /** Per-corner overrides applied on top of CORNERS. */
  corners?: Partial<CornerSpec>[];
  /** Acceleration rate multiplier out of corners. */
  accelFactor?: number;
  topSpeed?: number;
}

/** Speed (km/h), throttle, brake as a function of distance on the fictional circuit. */
export function profile(d: number, v: DriverVariant = {}) {
  const corners = CORNERS.map((c, i) => ({ ...c, ...(v.corners?.[i] ?? {}) }));
  const top = v.topSpeed ?? TOP_SPEED;
  const accel = v.accelFactor ?? 1;
  let speed = top;
  let throttle = 100;
  let brake = 0;
  for (const c of corners) {
    const bStart = c.apex - c.brakeDistance;
    if (d >= bStart && d <= c.apex) {
      const f = (d - bStart) / c.brakeDistance;
      const s = top - (top - c.minSpeed) * Math.sqrt(f);
      if (s < speed) { speed = s; throttle = 0; brake = f < 0.85 ? 1 : 0; }
    }
    if (d > c.apex) {
      const x = d - c.apex;
      const s = c.minSpeed + (top - c.minSpeed) * (1 - Math.exp((-x * accel) / 500));
      if (s < speed) {
        speed = s;
        brake = 0;
        throttle = x < c.throttleDistance ? 30 + (70 * x) / c.throttleDistance : 100;
      }
    }
  }
  return { speed, throttle, brake };
}

export interface SyntheticLap {
  timing: LapTiming;
  car: CarSamples;
  pos: PositionSamples;
}

/**
 * Integrates the profile in 1 ms steps for an exact ground-truth lap time, then samples car
 * data at ~3.7 Hz with jitter (like the public feed) and positions on an ellipse.
 */
export function syntheticLap(driverNumber: number, lapNumber: number, startMs: number, v: DriverVariant = {}, seed = 1): SyntheticLap {
  const rng = new Rng(seed);
  const car: CarSamples = { t: [], speed: [], throttle: [], brake: [], rpm: [], gear: [] };
  const pos: PositionSamples = { t: [], x: [], y: [], z: [] };
  const at = (dist: number) => profile(((dist % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH, v);
  const jitter = () => 230 + rng.next() * 60;

  let nextCar = -2400 + rng.next() * 50;
  let nextPos = -2400 + rng.next() * 50;
  const pushCar = (t: number, dist: number) => {
    const p = at(dist);
    car.t.push(startMs + t);
    car.speed.push(Math.round(p.speed)); // public feeds quantise speed to 1 km/h
    car.throttle.push(Math.round(p.throttle));
    car.brake.push(p.brake);
    car.rpm!.push(Math.round(7000 + p.speed * 35));
    car.gear!.push(Math.min(8, Math.max(2, Math.ceil(p.speed / 42))));
  };
  const pushPos = (t: number, dist: number) => {
    const th = (2 * Math.PI * dist) / TRACK_LENGTH;
    pos.t.push(startMs + t);
    pos.x.push(900 * Math.cos(th));
    pos.y.push(450 * Math.sin(th));
    pos.z.push(0);
  };
  const step = (t: number, dist: number) => {
    if (t >= nextCar) { pushCar(t, dist); nextCar += jitter(); }
    if (t >= nextPos) { pushPos(t, dist); nextPos += jitter(); }
    return dist + (at(dist).speed / 3.6) / 1000;
  };

  // Pre-roll 2.4 s before the line at top speed so interpolation at lap start is supported.
  let d = -(TOP_SPEED / 3.6) * 2.4;
  for (let t = -2400; t < 0; t++) d = step(t, d);
  d = 0;
  let tMs = 0;
  while (d < TRACK_LENGTH) d = step(tMs++, d);
  const lapTimeMs = tMs;
  for (let t = tMs; t < tMs + 2500; t++) d = step(t, d);

  return {
    timing: { driverNumber, lapNumber, startMs, lapTime: lapTimeMs / 1000, sector1: null, sector2: null, sector3: null, isPitOutLap: false },
    car,
    pos,
  };
}
