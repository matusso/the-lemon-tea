/** Stint arithmetic for the strategy editor: a strategy is a list of stints that always sums to race distance. */
export type Compound = "SOFT" | "MEDIUM" | "HARD" | "INTERMEDIATE" | "WET";
export interface Stint {
  compound: Compound;
  laps: number;
}

export const total = (s: Stint[]) => s.reduce((a, x) => a + x.laps, 0);
/** Laps at the end of which each stop happens. */
export const pitLaps = (s: Stint[]) => s.slice(0, -1).reduce<number[]>((acc, x) => [...acc, (acc.at(-1) ?? 0) + x.laps], []);

/** Move stop i to the end of `lap`, keeping every stint at least one lap. */
export function setPit(s: Stint[], i: number, lap: number): Stint[] {
  const pits = pitLaps(s);
  const lo = (pits[i - 1] ?? 0) + 1;
  const hi = (pits[i + 1] ?? total(s)) - 1;
  const L = Math.min(hi, Math.max(lo, Math.round(lap)));
  const next = s.map((x) => ({ ...x }));
  next[i]!.laps = L - (pits[i - 1] ?? 0);
  next[i + 1]!.laps = (pits[i + 1] ?? total(s)) - L;
  return next;
}

/** Add a stop at the end of `lap` (splits the stint that contains it). */
export function addPit(s: Stint[], lap: number): Stint[] {
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const end = start + s[i]!.laps;
    if (lap > start && lap < end) {
      const cur = s[i]!;
      const nextCompound: Compound = cur.compound === "HARD" ? "MEDIUM" : "HARD";
      return [...s.slice(0, i), { ...cur, laps: lap - start }, { compound: nextCompound, laps: end - lap }, ...s.slice(i + 1)];
    }
    start = end;
  }
  return s;
}

/** Remove stop i: the following stint is merged into the one before it. */
export const removePit = (s: Stint[], i: number): Stint[] => [...s.slice(0, i), { ...s[i]!, laps: s[i]!.laps + s[i + 1]!.laps }, ...s.slice(i + 2)];

/** Stints from fractions of race distance; the last stint absorbs rounding. */
export function fromShares(shares: [Compound, number][], laps: number): Stint[] {
  let used = 0;
  return shares.map(([compound, f], i) => {
    const n = i === shares.length - 1 ? laps - used : Math.max(1, Math.round(f * laps));
    used += n;
    return { compound, laps: n };
  });
}

export function rescale(s: Stint[], laps: number): Stint[] {
  const sum = total(s);
  if (!sum || sum === laps) return s;
  return fromShares(
    s.map((x) => [x.compound, x.laps / sum]),
    laps,
  ).map((x) => ({ ...x, laps: Math.max(1, x.laps) }));
}

export const TEMPLATES: { name: string; shares: [Compound, number][] }[] = [
  { name: "1-stop M→H", shares: [["MEDIUM", 0.42], ["HARD", 0.58]] },
  { name: "1-stop H→M", shares: [["HARD", 0.56], ["MEDIUM", 0.44]] },
  { name: "1-stop S→H", shares: [["SOFT", 0.3], ["HARD", 0.7]] },
  { name: "2-stop M→H→M", shares: [["MEDIUM", 0.3], ["HARD", 0.38], ["MEDIUM", 0.32]] },
  { name: "2-stop S→M→S", shares: [["SOFT", 0.26], ["MEDIUM", 0.48], ["SOFT", 0.26]] },
  { name: "2-stop S→H→S", shares: [["SOFT", 0.24], ["HARD", 0.52], ["SOFT", 0.24]] },
];

export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} (${i})`)) return `${base} (${i})`;
}

