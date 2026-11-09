import type { CircuitResponse } from "../../api";

type Geo = Pick<CircuitResponse["geometry"], "x" | "y" | "distance" | "sectorBoundaries" | "startFinish">;

/**
 * Track features derived from the driven line alone. None of these come from an official source:
 * the data feeds publish no DRS / straight-mode zone positions, no speed-trap location and no
 * surroundings, so everything here is an estimate or an illustration and is labelled as such.
 */

/** Index range along the lap; `to` may be smaller than `from` when the range wraps past S/F. */
export interface Span {
  from: number;
  to: number;
  length: number;
}

const STEP_WINDOW_M = 30;
/** A section is "straight" while its radius stays above this. */
const STRAIGHT_RADIUS_M = 350;

function stepM(geo: Pick<Geo, "distance">) {
  const L = geo.distance[geo.distance.length - 1]!;
  return L / Math.max(1, geo.distance.length - 1);
}

export function headingAt(geo: Pick<Geo, "x" | "y">, i: number): number {
  const n = geo.x.length;
  const j = Math.min(n - 1, i + 1);
  const k = Math.max(0, i - 1);
  return Math.atan2(geo.y[j]! - geo.y[k]!, geo.x[j]! - geo.x[k]!);
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Signed curvature (1/m, positive = turning left) at each sample, over a ±30 m window. */
export function curvature(geo: Pick<Geo, "x" | "y" | "distance">): number[] {
  const n = geo.x.length;
  const step = stepM(geo);
  const w = Math.max(1, Math.round(STEP_WINDOW_M / step));
  const at = (i: number) => ((i % n) + n) % n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = at(i - w);
    const b = at(i + w);
    const h1 = Math.atan2(geo.y[i]! - geo.y[a]!, geo.x[i]! - geo.x[a]!);
    const h2 = Math.atan2(geo.y[b]! - geo.y[i]!, geo.x[b]! - geo.x[i]!);
    out.push(wrapAngle(h2 - h1) / (2 * w * step));
  }
  return out;
}

/** Straights (radius above 350 m for at least `minLength`), longest first. Wraps past S/F. */
export function straights(geo: Pick<Geo, "x" | "y" | "distance">, minLength = 300): Span[] {
  const n = geo.x.length;
  const step = stepM(geo);
  const flat = curvature(geo).map((c) => Math.abs(c) < 1 / STRAIGHT_RADIUS_M);
  // Bridge tiny kinks (< 25 m) so a straight with a small wobble is not split in two.
  const bridge = Math.round(25 / step);
  const start = flat.indexOf(false);
  if (start < 0) return [];
  const runs: Span[] = [];
  let runFrom = -1;
  let gap = 0;
  const close = (endExclusive: number) => {
    const to = (endExclusive - 1 + n) % n;
    const len = (((to - runFrom + n) % n) + 1) * step;
    if (len >= minLength) runs.push({ from: runFrom, to, length: len });
    runFrom = -1;
    gap = 0;
  };
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n;
    if (flat[i]) {
      if (runFrom < 0) runFrom = i;
      gap = 0;
    } else if (runFrom >= 0) {
      gap++;
      if (gap > bridge) close((i - gap + 1 + n) % n);
    }
  }
  if (runFrom >= 0) close((start + 1 - gap + n) % n);
  return runs.sort((a, b) => b.length - a.length);
}

export const inSpan = (s: Span, i: number) => (s.from <= s.to ? i >= s.from && i <= s.to : i >= s.from || i <= s.to);

/**
 * Estimated DRS (pre-2026) / straight-mode (2026) zones: the up-to-three longest straights,
 * opening ~40 m after the straight starts and closing ~80 m before the braking zone.
 */
export function drsZones(geo: Pick<Geo, "x" | "y" | "distance">): Span[] {
  const n = geo.x.length;
  const step = stepM(geo);
  return straights(geo, 450)
    .slice(0, 3)
    .map((s) => ({ from: (s.from + Math.round(40 / step)) % n, to: (s.to - Math.round(80 / step) + n) % n, length: s.length - 120 }))
    .sort((a, b) => geo.distance[a.from]! - geo.distance[b.from]!);
}

/**
 * Estimated speed-trap position (index on the geometry): where the reference lap is fastest if a
 * speed trace is given (mapped from its own distance axis), otherwise near the end of the longest
 * straight, where the official traps usually sit.
 */
