/**
 * Wheel-to-wheel corner analysis from measured car positions.
 *
 * Positions come from the official timing feed (~4 Hz, 0.1 m resolution, metre-level noise). They are
 * NOT survey-grade GPS. Every verdict therefore carries a measurement uncertainty and is reported as
 * "too close to call" when the margin is inside it.
 *
 * Rules applied (FIA 2026 Formula 1 Driving Standards Guidelines, v01, 26 Feb 2026):
 *  - INSIDE: to be given room, the overtaking car's front axle must be AT LEAST ALONGSIDE THE MIRROR of
 *    the other car PRIOR TO AND AT THE APEX.
 *  - OUTSIDE: to be given room (including at the exit), the overtaking car's front axle must be AHEAD OF
 *    THE FRONT AXLE of the other car AT THE APEX.
 *  - Chicanes and S-bends: the tests may apply to each element; priority generally to the first element.
 * The guidelines' other conditions (control, "dive-in", reasonable line, track limits) cannot be judged
 * from position data alone and are listed as caveats, never decided here.
 *
 * Both cars' positions refer to the same on-car reference point, so the difference of their progress
 * along the track equals the front-axle-to-front-axle distance.
 */

export const BATTLE_ALGORITHM_VERSION = "corner-battle-v1";

export interface TrackLine {
  x: readonly number[];
  y: readonly number[];
  distance: readonly number[];
}

/** Closed driven line with unit tangents and signed curvature (+ = turning left). */
export interface TrackFrame {
  x: number[];
  y: number[];
  s: number[];
  tx: number[];
  ty: number[];
  curvature: number[];
  length: number;
}

export interface Apex {
  number: number;
  /** "T1"…, numbered by distance from the start line. Geometric: may differ from official numbering. */
  label: string;
  distance: number;
  x: number;
  y: number;
  direction: "left" | "right";
  turnDeg: number;
  radiusM: number;
  /** Corners closer than `complexGapM` form one complex (chicane, S-bend); its first element has priority. */
  group: number;
  firstInGroup: boolean;
}

export interface ApexOptions {
  /** Curvature threshold, 1/m (default 1/350: radius under 350 m). */
  minCurvature: number;
  /** Minimum total heading change for a corner, degrees. */
  minTurnDeg: number;
  /** Curvature smoothing window, metres. */
  smoothM: number;
  /** Corners whose curved sections are closer than this form one complex. */
  complexGapM: number;
}

export const DEFAULT_APEX_OPTIONS: ApexOptions = { minCurvature: 1 / 350, minTurnDeg: 18, smoothM: 30, complexGapM: 90 };

export interface BattleOptions {
  /** Front axle to mirror, metres (2026 cars: ~1.7 m). */
  mirrorOffsetM: number;
  carLengthM: number;
  carWidthM: number;
  /** 1-sigma position noise per car, metres. */
  positionNoiseM: number;
  /** "Prior to the apex" window: from this far before the apex up to it, metres. */
  preApexM: number;
  /** Where the attacker is decided (the car behind here attacks), metres before the apex. */
  approachM: number;
  /** Encounters are only reported when the cars come within this distance of each other around the apex. */
  engageM: number;
  /** Samples further apart than this are a data gap, ms. */
  maxGapMs: number;
  /** Lateral offset beyond which a car is treated as off the driven line (pit lane, run-off), metres. */
  offLineM: number;
  /** Whether lateral offsets are real measurements; "auto" checks the cars' spread (see lateralResolution). */
  lateral: "auto" | "measured" | "snapped";
}

export const DEFAULT_BATTLE_OPTIONS: BattleOptions = {
  mirrorOffsetM: 1.7,
  carLengthM: 5.4,
  carWidthM: 1.9,
  positionNoiseM: 0.7,
  preApexM: 40,
  approachM: 100,
  engageM: 12,
  maxGapMs: 1500,
  offLineM: 30,
  lateral: "auto",
};

/**
 * Do the positions carry real lateral information? Cars spread across a 12–15 m wide track, so true
 * positions give a 90th-percentile |offset| of several metres from any one driven line. A feed that
 * snaps every car to a reference line gives a few tenths. Off-line samples (pit lane) are ignored.
 */
export function lateralResolution(cars: readonly CarTrack[], offLineM = DEFAULT_BATTLE_OPTIONS.offLineM): { resolved: boolean; p90: number; samples: number } {
  const v: number[] = [];
  for (const c of cars) for (const l of c.lat) if (Number.isFinite(l) && Math.abs(l) < offLineM) v.push(Math.abs(l));
  if (v.length < 50) return { resolved: false, p90: Number.NaN, samples: v.length };
  v.sort((a, b) => a - b);
  const p90 = v[Math.floor(0.9 * (v.length - 1))]!;
  return { resolved: p90 >= 1.0, p90: Math.round(p90 * 100) / 100, samples: v.length };
}

