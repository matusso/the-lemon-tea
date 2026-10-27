import { isObject, parseLapTime, type Json, type JsonObject, type StreamRecord } from "./stream.ts";

/**
 * Lap reconstruction from the TimingData stream, ported from FastF1's `_api._laps_data_driver`
 * and `_stream_data_driver` (MIT, see NOTICE). TimingData is a mixed stream of per-driver
 * patches; values belong to "the current lap" only by arrival order, so the same heuristics
 * FastF1 uses are kept: two passes, a 5 s window for late values, the >150 s lap-time rule for
 * the gaps between Q1/Q2/Q3, sector back-filling from repeated values, and latency-based lap
 * end-time synchronisation. Lap and sector times are never modified, only assigned.
 *
 * All times are integer milliseconds (stream offsets) so equality checks are exact. NaN means
 * "not received"; null (lap time only) means the source explicitly sent an empty value.
 */

export interface DriverLapRow {
  time: number; // stream offset at which the lap ended
  lapTime: number | null; // ms
  numberOfLaps: number;
  numberOfPitStops: number;
  pitOutTime: number;
  pitInTime: number;
  sector: [number, number, number]; // ms
  sectorSessionTime: [number, number, number];
  speedI1: number;
  speedI2: number;
  speedFL: number;
  speedST: number;
}

export interface DriverStreamRow {
  time: number;
  position: number | null;
  gapToLeader: string | null;
  interval: string | null;
}

export interface DriverTiming {
  laps: DriverLapRow[];
  stream: DriverStreamRow[];
  retired: boolean;
  integrityErrors: number[];
}

const LATE_VALUE_MS = 5000;
const MAX_PLAUSIBLE_LAP_MS = 150_000;

const empty = (): DriverLapRow => ({
  time: NaN,
  lapTime: NaN,
  numberOfLaps: NaN,
  numberOfPitStops: NaN,
  pitOutTime: NaN,
  pitInTime: NaN,
  sector: [NaN, NaN, NaN],
  sectorSessionTime: [NaN, NaN, NaN],
  speedI1: NaN,
  speedI2: NaN,
  speedFL: NaN,
  speedST: NaN,
});

