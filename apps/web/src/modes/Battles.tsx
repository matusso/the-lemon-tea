import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  analysePair,
  BATTLE_CAVEATS,
  buildTrackFrame,
  carAt,
  DEFAULT_BATTLE_OPTIONS as OPT,
  detectApexes,
  lateralResolution,
  pointOnFrame,
  scanBattles,
  withSide,
  smoothTrack,
  trackCar,
  wrappedGap,
  type CarTrack,
  type Encounter,
  type Side,
  type TrackFrame,
} from "@lemon-tea/telemetry-core";
import type { TimingBundle } from "@lemon-tea/synchronization";
import { get, type CircuitResponse } from "../api";
import { useBundle, useCircuit } from "../data";
import { clock } from "../state/clock";
import { useUi } from "../state/store";
import { Combobox, type ComboOption } from "../components/Combobox";
import { Btn, Empty, ErrorNote, Frame, KindBadge, Loading, Stepper } from "../components/ui";
import { COLOR_A, COLOR_B } from "../components/TelemetryCharts";

type Driver = TimingBundle["drivers"][number];
const MAX_LAPS = 15;
const CHUNK_MS = 9 * 60_000; // the replay API serves at most 10 minutes per request
const SPEED_CHUNK_MS = 15 * 60_000; // keeps the telemetry API under its 5000-point cap, so samples stay raw

// ------------------------------------------------------------------------------------------- data

/** Session-ms window covering laps [from, to] for the whole field (lap 1 start estimated when missing). */
function lapWindow(b: TimingBundle, from: number, to: number): { t0: number; t1: number } | null {
  const ms = (iso: string) => Date.parse(iso) - b.epochMs;
  const starts = (n: number) => b.laps.filter((l) => l.lapNumber === n && l.dateStart).map((l) => ms(l.dateStart!));
  const startOf = (n: number): number | null => {
    const xs = starts(n);
    if (xs.length) return Math.min(...xs);
    const next = starts(n + 1);
    return next.length ? Math.min(...next) - 150_000 : null;
  };
  const endOf = (n: number): number | null => {
    const xs = b.laps.filter((l) => l.lapNumber === n && l.dateStart && l.lapTime).map((l) => ms(l.dateStart!) + l.lapTime! * 1000);
    if (xs.length) return Math.max(...xs);
    const next = starts(n + 1);
    return next.length ? Math.max(...next) : null;
  };
  const t0 = startOf(from);
  const t1 = endOf(to);
  return t0 === null || t1 === null || t1 <= t0 ? null : { t0: Math.max(0, t0 - 5_000), t1: t1 + 5_000 };
}

/** All cars' measured positions in the window, at full source rate (hz=10 keeps every ~4 Hz sample). */
function usePositions(sessionId: string, win: { t0: number; t1: number } | null) {
  return useQuery({
    queryKey: ["battle-positions", sessionId, win?.t0, win?.t1],
    enabled: !!win,
    staleTime: Infinity,
    queryFn: async () => {
      const ranges: [number, number][] = [];
      for (let t = win!.t0; t < win!.t1; t += CHUNK_MS) ranges.push([t, Math.min(win!.t1, t + CHUNK_MS)]);
      const windows = await Promise.all(ranges.map(([f, t]) => get.replay(sessionId, f, t, 10)));
      const cars = new Map<number, { t: number[]; x: number[]; y: number[] }>();
      for (const w of windows)
        for (const [d, c] of Object.entries(w.cars)) {
          const o = cars.get(Number(d)) ?? { t: [], x: [], y: [] };
          for (let i = 0; i < c.t.length; i++) {
            if (o.t.length && c.t[i]! <= o.t[o.t.length - 1]!) continue;
            o.t.push(c.t[i]!);
            o.x.push(c.x[i]!);
            o.y.push(c.y[i]!);
          }
          cars.set(Number(d), o);
        }
      // measured speed for the Kalman fusion; a car without it falls back to position-only smoothing
      const speedRanges: [number, number][] = [];
      for (let t = win!.t0; t < win!.t1; t += SPEED_CHUNK_MS) speedRanges.push([t, Math.min(win!.t1, t + SPEED_CHUNK_MS)]);
      const speeds = new Map<number, { t: number[]; speed: number[] } | null>();
      await Promise.all(
        [...cars.keys()].map(async (d) => {
          try {
            const parts = await Promise.all(speedRanges.map(([f, t]) => get.speed(sessionId, d, f, t)));
            speeds.set(d, { t: parts.flatMap((p) => p.t), speed: parts.flatMap((p) => p.speed) });
          } catch {
            speeds.set(d, null);
          }
        }),
      );
      return { cars, speeds };
    },
  });
}

