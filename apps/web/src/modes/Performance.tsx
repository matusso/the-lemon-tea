import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, get } from "../api";
import { useMe } from "../data";
import { useUi } from "../state/store";
import { Btn, COMPOUND_COLOR, dash, Empty, ErrorNote, fmtLap, fmtNum, Frame, KindBadge, ProbBar, Tyre } from "../components/ui";
import { AXIS, baseTextStyle, EChart } from "../components/EChart";

interface Interval {
  low: number;
  high: number;
  level: number;
  calibrated: boolean;
}

interface QualiDriver {
  driverNumber: number;
  code: string;
  teamName: string;
  projectedLapTime: number;
  interval: Interval;
  expectedRank: number;
  rankDistribution: number[];
  probabilities: { pole: number; frontRow: number; advanceQ1: number; advanceQ2: number; top10: number };
  evidence: { bestRawLap: number; bestLapSession: string; bestLapNumber: number; compound: string; tyreAge: number | null; adjustments: Record<string, number>; representativeLaps: number };
  explanation: string;
}
interface QualiResp {
  predictionId: string | null;
  asOf: string;
  confidenceType: string;
  modelVersion: string;
  paramsVersion: string;
  drivers: QualiDriver[];
  teammateGaps: { teamName: string; driverA: string; driverB: string; expectedGap: number; sd: number }[];
  sessionOffsets: Record<string, number>;
  compoundOffsets: Record<string, { value: number; source: string }>;
  changesSincePrevious: { code: string; rankChange: number | null; lapTimeChange: number | null }[] | null;
  meta: { assumptions: string[]; warnings: { message: string }[] };
}
interface PaceDriver {
  driverNumber: number;
  code: string;
  teamName: string;
  referencePace: number;
  interval: Interval;
  runs: number;
  laps: number;
  consistency: number;
  meanDegradation: number;
  primaryCompound: string;
}
interface PaceResp {
  drivers: PaceDriver[];
  teams: { teamName: string; referencePace: number; interval: Interval; drivers: string[] }[];
  lapClassCounts: Record<string, number>;
  meta: { assumptions: string[] };
}
interface DegResp {
  compounds: { compound: string; stints: number; laps: number; slope: number; slopeInterval: Interval; cliffIndicatorShare: number; lapsToOneSecondLoss: number | null; lossCurve: { age: number; loss: number }[]; warning: string | null }[];
  modelComparison: { model: string; holdoutMae: number; stintsEvaluated: number }[];
  assumptions: string[];
  inferred_tyre_state_note: string;
  params: { version: string; fuelEffectPerLap: number; calibrated: boolean };
}

