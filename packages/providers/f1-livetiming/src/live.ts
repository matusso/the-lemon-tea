import type { IntervalRecord, Lap, PositionRecord, RaceControlEvent, WeatherObservation } from "@lemon-tea/shared-types";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";
import type { LiveDelta } from "@lemon-tea/provider-sdk";
import { F1AuthError } from "./auth.ts";
import { deepMerge, inflateRawBase64, isObject, parseLapTime, type Json, type JsonObject } from "./stream.ts";
import { parseGap } from "./timing.ts";

/**
 * Client for the F1 live timing SignalR Core hub (the feed FastF1's live client records).
 *
 * negotiate → WebSocket with the subscription token as Bearer → JSON hub protocol handshake →
 * `Subscribe(topics)`. The completion of Subscribe carries the full current state; afterwards
 * the hub pushes `feed(topic, patch, utc)` invocations that are merged into that state.
 * Messages are buffered between `drain()` calls, so one connection serves the live coordinator's
 * polling loop and viewers never cause extra upstream connections.
 */

const BASE = "https://livetiming.formula1.com";
const HUB = "wss://livetiming.formula1.com/signalrcore";
const RS = "\u001e"; // SignalR record separator
const PING_MS = 15_000;
const MAX_BUFFERED_SAMPLES = 200_000;

export const LIVE_TOPICS = [
  "Heartbeat", "DriverList", "ExtrapolatedClock", "RaceControlMessages", "SessionInfo", "SessionStatus",
  "TeamRadio", "TimingAppData", "TimingStats", "TrackStatus", "WeatherData", "Position.z", "CarData.z",
  "SessionData", "TimingData", "TopThree", "LapCount",
] as const;

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => Promise<WebSocketLike>;

/** Node default: the `ws` package (the handshake needs an Authorization header, which the WHATWG WebSocket cannot set). */
export const nodeWebSocketFactory: WebSocketFactory = async (url, headers) => {
  const specifier = "ws"; // non-literal so Worker bundles do not pull in a Node-only module
  const mod = (await import(specifier)) as { default: new (u: string, o: { headers: Record<string, string> }) => WebSocketLike };
  return new mod.default(url, { headers });
};

export interface F1LiveFeedOptions {
  token: () => Promise<string>;
  onUnauthorized?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  connect?: WebSocketFactory;
  hubUrl?: string;
  negotiateUrl?: string;
}

interface Buffered {
  car: Map<number, CarSamples>;
  position: Map<number, PositionSamples>;
  raceControl: RaceControlEvent[];
  positionHistory: PositionRecord[];
  intervals: IntervalRecord[];
  weather: WeatherObservation[];
  laps: Lap[];
  latest: number | null;
}

const emptyBuffer = (): Buffered => ({ car: new Map(), position: new Map(), raceControl: [], positionHistory: [], intervals: [], weather: [], laps: [], latest: null });