function lapAt(b: TimingBundle, driver: number, t: number): number {
  let best: number | null = null;
  for (const l of b.laps) if (l.driverNumber === driver && l.dateStart && Date.parse(l.dateStart) - b.epochMs <= t && (best === null || l.lapNumber > best)) best = l.lapNumber;
  return best ?? 1;
}

// ------------------------------------------------------------------------------------------- page

const firstTime = (e: Encounter) => Math.min(...Object.values(e.apexTime));

const VERDICT: Record<Encounter["verdict"], { label: string; cls: string }> = {
  entitled: { label: "Entitled to room", cls: "text-good border-good/50 bg-good/10" },
  not_entitled: { label: "Not entitled", cls: "text-bad border-bad/50 bg-bad/10" },
  too_close: { label: "Too close to call", cls: "text-lemon border-lemon/50 bg-lemon/10" },
  not_alongside: { label: "Not alongside", cls: "text-fg-3 border-line-2" },
  side_unknown: { label: "Set side", cls: "text-lemon border-lemon/50 border-dashed" },
};

/** Stable key of an encounter, for remembering the side the user set. */
const encKey = (e: Encounter) => `${e.apex.number}:${Math.round(firstTime(e) / 1000)}:${Math.min(e.attacker, e.defender)}-${Math.max(e.attacker, e.defender)}`;

function loadSides(sessionId: string): Record<string, Side> {
  try {
    return JSON.parse(localStorage.getItem(`lt:sides:${sessionId}`) ?? "{}") as Record<string, Side>;
  } catch {
    return {};
  }
}
function saveSides(sessionId: string, v: Record<string, Side>) {
  try {
    localStorage.setItem(`lt:sides:${sessionId}`, JSON.stringify(v));
  } catch {
    // storage unavailable: sides are kept for this visit only
  }
}

function VerdictPill({ v }: { v: Encounter["verdict"] }) {
  return <span className={`inline-flex h-[20px] items-center whitespace-nowrap rounded-[4px] border px-1.5 text-[12px] font-bold uppercase tracking-wider ${VERDICT[v].cls}`}>{VERDICT[v].label}</span>;
}

const fmtClock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const sgn = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

export default function Battles() {
  const sessionId = useUi((s) => s.sessionId);
  const bundle = useBundle(sessionId);
  const circuit = useCircuit(sessionId);
  if (!sessionId) return <Empty>Select a season, weekend and session in the top bar.</Empty>;
  if (bundle.isLoading || circuit.isLoading) return <Loading what="Loading session and circuit" />;
  if (bundle.isError) return <ErrorNote error={bundle.error} />;
  if (circuit.isError) return <ErrorNote error={circuit.error} />;
  if (!bundle.data || !circuit.data) return <Empty>No data for this session.</Empty>;
  return <BattleView key={sessionId} sessionId={sessionId} b={bundle.data} circuit={circuit.data} />;
}