export function speedTrapIndex(geo: Pick<Geo, "x" | "y" | "distance">, trace?: { distance: number[]; speed: number[] }): number {
  const n = geo.x.length;
  const L = geo.distance[n - 1]!;
  if (trace?.speed.length) {
    let best = 0;
    for (let i = 1; i < trace.speed.length; i++) if (trace.speed[i]! > trace.speed[best]!) best = i;
    const refL = trace.distance[trace.distance.length - 1]!;
    return Math.round(((trace.distance[best]! / refL) * L) / stepM(geo)) % n;
  }
  const s = straights(geo, 200)[0];
  if (!s) return 0;
  return (s.to - Math.round(120 / stepM(geo)) + n) % n;
}

/** Sector (0, 1, 2) of a lap distance on the geometry's own axis. */
export function sectorOf(geo: Pick<Geo, "sectorBoundaries">, d: number): number {
  const s = geo.sectorBoundaries;
  return d < (s[0] ?? Infinity) ? 0 : d < (s[1] ?? Infinity) ? 1 : 2;
}

// ------------------------------------------------------------------------------------------------
// Illustrative surroundings. Placement is deterministic per circuit (seeded) and keeps clear of
// the driven line, but it is NOT real-world mapping: source coordinates are not georeferenced.

export interface Box {
  x: number;
  y: number;
  /** footprint along / across the heading, and height (m) */
  w: number;
  d: number;
  h: number;
  heading: number;
  /** nearest centreline sample (for elevation) */
  near: number;
}

export interface Tree {
  x: number;
  y: number;
  r: number;
  h: number;
  shade: number;
  near: number;
}

export interface Scenery {
  buildings: Box[];
  pit: Box[];
  paddock: Box[];
  stands: Box[];
  trees: Tree[];
  pitLane: { x: number; y: number; near: number }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Smooth value noise in [0, 1]. */
function valueNoise(seed: number) {
  const lattice = (ix: number, iy: number) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = fade(x - ix);
    const fy = fade(y - iy);
    const a = lattice(ix, iy) + (lattice(ix + 1, iy) - lattice(ix, iy)) * fx;
    const b = lattice(ix, iy + 1) + (lattice(ix + 1, iy + 1) - lattice(ix, iy + 1)) * fx;
    return a + (b - a) * fy;
  };
}

/** Distance to the driven line (and nearest sample) on a 10 m raster, by nearest-seed propagation. */
export class DistanceField {
  readonly cell = 10;
  readonly cols: number;
  readonly rows: number;
  private near: Int32Array;
  private occupied: Uint8Array;

  constructor(
    private geo: Pick<Geo, "x" | "y">,
    readonly minX: number,
    readonly minY: number,
    maxX: number,
    maxY: number,
  ) {
    this.cols = Math.ceil((maxX - minX) / this.cell) + 1;
    this.rows = Math.ceil((maxY - minY) / this.cell) + 1;
    this.near = new Int32Array(this.cols * this.rows).fill(-1);
    this.occupied = new Uint8Array(this.cols * this.rows);
    const dist = new Float32Array(this.cols * this.rows).fill(Infinity);
    const d2 = (k: number, c: number, r: number) => (geo.x[k]! - (minX + c * this.cell)) ** 2 + (geo.y[k]! - (minY + r * this.cell)) ** 2;
    for (let k = 0; k < geo.x.length; k++) {
      const c = Math.round((geo.x[k]! - minX) / this.cell);
      const r = Math.round((geo.y[k]! - minY) / this.cell);
      if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
      const id = r * this.cols + c;
      const dd = d2(k, c, r);
      if (dd < dist[id]!) {
        dist[id] = dd;
        this.near[id] = k;
      }
    }
    const relax = (c: number, r: number, nc: number, nr: number) => {
      if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) return;
      const k = this.near[nr * this.cols + nc]!;
      if (k < 0) return;
      const id = r * this.cols + c;
      const dd = d2(k, c, r);
      if (dd < dist[id]!) {
        dist[id] = dd;
        this.near[id] = k;
      }
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) {
          relax(c, r, c - 1, r);
          relax(c, r, c, r - 1);
          relax(c, r, c - 1, r - 1);
          relax(c, r, c + 1, r - 1);
        }
      for (let r = this.rows - 1; r >= 0; r--)
        for (let c = this.cols - 1; c >= 0; c--) {
          relax(c, r, c + 1, r);
          relax(c, r, c, r + 1);
          relax(c, r, c + 1, r + 1);
          relax(c, r, c - 1, r + 1);
        }
    }
  }

  private id(x: number, y: number) {
    const c = Math.round((x - this.minX) / this.cell);
    const r = Math.round((y - this.minY) / this.cell);
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
  }

  /** Distance to the driven line (m) and the nearest centreline sample. */
  at(x: number, y: number): { d: number; near: number } {
    const id = this.id(x, y);
    const k = id < 0 ? -1 : this.near[id]!;
    if (k < 0) return { d: Infinity, near: 0 };
    return { d: Math.hypot(this.geo.x[k]! - x, this.geo.y[k]! - y), near: k };
  }

  isFree(x: number, y: number) {
    const id = this.id(x, y);
    return id >= 0 && !this.occupied[id];
  }

  /** Mark a rotated rectangle (plus margin) as taken. */
  claim(b: { x: number; y: number; w: number; d: number; heading: number }, margin = 6) {
    const cos = Math.cos(b.heading);
    const sin = Math.sin(b.heading);
    const hw = b.w / 2 + margin;
    const hd = b.d / 2 + margin;
    for (let u = -hw; u <= hw; u += this.cell / 2)
      for (let v = -hd; v <= hd; v += this.cell / 2) {
        const id = this.id(b.x + u * cos - v * sin, b.y + u * sin + v * cos);
        if (id >= 0) this.occupied[id] = 1;
      }
  }

  /** True when the centre and corners of the rectangle keep `clear` metres off the line and are unclaimed. */
  fits(b: { x: number; y: number; w: number; d: number; heading: number }, clear: number) {
    const cos = Math.cos(b.heading);
    const sin = Math.sin(b.heading);
    const pts: [number, number][] = [
      [0, 0],
      [b.w / 2, b.d / 2],
      [-b.w / 2, b.d / 2],
      [b.w / 2, -b.d / 2],
      [-b.w / 2, -b.d / 2],
    ];
    return pts.every(([u, v]) => {
      const x = b.x + u * cos - v * sin;
      const y = b.y + u * sin + v * cos;
      return this.at(x, y).d > clear && this.isFree(x, y);
    });
  }
}

