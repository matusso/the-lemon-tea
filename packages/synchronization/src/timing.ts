import type {
  Driver,
  IntervalRecord,
  Lap,
  PitEvent,
  PositionRecord,
  RaceControlEvent,
  SessionResult,
  SessionType,
  Stint,
  TeamRadio,
  TyreCompound,
  WeatherObservation,
} from "@lemon-tea/shared-types";
import { theilSen } from "@lemon-tea/telemetry-core";

/**
 * Coordinate systems (kept distinct throughout the platform):
 *  - UTC:              ISO strings / epoch ms from the source ("authoritative" timestamps)
 *  - session time:     ms since session.dateStart (`tMs`); used by replay and live
 *  - lap time:         seconds since a lap's start
 *  - lap distance:     metres from the start/finish line on the normalised lap
 */
export interface TimingBundle {
  sessionId: string;
  sessionType: SessionType;
  /** Epoch ms of session.dateStart; session time 0. */
  epochMs: number;
  endMs: number | null;
  drivers: Driver[];
  laps: Lap[];
  stints: Stint[];
  pitEvents: PitEvent[];
  raceControl: RaceControlEvent[];
  weather: WeatherObservation[];
  teamRadio: TeamRadio[];
  positionHistory: PositionRecord[];
  intervals: IntervalRecord[];
  results: SessionResult[];
}

export const toSessionMs = (b: Pick<TimingBundle, "epochMs">, iso: string) => Date.parse(iso) - b.epochMs;
export const toUtcIso = (b: Pick<TimingBundle, "epochMs">, tMs: number) => new Date(b.epochMs + tMs).toISOString();

export type DriverStatus = "running" | "in_pit" | "retired" | "not_started" | "finished";

export interface TowerRow {
  position: number | null;
  driverNumber: number;
  code: string;
  teamName: string;
  teamColour: string;
  /** Seconds; race: from interval feed (measured). Practice/quali: best-lap gap (calculated). */
  gapToLeader: number | null;
  interval: number | null;
  lapsDown: number | null;
  currentLap: number;
  lastLap: number | null;
  bestLap: number | null;
  /** Sector times of the lap currently in progress (null until completed). */
  sectors: [number | null, number | null, number | null];
  /** Personal-best sectors so far. */
  bestSectors: [number | null, number | null, number | null];
  compound: TyreCompound | null;
  tyreAge: number | null;
  pitStops: number;
  status: DriverStatus;
  positionsGained: number | null;
  /** Slope of the last up-to-5 representative lap times (s/lap). Negative = getting faster. */
  paceTrend: number | null;
  gapKind: "measured" | "calculated";
}

