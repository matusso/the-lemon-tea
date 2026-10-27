export const PLAYBACK_RATES = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

type Listener = (tMs: number) => void;

/**
 * Shared session clock. All synchronised views subscribe to it; high-frequency consumers
 * (3D scene, chart cursor) read `now()` inside their own animation loop instead of re-rendering
 * React on every tick.
 */
export class PlaybackClock {
  private base = 0;
  private startedAt: number | null = null;
  private listeners = new Set<Listener>();
  rate: PlaybackRate = 1;
  min = 0;
  max = 0;

  constructor(private readonly perfNow: () => number = () => performance.now()) {}

  get playing(): boolean {
    return this.startedAt !== null;
  }

  now(): number {
    if (this.startedAt === null) return this.base;
    const t = this.base + (this.perfNow() - this.startedAt) * this.rate;
    if (t >= this.max) {
      this.base = this.max;
      this.startedAt = null;
      this.emit();
      return this.max;
    }
    return t;
  }

  setRange(min: number, max: number) {
    this.min = min;
    this.max = max;
    this.seek(Math.min(Math.max(this.now(), min), max));
  }

  play() {
    if (this.playing) return;
    if (this.base >= this.max) this.base = this.min;
    this.startedAt = this.perfNow();
    this.emit();
  }

  pause() {
    this.base = this.now();
    this.startedAt = null;
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(tMs: number) {
    this.base = Math.min(Math.max(tMs, this.min), this.max);
    if (this.startedAt !== null) this.startedAt = this.perfNow();
    this.emit();
  }

  step(deltaMs: number) {
    this.seek(this.now() + deltaMs);
  }

  setRate(rate: PlaybackRate) {
    this.base = this.now();
    if (this.startedAt !== null) this.startedAt = this.perfNow();
    this.rate = rate;
    this.emit();
  }

  /** Seek to the next/previous event time in a sorted list. */
  stepEvent(times: number[], direction: 1 | -1) {
    const t = this.now();
    const next = direction > 0 ? times.find((x) => x > t + 1) : [...times].reverse().find((x) => x < t - 1);
    if (next !== undefined) this.seek(next);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const t = this.now();
    for (const l of this.listeners) l(t);
  }
}
