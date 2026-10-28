import { useMemo, useState } from "react";
import { timingTower, type TimingBundle, type TowerRow } from "@lemon-tea/synchronization";
import { useClockTime } from "../../state/clock";
import { useUi } from "../../state/store";
import { dash, fmtLap, fmtNum, Frame, KindBadge, teamColor, Tyre } from "../../components/ui";

type SortKey = "position" | "bestLap" | "lastLap" | "number";

const STATUS: Record<string, string> = { running: "", in_pit: "PIT", retired: "OUT", not_started: "—", finished: "FIN" };

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
    <th className={`cursor-pointer px-1 py-1 font-medium ${sort === k ? "text-lemon" : ""} ${cls}`} onClick={() => setSort(k)}>
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
          Timing tower <KindBadge kind={isRace ? "measured" : "calculated"} title={isRace ? "Gaps from the source interval feed" : "Order and gaps calculated from best laps"} />
        </>
      }
      right={<input type="text" placeholder="filter" className="w-20" value={filter} onChange={(e) => setFilter(e.target.value)} />}
    >
      <table className="num w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-ink-1 text-left text-[10px] uppercase tracking-wider text-fg-3">
          <tr>
            {th("position", "P", "w-6 text-right")}
            {th("number", "Driver")}
            <th className="px-1 text-right">{isRace ? "Gap" : "Gap"}</th>
            <th className="px-1 text-right">Int</th>
            {th("lastLap", "Last", "text-right")}
            {th("bestLap", "Best", "text-right")}
            <th className="px-1 text-right">S1</th>
            <th className="px-1 text-right">S2</th>
            <th className="px-1 text-right">S3</th>
            <th className="px-1">Tyre</th>
            <th className="px-1 text-right">Pit</th>
            {isRace && <th className="px-1 text-right">±</th>}
            <th className="px-1">Tr</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const selA = driverA === r.driverNumber;
            const selB = driverB === r.driverNumber;
            return (
              <tr
                key={r.driverNumber}
                onClick={(e) => selectDriver(r.driverNumber, e.metaKey || e.ctrlKey || e.shiftKey)}
                onDoubleClick={() => togglePin(r.driverNumber)}
                className={`cursor-pointer border-b border-line/60 hover:bg-ink-3 ${selA ? "bg-lemon/10" : selB ? "bg-teal/10" : ""} ${r.status === "retired" ? "opacity-50" : ""}`}
                title="Click: driver A · Ctrl/Cmd/Shift-click: driver B · Double-click: pin"
              >
                <td className="px-1 py-[3px] text-right text-fg-2">{r.position ?? dash}</td>
                <td className="px-1">
                  <div className="flex items-center gap-1.5">
                    <span className="h-3.5 w-[3px] rounded-sm" style={{ background: teamColor(r.teamColour) }} />
                    <span className="w-5 text-right text-fg-3">{r.driverNumber}</span>
                    <span className={`font-bold ${selA ? "text-lemon" : selB ? "text-teal" : "text-fg"}`}>{r.code}</span>
                    {pinned.includes(r.driverNumber) && <span className="text-lemon">•</span>}
                    {STATUS[r.status] && <span className="rounded bg-ink-3 px-1 text-[10px] text-fg-2">{STATUS[r.status]}</span>}
                  </div>
                </td>
                <td className="px-1 text-right text-fg-2">{r.lapsDown ? `+${r.lapsDown}L` : r.position === 1 ? "—" : fmtNum(r.gapToLeader, 3, true)}</td>
                <td className="px-1 text-right text-fg-2">{fmtNum(r.interval, 3, true)}</td>
                <td className="px-1 text-right">{fmtLap(r.lastLap)}</td>
                <td className={`px-1 text-right ${r.bestLap !== null && r.bestLap <= best.lap + 1e-9 ? "text-purple" : ""}`}>{fmtLap(r.bestLap)}</td>
                {[0, 1, 2].map((i) => (
                  <td key={i} className="px-1 text-right">
                    {sec(r.sectors[i as 0 | 1 | 2], r.bestSectors[i as 0 | 1 | 2], i)}
                  </td>
                ))}
                <td className="px-1">
                  <Tyre compound={r.compound} age={r.tyreAge} />
                </td>
                <td className="px-1 text-right text-fg-2">{r.pitStops}</td>
                {isRace && (
                  <td className={`px-1 text-right ${r.positionsGained && r.positionsGained > 0 ? "text-good" : r.positionsGained && r.positionsGained < 0 ? "text-bad" : "text-fg-3"}`}>
                    {r.positionsGained ? (r.positionsGained > 0 ? `+${r.positionsGained}` : r.positionsGained) : dash}
                  </td>
                )}
                <td className="px-1 text-center">{trendArrow(r.paceTrend)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.some((r) => r.currentLap > 0) && <div className="p-3 text-[12px] text-fg-3">No laps started at this point of the session. Press play or move the scrubber.</div>}
    </Frame>
  );
}