function BattleView({ sessionId, b, circuit }: { sessionId: string; b: TimingBundle; circuit: CircuitResponse }) {
  const { driverA: a, driverB: bDriver, set: setUi } = useUi();
  const geo = circuit.geometry;
  const frame = useMemo(() => buildTrackFrame(geo), [geo]);
  const apexes = useMemo(() => detectApexes(frame), [frame]);
  const maxLap = useMemo(() => Math.max(1, ...b.laps.map((l) => l.lapNumber)), [b]);
  const [fromLap, setFromLap] = useState(1);
  const [toLap, setToLap] = useState(Math.min(3, maxLap));
  const [scope, setScope] = useState<"pair" | "field">("pair");
  const [sideOnly, setSideOnly] = useState(true);
  const [fusion, setFusion] = useState(true);
  const win = useMemo(() => lapWindow(b, fromLap, toLap), [b, fromLap, toLap]);
  const pos = usePositions(sessionId, win);
  const drivers = useMemo(() => new Map(b.drivers.map((d) => [d.driverNumber, d])), [b]);

  const tracks = useMemo(() => {
    const m = new Map<number, CarTrack>();
    if (!pos.data) return m;
    for (const [d, s] of pos.data.cars) {
      if (s.t.length <= 10) continue;
      const raw = trackCar(frame, d, s, geo.origin);
      m.set(d, fusion ? smoothTrack(frame, raw, pos.data.speeds.get(d)) : raw);
    }
    return m;
  }, [pos.data, frame, geo.origin, fusion]);
  const lateral = useMemo(() => lateralResolution([...tracks.values()]), [tracks]);
  const [sides, setSides] = useState<Record<string, Side>>(() => loadSides(sessionId));
  const setSide = (e: Encounter, side: Side | null) => {
    const next = { ...sides };
    if (side) next[encKey(e)] = side;
    else delete next[encKey(e)];
    setSides(next);
    saveSides(sessionId, next);
  };
  const fusedSpeed = pos.data ? [...pos.data.speeds.values()].filter((v) => v && v.t.length).length : 0;

  const encounters = useMemo(() => {
    if (!tracks.size) return [];
    if (scope === "field") return scanBattles(frame, apexes, [...tracks.values()]);
    const A = a !== null ? tracks.get(a) : undefined;
    const B = bDriver !== null ? tracks.get(bDriver) : undefined;
    if (!A || !B) return [];
    const all = analysePair(frame, apexes, A, B);
    return sideOnly ? all.filter((e) => e.overlapped && e.verdict !== "not_alongside") : all;
  }, [tracks, scope, frame, apexes, a, bDriver, sideOnly]);
  // sides set by the user apply wherever the feed did not measure one
  const shown = useMemo(() => encounters.map((e) => (e.sideSource !== "measured" && sides[encKey(e)] ? withSide(e, sides[encKey(e)]!) : e)), [encounters, sides]);

  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [encounters]);
  const enc = shown[sel] ?? null;

  const driverOptions = useMemo<ComboOption<number>[]>(
    () => b.drivers.map((d) => ({ value: d.driverNumber, label: `${d.code} · ${d.fullName}`, color: `#${d.teamColour}`, hint: `#${d.driverNumber}`, keywords: d.teamName })),
    [b],
  );
  const pairMissing = scope === "pair" && (a === null || bDriver === null);

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-2">
        <span className="label mr-1">Scope</span>
        <Btn active={scope === "pair"} onClick={() => setScope("pair")} title="Every corner where two chosen drivers arrive together">
          Two drivers
        </Btn>
        <Btn active={scope === "field"} onClick={() => setScope("field")} title="Every side-by-side corner between any two cars">
          Whole field
        </Btn>
        {scope === "pair" && (
          <>
            <span className="mx-1 h-4 w-px bg-line" />
            <Combobox ariaLabel="Driver A" value={a} options={driverOptions} minWidth={170} placeholder="Driver A…" onChange={(v) => setUi({ driverA: v })} />
            <span className="text-fg-3">vs</span>
            <Combobox ariaLabel="Driver B" value={bDriver} options={driverOptions} minWidth={170} placeholder="Driver B…" onChange={(v) => setUi({ driverB: v })} />
            <Btn active={sideOnly} onClick={() => setSideOnly(!sideOnly)} title="Only corners where the cars overlapped (gap under a car length) into or at the apex">
              Overlapping only
            </Btn>
          </>
        )}
        <span className="mx-1 h-4 w-px bg-line" />
        <span className="label">Laps</span>
        <Stepper ariaLabel="From lap" value={fromLap} min={1} max={toLap} onChange={setFromLap} width={44} />
        <span className="text-fg-3">–</span>
        <Stepper ariaLabel="To lap" value={toLap} min={fromLap} max={Math.min(maxLap, fromLap + MAX_LAPS - 1)} onChange={setToLap} width={44} />
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn
          active={fusion}
          onClick={() => setFusion(!fusion)}
          title="Kalman/RTS smoother fusing each car's position fixes with its measured speed: rejects glitches, bridges dropouts, follows braking between samples, and gives a per-moment uncertainty. Off = straight-line interpolation of raw fixes."
        >
          Speed fusion
        </Btn>
        {fusion && pos.data && <span className="text-[12px] text-fg-3">speed for {fusedSpeed}/{pos.data.cars.size} cars</span>}
        {pos.data && tracks.size > 0 && (
          <span
            className={`text-[12px] ${lateral.resolved ? "text-teal" : "text-lemon"}`}
            title={`90% of position samples lie within ${lateral.p90} m of one driven line (${lateral.samples} samples). Real positions spread across the track width; a few tenths means the feed snaps cars to a reference line.`}
          >
            {lateral.resolved ? "· lateral position measured" : `· side not in the data (spread ${lateral.p90} m): set inside/outside per corner`}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[13px] text-fg-3">
          <KindBadge kind="measured" title="Official timing positions, ~4 Hz, metre-level noise" /> positions
          <KindBadge kind="calculated" title="Projected on the driven line; apexes from its curvature" /> gaps & apexes
        </span>
      </div>

      {!win && <Empty>No lap timing for laps {fromLap}–{toLap} in this session.</Empty>}
      {win && pos.isLoading && <Loading what="Loading car positions" />}
      {pos.isError && <ErrorNote error={pos.error} />}
      {pos.data && pos.data.cars.size === 0 && (
        <Empty>
          No car positions between {fmtClock(win!.t0)} and {fmtClock(win!.t1)} session time. The lap timestamps of this session do not line up with its position data,
          usually a clock-origin error in an older ingest. Re-load the session from your user menu › Settings › Formula 1 account.
        </Empty>
      )}
      {pos.data && pos.data.cars.size > 0 && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1.3fr)_minmax(0,1fr)] xl:overflow-hidden">
          <div className="min-h-[380px] xl:min-h-0">
            <Frame
              title={enc ? `${enc.apex.label} · ${drivers.get(enc.attacker)?.code ?? enc.attacker} attacking ${drivers.get(enc.defender)?.code ?? enc.defender}` : "Corner view"}
              right={<span className="text-[12px] text-fg-3">to scale · travel ↑</span>}
            >
              {enc ? (
                <CornerView key={encKey(enc)} frame={frame} enc={enc} tracks={tracks} drivers={drivers} lateralMeasured={lateral.resolved} />
              ) : (
                <Empty>{pairMissing ? "Choose two drivers." : "No side-by-side corner in these laps."}</Empty>
              )}
            </Frame>
          </div>
          <div className="min-h-[320px] xl:min-h-0">
            <Frame title="2026 driving standards test">{enc ? <VerdictPanel enc={enc} tracks={tracks} frame={frame} drivers={drivers} onSide={(side) => setSide(enc, side)} /> : <Rules />}</Frame>
          </div>
          <div className="min-h-[240px] xl:col-span-2 xl:min-h-0">
            <Frame title={<>Corners {shown.length > 0 && <span className="num text-fg-3">· {shown.length}</span>}</>} right={<span className="text-[12px] text-fg-3">{apexes.length} apexes on this layout</span>}>
              <EncounterTable encs={shown} sel={sel} onSel={setSel} drivers={drivers} b={b} />
            </Frame>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- table

function EncounterTable({ encs, sel, onSel, drivers, b }: { encs: Encounter[]; sel: number; onSel: (i: number) => void; drivers: Map<number, Driver>; b: TimingBundle }) {
  if (!encs.length) return <Empty>No corners to show.</Empty>;
  const code = (n: number | null) => (n === null ? "—" : (drivers.get(n)?.code ?? `#${n}`));
  return (
    <table className="w-full text-[13px]">
      <thead className="sticky top-0 bg-ink-1 text-left text-[12px] uppercase tracking-wider text-fg-3">
        <tr>
          <th className="px-2 py-1">Lap</th>
          <th className="px-2">Corner</th>
          <th className="px-2">Attacker → defender</th>
          <th className="px-2">Inside</th>
          <th className="px-2">First at apex</th>
          <th className="px-2 text-right" title="Attacker front axle minus defender front axle at the apex">
            Gap at apex
          </th>
          <th className="px-2 text-right" title={`Least favourable gap in the ${OPT.preApexM} m before the apex`}>
            Worst before
          </th>
          <th className="px-2 text-right" title="Gap minus requirement at the binding point; ± measurement uncertainty">
            Margin
          </th>
          <th className="px-2">Verdict</th>
        </tr>
      </thead>
      <tbody>
        {encs.map((e, i) => (
          <tr key={i} onClick={() => onSel(i)} className={`cursor-pointer border-t border-line ${i === sel ? "bg-f1/10" : "hover:bg-ink-3/60"}`}>
            <td className="num px-2 py-1">{lapAt(b, e.defender, firstTime(e))}</td>
            <td className="px-2">
              <span className="num text-fg">{e.apex.label}</span> <span className="text-fg-3">{e.apex.direction === "left" ? "L" : "R"}</span>
              {!e.apex.firstInGroup && <span className="ml-1 text-[11px] text-fg-3">(complex)</span>}
            </td>
            <td className="px-2">
              {code(e.attacker)} → {code(e.defender)} {(e.attackerSide === "inside" || e.attackerSide === "outside") && <span className="text-fg-3">· {e.attackerSide}</span>}
            </td>
            <td className="px-2">
              {e.insideCar !== null ? code(e.insideCar) : <span className="text-lemon">set</span>}
              {e.sideSource === "user" && <span className="ml-1 text-[11px] text-fg-3">(you)</span>}
            </td>
            <td className="px-2">
              {code(e.firstToApex)} <span className="num text-fg-3">+{e.firstToApexByS.toFixed(2)} s</span>
            </td>
            <td className="num px-2 text-right">{sgn(e.gapAtApexM)} m</td>
            <td className="num px-2 text-right">{sgn(e.minGapPreApexM)} m</td>
            <td className="num px-2 text-right">{e.marginM === null ? "—" : `${sgn(e.marginM)} ±${e.uncertaintyM.toFixed(1)}`}</td>
            <td className="px-2">
              <VerdictPill v={e.verdict} />
              {e.verdict === "side_unknown" && (
                <span className="ml-1.5 text-[11px] text-fg-3">
                  in: {VERDICT[e.tests.inside.verdict].label.toLowerCase()} · out: {VERDICT[e.tests.outside.verdict].label.toLowerCase()}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------------------------------- verdict

function Rules() {
  return (
    <div className="space-y-3 p-3 text-[14px] text-fg-2">
      <p>
        <b className="text-fg">Inside:</b> the overtaking car's front axle must be <b>at least alongside the mirror</b> of the other car <b>prior to and at the apex</b>.
      </p>
      <p>
        <b className="text-fg">Outside:</b> the overtaking car's front axle must be <b>ahead of the front axle</b> of the other car <b>at the apex</b>; room then includes the exit.
      </p>
      <p>
        <b className="text-fg">Chicanes / S-bends:</b> each element can be judged; priority generally goes to the first element.
      </p>
      <p className="text-[12px] text-fg-3">FIA 2026 Formula 1 Driving Standards Guidelines, v01, 26 Feb 2026. The guidelines inform the stewards; they are not regulations.</p>
      <ul className="list-disc space-y-1 pl-4 text-[12px] text-fg-3">
        {BATTLE_CAVEATS.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

function explain(enc: Encounter, att: string, def: string): string {
  if (enc.rule === "inside") {
    if (enc.verdict === "entitled")
      return `${att}'s front axle was at least alongside ${def}'s mirror from ${OPT.preApexM} m before the apex to the apex (worst ${sgn(enc.minGapPreApexM)} m, required ≥ −${OPT.mirrorOffsetM} m). ${def} has to leave room.`;
    if (enc.verdict === "not_entitled")
      return `${att} needed the front axle at least alongside ${def}'s mirror (≥ −${OPT.mirrorOffsetM} m) before and at the apex; worst was ${sgn(enc.minGapPreApexM)} m. ${def} was not obliged to leave room.`;
    if (enc.verdict === "too_close") return `${att}'s worst position was ${sgn(enc.minGapPreApexM)} m against a −${OPT.mirrorOffsetM} m requirement: inside the measurement uncertainty.`;
    return `${att} was on the inside but never overlapped ${def}.`;
  }
  if (enc.rule === "outside") {
    if (enc.verdict === "entitled") return `${att} on the outside was ${sgn(enc.gapAtApexM)} m ahead of ${def}'s front axle at the apex. ${def} has to leave room, including at the exit.`;
    if (enc.verdict === "not_entitled") return `${att} on the outside was ${sgn(enc.gapAtApexM)} m relative to ${def}'s front axle at the apex: not ahead, so ${def} was not obliged to leave room.`;
    if (enc.verdict === "too_close") return `${att} on the outside was ${sgn(enc.gapAtApexM)} m relative to ${def}'s front axle at the apex: inside the measurement uncertainty.`;
    return `${att} was on the outside but never overlapped ${def}.`;
  }
  if (enc.attackerSide === "in_line") return `${att} and ${def} were in line through ${enc.apex.label}; there was no side-by-side claim.`;
  const i = enc.tests.inside;
  const o = enc.tests.outside;
  if (enc.verdict !== "side_unknown")
    return `Same result whichever side ${att} was on: ${VERDICT[i.verdict].label.toLowerCase()} (inside margin ${sgn(i.marginM)} m, outside margin ${sgn(o.marginM)} m).`;
  return `The answer depends on the side, which the timing feed does not record. If ${att} was on the inside: ${VERDICT[i.verdict].label.toLowerCase()} (worst ${sgn(enc.minGapPreApexM)} m vs ≥ −${OPT.mirrorOffsetM} m). If on the outside: ${VERDICT[o.verdict].label.toLowerCase()} (${sgn(enc.gapAtApexM)} m vs > 0 at the apex).`;
}

function VerdictPanel({ enc, tracks, frame, drivers, onSide }: { enc: Encounter; tracks: Map<number, CarTrack>; frame: TrackFrame; drivers: Map<number, Driver>; onSide: (s: Side | null) => void }) {
  const code = (n: number) => drivers.get(n)?.code ?? `#${n}`;
  const att = code(enc.attacker);
  const def = code(enc.defender);
  const replay = () => {
    clock.pause();
    clock.seek(firstTime(enc) - 4000);
    useUi.getState().set({ mode: "command", driverA: enc.attacker, driverB: enc.defender });
  };
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictPill v={enc.verdict} />
          <span className="text-[13px] text-fg-3">
            {enc.apex.label} · {enc.apex.direction}-hander · {enc.apex.turnDeg}° · r≈{enc.apex.radiusM} m
          </span>
          <span className="ml-auto">
            <Btn size="sm" onClick={replay} title="Open this moment in the Command Center replay">
              Replay in 3D
            </Btn>
          </span>
        </div>
        <p className="text-[14px] leading-snug text-fg">{explain(enc, att, def)}</p>
        {enc.sideSource !== "measured" && (
          <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="text-fg-3">{att} was on the</span>
            <Btn size="sm" active={enc.attackerSide === "inside"} onClick={() => onSide("inside")} title="Set from video or onboard footage">
              inside
            </Btn>
            <Btn size="sm" active={enc.attackerSide === "outside"} onClick={() => onSide("outside")} title="Set from video or onboard footage">
              outside
            </Btn>
            {enc.sideSource === "user" && (
              <Btn size="sm" onClick={() => onSide(null)}>
                clear
              </Btn>
            )}
            <span className="text-[12px] text-fg-3">· not in the timing data; set it from the footage</span>
          </div>
        )}
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <span className="text-fg-3">First to the apex</span>
          <span>
            {code(enc.firstToApex)} <span className="num text-fg-3">by {enc.firstToApexByS.toFixed(2)} s</span>
          </span>
          <span className="text-fg-3">Inside car</span>
          <span>{enc.insideCar === null ? "—" : code(enc.insideCar)}</span>
          <span className="text-fg-3">Lateral separation at apex</span>
          <span className="num">
            {enc.lateralSepM.toFixed(1)} m <span className="text-fg-3">(car width {OPT.carWidthM} m)</span>
          </span>
          <span className="text-fg-3">Gap on approach → at apex</span>
          <span className="num">
            {sgn(enc.gapAtApproachM)} → {sgn(enc.gapAtApexM)} m
          </span>
          <span className="text-fg-3">Uncertainty</span>
          <span className="num">
            ±{enc.uncertaintyM.toFixed(1)} m <span className="text-fg-3">· samples ≤{enc.sampleSpacingMs} ms apart</span>
          </span>
        </div>
        {enc.notes.length > 0 && (
          <ul className="list-disc pl-4 text-[12px] text-fg-3">
            {enc.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-h-[160px] flex-1 p-2">
        <GapChart enc={enc} tracks={tracks} frame={frame} att={att} def={def} />
      </div>
    </div>
  );
}

/** Attacker's front axle relative to the defender's, against the pair's distance from the apex. */
function GapChart({ enc, tracks, frame, att, def }: { enc: Encounter; tracks: Map<number, CarTrack>; frame: TrackFrame; att: string; def: string }) {
  const A = tracks.get(enc.attacker)!;
  const D = tracks.get(enc.defender)!;
  const L = frame.length;
  const ts = Object.values(enc.apexTime);
  const pts: [number, number][] = [];
  for (let t = Math.min(...ts) - 5000; t <= Math.max(...ts) + 3000; t += 40) {
    const a = carAt(A, t);
    const d = carAt(D, t);
    if (!a || !d) continue;
    const g = wrappedGap(a.p, d.p, L);
    const rel = wrappedGap(d.p + g / 2, enc.apex.distance, L);
    if (rel >= -130 && rel <= 70) pts.push([rel, g]);
  }
  const W = 400;
  const H = 180;
  const x = (m: number) => ((m + 130) / 200) * W;
  const yMax = Math.max(8, ...pts.map((p) => Math.min(25, Math.abs(p[1]))));
  const y = (g: number) => H / 2 - (Math.max(-yMax, Math.min(yMax, g)) / yMax) * (H / 2 - 8);
  const u = enc.uncertaintyM;
  const thr = enc.rule === "inside" ? -OPT.mirrorOffsetM : 0;
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-full w-full" preserveAspectRatio="none" role="img" aria-label="Gap between front axles approaching the apex">
      {enc.rule === "inside" && <rect x={x(-OPT.preApexM)} y={0} width={x(0) - x(-OPT.preApexM)} height={H} fill="#ffd12e" opacity={0.06} />}
      {enc.rule && <rect x={0} y={y(thr + u)} width={W} height={y(thr - u) - y(thr + u)} fill="#ffd12e" opacity={0.12} />}
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="#8b93a7" strokeWidth={1} />
      <line x1={0} x2={W} y1={y(-OPT.mirrorOffsetM)} y2={y(-OPT.mirrorOffsetM)} stroke="#8b93a7" strokeWidth={1} strokeDasharray="4 3" />
      <line x1={x(0)} x2={x(0)} y1={0} y2={H} stroke="#e10600" strokeWidth={1.2} />
      <polyline points={pts.map(([m, g]) => `${x(m)},${y(g)}`).join(" ")} fill="none" stroke={COLOR_A} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <text x={4} y={y(0) - 3} fontSize={10} fill="#8b93a7">
        {def} front axle (outside test)
      </text>
      <text x={4} y={y(-OPT.mirrorOffsetM) + 11} fontSize={10} fill="#8b93a7">
        {def} mirror (inside test)
      </text>
      <text x={x(0) + 3} y={11} fontSize={10} fill="#e10600">
        APEX
      </text>
      <text x={W - 4} y={11} fontSize={10} fill={COLOR_A} textAnchor="end">
        {att} ahead ↑
      </text>
      {[-120, -80, -40, 0, 40].map((m) => (
        <text key={m} x={x(m)} y={H + 13} fontSize={9} fill="#6b7287" textAnchor="middle">
          {m} m
        </text>
      ))}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------- corner view

function nearestIdx(f: TrackFrame, d: number): number {
  let best = 0;
  for (let i = 0; i < f.s.length; i++) if (Math.abs(f.s[i]! - d) < Math.abs(f.s[best]! - d)) best = i;
  return best;
}

/** To-scale top view around the apex (SVG units are metres), rotated so the direction of travel points up. */
function CornerView({ frame, enc, tracks, drivers, lateralMeasured }: { frame: TrackFrame; enc: Encounter; tracks: Map<number, CarTrack>; drivers: Map<number, Driver>; lateralMeasured: boolean }) {
  const apex = enc.apex;
  const A = tracks.get(enc.attacker)!;
  const D = tracks.get(enc.defender)!;
  const ts = Object.values(enc.apexTime);
  const t0 = Math.min(...ts) - 4500;
  const t1 = Math.max(...ts) + 2500;
  const tApex = ts.reduce((s, v) => s + v, 0) / ts.length;
  const [t, setT] = useState(tApex);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) * 0.35; // slow motion
      last = now;
      setT((v) => {
        const nv = Math.min(t1, v + dt);
        if (nv >= t1) setPlaying(false);
        return nv;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, t1]);

  const i0 = nearestIdx(frame, apex.distance);
  const tx = frame.tx[i0]!;
  const ty = frame.ty[i0]!;
  // local frame: up = direction of travel at the apex, screen-left = left of travel
  const loc = (px: number, py: number): [number, number] => {
    const dx = px - apex.x;
    const dy = py - apex.y;
    return [-(tx * dy - ty * dx), -(dx * tx + dy * ty)];
  };
  const line: string[] = [];
  for (let i = 0; i < frame.x.length; i++) {
    const rel = wrappedGap(frame.s[i]!, apex.distance, frame.length);
    if (rel < -160 || rel > 110) continue;
    const [X, Y] = loc(frame.x[i]!, frame.y[i]!);
    line.push(`${X.toFixed(2)},${Y.toFixed(2)}`);
  }
  const trail = (c: CarTrack) => {
    const pts: [number, number][] = [];
    const r = c.raw ?? c; // dots are always the measured fixes
    for (let i = 0; i < r.t.length; i++) if (r.t[i]! >= t0 && r.t[i]! <= t1) pts.push(loc(r.x[i]!, r.y[i]!));
    return pts;
  };
  const path = (c: CarTrack) => {
    const pts: string[] = [];
    for (let i = 0; i < c.t.length; i++) if (c.t[i]! >= t0 && c.t[i]! <= t1 && Number.isFinite(c.p[i]!)) pts.push(loc(c.x[i]!, c.y[i]!).join(","));
    return pts.join(" ");
  };
  // Without measured lateral position, cars are placed schematically either side of the line at their
  // measured along-track position: the chosen inside car on the inside, else attacker left / defender right.
  const towardsInside = apex.direction === "left" ? 1 : -1;
  const schematicLat = (isDef: boolean) => {
    const attIn = enc.attackerSide === "inside" ? 1 : enc.attackerSide === "outside" ? -1 : 0;
    if (attIn === 0) return isDef ? -1.3 : 1.3;
    return (isDef ? -attIn : attIn) * towardsInside * 1.3;
  };
  const placed = (c: CarTrack, at: number, isDef: boolean): { x: number; y: number } | null => {
    const s = carAt(c, at);
    if (!s) return null;
    if (lateralMeasured) return s;
    const q = pointOnFrame(frame, s.p);
    const l = schematicLat(isDef);
    return { x: q.x - q.ty * l, y: q.y + q.tx * l };
  };
  const carShape = (c: CarTrack, color: string, label: string, isDef: boolean) => {
    const p = placed(c, t, isDef);
    const p0 = placed(c, t - 120, isDef);
    const p1 = placed(c, t + 120, isDef);
    if (!p || !p0 || !p1) return null;
    const [X, Y] = loc(p.x, p.y);
    const [X0, Y0] = loc(p0.x, p0.y);
    const [X1, Y1] = loc(p1.x, p1.y);
    const ang = (Math.atan2(Y1 - Y0, X1 - X0) * 180) / Math.PI + 90; // shape is drawn pointing up (−Y)
    const len = OPT.carLengthM;
    const w = OPT.carWidthM;
    const nose = 0.9; // reference point drawn at the front axle; nose overhang illustrative
    return (
      <g transform={`translate(${X} ${Y}) rotate(${ang})`}>
        {isDef && (
          <>
            {/* the two lines the attacker's front axle is measured against, across the track */}
            <line x1={-9} x2={9} y1={0} y2={0} stroke="#e8eaf0" strokeWidth={0.25} />
            <line x1={-9} x2={9} y1={OPT.mirrorOffsetM} y2={OPT.mirrorOffsetM} stroke="#e8eaf0" strokeWidth={0.25} strokeDasharray="0.8 0.6" />
          </>
        )}
        <rect x={-w / 2} y={-nose} width={w} height={len} rx={0.4} fill={color} fillOpacity={0.85} stroke="#090a10" strokeWidth={0.12} />
        <line x1={-w / 2 - 0.2} x2={w / 2 + 0.2} y1={0} y2={0} stroke="#090a10" strokeWidth={0.22} />
        <line x1={-w / 2 - 0.4} x2={-w / 2} y1={OPT.mirrorOffsetM} y2={OPT.mirrorOffsetM} stroke="#e8eaf0" strokeWidth={0.3} />
        <line x1={w / 2} x2={w / 2 + 0.4} y1={OPT.mirrorOffsetM} y2={OPT.mirrorOffsetM} stroke="#e8eaf0" strokeWidth={0.3} />
        <text x={0} y={len - nose + 2.4} fontSize={2} textAnchor="middle" fill={color} fontWeight={700} transform={`rotate(${-ang} 0 ${len - nose + 1.8})`}>
          {label}
        </text>
      </g>
    );
  };
  const aCode = drivers.get(enc.attacker)?.code ?? `#${enc.attacker}`;
  const dCode = drivers.get(enc.defender)?.code ?? `#${enc.defender}`;
  const a = carAt(A, t);
  const d = carAt(D, t);
  const gNow = a && d ? wrappedGap(a.p, d.p, frame.length) : null;
  const rel = a && d && gNow !== null ? wrappedGap(d.p + gNow / 2, apex.distance, frame.length) : null;
  const left = apex.direction === "left";

  return (
    <div className="flex h-full flex-col">
      <svg viewBox="-34 -70 68 100" className="min-h-0 flex-1" role="img" aria-label={`Top view of ${apex.label}`}>
        <rect x={-34} y={-70} width={68} height={100} fill="#090a10" />
        <polyline points={line.join(" ")} fill="none" stroke="#1c1f2b" strokeWidth={14} strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={line.join(" ")} fill="none" stroke="#3a4052" strokeWidth={0.2} strokeDasharray="1.5 1" />
        <text x={left ? -14 : 14} y={6} fontSize={2.4} fill="#6b7287" textAnchor="middle">
          INSIDE
        </text>
        <circle cx={0} cy={0} r={0.8} fill="#e10600" />
        <text x={left ? -2 : 2} y={-1.4} fontSize={2.6} fill="#e10600" fontWeight={700} textAnchor={left ? "end" : "start"}>
          {apex.label} APEX
        </text>
        {[
          { c: D, col: COLOR_B },
          { c: A, col: COLOR_A },
        ].map(({ c, col }) => {
          const pts = trail(c);
          return (
            <g key={c.driverNumber}>
              <polyline points={path(c)} fill="none" stroke={col} strokeOpacity={0.5} strokeWidth={0.25} />
              {pts.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={0.3} fill={col} fillOpacity={0.7} />
              ))}
            </g>
          );
        })}
        {carShape(D, COLOR_B, dCode, true)}
        {carShape(A, COLOR_A, aCode, false)}
        <text x={-33} y={28.5} fontSize={1.9} fill="#6b7287">
          {lateralMeasured ? "" : "side by side placement is schematic (not in the data) · "}dots: measured fixes · line: {A.raw ? "fused track" : "linear"} · grey band: nominal 14 m (edges not mapped) · lines across {dCode}: front axle / mirror (dashed)
        </text>
      </svg>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5 text-[13px]">
        <Btn size="sm" onClick={() => (t >= t1 ? (setT(t0), setPlaying(true)) : setPlaying(!playing))} title="Play through the corner at 0.35× speed">
          {playing ? "❚❚" : "▶"}
        </Btn>
        <input
          aria-label="Time through the corner"
          type="range"
          min={t0}
          max={t1}
          step={10}
          value={t}
          onChange={(e) => (setPlaying(false), setT(Number(e.target.value)))}
          className="min-w-0 flex-1 accent-[#e10600]"
        />
        <Btn size="sm" onClick={() => (setPlaying(false), setT(tApex))}>
          Apex
        </Btn>
        <span className="num w-60 shrink-0 text-right text-fg-2">
          {rel === null ? "—" : `${rel >= 0 ? "+" : ""}${rel.toFixed(0)} m from apex`} · {aCode} {gNow === null ? "—" : `${sgn(gNow)} m`}
        </span>
      </div>
    </div>
  );
}
