/**
 * Small, dependency-free statistics toolkit. Everything here is deterministic; randomness
 * only enters through an explicitly seeded `Rng`.
 */

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number {
  return xs.length ? sum(xs) / xs.length : Number.NaN;
}

export function variance(xs: readonly number[], ddof = 1): number {
  if (xs.length <= ddof) return Number.NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - ddof);
}

export function std(xs: readonly number[], ddof = 1): number {
  return Math.sqrt(variance(xs, ddof));
}

/** Linear-interpolated quantile (type 7, same as numpy default). */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Median absolute deviation scaled to be a consistent estimator of sigma for normal data. */
export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

export interface LinearFit {
  intercept: number;
  slope: number;
  residualStd: number;
  n: number;
  /** Standard error of the slope (OLS formula applied to the fit's residuals). */
  slopeStdErr: number;
}

export function olsFit(x: readonly number[], y: readonly number[]): LinearFit {
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i]! - mx) ** 2;
    sxy += (x[i]! - mx) * (y[i]! - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  return withResiduals(x, y, intercept, slope, sxx);
}

/**
 * Theil-Sen estimator: median of pairwise slopes. Robust to ~29% outliers, which matters
 * for lap times where a single traffic-affected lap would otherwise dominate an OLS slope.
 */
export function theilSen(x: readonly number[], y: readonly number[]): LinearFit {
  const n = x.length;
  if (n < 2) return { intercept: n ? y[0]! : Number.NaN, slope: 0, residualStd: Number.NaN, n, slopeStdErr: Number.NaN };
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[j]! - x[i]!;
      if (dx !== 0) slopes.push((y[j]! - y[i]!) / dx);
    }
  }
  const slope = slopes.length ? median(slopes) : 0;
  const intercept = median(y.map((yi, i) => yi - slope * x[i]!));
  const mx = mean(x);
  let sxx = 0;
  for (const xi of x) sxx += (xi - mx) ** 2;
  return withResiduals(x, y, intercept, slope, sxx);
}

function withResiduals(x: readonly number[], y: readonly number[], intercept: number, slope: number, sxx: number): LinearFit {
  const n = x.length;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (y[i]! - (intercept + slope * x[i]!)) ** 2;
  const residualStd = n > 2 ? Math.sqrt(ss / (n - 2)) : Number.NaN;
  const slopeStdErr = n > 2 && sxx > 0 ? residualStd / Math.sqrt(sxx) : Number.NaN;
  return { intercept, slope, residualStd, n, slopeStdErr };
}

/** Least squares quadratic y = a + b x + c x^2 via normal equations. */
export function quadraticFit(x: readonly number[], y: readonly number[]): { a: number; b: number; c: number; residualStd: number } {
  const n = x.length;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i]!;
    const yi = y[i]!;
    const x2 = xi * xi;
    s0 += 1; s1 += xi; s2 += x2; s3 += x2 * xi; s4 += x2 * x2;
    t0 += yi; t1 += xi * yi; t2 += x2 * yi;
  }
  const sol = solve3([
    [s0, s1, s2],
    [s1, s2, s3],
    [s2, s3, s4],
  ], [t0, t1, t2]);
  if (!sol) {
    const lin = olsFit(x, y);
    return { a: lin.intercept, b: lin.slope, c: 0, residualStd: lin.residualStd };
  }
  const [a, b, c] = sol;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (y[i]! - (a + b * x[i]! + c * x[i]! ** 2)) ** 2;
  return { a, b, c, residualStd: n > 3 ? Math.sqrt(ss / (n - 3)) : Number.NaN };
}

function solve3(m: number[][], v: number[]): [number, number, number] | null {
  const det = (a: number[][]) =>
    a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) -
    a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) +
    a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  const col = (k: number) => m.map((row, i) => row.map((val, j) => (j === k ? v[i]! : val)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/** Normal CDF via Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** z-value for a two-sided central interval of the given level (inverse via bisection). */
export function zForLevel(level: number): number {
  const target = 0.5 + level / 2;
  let lo = 0, hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Seeded PRNG (mulberry32). Reproducible across Node, Workers and browsers. */
export class Rng {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  normal(mu = 0, sigma = 1): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return mu + sigma * s;
    }
    let u = 0, v = 0, s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * f;
    return mu + sigma * u * f;
  }

  bernoulli(p: number): boolean {
    return this.next() < p;
  }

  /** Log-normal with given median and log-sd; used for strictly positive durations. */
  lognormal(medianValue: number, logSd: number): number {
    return medianValue * Math.exp(this.normal(0, logSd));
  }
}

export function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