export class F1LiveFeed {
  private ws: WebSocketLike | null = null;
  private state: Record<string, JsonObject> = {};
  private buf: Buffered = emptyBuffer();
  private bufferedSamples = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  private closed: { code?: number; reason?: string } | null = null;
  private lastError: string | null = null;
  /** Frames are applied strictly in arrival order (decoding .z payloads is async). */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: F1LiveFeedOptions) {}

  async start(): Promise<void> {
    const f = this.o.fetchImpl ?? fetch;
    const token = await this.o.token();
    const auth = { authorization: `Bearer ${token}` };
    // The load balancer pins the WebSocket to the node that answered negotiate via this cookie.
    const pre = await f(this.o.negotiateUrl ?? `${BASE}/signalrcore/negotiate`, { method: "OPTIONS", redirect: "error" });
    const alb = /AWSALBCORS=([^;]+)/.exec(pre.headers.get("set-cookie") ?? "")?.[1];
    const cookie: Record<string, string> = alb ? { cookie: `AWSALBCORS=${alb}` } : {};
    const neg = await f(`${this.o.negotiateUrl ?? `${BASE}/signalrcore/negotiate`}?negotiateVersion=1`, { method: "POST", headers: { ...auth, ...cookie }, redirect: "error" });
    if (neg.status === 401 || neg.status === 403) {
      await this.o.onUnauthorized?.();
      throw new F1AuthError("Live timing rejected the F1 account token. Sign in again.");
    }
    if (!neg.ok) throw new Error(`Live timing negotiate failed (HTTP ${neg.status})`);
    const body = (await neg.json()) as { connectionToken?: string; connectionId?: string };
    const id = body.connectionToken ?? body.connectionId;
    if (!id) throw new Error("Live timing negotiate returned no connection id");

    const ws = await (this.o.connect ?? nodeWebSocketFactory)(`${this.o.hubUrl ?? HUB}?id=${encodeURIComponent(id)}`, { ...auth, ...cookie });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      let handshaken = false;
      ws.onerror = (e) => {
        this.lastError = (e as { message?: string })?.message ?? "WebSocket error";
        if (!handshaken) reject(new Error(this.lastError));
      };
      ws.onclose = (e) => {
        this.closed = { code: e.code, reason: e.reason };
        if (!handshaken) reject(new Error(`Live timing connection closed (${e.code ?? "?"})`));
      };
      ws.onopen = () => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      ws.onmessage = (ev) => {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        for (const frame of text.split(RS)) {
          if (!frame) continue;
          let msg: JsonObject;
          try {
            msg = JSON.parse(frame) as JsonObject;
          } catch {
            continue;
          }
          if (!handshaken) {
            handshaken = true;
            if (typeof msg.error === "string") return reject(new Error(`Live timing handshake failed: ${msg.error}`));
            ws.send(JSON.stringify({ type: 1, invocationId: "0", target: "Subscribe", arguments: [[...LIVE_TOPICS]] }) + RS);
            this.ping = setInterval(() => ws.send(JSON.stringify({ type: 6 }) + RS), PING_MS);
            resolve();
            continue;
          }
          this.queue = this.queue.then(() => this.onMessage(msg)).catch(() => {});
        }
      };
    });
  }

  async stop(): Promise<void> {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.ws?.close(1000);
    this.ws = null;
  }

  /** Current session key from SessionInfo, once the initial state arrived. */
  get sessionKey(): number | null {
    const k = this.state.SessionInfo?.Key;
    return typeof k === "number" ? k : null;
  }

  private async onMessage(msg: JsonObject) {
    if (msg.type === 1 && msg.target === "feed" && Array.isArray(msg.arguments)) {
      const [topic, data, utc] = msg.arguments as [string, Json, string];
      await this.apply(topic, data, Date.parse(String(utc)));
    } else if (msg.type === 3 && msg.invocationId === "0" && isObject(msg.result)) {
      // Subscribe completion: full current state per topic.
      for (const [topic, data] of Object.entries(msg.result)) await this.apply(topic, data, Date.now(), true);
    } else if (msg.type === 7) {
      this.closed = { reason: typeof msg.error === "string" ? msg.error : "closed by server" };
    }
  }

  private async apply(topic: string, data: Json, t: number, initial = false) {
    let payload = data;
    if (topic.endsWith(".z") && typeof data === "string") {
      try {
        payload = JSON.parse(await inflateRawBase64(data)) as Json;
      } catch {
        return;
      }
    }
    if (Number.isFinite(t)) this.buf.latest = Math.max(this.buf.latest ?? 0, t);
    if (topic === "CarData.z") return this.bufferCar(payload);
    if (topic === "Position.z") return this.bufferPosition(payload);
    if (!isObject(payload)) return;
    if (topic === "TimingData" && !initial) this.bufferTiming(payload, t);
    if (topic === "RaceControlMessages") this.bufferRaceControl(payload);
    if (topic === "WeatherData") this.bufferWeather(payload, t);
    this.state[topic] = initial ? payload : deepMerge(this.state[topic] ?? {}, payload);
  }

  private bufferCar(p: Json) {
    if (!isObject(p) || !Array.isArray(p.Entries) || this.bufferedSamples > MAX_BUFFERED_SAMPLES) return;
    for (const e of p.Entries) {
      if (!isObject(e) || !isObject(e.Cars)) continue;
      const t = Date.parse(String(e.Utc).replace(/(\.\d{3})\d+/, "$1"));
      for (const [num, c] of Object.entries(e.Cars)) {
        const ch = isObject(c) && isObject(c.Channels) ? c.Channels : null;
        if (!ch || typeof ch["2"] !== "number" || typeof ch["4"] !== "number") continue;
        const dn = Number(num);
        if (!this.buf.car.has(dn)) this.buf.car.set(dn, { t: [], speed: [], throttle: [], brake: [], rpm: [], gear: [], drs: [] });
        const s = this.buf.car.get(dn)!;
        s.t.push(t);
        s.speed.push(ch["2"]);
        s.throttle.push(Math.min(100, Math.max(0, ch["4"])));
        s.brake.push(Number(ch["5"] ?? 0) > 0 ? 1 : 0);
        s.rpm!.push(typeof ch["0"] === "number" ? ch["0"] : Number.NaN);
        s.gear!.push(typeof ch["3"] === "number" ? ch["3"] : Number.NaN);
        s.drs!.push(typeof ch["45"] === "number" ? ch["45"] : null);
        this.bufferedSamples++;
      }
    }
  }

  private bufferPosition(p: Json) {
    if (!isObject(p) || !Array.isArray(p.Position) || this.bufferedSamples > MAX_BUFFERED_SAMPLES) return;
    for (const sample of p.Position) {
      if (!isObject(sample) || !isObject(sample.Entries)) continue;
      const t = Date.parse(String(sample.Timestamp).replace(/(\.\d{3})\d+/, "$1"));
      for (const [num, e] of Object.entries(sample.Entries)) {
        if (!isObject(e) || typeof e.X !== "number" || typeof e.Y !== "number") continue;
        if (e.X === 0 && e.Y === 0 && (e.Z ?? 0) === 0) continue;
        const dn = Number(num);
        if (!this.buf.position.has(dn)) this.buf.position.set(dn, { t: [], x: [], y: [], z: [] });
        const s = this.buf.position.get(dn)!;
        s.t.push(t);
        s.x.push(e.X * 0.1);
        s.y.push(e.Y * 0.1);
        s.z.push(typeof e.Z === "number" ? e.Z * 0.1 : Number.NaN);
        this.bufferedSamples++;
      }
    }
  }

  private bufferTiming(p: JsonObject, t: number) {
    if (!isObject(p.Lines)) return;
    const date = new Date(t).toISOString();
    const prevLines = (this.state.TimingData?.Lines ?? {}) as JsonObject;
    for (const [num, patch] of Object.entries(p.Lines)) {
      if (!isObject(patch)) continue;
      const dn = Number(num);
      if (patch.Position !== undefined && Number.isInteger(Number(patch.Position))) {
        this.buf.positionHistory.push({ date, driverNumber: dn, position: Number(patch.Position) });
      }
      const gapRaw = typeof patch.GapToLeader === "string" ? patch.GapToLeader : null;
      const ivRaw = isObject(patch.IntervalToPositionAhead) && typeof patch.IntervalToPositionAhead.Value === "string" ? patch.IntervalToPositionAhead.Value : null;
      if (gapRaw !== null || ivRaw !== null) {
        const g = parseGap(gapRaw);
        this.buf.intervals.push({ date, driverNumber: dn, gapToLeader: g.seconds, interval: parseGap(ivRaw).seconds, lapsDown: g.lapsDown });
      }
      // A completed lap: NumberOfLaps advanced and/or a new LastLapTime arrived.
      const lastLap = isObject(patch.LastLapTime) ? parseLapTime(patch.LastLapTime.Value) : undefined;
      if (typeof patch.NumberOfLaps === "number" && typeof lastLap === "number") {
        const prev = isObject(prevLines[num]) ? (prevLines[num] as JsonObject) : {};
        const merged = deepMerge(structuredClone(prev), patch);
        const sec = (i: number) => {
          const s = isObject(merged.Sectors) ? (merged.Sectors as JsonObject)[String(i)] : undefined;
          const v = isObject(s) ? parseLapTime(s.Value) : undefined;
          return typeof v === "number" ? v : null;
        };
        const speed = (k: string) => {
          const s = isObject(merged.Speeds) ? (merged.Speeds as JsonObject)[k] : undefined;
          const v = isObject(s) ? Number(s.Value) : NaN;
          return Number.isFinite(v) && v > 0 ? v : null;
        };
        this.buf.laps.push({
          driverNumber: dn,
          lapNumber: patch.NumberOfLaps,
          dateStart: new Date(t - lastLap * 1000).toISOString(),
          lapTime: lastLap,
          sector1: sec(0),
          sector2: sec(1),
          sector3: sec(2),
          i1Speed: speed("I1"),
          i2Speed: speed("I2"),
          stSpeed: speed("ST"),
          isPitOutLap: false,
          miniSectors: [],
        });
      }
    }
  }

  private bufferRaceControl(p: JsonObject) {
    const msgs = Array.isArray(p.Messages) ? p.Messages : isObject(p.Messages) ? Object.values(p.Messages) : [];
    for (const m of msgs) {
      if (!isObject(m)) continue;
      const t = Date.parse(String(m.Utc).replace(/(\.\d{3})\d+/, "$1") + (/Z$/.test(String(m.Utc)) ? "" : "Z"));
      if (!Number.isFinite(t)) continue;
      this.buf.raceControl.push({
        date: new Date(t).toISOString(),
        lapNumber: typeof m.Lap === "number" ? m.Lap : null,
        category: String(m.Category ?? "Other"),
        flag: typeof m.Flag === "string" ? m.Flag : null,
        scope: typeof m.Scope === "string" ? m.Scope : null,
        sector: typeof m.Sector === "number" ? m.Sector : null,
        driverNumber: m.RacingNumber !== undefined && Number.isFinite(Number(m.RacingNumber)) ? Number(m.RacingNumber) : null,
        message: String(m.Message ?? "").slice(0, 500),
      });
    }
  }

  private bufferWeather(p: JsonObject, t: number) {
    const n = (v: unknown) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    this.buf.weather.push({
      date: new Date(Number.isFinite(t) ? t : Date.now()).toISOString(),
      airTemperature: n(p.AirTemp),
      trackTemperature: n(p.TrackTemp),
      humidity: n(p.Humidity),
      pressure: n(p.Pressure),
      rainfall: p.Rainfall === undefined ? null : String(p.Rainfall) === "1",
      windSpeed: n(p.WindSpeed),
      windDirection: n(p.WindDirection),
    });
  }

  /** Everything received since the previous drain, for the requested session only. */
  async drain(sessionKey: number): Promise<LiveDelta> {
    await this.queue;
    if (this.closed) throw new Error(`Live timing connection closed: ${this.closed.reason ?? this.closed.code ?? "unknown"}`);
    const current = this.sessionKey;
    if (current !== null && current !== sessionKey) {
      throw new Error(`Session ${sessionKey} is not the session currently live on F1 live timing (${current})`);
    }
    const b = this.buf;
    this.buf = emptyBuffer();
    this.bufferedSamples = 0;
    const latest = b.latest !== null ? new Date(b.latest).toISOString() : null;
    return {
      cursor: latest ?? new Date().toISOString(),
      sourceTimestamp: latest,
      car: b.car,
      position: b.position,
      bundle: { raceControl: b.raceControl, positionHistory: b.positionHistory, intervals: b.intervals, weather: b.weather, laps: b.laps },
    };
  }
}
