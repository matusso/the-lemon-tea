import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, get } from "../api";
import { useBundle } from "../data";
import { useUi } from "../state/store";
import { Btn, COMPOUND_COLOR, dash, Empty, ErrorNote, fmtNum, fmtPct, Frame, KindBadge, ProbBar } from "../components/ui";
import { AXIS, baseTextStyle, EChart } from "../components/EChart";

type Compound = "SOFT" | "MEDIUM" | "HARD" | "INTERMEDIATE" | "WET";
interface Strat {
  name: string;
  stints: { compound: Compound; laps: number }[];
}
interface Result {
  name: string;
  stints: { compound: string; laps: number }[];
  plannedPitLaps: number[];
  positionDistribution: number[];
  expectedPosition: number;
  expectedRaceTime: number | null;
  pWin: number;
  pPodium: number;
  pPoints: number;
  dnfShare: number;
  expectedPositionsGained: number;
  trafficRiskAfterPit: number;
  undercutGainFirstLap: number | null;
  sensitivity: { scenario: string; expectedPosition: number; change: number }[];
}
interface Study {
  totalLaps: number;
  iterations: number;
  seed: number;
  objective: string;
  results: Result[];
  headToHead: { a: string; b: string; pAAheadOfB: number }[];
  recommendation: { name: string; reason: string; distinguishable: boolean };
  assumptions: string[];
  notes: string[];
  parameters: Record<string, unknown>;
  modelVersion: string;
}

const PALETTE = ["#e8d44d", "#3fb5c0", "#b38cff", "#ff8a5b"];

