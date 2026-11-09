import { useMemo, useState } from "react";
import { timingTower, type TimingBundle, type TowerRow } from "@lemon-tea/synchronization";
import { useClockTime } from "../../state/clock";
import { useUi } from "../../state/store";
import { Chooser, dash, fmtLap, fmtNum, Frame, KindBadge, teamColor, Tyre, useChoice } from "../../components/ui";

type SortKey = "position" | "bestLap" | "lastLap" | "number";

const COLS = ["gap", "int", "last", "best", "sectors", "tyre", "pit", "gained", "trend"] as const;
type Col = (typeof COLS)[number];
const COL_LABEL: { id: Col; label: string; hint?: string }[] = [
  { id: "gap", label: "Gap to leader" },
  { id: "int", label: "Interval", hint: "car ahead" },
  { id: "last", label: "Last lap" },
  { id: "best", label: "Best lap" },
  { id: "sectors", label: "Sectors S1–S3" },
  { id: "tyre", label: "Tyre + age" },
  { id: "pit", label: "Pit stops" },
  { id: "gained", label: "Places gained", hint: "race" },
  { id: "trend", label: "Pace trend" },
];

const STATUS: Record<string, string> = { running: "", in_pit: "PIT", retired: "OUT", not_started: "", finished: "FIN" };

function trendArrow(t: number | null) {
  if (t === null) return <span className="text-fg-3">·</span>;
  if (t < -0.05) return <span className="text-good" title={`${t.toFixed(3)} s/lap`}>▼</span>;
  if (t > 0.05) return <span className="text-bad" title={`+${t.toFixed(3)} s/lap`}>▲</span>;
  return <span className="text-fg-3" title={`${t.toFixed(3)} s/lap`}>▬</span>;
}

