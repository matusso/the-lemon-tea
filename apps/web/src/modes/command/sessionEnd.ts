import type { TimingBundle } from "@lemon-tea/synchronization";

/** End of the replay range: the bundle end (max of scheduled end and last lap end), else last lap end. */
export function sessionEndMs(b: TimingBundle): number {
  if (b.endMs !== null) return b.endMs;
  const ends = b.laps.filter((l) => l.dateStart).map((l) => Date.parse(l.dateStart!) + (l.lapTime ?? 0) * 1000 - b.epochMs);
  return ends.length ? Math.max(...ends) : 3600_000;
}