const MARGIN_M = 600;

/** Point `off` metres to the left (negative = right) of centreline sample i, with the local heading. */
export function offsetPoint(geo: Pick<Geo, "x" | "y">, i: number, off: number) {
  const h = headingAt(geo, i);
  return { x: geo.x[i]! - Math.sin(h) * off, y: geo.y[i]! + Math.cos(h) * off, h };
}

/**
 * Deterministic, illustrative surroundings: a pit building and paddock beside the start/finish
 * straight, a main grandstand opposite, grandstands on the outside of the tightest corners,
 * clusters of buildings further out and woodland that keeps clear of the track.
 */
export function buildScenery(geo: Pick<Geo, "x" | "y" | "distance">, seed: number): Scenery {
  const n = geo.x.length;
  const step = stepM(geo);
  const rand = mulberry32(seed);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, geo.x[i]!);
    maxX = Math.max(maxX, geo.x[i]!);
    minY = Math.min(minY, geo.y[i]!);
    maxY = Math.max(maxY, geo.y[i]!);
  }
  minX -= MARGIN_M;
  minY -= MARGIN_M;
  maxX += MARGIN_M;
  maxY += MARGIN_M;
  const field = new DistanceField(geo, minX, minY, maxX, maxY);
  const along = (fromIdx: number, metres: number) => (((fromIdx + Math.round(metres / step)) % n) + n) % n;

  // --- pit building, pit lane and paddock along the start/finish straight
  const pit: Box[] = [];
  const paddock: Box[] = [];
  const stands: Box[] = [];
  const pitLane: Scenery["pitLane"] = [];
  const sfStraight = straights(geo, 150).find((s) => inSpan(s, 0));
  const pitLen = Math.min(360, Math.max(160, (sfStraight?.length ?? 300) * 0.6));
  const startOff = -pitLen * 0.55;
  const SEG = 40;
  const sideScore = (side: 1 | -1) => {
    let score = 0;
    for (let m = startOff; m <= startOff + pitLen; m += SEG) {
      const p = offsetPoint(geo, along(0, m), side * 70);
      score += Math.min(field.at(p.x, p.y).d, 120);
    }
    return score;
  };
  const side: 1 | -1 = sideScore(1) >= sideScore(-1) ? 1 : -1;
  for (let m = startOff - 120; m <= startOff + pitLen + 120; m += 10) {
    const i = along(0, m);
    const p = offsetPoint(geo, i, side * 30);
    pitLane.push({ x: p.x, y: p.y, near: i });
  }
  for (let m = startOff; m < startOff + pitLen; m += SEG) {
    const i = along(0, m + SEG / 2);
    const p = offsetPoint(geo, i, side * 52);
    const b = { x: p.x, y: p.y, w: SEG - 1, d: 22, h: 12, heading: p.h, near: i };
    pit.push(b);
    field.claim(b, 4);
    for (const [row, h] of [
      [100, 9],
      [130, 7],
    ] as const) {
      const q = offsetPoint(geo, i, side * row);
      const box = { x: q.x, y: q.y, w: SEG - 12, d: 18, h, heading: q.h, near: i };
      if (field.fits(box, 40)) {
        paddock.push(box);
        field.claim(box, 4);
      }
    }
  }
  {
    // race control tower at the line
    const p = offsetPoint(geo, 0, side * 58);
    const tower = { x: p.x, y: p.y, w: 18, d: 18, h: 34, heading: p.h, near: 0 };
    pit.push(tower);
    field.claim(tower, 4);
  }

  // grandstands: three stepped tiers rising away from the track
  const grandstand = (i: number, outSide: number, offset: number, segW: number) => {
    const tiers: Box[] = [];
    for (let t = 0; t < 3; t++) {
      const p = offsetPoint(geo, i, outSide * (offset + t * 7));
      tiers.push({ x: p.x, y: p.y, w: segW, d: 7, h: 5 + t * 5, heading: p.h, near: i });
    }
    const whole = { ...tiers[1]!, d: 24 };
    if (!field.fits(whole, offset - 14)) return;
    stands.push(...tiers);
    field.claim(whole, 3);
  };
  for (let m = startOff; m < startOff + pitLen; m += SEG) grandstand(along(0, m + SEG / 2), -side, 26, SEG - 2);

  const k = curvature(geo);
  const w = Math.round(60 / step);
  const tight = geo.x
    .map((_, i) => i)
    .filter((i) => {
      if (Math.abs(k[i]!) < 1 / 120) return false;
      for (let j = -w; j <= w; j++) if (Math.abs(k[(i + j + n) % n]!) > Math.abs(k[i]!)) return false;
      return true;
    })
    .sort((a, b) => Math.abs(k[b]!) - Math.abs(k[a]!))
    .slice(0, 6);
  for (const i of tight) {
    const outSide = k[i]! > 0 ? -1 : 1;
    for (const m of [-60, -20, 20, 60]) grandstand(along(i, m), outSide, 46, 36);
  }

  // --- buildings in clusters further out
  const urban = valueNoise(seed ^ 0x9e3779b9);
  const buildings: Box[] = [];
  for (let gx = minX; gx < maxX; gx += 70)
    for (let gy = minY; gy < maxY; gy += 70) {
      const x = gx + rand() * 40;
      const y = gy + rand() * 40;
      const u = urban(x / 520, y / 520);
      const r1 = rand();
      if (u < 0.58 || r1 > 0.8) continue;
      const { d, near } = field.at(x, y);
      if (d < 150) continue;
      const tall = rand() < 0.1;
      const b = {
        x,
        y,
        w: 18 + rand() * 40,
        d: 16 + rand() * 30,
        h: tall ? 28 + rand() * 40 : 6 + rand() * 12,
        heading: headingAt(geo, near) + (rand() < 0.3 ? Math.PI / 2 : 0),
        near,
      };
      if (!field.fits(b, 110)) continue;
      buildings.push(b);
      field.claim(b, 8);
    }

  // --- woodland: dense clusters plus thinner tree lines behind the run-off
  const forest = valueNoise(seed ^ 0x51ed270b);
  const trees: Tree[] = [];
  const MAX_TREES = 4500;
  for (let gx = minX; gx < maxX && trees.length < MAX_TREES; gx += 16)
    for (let gy = minY; gy < maxY && trees.length < MAX_TREES; gy += 16) {
      const x = gx + rand() * 14;
      const y = gy + rand() * 14;
      const r1 = rand();
      const { d, near } = field.at(x, y);
      if (d < 34 || !field.isFree(x, y)) continue;
      const line = d > 55 && d < 95 ? 0.12 : 0;
      const p = Math.max(0, (forest(x / 240, y / 240) - 0.48) * 2.2) + line;
      if (r1 > p) continue;
      trees.push({ x, y, r: 3 + rand() * 3.5, h: 7 + rand() * 10, shade: rand(), near });
    }

  return { buildings, pit, paddock, stands, trees, pitLane, bounds: { minX, minY, maxX, maxY } };
}