const na = (v: number | null) => v === null || Number.isNaN(v);
const toMs = (s: unknown): number | null | undefined => {
  const v = parseLapTime(s);
  return v === null || v === undefined ? v : Math.round(v * 1000);
};
const valueOf = (o: unknown, ...path: string[]): Json | undefined => {
  let cur: unknown = o;
  for (const p of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur as Json | undefined;
};
/** Python truthiness of a scalar: FastF1 skips empty strings, zero and missing values. */
const truthy = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== 0 && v !== false;

function sectorSum(r: DriverLapRow): number | null {
  const s = r.sector[0] + r.sector[1] + r.sector[2];
  return Number.isNaN(s) ? null : s;
}

/** Split a TimingData stream into per-driver patches. */
export function splitTimingByDriver(records: StreamRecord[]): Map<string, StreamRecord<JsonObject>[]> {
  const out = new Map<string, StreamRecord<JsonObject>[]>();
  for (const r of records) {
    const lines = valueOf(r.data, "Lines");
    if (!isObject(lines)) continue;
    for (const [drv, patch] of Object.entries(lines)) {
      if (!isObject(patch)) continue;
      if (!out.has(drv)) out.set(drv, []);
      out.get(drv)!.push({ offsetMs: r.offsetMs, data: patch });
    }
  }
  return out;
}

export function lapsForDriver(raw: StreamRecord<JsonObject>[]): DriverTiming | null {
  const integrityErrors: number[] = [];
  const nol = (resp: JsonObject) => (typeof resp.NumberOfLaps === "number" ? resp.NumberOfLaps : null);

  // Pass 1: find when laps start and end, so late values can be attributed in pass 2.
  const rows: DriverLapRow[] = [empty()];
  {
    let lapcnt = 0;
    let api = 0;
    let inPast = false;
    let outOfPit = false;
    for (const { offsetMs: t, data: resp } of raw) {
      const n = nol(resp);
      if (inPast && n === api) inPast = false;
      if (n !== null && n < api) {
        inPast = true;
        continue;
      }
      if (inPast) continue;
      if (resp.InPit === false) outOfPit = true;
      if (n !== null && n > api) {
        api++;
        if (outOfPit) {
          rows[lapcnt]!.time = t;
          lapcnt++;
          rows.push(empty());
        }
      }
    }
  }

  // Pass 2: fill in the values.
  let lapcnt = 0;
  let api = 0;
  let inPast = false;
  let pitstops = -1; // the first pit exit is the out lap, which must count as zero stops
  let retired = false;
  const row = (i: number) => {
    while (rows.length <= i) rows.push(empty());
    return rows[i]!;
  };
  for (const { offsetMs: t, data: resp } of raw) {
    const n = nol(resp);
    if (inPast && n === api) inPast = false;
    if (inPast || (n !== null && n < api)) {
      inPast = true;
      continue;
    }
    if (resp.Retired === true) retired = true;
    const lapOffset = lapcnt > 0 && t - row(lapcnt - 1).time < LATE_VALUE_MS ? 1 : 0;

    if (isObject(resp.Sectors)) {
      for (const sn of [0, 1, 2] as const) {
        const v = valueOf(resp, "Sectors", String(sn), "Value");
        const ms = truthy(v) ? toMs(v) : undefined;
        if (typeof ms === "number") {
          row(lapcnt - lapOffset).sector[sn] = ms;
          row(lapcnt - lapOffset).sectorSessionTime[sn] = t;
        }
      }
    }

    const llt = resp.LastLapTime;
    if (isObject(llt) && llt.Value !== undefined && llt.Value !== null) {
      const val = toMs(llt.Value);
      if (val !== undefined) {
        const idx = lapcnt - lapOffset;
        // Between Q1/Q2/Q3 the "lap time" is the time since the previous lap: only accept a long
        // value when the sectors received for this lap add up to exactly that value.
        if (val === null || val < MAX_PLAUSIBLE_LAP_MS || val === sectorSum(row(idx))) row(idx).lapTime = val;
      }
    }

    if (isObject(resp.Speeds)) {
      for (const [k, field] of [["I1", "speedI1"], ["I2", "speedI2"], ["FL", "speedFL"], ["ST", "speedST"]] as const) {
        const v = valueOf(resp, "Speeds", k, "Value");
        if (!truthy(v)) continue;
        const f = Number(v);
        if (!Number.isFinite(f)) continue;
        // The ST trap can come early enough in a new lap that the late-value offset must not apply.
        row(k === "ST" ? lapcnt : lapcnt - lapOffset)[field] = f;
      }
    }

    if ("InPit" in resp) {
      if (resp.InPit === true) {
        if (pitstops >= 0) row(lapcnt).pitInTime = t;
      } else if ((n !== null && n > api) || row(lapcnt).time - t < LATE_VALUE_MS) {
        row(lapcnt + 1).pitOutTime = t; // belongs to the lap that starts now
        pitstops++;
      } else {
        row(lapcnt).pitOutTime = t;
        pitstops++;
      }
    }

    if (n !== null && n > api) {
      api++;
      if (pitstops >= 0) {
        const r = row(lapcnt);
        r.time = t;
        r.numberOfLaps = lapcnt + 1; // own count; the source count can include a phantom lap
        r.numberOfPitStops = pitstops;
        lapcnt++;
      }
    }
  }
  if (lapcnt === 0) return null;

  const dataInLap = (r: DriverLapRow | undefined) =>
    !!r && [...r.sector, r.speedI1, r.speedI2, r.speedFL, r.speedST, r.lapTime].some((v) => !na(v));

  rows.length = Math.min(rows.length, lapcnt + 1);
  if (dataInLap(rows[lapcnt])) {
    rows[lapcnt]!.numberOfLaps = lapcnt + 1;
    rows[lapcnt]!.numberOfPitStops = pitstops;
  } else {
    rows.length = lapcnt;
  }
  if (!dataInLap(rows[0])) {
    rows.shift(); // pseudo out-lap that never existed
    for (const r of rows) r.numberOfLaps -= 1;
  }
  if (!rows.length) return { laps: [], stream: streamForDriver(raw), retired, integrityErrors };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    let sum = 0;
    const missing: number[] = [];
    r.sector.forEach((s, k) => (Number.isNaN(s) ? missing.push(k) : (sum += s)));
    if (r.lapTime !== null && sum > r.lapTime) {
      r.lapTime = NaN;
      integrityErrors.push(i + 1);
    }
    // Only an explicit empty value is replaced by the sector sum (never a value we did not get).
    if (r.lapTime === null) r.lapTime = missing.length ? NaN : sum;
    if (i === 0) continue;
    const prev = rows[i - 1]!;
    // The source only sends changes, so a value equal to the previous lap's can be missing.
    if (!missing.length && na(r.lapTime) && prev.lapTime === sum) {
      r.lapTime = sum;
    } else if (missing.length === 1 && !na(r.lapTime)) {
      const k = missing[0]!;
      const others = r.sector.reduce((a, s, j) => (j === k ? a : a + s), 0);
      const candidate = (r.lapTime as number) - others;
      if (candidate === prev.sector[k]) r.sector[k] = candidate;
    }
  }

  // Lap end: take the earliest of S3 time, S2 time + S3, S1 time + S2 + S3 (least latency).
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    let sum = 0;
    let minTime = r.time;
    const pairs: [number, number][] = [
      [0, r.sectorSessionTime[2]],
      [r.sector[2], r.sectorSessionTime[1]],
      [r.sector[1], r.sectorSessionTime[0]],
    ];
    for (const [sectorTime, sessionTime] of pairs) {
      if (Number.isNaN(sessionTime)) continue;
      if (Number.isNaN(sectorTime)) break;
      sum += sectorTime;
      const candidate = sessionTime + sum;
      if (candidate < minTime || Number.isNaN(minTime)) minTime = candidate;
    }
    if (i > 0 && minTime < rows[i - 1]!.time) {
      integrityErrors.push(i + 1);
      continue;
    }
    r.time = minTime;
  }

  const last = rows.at(-1)!;
  if (Number.isNaN(last.time)) {
    if (!Number.isNaN(last.pitInTime)) last.time = last.pitInTime;
    else rows.pop();
  }
  if (!rows.length) return { laps: [], stream: streamForDriver(raw), retired, integrityErrors };

  for (let i = rows.length - 1; i > 0; i--) {
    const candidate = rows[i]!.time - (rows[i]!.lapTime ?? NaN);
    if (candidate < rows[i - 1]!.time) {
      if (i > 1 && candidate < rows[i - 2]!.time) integrityErrors.push(i + 1);
      else rows[i - 1]!.time = candidate;
    }
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const r = rows[i]!;
    const nx = rows[i + 1]!;
    if (Number.isNaN(r.time) || na(nx.lapTime)) continue;
    if (r.time + (nx.lapTime as number) < nx.time) nx.time = r.time + (nx.lapTime as number);
    let acc = r.time;
    for (const k of [0, 1, 2] as const) {
      if (Number.isNaN(nx.sector[k])) break;
      acc += nx.sector[k];
      if (acc < nx.sectorSessionTime[k]) nx.sectorSessionTime[k] = acc;
    }
  }

  // Laps to the grid can produce pit stops before lap 1; count from zero.
  const offset = rows[0]!.numberOfPitStops;
  for (const r of rows) r.numberOfPitStops -= offset;
  if (rows[0]!.pitInTime < rows[0]!.pitOutTime) rows[0]!.pitInTime = NaN;

  return { laps: rows, stream: streamForDriver(raw), retired, integrityErrors };
}