/** Timing tower state at session time `tMs`, using only data timestamped at or before tMs. */
export function timingTower(b: TimingBundle, tMs: number): TowerRow[] {
  const at = b.epochMs + tMs;
  const isRace = b.sessionType === "race" || b.sessionType === "sprint";
  const lapsBy = groupBy(b.laps, (l) => l.driverNumber);
  const stintsBy = groupBy(b.stints, (s) => s.driverNumber);
  const pitsBy = groupBy(b.pitEvents, (p) => p.driverNumber);
  const posBy = groupBy(b.positionHistory, (p) => p.driverNumber);
  const ivBy = groupBy(b.intervals, (p) => p.driverNumber);
  const resultBy = new Map(b.results.map((r) => [r.driverNumber, r]));

  const rows: TowerRow[] = b.drivers.map((d) => {
    const laps = (lapsBy.get(d.driverNumber) ?? []).filter((l) => l.dateStart !== null && Date.parse(l.dateStart) <= at);
    const completed = laps.filter((l) => l.lapTime !== null && Date.parse(l.dateStart!) + l.lapTime * 1000 <= at);
    const current = laps[laps.length - 1];
    const lastLap = completed.length ? completed[completed.length - 1]!.lapTime : null;
    const valid = completed.filter((l) => !l.isPitOutLap).map((l) => l.lapTime!);
    const bestLap = valid.length ? Math.min(...valid) : null;
    const sectors: TowerRow["sectors"] = [null, null, null];
    if (current?.dateStart) {
      const t0 = Date.parse(current.dateStart);
      let acc = 0;
      ([current.sector1, current.sector2, current.sector3] as (number | null)[]).forEach((s, i) => {
        if (s === null) return;
        acc += s;
        if (t0 + acc * 1000 <= at) sectors[i] = s;
      });
    }
    const bestSectors = ([1, 2, 3] as const).map((k) => {
      const key = `sector${k}` as const;
      const v = completed.map((l) => l[key]).filter((x): x is number => x !== null);
      return v.length ? Math.min(...v) : null;
    }) as TowerRow["bestSectors"];

    const lapNo = current?.lapNumber ?? 0;
    const stint = (stintsBy.get(d.driverNumber) ?? []).find((s) => lapNo >= s.lapStart && lapNo <= s.lapEnd) ?? null;
    const pits = (pitsBy.get(d.driverNumber) ?? []).filter((p) => Date.parse(p.date) <= at);
    const lastPit = pits[pits.length - 1];
    const inPit = lastPit ? at - Date.parse(lastPit.date) < (lastPit.laneDuration ?? 25) * 1000 : false;
    const posHist = (posBy.get(d.driverNumber) ?? []).filter((p) => Date.parse(p.date) <= at);
    const pos = posHist.length ? posHist[posHist.length - 1]!.position : null;
    const startPos = posBy.get(d.driverNumber)?.[0]?.position ?? null;
    const iv = latest((ivBy.get(d.driverNumber) ?? []), at);

    const res = resultBy.get(d.driverNumber);
    const sessionOver = b.endMs !== null && tMs >= b.endMs;
    let status: DriverStatus = laps.length ? "running" : "not_started";
    if (inPit) status = "in_pit";
    if (res && (res.status === "dnf" || res.status === "dsq") && current && current.lapNumber >= (res.laps ?? Infinity)) {
      const lastEnd = current.dateStart ? Date.parse(current.dateStart) + (current.lapTime ?? 120) * 1000 : at;
      if (at > lastEnd + 60_000) status = "retired";
    }
    if (sessionOver && status === "running") status = "finished";

    const recent = completed.filter((l) => !l.isPitOutLap && bestLap !== null && l.lapTime! < bestLap * 1.07).slice(-5);
    const trend = recent.length >= 3 ? theilSen(recent.map((_, i) => i), recent.map((l) => l.lapTime!)).slope : null;

    return {
      position: pos,
      driverNumber: d.driverNumber,
      code: d.code,
      teamName: d.teamName,
      teamColour: d.teamColour,
      gapToLeader: isRace ? iv?.gapToLeader ?? null : null,
      interval: isRace ? iv?.interval ?? null : null,
      lapsDown: iv?.lapsDown ?? null,
      currentLap: lapNo,
      lastLap,
      bestLap,
      sectors,
      bestSectors,
      compound: stint?.compound ?? null,
      tyreAge: stint ? (stint.tyreAgeAtStart ?? 0) + (lapNo - stint.lapStart) : null,
      pitStops: pits.length,
      status,
      positionsGained: isRace && pos !== null && startPos !== null ? startPos - pos : null,
      paceTrend: trend,
      gapKind: isRace ? "measured" : "calculated",
    };
  });

  if (!isRace) {
    // Practice/qualifying classification is by best lap time.
    rows.sort((a, c) => (a.bestLap ?? Infinity) - (c.bestLap ?? Infinity));
    const leader = rows[0]?.bestLap ?? null;
    rows.forEach((r, i) => {
      r.position = r.bestLap !== null ? i + 1 : null;
      r.gapToLeader = r.bestLap !== null && leader !== null ? r.bestLap - leader : null;
      r.interval = i > 0 && r.bestLap !== null && rows[i - 1]!.bestLap !== null ? r.bestLap - rows[i - 1]!.bestLap! : null;
    });
  } else {
    rows.sort((a, c) => (a.position ?? 99) - (c.position ?? 99));
  }
  return rows;
}

function latest<T extends { date: string }>(xs: T[], at: number): T | null {
  let lo = 0, hi = xs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(xs[mid]!.date) <= at) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? xs[ans]! : null;
}

export function weatherAt(b: TimingBundle, tMs: number): WeatherObservation | null {
  return latest(b.weather, b.epochMs + tMs);
}

/** Flag / neutralisation state from race-control messages up to tMs. */
export type TrackStatus = "green" | "yellow" | "sc" | "vsc" | "red" | "chequered" | "unknown";

export function trackStatusAt(b: TimingBundle, tMs: number): { status: TrackStatus; since: string | null; message: string | null } {
  const at = b.epochMs + tMs;
  let status: TrackStatus = "unknown";
  let since: string | null = null;
  let message: string | null = null;
  for (const e of b.raceControl) {
    if (Date.parse(e.date) > at) break;
    const m = e.message.toUpperCase();
    const f = (e.flag ?? "").toUpperCase();
    let next: TrackStatus | null = null;
    if (f === "RED") next = "red";
    else if (f === "CHEQUERED") next = "chequered";
    else if (m.includes("VIRTUAL SAFETY CAR DEPLOYED")) next = "vsc";
    else if (m.includes("SAFETY CAR DEPLOYED")) next = "sc";
    else if (f === "GREEN" || f === "CLEAR" || m.includes("VSC ENDING") || m.includes("SAFETY CAR IN THIS LAP")) next = "green";
    else if ((f === "YELLOW" || f === "DOUBLE YELLOW") && e.scope !== "Sector") next = "yellow";
    if (next) {
      status = next;
      since = e.date;
      message = e.message;
    }
  }
  return { status, since, message };
}

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}