function StintTimeline({ strategies, total }: { strategies: { name: string; stints: { compound: string; laps: number }[] }[]; total: number }) {
  return (
    <div className="space-y-1.5">
      {strategies.map((s) => {
        let acc = 0;
        return (
          <div key={s.name} className="flex items-center gap-2">
            <span className="w-24 truncate text-[12px] text-fg-2">{s.name}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-ink-0">
              {s.stints.map((st, i) => {
                const left = (acc / total) * 100;
                acc += st.laps;
                return (
                  <div
                    key={i}
                    className="absolute top-0 flex h-full items-center justify-center border-r-2 border-ink-0 text-[10px] font-bold text-ink-0"
                    style={{ left: `${left}%`, width: `${(st.laps / total) * 100}%`, background: COMPOUND_COLOR[st.compound] ?? "#888" }}
                    title={`${st.compound} ${st.laps} laps`}
                  >
                    {st.compound[0]}
                    {st.laps}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Strategy() {
  const { meetingId, sessionId } = useUi();
  const sessions = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: !!meetingId });
  const races = (sessions.data ?? []).filter((s) => (s.type === "race" || s.type === "sprint") && s.ingestStatus !== "not_ingested");
  const practice = (sessions.data ?? []).filter((s) => s.type === "practice" && s.ingestStatus !== "not_ingested");
  const [race, setRace] = useState<string | null>(null);
  const [paceIds, setPaceIds] = useState<string[]>([]);
  useEffect(() => {
    if (!race || !races.some((r) => r.id === race)) setRace(races.find((r) => r.id === sessionId)?.id ?? races[0]?.id ?? null);
    setPaceIds(practice.map((p) => p.id));
  }, [sessions.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const bundle = useBundle(race);
  const maxLap = useMemo(() => bundle.data?.laps.reduce((m, l) => Math.max(m, l.lapNumber), 0) ?? 0, [bundle.data]);
  const [driver, setDriver] = useState<number | null>(null);
  const [totalLaps, setTotalLaps] = useState(53);
  useEffect(() => {
    if (maxLap > 5) setTotalLaps(maxLap);
    if (bundle.data && driver === null) setDriver(bundle.data.drivers[0]?.driverNumber ?? null);
  }, [maxLap, bundle.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const [strats, setStrats] = useState<Strat[]>([
    { name: "1-stop M-H", stints: [{ compound: "MEDIUM", laps: 22 }, { compound: "HARD", laps: 31 }] },
    { name: "2-stop M-H-M", stints: [{ compound: "MEDIUM", laps: 16 }, { compound: "HARD", laps: 20 }, { compound: "MEDIUM", laps: 17 }] },
  ]);
  const [sc, setSc] = useState(0.012);
  const [vsc, setVsc] = useState(0.008);
  const [pitLoss, setPitLoss] = useState<number | null>(null);
  const [temp, setTemp] = useState(0);
  const [iterations, setIterations] = useState(1000);
  const [seed, setSeed] = useState(42);

  const sim = useMutation({
    mutationFn: () =>
      api<Study>("/api/strategy/simulate", {
        method: "POST",
        body: {
          sessionId: race,
          paceSessionIds: paceIds,
          driverNumber: driver,
          totalLaps,
          strategies: strats,
          iterations,
          seed,
          scenario: { safetyCarProbabilityPerLap: sc, vscProbabilityPerLap: vsc, trackTempDeltaC: temp, ...(pitLoss !== null ? { pitLossSeconds: pitLoss } : {}) },
        },
      }),
  });

  const lapsSum = (s: Strat) => s.stints.reduce((a, x) => a + x.laps, 0);
  const editStint = (si: number, ti: number, p: Partial<Strat["stints"][number]>) =>
    setStrats(strats.map((s, i) => (i !== si ? s : { ...s, stints: s.stints.map((t, j) => (j === ti ? { ...t, ...p } : t)) })));

  const dist = useMemo(() => {
    const r = sim.data;
    if (!r) return null;
    const n = r.results[0]?.positionDistribution.length ?? 20;
    return {
      animation: false,
      textStyle: baseTextStyle,
      grid: { left: 40, right: 10, top: 28, bottom: 28 },
      legend: { top: 0, textStyle: { color: "#b9bbc6", fontSize: 11 } },
      tooltip: { trigger: "axis" as const, backgroundColor: "rgba(18,20,24,0.95)", borderColor: "#31363f", textStyle: { color: "#f5f5f7", fontSize: 11 }, valueFormatter: (v: unknown) => fmtPct(Number(v)) },
      xAxis: { type: "category" as const, data: Array.from({ length: n }, (_, i) => `P${i + 1}`), axisLabel: { color: AXIS.color, fontSize: 10 } },
      yAxis: { type: "value" as const, axisLabel: { color: AXIS.color, formatter: (v: number) => `${Math.round(v * 100)}%` }, splitLine: { lineStyle: { color: AXIS.split } } },
      series: r.results.map((x, i) => ({ name: x.name, type: "bar" as const, data: x.positionDistribution, itemStyle: { color: PALETTE[i % 4] } })),
    };
  }, [sim.data]);

  if (!meetingId) return <Empty>Select a race weekend.</Empty>;
  if (!races.length) return <Empty>No ingested race or sprint session for this weekend. Ingest the race (timing is enough) to provide the field and grid.</Empty>;

  return (
    <div className="grid h-full grid-cols-1 gap-px bg-line lg:grid-cols-[380px_minmax(0,1fr)]">
      <Frame title={<>Scenario <KindBadge kind="simulated" /></>}>
        <div className="space-y-3 p-3 text-[13px]">
          <div className="grid grid-cols-[90px_1fr] items-center gap-2">
            <span className="label">Race</span>
            <select value={race ?? ""} onChange={(e) => setRace(e.target.value)}>
              {races.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <span className="label">Driver</span>
            <select value={driver ?? ""} onChange={(e) => setDriver(Number(e.target.value))}>
              {bundle.data?.drivers.map((d) => (
                <option key={d.driverNumber} value={d.driverNumber}>
                  {d.code} #{d.driverNumber}
                </option>
              ))}
            </select>
            <span className="label">Total laps</span>
            <input type="number" min={5} max={100} value={totalLaps} onChange={(e) => setTotalLaps(Number(e.target.value))} />
            <span className="label">Pace from</span>
            <div className="flex flex-wrap gap-2">
              {practice.length === 0 && <span className="text-[12px] text-fg-3">no practice ingested</span>}
              {practice.map((p) => (
                <label key={p.id} className="flex items-center gap-1 text-[12px]">
                  <input type="checkbox" checked={paceIds.includes(p.id)} onChange={(e) => setPaceIds(e.target.checked ? [...paceIds, p.id] : paceIds.filter((x) => x !== p.id))} />
                  {p.name.replace("Practice ", "FP")}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="label">Strategies</span>
              <Btn disabled={strats.length >= 4} onClick={() => setStrats([...strats, { name: `Option ${strats.length + 1}`, stints: [{ compound: "SOFT", laps: 15 }, { compound: "HARD", laps: totalLaps - 15 }] }])}>
                + add
              </Btn>
            </div>
            {strats.map((s, si) => (
              <div key={si} className="mb-2 rounded border border-line bg-ink-0/50 p-2" style={{ borderLeft: `3px solid ${PALETTE[si % 4]}` }}>
                <div className="mb-1 flex items-center gap-2">
                  <input type="text" className="flex-1" value={s.name} maxLength={40} onChange={(e) => setStrats(strats.map((x, i) => (i === si ? { ...x, name: e.target.value } : x)))} />
                  <span className={`num text-[11px] ${lapsSum(s) === totalLaps ? "text-fg-3" : "text-lemon"}`} title="Last stint absorbs any mismatch">
                    {lapsSum(s)}/{totalLaps}
                  </span>
                  <button className="text-fg-3 hover:text-bad" onClick={() => setStrats(strats.filter((_, i) => i !== si))} disabled={strats.length <= 1}>
                    ✕
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {s.stints.map((t, ti) => (
                    <div key={ti} className="flex items-center gap-0.5">
                      <select value={t.compound} onChange={(e) => editStint(si, ti, { compound: e.target.value as Compound })} style={{ color: COMPOUND_COLOR[t.compound] }}>
                        {(["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"] as Compound[]).map((c) => (
                          <option key={c} value={c}>
                            {c[0]}
                          </option>
                        ))}
                      </select>
                      <input type="number" className="w-12" min={1} max={100} value={t.laps} onChange={(e) => editStint(si, ti, { laps: Number(e.target.value) })} />
                    </div>
                  ))}
                  <Btn disabled={s.stints.length >= 5} onClick={() => setStrats(strats.map((x, i) => (i === si ? { ...x, stints: [...x.stints, { compound: "HARD", laps: 10 }] } : x)))}>
                    +stint
                  </Btn>
                  {s.stints.length > 1 && <Btn onClick={() => setStrats(strats.map((x, i) => (i === si ? { ...x, stints: x.stints.slice(0, -1) } : x)))}>−</Btn>}
                </div>
              </div>
            ))}
            <StintTimeline strategies={strats} total={totalLaps} />
          </div>

          <div className="space-y-1.5">
            <span className="label">Scenario</span>
            {[
              { label: "SC prob / lap", v: sc, set: setSc, min: 0, max: 0.06, step: 0.002, fmt: (x: number) => x.toFixed(3) },
              { label: "VSC prob / lap", v: vsc, set: setVsc, min: 0, max: 0.06, step: 0.002, fmt: (x: number) => x.toFixed(3) },
              { label: "Track temp Δ", v: temp, set: setTemp, min: -15, max: 15, step: 1, fmt: (x: number) => `${x > 0 ? "+" : ""}${x} °C` },
            ].map((s) => (
              <div key={s.label} className="grid grid-cols-[100px_1fr_60px] items-center gap-2">
                <span className="text-[12px] text-fg-2">{s.label}</span>
                <input type="range" min={s.min} max={s.max} step={s.step} value={s.v} onChange={(e) => s.set(Number(e.target.value))} />
                <span className="num text-right text-[12px]">{s.fmt(s.v)}</span>
              </div>
            ))}
            <div className="grid grid-cols-[100px_1fr_60px] items-center gap-2">
              <span className="text-[12px] text-fg-2">Pit loss</span>
              <input type="range" min={10} max={35} step={0.5} value={pitLoss ?? 20} onChange={(e) => setPitLoss(Number(e.target.value))} />
              <span className="num text-right text-[12px]">{pitLoss === null ? "data" : `${pitLoss} s`}</span>
            </div>
            <div className="grid grid-cols-[100px_1fr_1fr] items-center gap-2">
              <span className="text-[12px] text-fg-2">Iterations / seed</span>
              <input type="number" min={100} max={2000} step={100} value={iterations} onChange={(e) => setIterations(Number(e.target.value))} />
              <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
            </div>
          </div>
          <Btn variant="primary" disabled={!race || driver === null || sim.isPending} onClick={() => sim.mutate()}>
            {sim.isPending ? "Simulating…" : "Run Monte Carlo"}
          </Btn>
        </div>
      </Frame>

      <Frame title={<>Results <KindBadge kind="simulated" /></>}>
        {sim.isError && <ErrorNote error={sim.error} />}
        {!sim.data && !sim.isError && <Empty>Configure strategies and run the simulation. Results are distributions, not certainties.</Empty>}
        {sim.data && (
          <div className="space-y-3 p-3 text-[13px]">
            <div className={`rounded border p-2.5 ${sim.data.recommendation.distinguishable ? "border-lemon/40 bg-lemon/5" : "border-line-2 bg-ink-0/50"}`}>
              <div className="label mb-1">{sim.data.recommendation.distinguishable ? "Best under this objective" : "No clear separation"}</div>
              <div className="text-[14px] font-semibold">{sim.data.recommendation.name}</div>
              <div className="text-fg-2">{sim.data.recommendation.reason}</div>
              <div className="mt-1 text-[11px] text-fg-3">Objective: {sim.data.objective}</div>
            </div>
            <div className="h-56">{dist && <EChart option={dist} />}</div>
            <table className="num w-full text-[12px]">
              <thead className="text-left text-[10px] uppercase tracking-wider text-fg-3">
                <tr>
                  <th>Strategy</th>
                  <th className="text-right">E[pos]</th>
                  <th className="pl-3">P(win)</th>
                  <th>P(podium)</th>
                  <th>P(points)</th>
                  <th className="text-right">Gained</th>
                  <th className="text-right">Traffic risk</th>
                  <th className="text-right">Undercut L1</th>
                  <th className="text-right">Pit laps</th>
                  <th className="text-right">DNF</th>
                </tr>
              </thead>
              <tbody>
                {sim.data.results.map((r, i) => (
                  <tr key={r.name} className="border-b border-line/50">
                    <td className="py-0.5">
                      <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: PALETTE[i % 4] }} />
                      {r.name}
                    </td>
                    <td className="text-right">{r.expectedPosition.toFixed(2)}</td>
                    <td className="pl-3">
                      <ProbBar p={r.pWin} />
                    </td>
                    <td>
                      <ProbBar p={r.pPodium} />
                    </td>
                    <td>
                      <ProbBar p={r.pPoints} color="#3fb5c0" />
                    </td>
                    <td className="text-right">{fmtNum(r.expectedPositionsGained, 2, true)}</td>
                    <td className="text-right">{fmtPct(r.trafficRiskAfterPit)}</td>
                    <td className="text-right">{r.undercutGainFirstLap === null ? dash : `${fmtNum(r.undercutGainFirstLap, 2, true)} s`}</td>
                    <td className="text-right text-fg-2">{r.plannedPitLaps.join(", ") || dash}</td>
                    <td className="text-right text-fg-2">{fmtPct(r.dnfShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="label mb-1">Sensitivity (Δ expected position)</div>
                <table className="num w-full text-[12px]">
                  <tbody>
                    {sim.data.results[0]?.sensitivity.map((s, k) => (
                      <tr key={s.scenario} className="border-b border-line/40">
                        <td className="py-0.5 text-fg-2">{s.scenario}</td>
                        {sim.data.results.map((r) => (
                          <td key={r.name} className="text-right">
                            {fmtNum(r.sensitivity[k]?.change, 2, true)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="label mb-1">Head-to-head (paired simulations)</div>
                {sim.data.headToHead.map((h) => (
                  <div key={`${h.a}-${h.b}`} className="num text-[12px] text-fg-2">
                    {h.a} ahead of {h.b}: {fmtPct(h.pAAheadOfB)}
                  </div>
                ))}
                <div className="label mb-1 mt-3">Stints</div>
                <StintTimeline strategies={sim.data.results} total={sim.data.totalLaps} />
              </div>
            </div>
            <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-fg-3">
              {[...sim.data.notes, ...sim.data.assumptions].map((a) => (
                <li key={a}>{a}</li>
              ))}
              <li>
                {sim.data.modelVersion} · {sim.data.iterations} iterations · seed {sim.data.seed} (reproducible)
              </li>
            </ul>
          </div>
        )}
      </Frame>
    </div>
  );
}
