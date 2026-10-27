/**
 * Interpolation primitives. Channel type decides the method:
 * - continuous physical quantities (speed, rpm, throttle, x/y): linear
 * - discrete states (gear, brake on/off, DRS code): step (previous sample holds)
 * Gaps larger than `maxGap` produce NaN instead of bridging missing data.
 */

/** Index of the last element <= x (or -1). `xs` must be ascending. */
export function bisectRight(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function interpLinear(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number, maxGap = Infinity): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  if (x <= xs[0]!) return x === xs[0]! ? ys[0]! : Number.NaN;
  if (x >= xs[n - 1]!) return x === xs[n - 1]! ? ys[n - 1]! : Number.NaN;
  const i = bisectRight(xs, x);
  const x0 = xs[i]!;
  const x1 = xs[i + 1]!;
  if (x1 - x0 > maxGap) return Number.NaN;
  if (x1 === x0) return ys[i]!;
  const f = (x - x0) / (x1 - x0);
  return ys[i]! + (ys[i + 1]! - ys[i]!) * f;
}

export function interpStep(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number, maxGap = Infinity): number {
  const n = xs.length;
  if (n === 0 || x < xs[0]! || x > xs[n - 1]!) return Number.NaN;
  const i = bisectRight(xs, x);
  if (i < n - 1 && xs[i + 1]! - xs[i]! > maxGap) return Number.NaN;
  return ys[i]!;
}

/**
 * Like interpLinear but clamps to the end values instead of returning NaN outside the range.
 * Used only where extrapolation by a fraction of a sample is physically harmless (lap edges).
 */
export function interpLinearClamped(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  return interpLinear(xs, ys, x);
}

export function resample(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  grid: readonly number[],
  method: "linear" | "step",
  maxGap = Infinity,
): number[] {
  const f = method === "linear" ? interpLinear : interpStep;
  return grid.map((g) => f(xs, ys, g, maxGap));
}

/** Evenly spaced grid [start, end] inclusive of start, exclusive of points beyond end. */
export function grid(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * Largest-triangle-three-buckets style decimation simplified to min/max bucketing:
 * preserves peaks (braking points, top speed) that naive stride sampling would lose.
 * Returns indices into the original arrays.
 */
export function decimateIndices(values: ArrayLike<number>, maxPoints: number): number[] {
  const n = values.length;
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const size = n / buckets;
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size);
    const e = Math.min(n, Math.floor((b + 1) * size));
    let mi = s, ma = s;
    for (let i = s; i < e; i++) {
      if (values[i]! < values[mi]!) mi = i;
      if (values[i]! > values[ma]!) ma = i;
    }
    if (mi === ma) out.push(mi);
    else out.push(Math.min(mi, ma), Math.max(mi, ma));
  }
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}
