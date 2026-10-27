import { useEffect, useState } from "react";
import { PlaybackClock } from "@lemon-tea/synchronization";

/**
 * The one session clock. 3D markers and chart cursors read `clock.now()` in their own loops;
 * React components that only need coarse updates use `useClockTime(ms)` which samples it.
 */
export const clock = new PlaybackClock();

export function useClockTime(intervalMs = 250): number {
  const [t, setT] = useState(() => clock.now());
  useEffect(() => {
    const id = setInterval(() => setT(clock.now()), intervalMs);
    const off = clock.subscribe((x) => setT(x));
    return () => {
      clearInterval(id);
      off();
    };
  }, [intervalMs]);
  return t;
}

export function usePlaying(): boolean {
  const [p, setP] = useState(clock.playing);
  useEffect(() => clock.subscribe(() => setP(clock.playing)), []);
  return p;
}

export function fmtClock(ms: number): string {
  const neg = ms < 0;
  const s = Math.abs(ms) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${neg ? "-" : ""}${h ? `${h}:` : ""}${p(m)}:${p(sec)}`;
}