/** Timing tower recomputed from the shared timingTower() at the clock time (4×/s). */
export function TimingTower({ bundle }: { bundle: TimingBundle }) {
  const t = useClockTime(250);
  const { driverA, driverB, pinned, selectDriver, togglePin } = useUi();
  const [sort, setSort] = useState<SortKey>("position");
  const [filter, setFilter] = useState("");
  const [cols, setCols] = useChoice<Col>("lt:tower-cols", COLS, ["gap", "int", "last", "best", "tyre", "pit", "gained"]);
  const show = (c: Col) => cols.includes(c);
  const rows = useMemo(() => timingTower(bundle, t), [bundle, t]);

  const best = useMemo(() => {
    const m = [0, 1, 2].map((i) => Math.min(...rows.map((r) => r.bestSectors[i] ?? Infinity)));
    const lap = Math.min(...rows.map((r) => r.bestLap ?? Infinity));
    return { sectors: m, lap };
  }, [rows]);

  const shown = useMemo(() => {
    const f = filter.trim().toUpperCase();
    let r = rows.filter((x) => !f || x.code.includes(f) || String(x.driverNumber) === f || x.teamName.toUpperCase().includes(f));
    const key = (x: TowerRow) =>
      sort === "position" ? x.position ?? 99 : sort === "bestLap" ? x.bestLap ?? Infinity : sort === "lastLap" ? x.lastLap ?? Infinity : x.driverNumber;
    r = [...r].sort((a, b) => key(a) - key(b));
    return [...r.filter((x) => pinned.includes(x.driverNumber)), ...r.filter((x) => !pinned.includes(x.driverNumber))];
  }, [rows, filter, sort, pinned]);

  const isRace = bundle.sessionType === "race" || bundle.sessionType === "sprint";
  const th = (k: SortKey, label: string, cls = "") => (
    <th className={`cursor-pointer px-1.5 py-2 font-bold ${sort === k ? "text-f1-hi" : ""} ${cls}`} onClick={() => setSort(k)} aria-sort={sort === k ? "ascending" : undefined}>
      {label}
    </th>
  );
  const sec = (v: number | null, pb: number | null, i: number) => {
    if (v === null) return <span className="text-fg-3">{dash}</span>;
    const c = v <= best.sectors[i]! + 1e-9 ? "text-purple" : pb !== null && v <= pb + 1e-9 ? "text-good" : "text-fg-2";
    return <span className={c}>{v.toFixed(3)}</span>;
  };

  return (
    <Frame
      title={
        <>
          Timing <KindBadge kind={isRace ? "measured" : "calculated"} title={isRace ? "Gaps from the source interval feed" : "Order and gaps calculated from best laps"} />
        </>
      }
      right={
        <>
          <input type="text" placeholder="Filter" aria-label="Filter drivers" className="w-20 !py-0.5" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Chooser label="Columns" options={COL_LABEL} value={cols} onChange={setCols} />
        </>
      }
    >
      <table className="num w-full border-collapse text-[14px]">
        <thead className="label sticky top-0 z-10 bg-ink-1 text-left !text-[10px]">
          <tr className="border-b border-line">
            {th("position", "Pos", "w-9 pl-3 text-right")}
            {th("number", "Driver")}
            {show("gap") && <th className="px-1.5 text-right">Gap</th>}
            {show("int") && <th className="px-1.5 text-right">Int</th>}
            {show("last") && th("lastLap", "Last", "text-right")}
            {show("best") && th("bestLap", "Best", "text-right")}
            {show("sectors") && (
              <>
                <th className="px-1.5 text-right">S1</th>
                <th className="px-1.5 text-right">S2</th>
                <th className="px-1.5 text-right">S3</th>
              </>
            )}
            {show("tyre") && <th className="px-1.5">Tyre</th>}
            {show("pit") && <th className="px-1.5 text-right">Pit</th>}
            {isRace && show("gained") && <th className="px-1.5 text-right">+/−</th>}
            {show("trend") && <th className="px-1.5 pr-3 text-center">Trend</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const selA = driverA === r.driverNumber;
            const selB = driverB === r.driverNumber;
            const tc = teamColor(r.teamColour);
            return (
              <tr
                key={r.driverNumber}
                onClick={(e) => selectDriver(r.driverNumber, e.metaKey || e.ctrlKey || e.shiftKey)}
                onDoubleClick={() => togglePin(r.driverNumber)}
                className={`h-9 cursor-pointer border-b border-line/60 transition-colors hover:bg-ink-3 ${selA ? "bg-lemon/[0.09] shadow-[inset_3px_0_0_var(--color-lemon)]" : selB ? "bg-teal/[0.09] shadow-[inset_3px_0_0_var(--color-teal)]" : ""} ${r.status === "retired" ? "opacity-45" : ""}`}
                title="Click: driver A · Ctrl/Cmd/Shift-click: driver B · Double-click: pin"
              >
                <td className="pl-3 pr-1.5 text-right">
                  <span className={`display text-[16px] ${r.position === 1 ? "text-f1-hi" : "text-fg"}`}>{r.position ?? dash}</span>
                </td>
                <td className="px-1.5">
                  <div className="flex items-center gap-2">
                    <span className="h-5 w-[5px] -skew-x-[20deg]" style={{ background: tc }} />
                    <span className={`display w-12 text-[14px] tracking-[0.02em] ${selA ? "text-lemon" : selB ? "text-teal" : "text-fg"}`}>{r.code}</span>
                    <span className="w-6 text-[12px] text-fg-3">{r.driverNumber}</span>
                    {pinned.includes(r.driverNumber) && <span className="text-lemon" title="Pinned">●</span>}
                    {STATUS[r.status] && <span className={`tag !h-4 !text-[9px] ${r.status === "in_pit" ? "" : "!bg-ink-3 !text-fg-2"}`}>{STATUS[r.status]}</span>}
                  </div>
                </td>
                {show("gap") && <td className="px-1.5 text-right text-fg">{r.lapsDown ? `+${r.lapsDown}L` : r.position === 1 ? <span className="label !text-[10px]">Leader</span> : fmtNum(r.gapToLeader, 3, true)}</td>}
                {show("int") && <td className="px-1.5 text-right text-fg-2">{fmtNum(r.interval, 3, true)}</td>}
                {show("last") && <td className="px-1.5 text-right">{fmtLap(r.lastLap)}</td>}
                {show("best") && <td className={`px-1.5 text-right ${r.bestLap !== null && r.bestLap <= best.lap + 1e-9 ? "font-bold text-purple" : "text-fg-2"}`}>{fmtLap(r.bestLap)}</td>}
                {show("sectors") &&
                  [0, 1, 2].map((i) => (
                    <td key={i} className="px-1.5 text-right text-[13px]">
                      {sec(r.sectors[i as 0 | 1 | 2], r.bestSectors[i as 0 | 1 | 2], i)}
                    </td>
                  ))}
                {show("tyre") && (
                  <td className="px-1.5">
                    <Tyre compound={r.compound} age={r.tyreAge} />
                  </td>
                )}
                {show("pit") && <td className="px-1.5 text-right text-fg-2">{r.pitStops}</td>}
                {isRace && show("gained") && (
                  <td className={`px-1.5 text-right ${r.positionsGained && r.positionsGained > 0 ? "text-good" : r.positionsGained && r.positionsGained < 0 ? "text-bad" : "text-fg-3"}`}>
                    {r.positionsGained ? (r.positionsGained > 0 ? `▲${r.positionsGained}` : `▼${-r.positionsGained}`) : dash}
                  </td>
                )}
                {show("trend") && <td className="px-1.5 pr-3 text-center">{trendArrow(r.paceTrend)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.some((r) => r.currentLap > 0) && <div className="p-3 text-[14px] text-fg-3">No laps started at this point of the session. Press play or move the scrubber.</div>}
    </Frame>
  );
}