/** Apply a side (measured or user-chosen) to an encounter: picks the applicable FIA test. */
export function withSide(e: Encounter, side: Side, source: "measured" | "user" = "user", mirrorOffsetM = DEFAULT_BATTLE_OPTIONS.mirrorOffsetM): Encounter {
  const t = e.tests[side];
  return {
    ...e,
    attackerSide: side,
    sideSource: source,
    insideCar: side === "inside" ? e.attacker : e.defender,
    rule: side,
    requiredGapM: side === "inside" ? -mirrorOffsetM : 0,
    marginM: t.marginM,
    verdict: t.verdict,
  };
}

export interface CarTrack {
  driverNumber: number;
  t: number[];
  x: number[];
  y: number[];
  /** Unwrapped progress along the driven line, metres (laps accumulate). */
  p: number[];
  /** Signed lateral offset from the driven line, metres (+ = left of travel direction). */
  lat: number[];
  /** Posterior 1-sigma of p and lat (set by `smoothTrack`; NaN p marks an unusable grid point). */
  sigmaP?: number[];
  sigmaLat?: number[];
  /** The measured samples behind a smoothed track (projected, origin-shifted). */
  raw?: { t: number[]; x: number[]; y: number[] };
}

export type Verdict = "entitled" | "not_entitled" | "too_close" | "not_alongside" | "side_unknown";
export type Side = "inside" | "outside";

/** One FIA test evaluated on the measured along-track gap. */
export interface SideTest {
  marginM: number;
  verdict: Exclude<Verdict, "side_unknown">;
}

export interface Encounter {
  apex: Apex;
  attacker: number;
  defender: number;
  /** Session ms when each car's reference point crossed the apex. */
  apexTime: Record<number, number>;
  firstToApex: number;
  /** How much earlier the first car reached the apex, seconds. */
  firstToApexByS: number;
  /** The attacker's side; "in_line" when measured but never side by side; "unknown" when the feed has no lateral information. */
  attackerSide: Side | "in_line" | "unknown";
  /** Where the side came from: measured lateral offsets, set by the user (e.g. from video), or not known. */
  sideSource: "measured" | "user" | "unknown";
  /** The cars overlapped (front-to-back gap under a car length) on the way into or at the apex. */
  overlapped: boolean;
  /** Both FIA tests on the measured gaps; the applicable one depends on the attacker's side. */
  tests: Record<Side, SideTest>;
  insideCar: number | null;
  /** Attacker front axle minus defender front axle along the track at the apex, metres (+ = attacker ahead). */
  gapAtApexM: number;
  /** Least favourable gap for the attacker over the pre-apex window, metres. */
  minGapPreApexM: number;
  /** Gap where the attacker is decided (approachM before the apex). */
  gapAtApproachM: number;
  /** Centre-to-centre lateral separation at the apex, metres. */
  lateralSepM: number;
  /** Rule applied and its required gap: inside ≥ −mirror offset (prior to and at apex); outside > 0 at apex. */
  rule: "inside" | "outside" | null;
  requiredGapM: number | null;
  /** Gap minus requirement at the binding point; + = satisfied. */
  marginM: number | null;
  uncertaintyM: number;
  verdict: Verdict;
  /** Largest sample spacing of either car around the apex, ms. */
  sampleSpacingMs: number;
  notes: string[];
}

export const BATTLE_CAVEATS = [
  "The timing feed measures how far along the track each car is (~4 Hz, about a metre). In sessions checked so far it places every car on one reference line, so it does not show which side a car is on: inside/outside then has to be set by you, e.g. from video.",
  "With fusion on, each car's positions are combined with its measured speed in a Kalman/RTS smoother; the stated uncertainty is the smoother's own estimate (floored at 0.4 m for model error).",
  "Apexes are geometric (peak curvature of the field's driven line) and numbered from the start line; the FIA notes the apex may vary with the line taken.",
  "Control, 'dive-in', a reasonable racing line and track limits are part of the guidelines but cannot be judged from positions alone.",
  "Track edges are not mapped, so whether a car was forced off cannot be measured; lateral offsets are relative to the field's driven line.",
];

// ---------------------------------------------------------------------------------------------- frame

function circularSmooth(v: number[], half: number): number[] {
  const n = v.length;
  const out = new Array<number>(n);
  let sum = 0;
  for (let k = -half; k <= half; k++) sum += v[(((k % n) + n) % n)]!;
  for (let i = 0; i < n; i++) {
    out[i] = sum / (2 * half + 1);
    sum += v[(i + half + 1) % n]! - v[(((i - half) % n) + n) % n]!;
  }
  return out;
}

