import type { ProviderAdapter } from "@lemon-tea/provider-sdk";

export interface LiveMessage {
  type: "delta" | "status";
  sessionId: string;
  seq: number;
  /** Latest source timestamp contained in the delta (source freshness). */
  sourceTimestamp: string | null;
  /** When the platform received/processed it. sourceLag = receivedAt - sourceTimestamp. */
  receivedAt: string;
  payload: unknown;
}

export interface Subscriber {
  send(m: LiveMessage): void;
  close(): void;
}

/**
 * One provider poller per live session, fanned out to any number of viewers. Viewers never cause
 * extra provider requests. A bounded ring buffer lets late joiners catch up on recent deltas;
 * slow subscribers that throw are dropped instead of blocking others.
 */
export class LiveSessionCoordinator {
  private subs = new Set<Subscriber>();
  private buffer: LiveMessage[] = [];
  private seq = 0;
  private cursor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(
    readonly sessionId: string,
    private readonly provider: ProviderAdapter,
    private readonly sessionKey: string,
    private readonly opts: { intervalMs?: number; bufferSize?: number; onDelta?: (m: LiveMessage) => Promise<void> } = {},
  ) {}

  get viewers() {
    return this.subs.size;
  }

  subscribe(s: Subscriber) {
    this.subs.add(s);
    for (const m of this.buffer) s.send(m);
    if (!this.timer) this.schedule(0);
    return () => {
      this.subs.delete(s);
      if (this.subs.size === 0) this.stop();
    };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private publish(type: LiveMessage["type"], sourceTimestamp: string | null, payload: unknown) {
    const m: LiveMessage = { type, sessionId: this.sessionId, seq: ++this.seq, sourceTimestamp, receivedAt: new Date().toISOString(), payload };
    this.buffer.push(m);
    if (this.buffer.length > (this.opts.bufferSize ?? 120)) this.buffer.shift();
    for (const s of [...this.subs]) {
      try {
        s.send(m);
      } catch {
        this.subs.delete(s);
        s.close();
      }
    }
    return m;
  }

  private async tick() {
    if (!this.provider.pollLive) {
      this.publish("status", null, { state: "unavailable", reason: "Provider has no authorised live access configured" });
      return;
    }
    try {
      const d = await this.provider.pollLive(this.sessionKey, this.cursor);
      this.cursor = d.cursor;
      this.failures = 0;
      const car = Object.fromEntries([...d.car].map(([k, v]) => [k, v]));
      const position = Object.fromEntries([...d.position].map(([k, v]) => [k, v]));
      const m = this.publish("delta", d.sourceTimestamp, { bundle: d.bundle, car, position });
      await this.opts.onDelta?.(m);
    } catch (e) {
      this.failures++;
      this.publish("status", null, { state: "degraded", error: (e as Error).message.slice(0, 200), retryInMs: this.backoff() });
    }
    if (this.subs.size > 0) this.schedule(this.failures ? this.backoff() : this.opts.intervalMs ?? 2000);
  }

  private backoff() {
    return Math.min(60_000, 2000 * 2 ** Math.min(this.failures, 5));
  }
}
