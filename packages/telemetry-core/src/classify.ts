import type { TyreCompound } from "@lemon-tea/shared-types";
import type { LapTiming } from "./samples.ts";
import { mad, median } from "./stats.ts";

export const CLASSIFIER_VERSION = "lap-classifier-v1";

export type LapClass =
  | "out_lap"
  | "in_lap"
  | "no_time"
  | "interrupted"
  | "traffic_affected"
  | "qualifying_simulation"
  | "push"
  | "long_run"
  | "cooldown"
  | "unrepresentative";

export interface ContextLap extends LapTiming {
  sessionId: string;
  compound: TyreCompound;
  stintNumber: number | null;
  /** Laps on this tyre set at the start of this lap; null when the set history is unknown. */
  tyreAge: number | null;
  trackTemperature?: number | null;
  /** Seconds to the car ahead on track at lap start, when computable. */
  gapAhead?: number | null;
}

export interface ClassifiedLap extends ContextLap {
  classes: LapClass[];
  /** The primary label used for downstream selection. */
  primary: LapClass;
  runId: string | null;
}

/** Transparent, configurable thresholds. Documented in docs/PREDICTION_MODELS.md. */
export interface ClassifierConfig {
  /** Push lap if within this fraction of the session-best lap. */
  pushThreshold: number;
  /** Long-run laps must be within this fraction of their run median. */
  longRunBand: number;
  /** Minimum consecutive representative laps for a long run. */
  longRunMinLaps: number;
  /** Cooldown laps are this much slower than the driver's push pace. */
  cooldownThreshold: number;
  /** Traffic if gap to car ahead below this (s). */
  trafficGap: number;
  /** Robust z-score above which a lap within a run is unrepresentative. */
  outlierZ: number;
  /** Max tyre age (laps at lap start) for a qualifying simulation. */
  qualiSimMaxTyreAge: number;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  pushThreshold: 0.03,
  longRunBand: 0.04,
  longRunMinLaps: 5,
  cooldownThreshold: 0.1,
  trafficGap: 1.0,
  outlierZ: 3,
  qualiSimMaxTyreAge: 2,
};

export interface NeutralisedPeriod {
  fromMs: number;
  toMs: number;
  kind: "yellow" | "double_yellow" | "sc" | "vsc" | "red";
}

/**
 * Classify all laps of one session. A lap can carry several classes; `primary` is chosen by
 * precedence (no_time > out/in > interrupted > traffic > quali sim > long run > push > cooldown).
 */
export function classifyLaps(
  laps: ContextLap[],
  neutralised: NeutralisedPeriod[],
  pitLapsByDriver: Map<number, Set<number>>,
  cfg: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
): ClassifiedLap[] {
  const timed = laps.filter((l) => l.lapTime !== null);
  const sessionBest = timed.length ? Math.min(...timed.map((l) => l.lapTime!)) : Number.NaN;
  const out: ClassifiedLap[] = [];
  const byDriver = new Map<number, ContextLap[]>();
  for (const l of laps) {
    if (!byDriver.has(l.driverNumber)) byDriver.set(l.driverNumber, []);
    byDriver.get(l.driverNumber)!.push(l);
  }

  for (const [driver, dl] of byDriver) {
    dl.sort((a, b) => a.lapNumber - b.lapNumber);
    const pits = pitLapsByDriver.get(driver) ?? new Set<number>();
    const driverTimes = dl.filter((l) => l.lapTime !== null && !l.isPitOutLap).map((l) => l.lapTime!);
    const driverBest = driverTimes.length ? Math.min(...driverTimes) : Number.NaN;

    const tagged = dl.map((l, i): ClassifiedLap => {
      const classes: LapClass[] = [];
      const next = dl[i + 1];
      if (l.lapTime === null) classes.push("no_time");
      if (l.isPitOutLap || (i > 0 && l.stintNumber !== null && dl[i - 1]!.stintNumber !== l.stintNumber)) classes.push("out_lap");
      if (pits.has(l.lapNumber) || (next && next.isPitOutLap)) classes.push("in_lap");
      if (l.startMs !== null && l.lapTime !== null) {
        const s = l.startMs;
        const e = s + l.lapTime * 1000;
        if (neutralised.some((p) => p.fromMs < e && p.toMs > s)) classes.push("interrupted");
      }
      if (l.gapAhead != null && l.gapAhead < cfg.trafficGap) classes.push("traffic_affected");
      if (l.lapTime !== null && l.lapTime <= sessionBest * (1 + cfg.pushThreshold)) classes.push("push");
      if (l.lapTime !== null && Number.isFinite(driverBest) && l.lapTime > driverBest * (1 + cfg.cooldownThreshold)) classes.push("cooldown");
      return { ...l, classes, primary: "unrepresentative", runId: null };
    });

    markLongRuns(tagged, cfg);

    for (const l of tagged) {
      if (l.classes.includes("push") && (l.tyreAge ?? 99) <= cfg.qualiSimMaxTyreAge && !l.classes.includes("out_lap")) {
        l.classes.push("qualifying_simulation");
      }
      l.primary = pickPrimary(l.classes);
      out.push(l);
    }
  }
  return out;
}