export function buildTrackFrame(line: TrackLine, smoothM = DEFAULT_APEX_OPTIONS.smoothM): TrackFrame {
  let n = line.x.length;
  // drop a duplicated closing vertex
  if (n > 2 && Math.hypot(line.x[0]! - line.x[n - 1]!, line.y[0]! - line.y[n - 1]!) < 0.5) n--;
  const x = line.x.slice(0, n) as number[];
  const y = line.y.slice(0, n) as number[];
  const s = new Array<number>(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, y[i]! - y[i - 1]!);
  const length = s[n - 1]! + Math.hypot(x[0]! - x[n - 1]!, y[0]! - y[n - 1]!);
  const step = length / n;
  const tx = new Array<number>(n);
  const ty = new Array<number>(n);
  const heading = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const dx = x[(i + 1) % n]! - x[(i - 1 + n) % n]!;
    const dy = y[(i + 1) % n]! - y[(i - 1 + n) % n]!;
    const m = Math.hypot(dx, dy) || 1;
    tx[i] = dx / m;
    ty[i] = dy / m;
    heading[i] = Math.atan2(dy, dx);
  }
  const raw = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let dh = heading[(i + 1) % n]! - heading[(i - 1 + n) % n]!;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    raw[i] = dh / (2 * step);
  }
  const curvature = circularSmooth(raw, Math.max(1, Math.round(smoothM / step / 2)));
  return { x, y, s, tx, ty, curvature, length };
}

/** Project a point onto the driven line. `hint` (a vertex index) limits the search for speed. */
export function projectToFrame(f: TrackFrame, px: number, py: number, hint = -1): { s: number; lat: number; idx: number } {
  const n = f.x.length;
  let best = 0;
  let bd = Infinity;
  const scan = (from: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const i = (((from + k) % n) + n) % n;
      const d = (f.x[i]! - px) ** 2 + (f.y[i]! - py) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  };
  if (hint >= 0) scan(hint - 40, 120);
  if (hint < 0 || bd > 60 * 60) scan(0, n);
  // refine on the two segments adjacent to the nearest vertex
  let bestS = f.s[best]!;
  let bestLat = 0;
  let bestD = Infinity;
  for (const a of [(best - 1 + n) % n, best]) {
    const b = (a + 1) % n;
    const ax = f.x[a]!;
    const ay = f.y[a]!;
    const sx = f.x[b]! - ax;
    const sy = f.y[b]! - ay;
    const L2 = sx * sx + sy * sy || 1;
    const u = Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / L2));
    const d = (px - (ax + sx * u)) ** 2 + (py - (ay + sy * u)) ** 2;
    if (d < bestD) {
      bestD = d;
      const segLen = Math.sqrt(L2);
      bestS = (f.s[a]! + u * segLen) % f.length;
      bestLat = (sx * (py - ay) - sy * (px - ax)) / segLen; // cross(tangent, p − a): + = left
    }
  }
  return { s: bestS, lat: bestLat, idx: best };
}

/** Point and tangent on the driven line at lap distance d (wraps). */
export function pointOnFrame(f: TrackFrame, d: number): { x: number; y: number; tx: number; ty: number } {
  const L = f.length;
  const s = ((d % L) + L) % L;
  let lo = 0;
  let hi = f.s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f.s[mid]! <= s) lo = mid;
    else hi = mid - 1;
  }
  const b = (lo + 1) % f.s.length;
  const sb = b === 0 ? L : f.s[b]!;
  const u = sb > f.s[lo]! ? (s - f.s[lo]!) / (sb - f.s[lo]!) : 0;
  return { x: f.x[lo]! + (f.x[b]! - f.x[lo]!) * u, y: f.y[lo]! + (f.y[b]! - f.y[lo]!) * u, tx: f.tx[lo]!, ty: f.ty[lo]! };
}

// ---------------------------------------------------------------------------------------------- apexes

/**
 * Corners as runs of same-sign curvature above a threshold; the apex is the curvature peak of the run
 * (on a racing line the tightest point sits at the apex).
 */
