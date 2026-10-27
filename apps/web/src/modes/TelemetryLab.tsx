import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type CompareResponse } from "../api";
import { useBundle, useCircuit, useCompare, useLaps, type CompareArgs } from "../data";
import { useUi, type LapPick } from "../state/store";
import { dash, Empty, ErrorNote, fmtLap, fmtNum, Frame, KindBadge, Loading } from "../components/ui";
import { COLOR_A, COLOR_B, TelemetryStack } from "../components/TelemetryCharts";
import { TrackMap2D } from "../components/TrackMap2D";

function LapPicker({ which, pick, color }: { which: "lapA" | "lapB"; pick: LapPick; color: string }) {
  const { meetingId, set } = useUi();
  const sessions = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: !!meetingId });
  const bundle = useBundle(pick.sessionId);
  const laps = useLaps(pick.sessionId, pick.driverNumber);
  const update = (p: Partial<LapPick>) => set({ [which]: { ...pick, ...p } } as never);
  const timed = (laps.data ?? []).filter((l) => l.lapTime !== null);
  const fastest = timed.filter((l) => !l.isPitOutLap).reduce<number | null>((m, l) => (m === null || l.lapTime! < m ? l.lapTime! : m), null);
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border px-2 py-1" style={{ borderColor: `${color}55` }}>
      <span className="text-[11px] font-bold" style={{ color }}>
        {which === "lapA" ? "A" : "B"}
      </span>
      <select value={pick.sessionId ?? ""} onChange={(e) => update({ sessionId: e.target.value, lapNumber: null })}>
        {sessions.data
          ?.filter((s) => s.ingestStatus !== "not_ingested")
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
      </select>
      <select value={pick.driverNumber ?? ""} onChange={(e) => update({ driverNumber: Number(e.target.value), lapNumber: null })}>
        <option value="">driver…</option>
        {bundle.data?.drivers.map((d) => (
          <option key={d.driverNumber} value={d.driverNumber}>
            {d.code} #{d.driverNumber}
          </option>
        ))}
      </select>
      <select value={pick.lapNumber ?? ""} onChange={(e) => update({ lapNumber: e.target.value ? Number(e.target.value) : null })} disabled={!laps.data}>
        <option value="">fastest</option>
        {timed.map((l) => (
          <option key={l.lapNumber} value={l.lapNumber}>
            L{l.lapNumber} {fmtLap(l.lapTime)} {l.compound?.[0] ?? ""}
            {l.isPitOutLap ? " (out)" : l.lapTime === fastest ? " ★" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function CornerTable({ cmp }: { cmp: CompareResponse }) {
  const cursor = useUi((s) => s.cursorDistance);
  const set = useUi((s) => s.set);
  const m = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? dash : v.toFixed(d));
  return (
    <table className="num w-full text-[11px]">
      <thead className="sticky top-0 bg-ink-1 text-left text-[9px] uppercase tracking-wider text-fg-3">
        <tr>
          <th className="px-1.5 py-1">Corner</th>
          <th className="px-1 text-right">Δ total</th>
          <th className="px-1 text-right">Entry</th>
          <th className="px-1 text-right">Mid</th>
          <th className="px-1 text-right">Exit</th>
          <th className="px-1 text-right">Brake A/B (m)</th>
          <th className="px-1 text-right">Min v A/B</th>
          <th className="px-1 text-right">Thr-on A/B (m)</th>
          <th className="px-1 text-right">Exit v A/B</th>
          <th className="px-1">Apex</th>
        </tr>
      </thead>
      <tbody>
        {cmp.corners.map((c) => {
          const active = cursor !== null && cursor >= c.corner.windowStart && cursor <= c.corner.windowEnd;
          const ph = (p: string) => c.phases.find((x) => x.phase === p)?.deltaChange ?? null;
          const dc = (v: number | null) => (
            <span className={v === null || Math.abs(v) < 0.005 ? "text-fg-3" : v < 0 ? "text-lemon" : "text-teal"}>{fmtNum(v, 3, true)}</span>
          );
          return (
            <tr key={c.corner.index} onClick={() => set({ cursorDistance: c.corner.minSpeedDistance })} className={`cursor-pointer border-b border-line/50 hover:bg-ink-3 ${active ? "bg-lemon/10" : ""}`}>
              <td className="px-1.5 py-0.5">
                <span className="font-bold">{c.corner.label}</span> <span className="text-fg-3">{c.corner.band}</span>
                {c.dominant_phase && <span className="ml-1 text-[9px] text-fg-3">({c.dominant_phase})</span>}
              </td>
              <td className="px-1 text-right">{dc(c.delta_change_seconds)}</td>
              <td className="px-1 text-right">{dc(ph("entry"))}</td>
              <td className="px-1 text-right">{dc(ph("mid"))}</td>
              <td className="px-1 text-right">{dc(ph("exit"))}</td>
              <td className="px-1 text-right">
                {m(c.a.brakeStart)}/{m(c.b.brakeStart)}
              </td>
              <td className="px-1 text-right">
                {m(c.a.minSpeed)}/{m(c.b.minSpeed)}
              </td>
              <td className="px-1 text-right">
                {m(c.a.throttleOn)}/{m(c.b.throttleOn)}
              </td>
              <td className="px-1 text-right">
                {m(c.a.exitSpeed)}/{m(c.b.exitSpeed)}
              </td>
              <td className="px-1 text-fg-3" title={c.apex_assessment.reason}>
                not determinable
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Summary({ cmp }: { cmp: CompareResponse }) {
  const maxAbs = Math.max(0.01, ...cmp.mini_sectors.map((m) => Math.abs(m.deltaChange)));
  return (
    <div className="space-y-3 p-2.5 text-[12px]">
      <div className="flex items-baseline gap-3">
        <span className="num text-[22px]" style={{ color: cmp.time_delta_seconds <= 0 ? COLOR_A : COLOR_B }}>
          {fmtNum(cmp.time_delta_seconds, 3, true)} s
        </span>
        <span className="text-fg-2">
          lap time {cmp.a.driverCode} {fmtLap(cmp.a.lapTime)} vs {cmp.b.driverCode} {fmtLap(cmp.b.lapTime)}
        </span>
      </div>
      <div className="text-[11px] text-fg-3">{cmp.delta_semantics}</div>
      <p className="text-fg">{cmp.summary}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {cmp.sectors.map((s) => (
          <div key={s.sector} className="rounded border border-line bg-ink-0/60 px-2 py-1">
            <div className="label flex justify-between">
              S{s.sector} <KindBadge kind="measured" />
            </div>
            <div className={`num text-[13px] ${s.measuredDelta === null ? "text-fg-3" : s.measuredDelta < 0 ? "text-lemon" : "text-teal"}`}>{fmtNum(s.measuredDelta, 3, true)}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="label mb-1">Mini-sectors (25 equal segments, calculated)</div>
        <div className="flex h-10 items-center gap-px">
          {cmp.mini_sectors.map((m) => (
            <div key={m.label} className="flex h-full flex-1 flex-col justify-center" title={`${m.label} ${m.from}–${m.to} m: ${fmtNum(m.deltaChange, 3, true)} s`}>
              <div
                className="w-full rounded-sm"
                style={{
                  height: `${Math.max(2, (Math.abs(m.deltaChange) / maxAbs) * 100)}%`,
                  background: m.deltaChange < 0 ? COLOR_A : COLOR_B,
                  opacity: Math.abs(m.deltaChange) < cmp.noise_floor_seconds / 4 ? 0.3 : 0.9,
                  alignSelf: "center",
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="label mb-1">Findings (deterministic, evidence-linked)</div>
        <ul className="space-y-1.5">
          {cmp.findings.map((f, i) => (
            <li key={i} className="rounded border border-line bg-ink-0/50 p-2">
              <div className="text-fg">{f.text}</div>
              <div className="num mt-1 flex flex-wrap gap-x-3 text-[10px] text-fg-3">
                {Object.entries(f.evidence).map(([k, v]) => (
                  <span key={k}>
                    {k.replaceAll("_", " ")}: <span className="text-fg-2">{v ?? dash}</span>
                  </span>
                ))}
              </div>
            </li>
          ))}
          {cmp.findings.length === 0 && <li className="text-fg-3">No section exceeds the {cmp.noise_floor_seconds}s noise floor.</li>}
        </ul>
      </div>
      <div className="rounded border border-line bg-ink-0/50 p-2 text-[11px] text-fg-2">
        <div>
          Quality score <span className="num text-fg">{cmp.confidence.toFixed(2)}</span> ({cmp.meta.dataQuality}) — heuristic, not a probability · noise floor {cmp.noise_floor_seconds}s
        </div>
        <ul className="mt-1 list-disc pl-4 text-fg-3">
          {cmp.meta.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
          {cmp.meta.warnings.map((w) => (
            <li key={w.code} className="text-lemon">
              {w.message}
            </li>
          ))}
        </ul>
        <div className="mt-1 text-[10px] text-fg-3">{cmp.meta.algorithmVersion}</div>
      </div>
    </div>
  );
}

export default function TelemetryLab() {
  const { sessionId, driverA, driverB, lapA, lapB, set } = useUi();
  const bundle = useBundle(sessionId);

  // Seed lap picks from the current session + tower selection
  useEffect(() => {
    if (!sessionId || !bundle.data) return;
    const ds = bundle.data.drivers;
    if (!lapA.sessionId || !lapA.driverNumber) set({ lapA: { sessionId, driverNumber: driverA ?? ds[0]?.driverNumber ?? null, lapNumber: null } });
    if (!lapB.sessionId || !lapB.driverNumber) set({ lapB: { sessionId, driverNumber: driverB ?? ds[1]?.driverNumber ?? null, lapNumber: null } });
  }, [sessionId, bundle.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const args = useMemo<CompareArgs | null>(() => {
    if (!lapA.sessionId || !lapA.driverNumber || !lapB.sessionId || !lapB.driverNumber) return null;
    return {
      a: { sessionId: lapA.sessionId, driverNumber: lapA.driverNumber, ...(lapA.lapNumber ? { lapNumber: lapA.lapNumber } : {}) },
      b: { sessionId: lapB.sessionId, driverNumber: lapB.driverNumber, ...(lapB.lapNumber ? { lapNumber: lapB.lapNumber } : {}) },
      resolution: 5,
    };
  }, [lapA, lapB]);
  const cmp = useCompare(args);
  const circuit = useCircuit(lapA.sessionId);

  if (!sessionId) return <Empty>Select a session first.</Empty>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-ink-1/80 px-3 py-1.5">
        <LapPicker which="lapA" pick={lapA} color={COLOR_A} />
        <LapPicker which="lapB" pick={lapB} color={COLOR_B} />
        <button className="text-[11px] text-fg-3 hover:text-fg" onClick={() => set({ lapA: lapB, lapB: lapA })}>
          ⇄ swap
        </button>
        {cmp.isFetching && <span className="text-[11px] text-fg-3">computing…</span>}
      </div>
      {cmp.isError && <ErrorNote error={cmp.error} />}
      {!cmp.data && !cmp.isError && (cmp.isLoading ? <Loading what="Aligning laps on distance" /> : <Empty>Pick two laps.</Empty>)}
      {cmp.data && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_200px] gap-px">
            <Frame title={<>Synchronised channels vs lap distance <KindBadge kind="measured" /></>}>
              <TelemetryStack cmp={cmp.data} />
            </Frame>
            <Frame title="Corner analysis (detected corners)">
              <CornerTable cmp={cmp.data} />
            </Frame>
          </div>
          <div className="grid min-h-0 grid-rows-[260px_minmax(0,1fr)] gap-px">
            <Frame title="Track map · trajectories">{circuit.data ? <TrackMap2D circuit={circuit.data} cmp={cmp.data} /> : circuit.isError ? <ErrorNote error={circuit.error} /> : <Loading />}</Frame>
            <Frame title={<>Explanation <KindBadge kind="calculated" /></>}>
              <Summary cmp={cmp.data} />
            </Frame>
          </div>
        </div>
      )}
    </div>
  );
}