const PRECEDENCE: LapClass[] = [
  "no_time",
  "out_lap",
  "in_lap",
  "interrupted",
  "traffic_affected",
  "qualifying_simulation",
  "long_run",
  "push",
  "cooldown",
  "unrepresentative",
];

function pickPrimary(classes: LapClass[]): LapClass {
  for (const p of PRECEDENCE) if (classes.includes(p)) return p;
  return "unrepresentative";
}

const BLOCKING: LapClass[] = ["no_time", "out_lap", "in_lap", "interrupted"];

/** Long runs: maximal sequences inside one stint of consecutive representative laps. */
function markLongRuns(dl: ClassifiedLap[], cfg: ClassifierConfig) {
  let run: ClassifiedLap[] = [];
  const flush = () => {
    const usable = run.filter((l) => !l.classes.some((c) => BLOCKING.includes(c)));
    if (usable.length >= cfg.longRunMinLaps) {
      const times = usable.map((l) => l.lapTime!);
      const m = median(times);
      const s = Math.max(mad(times), 0.05);
      const inBand = usable.filter((l) => Math.abs(l.lapTime! - m) <= m * cfg.longRunBand);
      if (inBand.length >= cfg.longRunMinLaps) {
        const id = `${run[0]!.sessionId}:${run[0]!.driverNumber}:${run[0]!.lapNumber}`;
        for (const l of inBand) {
          if ((l.lapTime! - m) / s > cfg.outlierZ) l.classes.push("unrepresentative");
          else l.classes.push("long_run");
          l.runId = id;
        }
      }
    }
    run = [];
  };
  for (let i = 0; i < dl.length; i++) {
    const l = dl[i]!;
    const prev = dl[i - 1];
    const breaks = !prev || prev.stintNumber !== l.stintNumber || prev.lapNumber + 1 !== l.lapNumber || l.classes.includes("out_lap");
    if (breaks) flush();
    run.push(l);
  }
  flush();
}

/** Laps under neutralisation derived from race-control flags. */
export function neutralisedPeriods(
  events: { tMs: number; category: string; flag: string | null; message: string }[],
  sessionEndMs: number,
): NeutralisedPeriod[] {
  const sorted = [...events].sort((a, b) => a.tMs - b.tMs);
  const periods: NeutralisedPeriod[] = [];
  let open: { kind: NeutralisedPeriod["kind"]; from: number } | null = null;
  const close = (t: number) => {
    if (open) periods.push({ fromMs: open.from, toMs: t, kind: open.kind });
    open = null;
  };
  for (const e of sorted) {
    const msg = e.message.toUpperCase();
    const flag = (e.flag ?? "").toUpperCase();
    if (flag === "RED") { close(e.tMs); open = { kind: "red", from: e.tMs }; continue; }
    if (msg.includes("VIRTUAL SAFETY CAR DEPLOYED") || msg.includes("VSC DEPLOYED")) { close(e.tMs); open = { kind: "vsc", from: e.tMs }; continue; }
    if (msg.includes("SAFETY CAR DEPLOYED")) { close(e.tMs); open = { kind: "sc", from: e.tMs }; continue; }
    if (msg.includes("VSC ENDING") || msg.includes("SAFETY CAR IN THIS LAP") || flag === "GREEN" || flag === "CLEAR") {
      // Sector-scoped yellows are short; a CLEAR/GREEN closes whatever is open.
      close(e.tMs);
      continue;
    }
    if (flag === "DOUBLE YELLOW" || flag === "YELLOW") {
      if (!open) open = { kind: flag === "YELLOW" ? "yellow" : "double_yellow", from: e.tMs };
    }
  }
  close(sessionEndMs);
  return periods;
}