/** Position / gap samples; every field carries its last known value forward. */
export function streamForDriver(raw: StreamRecord<JsonObject>[]): DriverStreamRow[] {
  const out: DriverStreamRow[] = [];
  let cur: DriverStreamRow = { time: NaN, position: null, gapToLeader: null, interval: null };
  for (const { offsetMs: t, data: resp } of raw) {
    let changed = false;
    if (truthy(resp.Position)) {
      const p = Number(resp.Position);
      if (Number.isInteger(p)) {
        cur = { ...cur, position: p };
        changed = true;
      }
    }
    if (truthy(resp.GapToLeader)) {
      cur = { ...cur, gapToLeader: String(resp.GapToLeader) };
      changed = true;
    }
    const iv = valueOf(resp, "IntervalToPositionAhead", "Value");
    if (truthy(iv)) {
      cur = { ...cur, interval: String(iv) };
      changed = true;
    }
    if (changed) out.push({ ...cur, time: t });
  }
  return out;
}

/** "+1.234" → 1.234; "1L"/"2 LAPS" → laps down; "LAP 12" (leader) → 0. */
export function parseGap(s: string | null): { seconds: number | null; lapsDown: number | null } {
  if (s === null) return { seconds: null, lapsDown: null };
  const t = s.trim().toUpperCase();
  if (/^LAP\s*\d+$/.test(t)) return { seconds: 0, lapsDown: null };
  const lapped = /^\+?(\d+)\s*L/.exec(t);
  if (lapped) return { seconds: null, lapsDown: Number(lapped[1]) };
  const v = Number(t.replace(/^\+/, ""));
  return Number.isFinite(v) ? { seconds: v, lapsDown: null } : { seconds: null, lapsDown: null };
}
