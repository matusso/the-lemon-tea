import type { PositionSamples } from "@lemon-tea/telemetry-core";
import { get } from "../../api";

const WINDOW_MS = 120_000;
const OVERLAP_MS = 5_000;

/**
 * Windowed cache of measured car positions for replay. Windows (2 min, 5 s overlap so
 * interpolation works across boundaries) are fetched on demand and the next one is prefetched;
 * at most ~10 windows are kept so long sessions never live entirely in browser memory.
 */
export class ReplayCache {
  private windows = new Map<number, Map<number, PositionSamples>>();
  private pending = new Set<number>();
  private order: number[] = [];
  error: string | null = null;

  constructor(readonly sessionId: string, private readonly min: number, private readonly max: number) {}

  private load(idx: number) {
    const from = idx * WINDOW_MS - OVERLAP_MS;
    const to = (idx + 1) * WINDOW_MS + OVERLAP_MS;
    if (this.windows.has(idx) || this.pending.has(idx) || to < this.min || from > this.max) return;
    this.pending.add(idx);
    get
      .replay(this.sessionId, Math.max(0, from), to)
      .then((w) => {
        const m = new Map<number, PositionSamples>();
        for (const [d, c] of Object.entries(w.cars)) m.set(Number(d), { t: c.t, x: c.x, y: c.y, z: new Array(c.t.length).fill(0) });
        this.windows.set(idx, m);
        this.order.push(idx);
        while (this.order.length > 10) this.windows.delete(this.order.shift()!);
        this.error = null;
      })
      .catch((e: Error) => (this.error = e.message))
      .finally(() => this.pending.delete(idx));
  }

  /** Samples covering time t (session ms), or null while loading. Triggers prefetch. */
  at(t: number): Map<number, PositionSamples> | null {
    const idx = Math.floor(t / WINDOW_MS);
    this.load(idx);
    this.load(idx + 1);
    return this.windows.get(idx) ?? null;
  }
}