function Quali({ q }: { q: QualiResp }) {
  const [open, setOpen] = useState<number | null>(null);
  const calibrated = q.confidenceType === "calibrated_probability";
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[11px] text-fg-3">
        <KindBadge kind="estimated" />
        <span>
          {q.modelVersion} · params {q.paramsVersion} · as of {q.asOf.slice(0, 16).replace("T", " ")} UTC
        </span>
        {!calibrated && <span className="rounded border border-lemon/40 px-1 text-lemon">probabilities uncalibrated</span>}
        {q.predictionId && <span>snapshot saved</span>}
      </div>
      <table className="num w-full text-[12px]">
        <thead className="text-left text-[10px] uppercase tracking-wider text-fg-3">
          <tr>
            <th className="px-2">Exp.</th>
            <th>Driver</th>
            <th className="text-right">Projected</th>
            <th className="text-right">{Math.round((q.drivers[0]?.interval.level ?? 0.8) * 100)}% interval</th>
            <th className="pl-3">P(pole)</th>
            <th>P(front row)</th>
            <th>P(Q3)</th>
            <th>P(Q2)</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {q.drivers.map((d) => (
            <Fragment key={d.driverNumber}>
              <tr className="cursor-pointer border-b border-line/50 hover:bg-ink-3" onClick={() => setOpen(open === d.driverNumber ? null : d.driverNumber)}>
                <td className="px-2 py-0.5 text-fg-2">{d.expectedRank.toFixed(1)}</td>
                <td className="font-bold">
                  {d.code} <span className="font-normal text-fg-3">{d.teamName}</span>
                </td>
                <td className="text-right">{fmtLap(d.projectedLapTime)}</td>
                <td className="text-right text-fg-2">
                  {fmtLap(d.interval.low)} – {fmtLap(d.interval.high)}
                </td>
                <td className="pl-3">
                  <ProbBar p={d.probabilities.pole} />
                </td>
                <td>
                  <ProbBar p={d.probabilities.frontRow} />
                </td>
                <td>
                  <ProbBar p={d.probabilities.advanceQ2} color="#3fb5c0" />
                </td>
                <td>
                  <ProbBar p={d.probabilities.advanceQ1} color="#3fb5c0" />
                </td>
                <td className="text-fg-3">
                  {fmtLap(d.evidence.bestRawLap)} <Tyre compound={d.evidence.compound} /> {d.evidence.bestLapSession.split(":")[1]} L{d.evidence.bestLapNumber}
                </td>
              </tr>
              {open === d.driverNumber && (
                <tr className="bg-ink-0/60">
                  <td colSpan={9} className="px-3 py-2 text-[12px] text-fg-2">
                    {d.explanation}
                    <div className="mt-1 text-fg-3">
                      adjustments: {Object.entries(d.evidence.adjustments).map(([k, v]) => `${k} ${fmtNum(v, 3, true)} s`).join(" · ")} · representative laps {d.evidence.representativeLaps}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="grid gap-3 p-3 text-[12px] md:grid-cols-3">
        <div>
          <div className="label mb-1">Teammate gaps (expected ± sd)</div>
          {q.teammateGaps.map((g) => (
            <div key={g.teamName} className="num text-fg-2">
              {g.driverA}−{g.driverB}: {fmtNum(g.expectedGap, 3, true)} ± {g.sd.toFixed(3)} s
            </div>
          ))}
        </div>
        <div>
          <div className="label mb-1">Changes since previous snapshot</div>
          {q.changesSincePrevious === null ? (
            <div className="text-fg-3">No earlier snapshot.</div>
          ) : q.changesSincePrevious.length === 0 ? (
            <div className="text-fg-3">No material changes.</div>
          ) : (
            q.changesSincePrevious.map((c) => (
              <div key={c.code} className="num text-fg-2">
                {c.code}: rank {fmtNum(c.rankChange, 1, true)}, time {fmtNum(c.lapTimeChange, 3, true)} s
              </div>
            ))
          )}
        </div>
        <div>
          <div className="label mb-1">Adjustments</div>
          {Object.entries(q.sessionOffsets).map(([s, v]) => (
            <div key={s} className="num text-fg-2">
              session {s.split(":")[1]}: {fmtNum(v, 3, true)} s
            </div>
          ))}
          {Object.entries(q.compoundOffsets).map(([c, v]) => (
            <div key={c} className="num text-fg-2">
              {c} vs soft: {fmtNum(v.value, 3, true)} s ({v.source})
            </div>
          ))}
        </div>
      </div>
      <Assumptions items={[...q.meta.assumptions, ...q.meta.warnings.map((w) => w.message)]} />
    </div>
  );
}

function Assumptions({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-0.5 px-3 pb-3 pl-7 text-[11px] text-fg-3">
      {items.map((a) => (
        <li key={a}>{a}</li>
      ))}
    </ul>
  );
}

function Pace({ p }: { p: PaceResp }) {
  return (
    <div>
      <table className="num w-full text-[12px]">
        <thead className="text-left text-[10px] uppercase tracking-wider text-fg-3">
          <tr>
            <th className="px-2">#</th>
            <th>Driver</th>
            <th className="text-right">Ref. pace</th>
            <th className="text-right">Interval</th>
            <th className="text-right">Deg s/lap</th>
            <th className="text-right">Consistency</th>
            <th className="text-right">Runs/laps</th>
            <th>Tyre</th>
          </tr>
        </thead>
        <tbody>
          {p.drivers.map((d, i) => (
            <tr key={d.driverNumber} className="border-b border-line/50">
              <td className="px-2 py-0.5 text-fg-3">{i + 1}</td>
              <td className="font-bold">{d.code}</td>
              <td className="text-right">{fmtLap(d.referencePace)}</td>
              <td className="text-right text-fg-2">
                {fmtLap(d.interval.low)} – {fmtLap(d.interval.high)}
              </td>
              <td className="text-right">{fmtNum(d.meanDegradation, 3)}</td>
              <td className="text-right">{fmtNum(d.consistency, 3)}</td>
              <td className="text-right text-fg-2">
                {d.runs}/{d.laps}
              </td>
              <td>
                <Tyre compound={d.primaryCompound} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="p-3">
        <div className="label mb-1">Team race-pace ranking</div>
        {p.teams.map((t, i) => (
          <div key={t.teamName} className="num flex gap-3 text-[12px]">
            <span className="w-4 text-fg-3">{i + 1}</span>
            <span className="w-40 truncate">{t.teamName}</span>
            <span>{fmtLap(t.referencePace)}</span>
            <span className="text-fg-3">
              ({fmtLap(t.interval.low)}–{fmtLap(t.interval.high)})
            </span>
          </div>
        ))}
        <div className="label mb-1 mt-3">Lap classification</div>
        <div className="num flex flex-wrap gap-x-3 text-[11px] text-fg-2">
          {Object.entries(p.lapClassCounts).map(([k, v]) => (
            <span key={k}>
              {k.replaceAll("_", " ")}: {v}
            </span>
          ))}
        </div>
      </div>
      <Assumptions items={p.meta.assumptions} />
    </div>
  );
}

function Deg({ d }: { d: DegResp }) {
  const option = useMemo(
    () => ({
      animation: false,
      textStyle: baseTextStyle,
      grid: { left: 46, right: 12, top: 24, bottom: 30 },
      legend: { top: 0, textStyle: { color: "#b9bbc6", fontSize: 11 } },
      tooltip: { trigger: "axis" as const, backgroundColor: "rgba(18,20,24,0.95)", borderColor: "#31363f", textStyle: { color: "#f5f5f7", fontSize: 11 } },
      xAxis: { type: "value" as const, name: "tyre age (laps)", nameLocation: "middle" as const, nameGap: 20, max: 35, axisLabel: { color: AXIS.color }, splitLine: { show: false } },
      yAxis: { type: "value" as const, name: "s vs fresh", axisLabel: { color: AXIS.color }, splitLine: { lineStyle: { color: AXIS.split } } },
      series: d.compounds.map((c) => ({
        name: `${c.compound} (${c.stints} stints)`,
        type: "line" as const,
        showSymbol: false,
        lineStyle: { color: COMPOUND_COLOR[c.compound] ?? "#888" },
        itemStyle: { color: COMPOUND_COLOR[c.compound] ?? "#888" },
        data: c.lossCurve.filter((x) => x.age <= 35).map((x) => [x.age, x.loss]),
      })),
    }),
    [d],
  );
  return (
    <div>
      <div className="h-56">
        <EChart option={option} />
      </div>
      <table className="num w-full text-[12px]">
        <thead className="text-left text-[10px] uppercase tracking-wider text-fg-3">
          <tr>
            <th className="px-2">Compound</th>
            <th className="text-right">s/lap</th>
            <th className="text-right">Interval</th>
            <th className="text-right">Laps→1 s</th>
            <th className="text-right">Cliff ind.</th>
          </tr>
        </thead>
        <tbody>
          {d.compounds.map((c) => (
            <tr key={c.compound} className="border-b border-line/50">
              <td className="px-2 py-0.5">
                <Tyre compound={c.compound} /> {c.compound}
              </td>
              <td className="text-right">{c.slope.toFixed(3)}</td>
              <td className="text-right text-fg-2">
                {c.slopeInterval.low.toFixed(3)} – {c.slopeInterval.high.toFixed(3)} {c.slopeInterval.calibrated ? "" : "(uncal.)"}
              </td>
              <td className="text-right">{c.lapsToOneSecondLoss ?? dash}</td>
              <td className="text-right">{(c.cliffIndicatorShare * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.compounds
        .filter((c) => c.warning)
        .map((c) => (
          <div key={c.compound} className="mx-2 mt-2 rounded border border-line px-2 py-1 text-[12px] text-amber-300">
            {c.compound}: {c.warning}
          </div>
        ))}
      <div className="p-3">
        <div className="label mb-1">Model comparison (holdout MAE, last 3 laps of each stint)</div>
        {d.modelComparison.map((m) => (
          <div key={m.model} className="num text-[12px] text-fg-2">
            {m.model.replaceAll("_", " ")}: {Number.isFinite(m.holdoutMae) ? `${m.holdoutMae.toFixed(3)} s` : dash} ({m.stintsEvaluated} stints)
          </div>
        ))}
        <div className="mt-2 text-[11px] text-fg-3">{d.inferred_tyre_state_note}</div>
      </div>
      <Assumptions items={d.assumptions} />
    </div>
  );
}

export default function Performance() {
  const { meetingId } = useUi();
  const me = useMe();
  const sessions = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: !!meetingId });
  const practice = useMemo(() => (sessions.data ?? []).filter((s) => (s.type === "practice" || s.type === "sprint") && s.ingestStatus !== "not_ingested").sort((a, b) => a.dateStart.localeCompare(b.dateStart)), [sessions.data]);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked(practice.map((s) => s.id)), [practice]);

  const quali = useMutation({ mutationFn: () => api<QualiResp>("/api/predictions/qualifying", { method: "POST", body: { sessionIds: picked, persist: !me.data?.anonymous } }) });
  const pace = useMutation({ mutationFn: () => api<PaceResp>("/api/predictions/race-pace", { method: "POST", body: { sessionIds: picked } }) });
  const deg = useMutation({ mutationFn: () => api<DegResp>("/api/tyres/degradation", { method: "POST", body: { sessionIds: picked } }) });

  if (!meetingId) return <Empty>Select a race weekend.</Empty>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-ink-1/80 px-3 py-1.5">
        <span className="label">Practice inputs</span>
        {practice.length === 0 && <span className="text-[12px] text-fg-3">No ingested practice/sprint sessions for this weekend.</span>}
        {practice.map((s) => (
          <label key={s.id} className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
            {s.name}
          </label>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        <Btn variant="primary" disabled={!picked.length || quali.isPending} onClick={() => quali.mutate()}>
          {quali.isPending ? "Forecasting…" : "Predict qualifying"}
        </Btn>
        <Btn disabled={!picked.length || pace.isPending} onClick={() => pace.mutate()}>
          {pace.isPending ? "…" : "Race pace"}
        </Btn>
        <Btn disabled={!picked.length || deg.isPending} onClick={() => deg.mutate()}>
          {deg.isPending ? "…" : "Tyre degradation"}
        </Btn>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Frame title={<>Qualifying forecast <KindBadge kind="estimated" /></>}>
          {quali.isError && <ErrorNote error={quali.error} />}
          {quali.data ? <Quali q={quali.data} /> : !quali.isError && <Empty>Run “Predict qualifying” using the selected practice sessions.</Empty>}
        </Frame>
        <div className="grid min-h-0 grid-rows-2 gap-px">
          <Frame title={<>Long runs · race pace <KindBadge kind="estimated" /></>}>
            {pace.isError && <ErrorNote error={pace.error} />}
            {pace.data ? <Pace p={pace.data} /> : !pace.isError && <Empty>Run “Race pace”.</Empty>}
          </Frame>
          <Frame title={<>Tyre degradation <KindBadge kind="estimated" /></>}>
            {deg.isError && <ErrorNote error={deg.error} />}
            {deg.data ? <Deg d={deg.data} /> : !deg.isError && <Empty>Run “Tyre degradation”.</Empty>}
          </Frame>
        </div>
      </div>
    </div>
  );
}
