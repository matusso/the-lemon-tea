import { useEffect, useState } from "react";
import { LiveBuffer, type LiveSamplesPayload, type TimingBundle } from "@lemon-tea/synchronization";

/** Timing rows received live (merged into the session bundle so the tower and timeline run live). */
export type LiveTiming = Pick<TimingBundle, "laps" | "positionHistory" | "intervals" | "raceControl" | "weather">;
const EMPTY_TIMING: LiveTiming = { laps: [], positionHistory: [], intervals: [], raceControl: [], weather: [] };

/** Sessions are offered as live from 15 min before the start until 30 min after the scheduled end. */
export function isLiveWindow(s: { dateStart: string; dateEnd: string | null }, now = Date.now()): boolean {
  const start = Date.parse(s.dateStart);
  const end = s.dateEnd ? Date.parse(s.dateEnd) : start + 2.5 * 3600_000;
  return now >= start - 15 * 60_000 && now <= end + 30 * 60_000;
}

export type LiveState = "connecting" | "live" | "waiting" | "degraded" | "unavailable" | "error" | "closed";

export interface LiveStatus {
  state: LiveState;
  message: string | null;
  /** Age of the newest source timestamp when the server received it (source → server lag). */
  lagMs: number | null;
  /** When the last delta arrived (epoch ms). */
  lastAt: number | null;
}

interface LiveMessage {
  type: "delta" | "status";
  sourceTimestamp?: string | null;
  receivedAt?: string;
  payload: { car?: LiveSamplesPayload["car"]; position?: LiveSamplesPayload["position"]; bundle?: Partial<LiveTiming>; state?: string; error?: string; reason?: string } | null;
}

const CLOSED: LiveStatus = { state: "closed", message: null, lagMs: null, lastAt: null };

/**
 * Subscribe to the live WebSocket of a session. Samples go into a rolling LiveBuffer (session time)
 * that the 3D map and live telemetry read; React re-renders on `revision` (throttled to ~2 Hz) and
 * on status changes. Reconnects with back-off while mounted.
 */
export function useLiveFeed(sessionId: string | null, epochMs: number | null, enabled: boolean) {
  const [status, setStatus] = useState<LiveStatus>(CLOSED);
  const [revision, setRevision] = useState(0);
  const [buffer, setBuffer] = useState<LiveBuffer | null>(null);
  const [timing, setTiming] = useState<LiveTiming>(EMPTY_TIMING);

  useEffect(() => {
    if (!enabled || !sessionId || epochMs === null) {
      setBuffer(null);
      setStatus(CLOSED);
      setTiming(EMPTY_TIMING);
      return;
    }
    const buf = new LiveBuffer(epochMs);
    setBuffer(buf);
    // laps are re-sent as they complete: keep the latest row per driver and lap
    const laps = new Map<string, LiveTiming["laps"][number]>();
    const acc: LiveTiming = { laps: [], positionHistory: [], intervals: [], raceControl: [], weather: [] };
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let paintTimer: ReturnType<typeof setTimeout> | null = null;
    const paint = () => {
      if (paintTimer) return;
      paintTimer = setTimeout(() => {
        paintTimer = null;
        setRevision(buf.revision);
        setTiming({ ...acc, laps: [...laps.values()] });
      }, 500);
    };

    const connect = () => {
      setStatus((s) => ({ ...s, state: "connecting", message: null }));
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/live/${encodeURIComponent(sessionId)}`);
      ws.onopen = () => {
        retry = 0;
        setStatus((s) => ({ ...s, state: "waiting", message: "Connected, waiting for data" }));
      };
      ws.onmessage = (ev) => {
        let m: LiveMessage;
        try {
          m = JSON.parse(String(ev.data)) as LiveMessage;
        } catch {
          return;
        }
        if (m.type === "status") {
          const st = m.payload?.state;
          const state: LiveState = st === "unavailable" ? "unavailable" : st === "error" ? "error" : "degraded";
          setStatus((s) => ({ ...s, state, message: m.payload?.error ?? m.payload?.reason ?? null }));
          return;
        }
        const added = buf.ingest({ car: m.payload?.car ?? {}, position: m.payload?.position ?? {} });
        const tb = m.payload?.bundle ?? {};
        for (const l of tb.laps ?? []) laps.set(`${l.driverNumber}:${l.lapNumber}`, l);
        acc.positionHistory.push(...(tb.positionHistory ?? []));
        acc.intervals.push(...(tb.intervals ?? []));
        acc.raceControl.push(...(tb.raceControl ?? []));
        acc.weather.push(...(tb.weather ?? []));
        const timingRows = (tb.laps?.length ?? 0) + (tb.positionHistory?.length ?? 0) + (tb.intervals?.length ?? 0) + (tb.raceControl?.length ?? 0);
        const src = m.sourceTimestamp ? Date.parse(m.sourceTimestamp) : null;
        const rec = m.receivedAt ? Date.parse(m.receivedAt) : Date.now();
        setStatus({ state: buf.latestMs > -Infinity ? "live" : "waiting", message: null, lagMs: src !== null ? Math.max(0, rec - src) : null, lastAt: Date.now() });
        if (added || timingRows) paint();
      };
      ws.onclose = () => {
        if (stopped) return;
        retry++;
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
        setStatus((s) => (s.state === "unavailable" || s.state === "error" ? s : { ...s, state: "degraded", message: `Disconnected, retrying in ${Math.round(wait / 1000)} s` }));
        retryTimer = setTimeout(connect, wait);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (paintTimer) clearTimeout(paintTimer);
      ws?.close();
    };
  }, [sessionId, epochMs, enabled]);

  return { buffer, status, revision, timing };
}