export function detectApexes(f: TrackFrame, o: ApexOptions = DEFAULT_APEX_OPTIONS): Apex[] {
  const n = f.x.length;
  const k = f.curvature;
  // start on the straightest vertex so no corner is split across the array end
  let start = 0;
  for (let i = 1; i < n; i++) if (Math.abs(k[i]!) < Math.abs(k[start]!)) start = i;
  const runs: { from: number; to: number; sign: number }[] = [];
  let cur: { from: number; to: number; sign: number } | null = null;
  for (let j = 0; j <= n; j++) {
    const c = k[(start + j) % n]!;
    const sign = j < n && Math.abs(c) >= o.minCurvature ? Math.sign(c) : 0;
    if (cur && sign === cur.sign) cur.to = j;
    else {
      if (cur) runs.push(cur);
      cur = sign ? { from: j, to: j, sign } : null;
    }
  }
  const step = f.length / n;
  const raw: (Apex & { fromJ: number; toJ: number })[] = [];
  for (const r of runs) {
    let turn = 0;
    let peak = r.from;
    for (let j = r.from; j <= r.to; j++) {
      const i = (start + j) % n;
      turn += k[i]! * step;
      if (Math.abs(k[i]!) > Math.abs(k[(start + peak) % n]!)) peak = j;
    }
    const turnDeg = Math.abs((turn * 180) / Math.PI);
    if (turnDeg < o.minTurnDeg) continue;
    const i = (start + peak) % n;
    raw.push({
      number: 0,
      label: "",
      distance: f.s[i]!,
      x: f.x[i]!,
      y: f.y[i]!,
      direction: r.sign > 0 ? "left" : "right",
      turnDeg: Math.round(turnDeg),
      radiusM: Math.round(1 / Math.abs(k[i]!)),
      group: 0,
      firstInGroup: true,
      fromJ: r.from,
      toJ: r.to,
    });
  }
  // complexes: consecutive curved runs (in driving order) separated by less than complexGapM
  let group = 0;
  for (let j = 0; j < raw.length; j++) {
    if (j > 0 && (raw[j]!.fromJ - raw[j - 1]!.toJ) * step < o.complexGapM) {
      raw[j]!.group = raw[j - 1]!.group;
      raw[j]!.firstInGroup = false;
    } else raw[j]!.group = ++group;
  }
  const out: Apex[] = raw.map(({ fromJ: _a, toJ: _b, ...a }) => a).sort((a, b) => a.distance - b.distance);
  out.forEach((a, i) => {
    a.number = i + 1;
    a.label = `T${i + 1}`;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------- cars

/** Project a car's samples onto the line: unwrapped progress and lateral offset per sample. */
export function trackCar(
  f: TrackFrame,
  driverNumber: number,
  samples: { t: readonly number[]; x: readonly number[]; y: readonly number[] },
  offset: { x: number; y: number } = { x: 0, y: 0 },
): CarTrack {
  const out: CarTrack = { driverNumber, t: [], x: [], y: [], p: [], lat: [] };
  const L = f.length;
  let hint = -1;
  let prevS = 0;
  let progress = 0;
  for (let i = 0; i < samples.t.length; i++) {
    const x = samples.x[i]! - offset.x;
    const y = samples.y[i]! - offset.y;
    const pr = projectToFrame(f, x, y, hint);
    hint = pr.idx;
    if (out.t.length === 0) progress = pr.s;
    else {
      let ds = pr.s - prevS;
      if (ds < -L / 2) ds += L;
      else if (ds > L / 2) ds -= L;
      progress += ds;
    }
    prevS = pr.s;
    out.t.push(samples.t[i]!);
    out.x.push(x);
    out.y.push(y);
    out.p.push(progress);
    out.lat.push(pr.lat);
  }
  return out;
}

function bisect(t: readonly number[], v: number): number {
  if (!t.length || v < t[0]!) return -1;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Interpolated state of a car at session time t, or null across a data gap or outside its samples. */
export interface CarState {
  p: number;
  lat: number;
  x: number;
  y: number;
  /** Spacing of the measured samples around t, ms. */
  spacingMs: number;
  /** 1-sigma of p: posterior when smoothed, else the raw position noise is assumed by callers. */
  sigmaP: number | null;
}

/** Spacing of the measured samples bracketing t, ms. */
function rawSpacing(c: CarTrack, t: number): number {
  const r = c.raw ?? c;
  const i = bisect(r.t, t);
  if (i < 0 || i >= r.t.length - 1) return 0;
  return r.t[i + 1]! - r.t[i]!;
}

export function carAt(c: CarTrack, t: number, maxGapMs = DEFAULT_BATTLE_OPTIONS.maxGapMs): CarState | null {
  const n = c.t.length;
  const i = bisect(c.t, t);
  if (i < 0 || i >= n - 1) {
    const j = i < 0 ? 0 : n - 1;
    if (!n || Math.abs(c.t[j]! - t) > 60 || !Number.isFinite(c.p[j]!)) return null;
    return { p: c.p[j]!, lat: c.lat[j]!, x: c.x[j]!, y: c.y[j]!, spacingMs: rawSpacing(c, t), sigmaP: c.sigmaP?.[j] ?? null };
  }
  const dt = c.t[i + 1]! - c.t[i]!;
  if (dt > maxGapMs || !Number.isFinite(c.p[i]!) || !Number.isFinite(c.p[i + 1]!)) return null;
  const u = dt ? (t - c.t[i]!) / dt : 0;
  const lerp = (a: number[]) => a[i]! + (a[i + 1]! - a[i]!) * u;
  return { p: lerp(c.p), lat: lerp(c.lat), x: lerp(c.x), y: lerp(c.y), spacingMs: c.raw ? rawSpacing(c, t) : dt, sigmaP: c.sigmaP ? lerp(c.sigmaP) : null };
}

/** Times at which the car crossed lap distance d (interpolated), with the spacing of the bracketing samples. */
export function crossings(c: CarTrack, d: number, L: number, maxGapMs = DEFAULT_BATTLE_OPTIONS.maxGapMs): { t: number; spacingMs: number }[] {
  const out: { t: number; spacingMs: number }[] = [];
  for (let i = 0; i + 1 < c.t.length; i++) {
    const a = c.p[i]!;
    const b = c.p[i + 1]!;
    if (!(b > a) || c.t[i + 1]! - c.t[i]! > maxGapMs) continue; // also skips NaN (unusable) points
    const target = d + Math.ceil((a - d) / L) * L;
    if (target >= a && target < b) {
      const t = c.t[i]! + ((target - a) / (b - a)) * (c.t[i + 1]! - c.t[i]!);
      out.push({ t, spacingMs: c.raw ? rawSpacing(c, t) : c.t[i + 1]! - c.t[i]! });
    }
  }
  return out;
}

/** a − b along the track, wrapped to ±L/2 (cars in a battle are always close). */
export function wrappedGap(pa: number, pb: number, L: number): number {
  let g = (pa - pb) % L;
  if (g > L / 2) g -= L;
  if (g < -L / 2) g += L;
  return g;
}

// ---------------------------------------------------------------------------------------------- battles

function crossingNear(c: CarTrack, d: number, L: number, near: number, maxGapMs: number): number | null {
  let best: number | null = null;
  for (const x of crossings(c, d, L, maxGapMs)) if (best === null || Math.abs(x.t - near) < Math.abs(best - near)) best = x.t;
  return best !== null && Math.abs(best - near) < 8000 ? best : null;
}

/** Gap A−B and both lateral offsets when the cars' midpoint is `before` metres ahead of the apex. */
function stateBefore(A: CarTrack, B: CarTrack, d: number, L: number, ta0: number, tb0: number, maxGapMs: number) {
  const ta = crossingNear(A, d, L, ta0, maxGapMs);
  const tb = crossingNear(B, d, L, tb0, maxGapMs);
  if (ta === null || tb === null) return null;
  const t = (ta + tb) / 2;
  const a = carAt(A, t, maxGapMs);
  const b = carAt(B, t, maxGapMs);
  if (!a || !b) return null;
  const sigma = a.sigmaP !== null && b.sigmaP !== null ? Math.hypot(a.sigmaP, b.sigmaP) : null;
  return { t, g: wrappedGap(a.p, b.p, L), latA: a.lat, latB: b.lat, spacingMs: Math.max(a.spacingMs, b.spacingMs), sigma };
}

/** Every corner where A and B arrive together, judged against the 2026 inside/outside tests. */
export function analysePair(f: TrackFrame, apexes: readonly Apex[], A: CarTrack, B: CarTrack, o: BattleOptions = DEFAULT_BATTLE_OPTIONS): Encounter[] {
  const L = f.length;
  const out: Encounter[] = [];
  const baseU = Math.SQRT2 * o.positionNoiseM; // difference of two independent noisy positions
  const lateralMeasured = o.lateral === "measured" || (o.lateral === "auto" && lateralResolution([A, B], o.offLineM).resolved);
  for (const apex of apexes) {
    const bx = crossings(B, apex.distance, L, o.maxGapMs);
    for (const ax of crossings(A, apex.distance, L, o.maxGapMs)) {
      let bm: { t: number; spacingMs: number } | null = null;
      for (const c of bx) if (!bm || Math.abs(c.t - ax.t) < Math.abs(bm.t - ax.t)) bm = c;
      if (!bm || Math.abs(bm.t - ax.t) > 3000) continue;
      // "at the apex": the moment the cars' midpoint passes it
      const at = stateBefore(A, B, apex.distance, L, ax.t, bm.t, o.maxGapMs);
      if (!at || Math.abs(at.latA) > o.offLineM || Math.abs(at.latB) > o.offLineM) continue;
      const pre: NonNullable<typeof at>[] = [];
      for (let d = o.preApexM; d > 0; d -= 5) {
        const e = stateBefore(A, B, apex.distance - d, L, ax.t, bm.t, o.maxGapMs);
        if (e) pre.push(e);
      }
      pre.push(at);
      if (Math.min(...pre.map((e) => Math.abs(e.g))) > o.engageM) continue;
      const approach = stateBefore(A, B, apex.distance - o.approachM, L, ax.t, bm.t, o.maxGapMs);

      // the attacker is the car behind on the approach (fallback: behind at the apex)
      const gRef = approach && Math.abs(approach.g) > 0.5 ? approach.g : at.g;
      const attackerIsA = gRef < 0;
      const attacker = attackerIsA ? A.driverNumber : B.driverNumber;
      const defender = attackerIsA ? B.driverNumber : A.driverNumber;
      const sgn = attackerIsA ? 1 : -1;
      const gapAtApexM = sgn * at.g;
      const minGapPreApexM = Math.min(...pre.map((e) => sgn * e.g));
      const gapAtApproachM = approach ? sgn * approach.g : gapAtApexM;

      const overlapped = pre.some((e) => Math.abs(e.g) < o.carLengthM);
      const sampleSpacingMs = Math.max(ax.spacingMs, bm.spacingMs, ...pre.map((e) => e.spacingMs));
      // Smoothed tracks carry their own posterior sigma (worst point of the window, floored for model
      // error such as the reference-point assumption). Raw tracks: per-car noise, widened when sparser than 4 Hz.
      const post = pre.map((e) => e.sigma).filter((v): v is number => v !== null);
      const uncertaintyM =
        post.length === pre.length ? round1(Math.max(MODEL_FLOOR_M, ...post)) : round1(baseU * Math.max(1, sampleSpacingMs / 250));
      const judge = (margin: number): SideTest["verdict"] =>
        !overlapped && margin <= uncertaintyM ? "not_alongside" : margin > uncertaintyM ? "entitled" : margin < -uncertaintyM ? "not_entitled" : "too_close";
      const tests: Record<Side, SideTest> = {
        inside: { marginM: round1(minGapPreApexM + o.mirrorOffsetM), verdict: judge(minGapPreApexM + o.mirrorOffsetM) },
        outside: { marginM: round1(gapAtApexM), verdict: judge(gapAtApexM) },
      };

      const notes: string[] = [];
      let attackerSide: Encounter["attackerSide"] = "unknown";
      let sideSource: Encounter["sideSource"] = "unknown";
      let verdict: Verdict = tests.inside.verdict === tests.outside.verdict ? tests.inside.verdict : "side_unknown";
      if (lateralMeasured) {
        // side: the attacker's mean lateral offset relative to the defender, towards the corner's inside
        const turn = apex.direction === "left" ? 1 : -1;
        const rel = pre.map((e) => (attackerIsA ? e.latA - e.latB : e.latB - e.latA) * turn);
        const relMean = rel.reduce((s, v) => s + v, 0) / rel.length;
        const sideBySide = Math.max(...pre.map((e) => Math.abs(e.latA - e.latB))) >= o.carWidthM * 0.8;
        sideSource = "measured";
        if (!sideBySide) {
          attackerSide = "in_line";
          verdict = "not_alongside";
          notes.push("Cars were in line (lateral separation under a car width): no side-by-side claim.");
        } else {
          attackerSide = relMean > 0 ? "inside" : "outside";
          verdict = tests[attackerSide].verdict;
        }
      } else if (verdict === "side_unknown") notes.push("The verdict depends on the side; the feed does not measure it. Set who was on the inside.");
      if (!overlapped) notes.push("Never overlapped: the attacker stayed more than a car length behind.");
      if (!apex.firstInGroup) notes.push("Later element of a complex: priority generally goes to the first element.");
      if (apex.turnDeg < 35 && apex.radiusM > 150) notes.push("Long-radius or shallow corner: stewards judge such cases on their merits.");
      if (gapAtApexM > -o.mirrorOffsetM && minGapPreApexM < -o.mirrorOffsetM && attackerSide !== "outside" && attackerSide !== "in_line")
        notes.push(`Alongside the mirror only at the apex, not before it (worst ${minGapPreApexM.toFixed(1)} m): fails the inside test.`);
      const side = attackerSide === "inside" || attackerSide === "outside" ? attackerSide : null;
      const insideCar = side === null ? null : side === "inside" ? attacker : defender;
      const rule: Encounter["rule"] = side;
      const requiredGapM = side === "inside" ? -o.mirrorOffsetM : side === "outside" ? 0 : null;
      const marginM = side ? tests[side].marginM : null;

      out.push({
        apex,
        attacker,
        defender,
        apexTime: { [A.driverNumber]: ax.t, [B.driverNumber]: bm.t },
        firstToApex: ax.t <= bm.t ? A.driverNumber : B.driverNumber,
        firstToApexByS: Math.round(Math.abs(ax.t - bm.t)) / 1000,
        attackerSide,
        sideSource,
        overlapped,
        tests,
        insideCar,
        gapAtApexM: round1(gapAtApexM),
        minGapPreApexM: round1(minGapPreApexM),
        gapAtApproachM: round1(gapAtApproachM),
        lateralSepM: round1(Math.abs(at.latA - at.latB)),
        rule,
        requiredGapM,
        marginM,
        uncertaintyM,
        verdict,
        sampleSpacingMs: Math.round(sampleSpacingMs),
        notes,
      });
    }
  }
  return out.sort((x, y) => firstTime(x) - firstTime(y));
}

/** Every pair of cars, keeping only real fights: overlapping and not ruled out as in line. */
export function scanBattles(f: TrackFrame, apexes: readonly Apex[], cars: readonly CarTrack[], o: BattleOptions = DEFAULT_BATTLE_OPTIONS): Encounter[] {
  const out: Encounter[] = [];
  const opt: BattleOptions = o.lateral === "auto" ? { ...o, lateral: lateralResolution(cars, o.offLineM).resolved ? "measured" : "snapped" } : o;
  for (let i = 0; i < cars.length; i++)
    for (let j = i + 1; j < cars.length; j++) for (const e of analysePair(f, apexes, cars[i]!, cars[j]!, opt)) if (e.overlapped && e.verdict !== "not_alongside") out.push(e);
  return out.sort((x, y) => firstTime(x) - firstTime(y));
}

/** Floor on the gap uncertainty of smoothed tracks: reference-point and line-projection model error. */
const MODEL_FLOOR_M = 0.4;

// ---------------------------------------------------------------------------------------------- fusion

export interface SmoothOptions {
  /** Output grid spacing, ms. */
  gridMs: number;
  /** Process noise: 1-sigma longitudinal acceleration, m/s² (F1 braking reaches ~50). */
  accelSigma: number;
  /** Process noise for the lateral offset, m/s². */
  latAccelSigma: number;
  /** 1-sigma of the measured car speed, m/s. */
  speedSigma: number;
  /** Position fixes further than this many sigma from the prediction are rejected (glitches, "teleports"). */
  gateSigma: number;
  /** Grid points whose posterior sigma exceeds this are marked unusable, metres. */
  maxSigmaM: number;
  positionNoiseM: number;
}

export const DEFAULT_SMOOTH_OPTIONS: SmoothOptions = { gridMs: 100, accelSigma: 30, latAccelSigma: 4, speedSigma: 0.6, gateSigma: 4, maxSigmaM: 3, positionNoiseM: 0.7 };

interface Meas {
  t: number;
  /** 0 = level (position), 1 = rate (velocity). */
  kind: 0 | 1;
  z: number;
  r: number;
}

/**
 * Two-state (level, rate) Kalman filter with a white-acceleration model, followed by a
 * Rauch–Tung–Striebel smoother. Measurements are applied at their exact timestamps; the result is
 * read out on `grid`. The smoothed level is the classic cubic smoothing spline, so this also covers
 * spline interpolation. Level fixes failing the innovation gate are rejected, unless three in a row
 * fail (then the track has genuinely moved, e.g. after a gap, and the fix is accepted).
 */
function kalmanRts(meas: Meas[], grid: number[], q: number, gate: number): { level: number[]; rate: number[]; sigma: number[]; rejected: number } {
  type Node = { t: number; m: Meas[]; out: number };
  const nodes: Node[] = [];
  const byT = new Map<number, Node>();
  const node = (t: number) => {
    let n = byT.get(t);
    if (!n) byT.set(t, (n = { t, m: [], out: -1 }));
    return n;
  };
  for (const m of meas) node(m.t).m.push(m);
  grid.forEach((t, i) => (node(t).out = i));
  nodes.push(...byT.values());
  nodes.sort((a, b) => a.t - b.t);
  const N = nodes.length;
  const first = meas.find((m) => m.kind === 0);
  const firstRate = meas.find((m) => m.kind === 1);
  // filtered and predicted state/covariance per node: x = [a, b], P = [[p00, p01], [p01, p11]]
  const fx = new Float64Array(N * 2);
  const fP = new Float64Array(N * 3);
  const px = new Float64Array(N * 2);
  const pP = new Float64Array(N * 3);
  let x0 = first?.z ?? 0;
  let x1 = firstRate?.z ?? 0;
  let p00 = first ? first.r : 1e6;
  let p01 = 0;
  let p11 = firstRate ? firstRate.r : 100 * 100;
  let run = 0;
  let rejected = 0;
  for (let k = 0; k < N; k++) {
    if (k > 0) {
      const dt = (nodes[k]!.t - nodes[k - 1]!.t) / 1000;
      x0 += x1 * dt;
      const n00 = p00 + 2 * dt * p01 + dt * dt * p11 + (q * dt ** 3) / 3;
      const n01 = p01 + dt * p11 + (q * dt * dt) / 2;
      const n11 = p11 + q * dt;
      p00 = n00;
      p01 = n01;
      p11 = n11;
    }
    px[2 * k] = x0;
    px[2 * k + 1] = x1;
    pP[3 * k] = p00;
    pP[3 * k + 1] = p01;
    pP[3 * k + 2] = p11;
    for (const m of nodes[k]!.m) {
      const y = m.z - (m.kind === 0 ? x0 : x1);
      const S = (m.kind === 0 ? p00 : p11) + m.r;
      if (m.kind === 0 && k > 0 && (y * y) / S > gate * gate && run < 3) {
        run++;
        rejected++;
        continue;
      }
      if (m.kind === 0) run = 0;
      const k0 = (m.kind === 0 ? p00 : p01) / S;
      const k1 = (m.kind === 0 ? p01 : p11) / S;
      x0 += k0 * y;
      x1 += k1 * y;
      const h0 = m.kind === 0 ? p00 : p01; // H P (row)
      const h1 = m.kind === 0 ? p01 : p11;
      p00 -= k0 * h0;
      p01 -= k0 * h1;
      p11 -= k1 * h1;
    }
    fx[2 * k] = x0;
    fx[2 * k + 1] = x1;
    fP[3 * k] = p00;
    fP[3 * k + 1] = p01;
    fP[3 * k + 2] = p11;
  }
  // RTS backward pass (in place on the filtered arrays)
  for (let k = N - 2; k >= 0; k--) {
    const dt = (nodes[k + 1]!.t - nodes[k]!.t) / 1000;
    const a00 = fP[3 * k]!;
    const a01 = fP[3 * k + 1]!;
    const a11 = fP[3 * k + 2]!;
    // P_f F^T
    const b00 = a00 + dt * a01;
    const b01 = a01;
    const b10 = a01 + dt * a11;
    const b11 = a11;
    const q00 = pP[3 * (k + 1)]!;
    const q01 = pP[3 * (k + 1) + 1]!;
    const q11 = pP[3 * (k + 1) + 2]!;
    const det = q00 * q11 - q01 * q01 || 1e-12;
    const i00 = q11 / det;
    const i01 = -q01 / det;
    const i11 = q00 / det;
    // C = P_f F^T Pp^-1
    const c00 = b00 * i00 + b01 * i01;
    const c01 = b00 * i01 + b01 * i11;
    const c10 = b10 * i00 + b11 * i01;
    const c11 = b10 * i01 + b11 * i11;
    const d0 = fx[2 * (k + 1)]! - px[2 * (k + 1)]!;
    const d1 = fx[2 * (k + 1) + 1]! - px[2 * (k + 1) + 1]!;
    fx[2 * k] = fx[2 * k]! + c00 * d0 + c01 * d1;
    fx[2 * k + 1] = fx[2 * k + 1]! + c10 * d0 + c11 * d1;
    // P_s = P_f + C (P_s' − P_p') C^T
    const e00 = fP[3 * (k + 1)]! - q00;
    const e01 = fP[3 * (k + 1) + 1]! - q01;
    const e11 = fP[3 * (k + 1) + 2]! - q11;
    const g00 = c00 * e00 + c01 * e01;
    const g01 = c00 * e01 + c01 * e11;
    const g10 = c10 * e00 + c11 * e01;
    const g11 = c10 * e01 + c11 * e11;
    fP[3 * k] = a00 + g00 * c00 + g01 * c01;
    fP[3 * k + 1] = a01 + g00 * c10 + g01 * c11;
    fP[3 * k + 2] = a11 + g10 * c10 + g11 * c11;
  }
  const level = new Array<number>(grid.length);
  const rate = new Array<number>(grid.length);
  const sigma = new Array<number>(grid.length);
  for (let k = 0; k < N; k++) {
    const o = nodes[k]!.out;
    if (o < 0) continue;
    level[o] = fx[2 * k]!;
    rate[o] = fx[2 * k + 1]!;
    sigma[o] = Math.sqrt(Math.max(0, fP[3 * k]!));
  }
  return { level, rate, sigma, rejected };
}

function interpAt(t: readonly number[], v: readonly number[], at: number): number {
  const i = bisect(t, at);
  if (i < 0) return v[0]!;
  if (i >= t.length - 1) return v[t.length - 1]!;
  const u = (at - t[i]!) / (t[i + 1]! - t[i]! || 1);
  return v[i]! + (v[i + 1]! - v[i]!) * u;
}

/**
 * Fuse a car's position fixes with its measured speed (when given) into a smooth track on a uniform
 * time grid, with a posterior sigma per point. Speed is converted to progress rate along the driven
 * line, correcting for the car's lateral offset in curves (a car on the inside covers less distance).
 */
export function smoothTrack(
  f: TrackFrame,
  car: CarTrack,
  speed?: { t: readonly number[]; speed: readonly number[] } | null,
  o: SmoothOptions = DEFAULT_SMOOTH_OPTIONS,
): CarTrack & { rejected: number } {
  const n = car.t.length;
  if (n < 2) return { ...car, rejected: 0 };
  const t0 = car.t[0]!;
  const t1 = car.t[n - 1]!;
  const grid: number[] = [];
  for (let t = Math.ceil(t0 / o.gridMs) * o.gridMs; t <= t1; t += o.gridMs) grid.push(t);
  const R = o.positionNoiseM ** 2;

  const lat = kalmanRts(
    car.t.map((t, i) => ({ t, kind: 0 as const, z: car.lat[i]!, r: R })),
    grid,
    o.latAccelSigma ** 2,
    o.gateSigma,
  );

  const meas: Meas[] = car.t.map((t, i) => ({ t, kind: 0 as const, z: car.p[i]!, r: R }));
  if (speed)
    for (let i = 0; i < speed.t.length; i++) {
      const t = speed.t[i]!;
      if (t < t0 || t > t1 || !Number.isFinite(speed.speed[i]!)) continue;
      const s = interpAt(car.t, car.p, t);
      const kappa = f.curvature[Math.min(f.x.length - 1, Math.max(0, Math.round(((((s % f.length) + f.length) % f.length) / f.length) * f.x.length)))]!;
      const l = interpAt(grid, lat.level, t);
      const scale = Math.min(1.3, Math.max(0.7, 1 - kappa * l)); // path length per metre of driven line
      meas.push({ t, kind: 1, z: speed.speed[i]! / 3.6 / scale, r: o.speedSigma ** 2 });
    }
  const lon = kalmanRts(meas, grid, o.accelSigma ** 2, o.gateSigma);

  const out: CarTrack & { rejected: number } = {
    driverNumber: car.driverNumber,
    t: grid,
    x: [],
    y: [],
    p: [],
    lat: lat.level,
    sigmaP: lon.sigma,
    sigmaLat: lat.sigma,
    raw: { t: car.t, x: car.x, y: car.y },
    rejected: lon.rejected,
  };
  for (let i = 0; i < grid.length; i++) {
    const ok = lon.sigma[i]! <= o.maxSigmaM;
    const p = lon.level[i]!;
    const q = pointOnFrame(f, p);
    out.p.push(ok ? p : Number.NaN);
    out.x.push(q.x - q.ty * lat.level[i]!);
    out.y.push(q.y + q.tx * lat.level[i]!);
  }
  return out;
}

const firstTime = (e: Encounter) => Math.min(...Object.values(e.apexTime));
const round1 = (v: number) => Math.round(v * 10) / 10;
