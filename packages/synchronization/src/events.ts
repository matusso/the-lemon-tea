import type { TimingBundle } from "./timing.ts";

export type TimelineEventKind =
  | "flag"
  | "safety_car"
  | "vsc"
  | "red_flag"
  | "start"
  | "pit_stop"
  | "retirement"
  | "investigation"
  | "penalty"
  | "message"
  | "team_radio"
  | "chequered";

export interface TimelineEvent {
  tMs: number;
  date: string;
  kind: TimelineEventKind;
  driverNumber: number | null;
  lapNumber: number | null;
  label: string;
  /** Raw source text; untrusted, display-only. */
  sourceText?: string;
  ref?: string;
}

/** One chronologically sorted event stream; clicking an event seeks every synchronised view. */
export function buildTimeline(b: TimingBundle): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  const t = (iso: string) => Date.parse(iso) - b.epochMs;
  for (const r of b.raceControl) {
    const m = r.message.toUpperCase();
    const f = (r.flag ?? "").toUpperCase();
    let kind: TimelineEventKind = "message";
    if (f === "RED") kind = "red_flag";
    else if (f === "CHEQUERED") kind = "chequered";
    else if (m.includes("VIRTUAL SAFETY CAR")) kind = "vsc";
    else if (m.includes("SAFETY CAR")) kind = "safety_car";
    else if (m.includes("UNDER INVESTIGATION") || m.includes("NOTED")) kind = "investigation";
    else if (m.includes("PENALTY")) kind = "penalty";
    else if (f) kind = "flag";
    ev.push({ tMs: t(r.date), date: r.date, kind, driverNumber: r.driverNumber, lapNumber: r.lapNumber, label: kind.replaceAll("_", " "), sourceText: r.message });
  }
  for (const p of b.pitEvents) {
    ev.push({
      tMs: t(p.date),
      date: p.date,
      kind: "pit_stop",
      driverNumber: p.driverNumber,
      lapNumber: p.lapNumber,
      label: `#${p.driverNumber} pit${p.stopDuration ? ` ${p.stopDuration.toFixed(1)} s stationary` : ""}${p.laneDuration ? `, ${p.laneDuration.toFixed(1)} s lane` : ""}`,
    });
  }
  for (const r of b.teamRadio) {
    ev.push({ tMs: t(r.date), date: r.date, kind: "team_radio", driverNumber: r.driverNumber, lapNumber: null, label: `#${r.driverNumber} team radio`, ...(r.recordingUrl ? { ref: r.recordingUrl } : {}) });
  }
  if (b.sessionType === "race" || b.sessionType === "sprint") {
    const lap1 = b.laps.filter((l) => l.lapNumber === 1 && l.dateStart).map((l) => Date.parse(l.dateStart!));
    if (lap1.length) {
      const ms = Math.min(...lap1);
      ev.push({ tMs: ms - b.epochMs, date: new Date(ms).toISOString(), kind: "start", driverNumber: null, lapNumber: 1, label: "Race start" });
    }
    for (const r of b.results) {
      if (r.status !== "dnf") continue;
      const last = b.laps.filter((l) => l.driverNumber === r.driverNumber && l.dateStart).at(-1);
      if (!last) continue;
      const ms = Date.parse(last.dateStart!) + (last.lapTime ?? 90) * 1000;
      ev.push({ tMs: ms - b.epochMs, date: new Date(ms).toISOString(), kind: "retirement", driverNumber: r.driverNumber, lapNumber: last.lapNumber, label: `#${r.driverNumber} retired (approximate time)` });
    }
  }
  return ev.sort((a, c) => a.tMs - c.tMs);
}
