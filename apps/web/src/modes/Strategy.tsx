import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, get, type SessionRow } from "../api";
import { useBundle, useCircuit } from "../data";
import { Combobox, Pill } from "../components/Combobox";
import { useUi } from "../state/store";
import { Btn, Chooser, COMPOUND_COLOR, dash, Empty, ErrorNote, fmtNum, fmtPct, Frame, KindBadge, Loading, ProbBar, Stepper, useChoice } from "../components/ui";
import { AXIS, baseTextStyle, EChart } from "../components/EChart";

import { addPit, type Compound, fromShares, pitLaps, removePit, rescale, setPit, type Stint, TEMPLATES, total, uniqueName } from "./strategy/stints";

const COMPOUNDS: Compound[] = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"];
interface Strat {
  name: string;
  stints: Stint[];
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
  parameters: {
    pitLaneLoss?: number;
    scProbabilityPerLap?: number;
    vscProbabilityPerLap?: number;
    fuelEffectPerLap?: number;
    overtakeDifficulty?: number;
    degradation?: Record<string, { slope: number; quad: number }>;
  };
  modelVersion: string;
}

/** Strategy identity colours (distinct from the compound colours used inside the bars). */
const PALETTE = ["#e10600", "#ffffff", "#27c5e8", "#b44cf0", "#ffd12e", "#00d26a"];
const MAX_STRATS = 6;

// ---------------------------------------------------------------- small pieces

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3.5 last:border-b-0">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="label !text-fg">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[116px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 py-1">
      <span className="text-[13px] text-fg-2">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      {hint && <div className="col-start-2 text-[12px] leading-snug text-fg-3">{hint}</div>}
    </div>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${on ? "border-f1 bg-f1" : "border-line-2 bg-ink-0"}`}
    >
      <span className={`absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-[2px]"}`} />
    </button>
  );
}

function TyreDot({ c, size = 16 }: { c: string; size?: number }) {
  const col = COMPOUND_COLOR[c] ?? "#888";
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full border-[2.5px] bg-ink-0 font-black" style={{ width: size, height: size, borderColor: col, color: col, fontSize: size * 0.5 }}>
      {c[0]}
    </span>
  );
}

/** Compact stint strip for tables. */
function StintMini({ stints, laps }: { stints: { compound: string; laps: number }[]; laps: number }) {
  return (
    <div className="flex h-2.5 w-40 overflow-hidden rounded-[2px] bg-ink-0">
      {stints.map((s, i) => (
        <div key={i} title={`${s.compound} · ${s.laps} laps`} style={{ width: `${(s.laps / laps) * 100}%`, background: COMPOUND_COLOR[s.compound] ?? "#888" }} className="border-r-2 border-ink-1 last:border-r-0" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- lap-precise stint editor

/**
 * One strategy on a lap axis. Drag a pit marker (or focus it and use ←/→, Shift ×5) to move the
 * stop; double-click the bar to add a stop at that lap; Delete removes a focused stop; click a
 * stint to change its compound.
 */
function StintBar({ stints, laps, onChange }: { stints: Stint[]; laps: number; onChange: (s: Stint[]) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const pits = pitLaps(stints);
  const lapAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(laps, Math.max(0, ((clientX - r.left) / r.width) * laps));
  };
  const pct = (lap: number) => `${(lap / laps) * 100}%`;
  const major = laps > 60 ? 10 : 5;
  useEffect(() => {
    if (pick === null) return;
    const close = () => setPick(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [pick]);

  let start = 0;
  return (
    <div className="select-none">
      <div
        ref={bar}
        className="relative h-10 cursor-crosshair rounded-[4px] bg-ink-0"
        onPointerMove={(e) => {
          const l = lapAt(e.clientX);
          setHover(Math.max(1, Math.ceil(l)));
          if (drag !== null) onChange(setPit(stints, drag, Math.round(l)));
        }}
        onPointerLeave={() => drag === null && setHover(null)}
        onPointerUp={() => setDrag(null)}
        onDoubleClick={(e) => {
          const l = Math.round(lapAt(e.clientX));
          if (stints.length < 5 && !pits.includes(l)) onChange(addPit(stints, l));
        }}
        title="Double-click to add a stop at that lap"
      >
        {stints.map((s, i) => {
          const left = start;
          start += s.laps;
          const w = (s.laps / laps) * 100;
          const col = COMPOUND_COLOR[s.compound] ?? "#888";
          return (
            <button
              type="button"
              key={i}
              className="absolute top-0 flex h-full items-center gap-1.5 overflow-hidden px-2 text-left text-ink-0 outline-offset-[-2px] hover:brightness-110"
              style={{ left: pct(left), width: `${w}%`, background: `linear-gradient(180deg, ${col}, ${col}d0)`, borderRadius: i === 0 ? "4px 0 0 4px" : i === stints.length - 1 ? "0 4px 4px 0" : 0 }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setPick(pick === i ? null : i)}
              aria-label={`Stint ${i + 1}: ${s.compound}, laps ${left + 1} to ${left + s.laps}. Click to change compound.`}
            >
              <span className="display truncate text-[12px] tracking-[0.04em]">{w > 14 ? s.compound : s.compound[0]}</span>
              <span className="num shrink-0 text-[12px] font-bold">{s.laps}</span>
            </button>
          );
        })}
        {hover !== null && drag === null && (
          <div className="pointer-events-none absolute inset-y-0 w-px bg-white/70" style={{ left: pct(hover - 0.5) }}>
            <span className="num absolute -top-5 -translate-x-1/2 rounded-[3px] bg-ink-3 px-1 text-[11px] text-fg">L{hover}</span>
          </div>
        )}
        {pits.map((p, i) => (
          <div
            key={i}
            role="slider"
            tabIndex={0}
            aria-label={`Stop ${i + 1}, end of lap`}
            aria-valuenow={p}
            aria-valuemin={1}
            aria-valuemax={laps - 1}
            className="group absolute -top-1.5 bottom-[-6px] z-10 flex w-4 -translate-x-1/2 cursor-ew-resize justify-center outline-none"
            style={{ left: pct(p) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              setDrag(i);
            }}
            onPointerUp={() => setDrag(null)}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              const d = (e.shiftKey ? 5 : 1) * (e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0);
              if (d) {
                e.preventDefault();
                onChange(setPit(stints, i, p + d));
              } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                onChange(removePit(stints, i));
              }
            }}
          >
            <span className={`h-full bg-f1 shadow-[0_0_0_1px_#070709] transition-all group-hover:w-[5px] group-focus-visible:w-[5px] ${drag === i ? "w-[5px]" : "w-[3px]"}`} />
            <span className={`num absolute -top-5 whitespace-nowrap rounded-[3px] px-1 text-[11px] font-bold ${drag === i ? "bg-f1 text-white" : "bg-ink-3 text-fg group-hover:bg-f1 group-hover:text-white"}`}>L{p}</span>
          </div>
        ))}
        {pick !== null && stints[pick] && (
          <div
            className="absolute top-[calc(100%+8px)] z-20 flex -translate-x-1/2 gap-1 rounded-md border border-line-2 bg-ink-2 p-1 shadow-2xl"
            style={{ left: pct((pits[pick - 1] ?? 0) + stints[pick]!.laps / 2) }}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {COMPOUNDS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                className={`rounded p-1 hover:bg-ink-3 ${stints[pick]!.compound === c ? "bg-ink-3 ring-1 ring-fg-3" : ""}`}
                onClick={() => (onChange(stints.map((x, j) => (j === pick ? { ...x, compound: c } : x))), setPick(null))}
              >
                <TyreDot c={c} size={22} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="relative mt-1 h-4">
        {Array.from({ length: laps + 1 }, (_, l) => l).map((l) =>
          l % major === 0 || l === laps ? (
            <span key={l} className="absolute top-0 -translate-x-1/2 text-center" style={{ left: pct(l) }}>
              <span className="mx-auto block h-1 w-px bg-fg-3" />
              <span className="num block text-[10px] leading-3 text-fg-3">{l}</span>
            </span>
          ) : laps <= 80 ? (
            <span key={l} className="absolute top-0 h-[3px] w-px bg-line-2" style={{ left: pct(l) }} />
          ) : null,
        )}
      </div>
    </div>
  );
}

function StrategyRow({
  s,
  i,
  laps,
  result,
  duplicateName,
  onChange,
  onRemove,
  onDuplicate,
  canRemove,
  canDuplicate,
}: {
  s: Strat;
  i: number;
  laps: number;
  result: Result | undefined;
  duplicateName: boolean;
  onChange: (s: Strat) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  canRemove: boolean;
  canDuplicate: boolean;
}) {
  const pits = pitLaps(s.stints);
  return (
    <div className="rounded-[8px] border border-line bg-ink-2/50 px-3 pb-2 pt-2.5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="h-5 w-[6px] -skew-x-[20deg]" style={{ background: PALETTE[i % PALETTE.length] }} />
        <input
          type="text"
          aria-label="Strategy name"
          className={`display !w-48 !border-transparent !bg-transparent !px-1 !text-[14px] hover:!border-line-2 focus:!border-line-2 ${duplicateName ? "!border-bad" : ""}`}
          value={s.name}
          maxLength={40}
          onChange={(e) => onChange({ ...s, name: e.target.value })}
        />
        {duplicateName && <span className="text-[12px] text-bad">name already used</span>}
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="label mr-0.5">Stops</span>
          {pits.length === 0 && <span className="text-[12px] text-fg-3">none</span>}
          {pits.map((p, k) => (
            <span key={k} className="inline-flex items-center gap-0.5">
              <Stepper ariaLabel={`Stop ${k + 1} lap`} value={p} min={1} max={laps - 1} width={34} onChange={(v) => onChange({ ...s, stints: setPit(s.stints, k, v) })} />
              <button type="button" className="px-1 text-[13px] text-fg-3 hover:text-bad" title="Remove this stop" onClick={() => onChange({ ...s, stints: removePit(s.stints, k) })}>
                ✕
              </button>
            </span>
          ))}
          <Btn
            size="sm"
            disabled={s.stints.length >= 5}
            title="Add a stop in the middle of the longest stint (or double-click the bar)"
            onClick={() => {
              const longest = s.stints.reduce((b, x, k) => (x.laps > s.stints[b]!.laps ? k : b), 0);
              const start = s.stints.slice(0, longest).reduce((a, x) => a + x.laps, 0);
              const lap = start + Math.floor(s.stints[longest]!.laps / 2);
              if (s.stints[longest]!.laps >= 2) onChange({ ...s, stints: addPit(s.stints, lap) });
            }}
          >
            + Stop
          </Btn>
        </span>
        <span className="ml-auto flex items-center gap-2">
          {result && (
            <span className="num text-[12px] text-fg-2" title="From the last simulation run">
              E[pos] <b className="text-fg">{result.expectedPosition.toFixed(2)}</b> · podium {fmtPct(result.pPodium)}
            </span>
          )}
          <Btn size="sm" onClick={onDuplicate} disabled={!canDuplicate} title="Duplicate to try a variation">
            Duplicate
          </Btn>
          <Btn size="sm" onClick={onRemove} disabled={!canRemove} title="Remove strategy">
            ✕
          </Btn>
        </span>
      </div>
      <StintBar stints={s.stints} laps={laps} onChange={(st) => onChange({ ...s, stints: st })} />
    </div>
  );
}

function TemplateMenu({ onPick, disabled }: { onPick: (t: (typeof TEMPLATES)[number]) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={root} className="relative">
      <Btn disabled={disabled} active={open} onClick={() => setOpen(!open)}>
        + Strategy
      </Btn>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-[70] w-56 rounded-lg border border-line-2 bg-ink-2 p-1 shadow-2xl">
          {TEMPLATES.map((t) => (
            <button key={t.name} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] hover:bg-ink-3" onClick={() => (onPick(t), setOpen(false))}>
              <span className="flex gap-0.5">
                {t.shares.map(([c], k) => (
                  <TyreDot key={k} c={c} size={14} />
                ))}
              </span>
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- results

const METRICS = ["epos", "win", "podium", "points", "gained", "traffic", "undercut", "pits", "dnf", "time"] as const;
type Metric = (typeof METRICS)[number];
const METRIC_OPTS: { id: Metric; label: string; hint?: string }[] = [
  { id: "epos", label: "Expected position" },
  { id: "win", label: "P(win)" },
  { id: "podium", label: "P(podium)" },
  { id: "points", label: "P(points)" },
  { id: "gained", label: "Places gained", hint: "vs grid" },
  { id: "traffic", label: "Traffic risk after stop" },
  { id: "undercut", label: "Undercut, first lap" },
  { id: "pits", label: "Pit laps" },
  { id: "dnf", label: "DNF share" },
  { id: "time", label: "Expected race time" },
];
const SECTIONS = ["dist", "h2h", "sens", "model", "notes"] as const;
type Sect = (typeof SECTIONS)[number];
const SECTION_OPTS: { id: Sect; label: string }[] = [
  { id: "dist", label: "Finishing-position distribution" },
  { id: "h2h", label: "Head-to-head" },
  { id: "sens", label: "Sensitivity" },
  { id: "model", label: "Model inputs used" },
  { id: "notes", label: "Notes & assumptions" },
];

function fmtRaceTime(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return dash;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

function Results({ data, stale }: { data: Study; stale: boolean }) {
  const [metrics, setMetrics] = useChoice<Metric>("lt:strat-metrics", METRICS, ["epos", "win", "podium", "points", "gained", "pits"]);
  const [sections, setSections] = useChoice<Sect>("lt:strat-sections", SECTIONS, ["dist", "h2h", "model"]);
  const m = (k: Metric) => metrics.includes(k);
  const sec = (k: Sect) => sections.includes(k);
  const colour = (name: string) => PALETTE[Math.max(0, data.results.findIndex((r) => r.name === name)) % PALETTE.length]!;

  const dist = useMemo(() => {
    const n = data.results[0]?.positionDistribution.length ?? 20;
    return {
      animation: false,
      textStyle: baseTextStyle,
      grid: { left: 44, right: 12, top: 30, bottom: 26 },
      legend: { top: 0, icon: "rect", itemWidth: 10, itemHeight: 10, textStyle: { color: "#c9c9d1", fontSize: 12, fontFamily: "Archivo Variable, sans-serif" } },
      tooltip: { trigger: "axis" as const, backgroundColor: "rgba(16,16,21,0.96)", borderColor: "#3a3a46", textStyle: { color: "#fff", fontSize: 12, fontFamily: "Space Mono, monospace" }, valueFormatter: (v: unknown) => fmtPct(Number(v)) },
      xAxis: { type: "category" as const, data: Array.from({ length: n }, (_, i) => `P${i + 1}`), axisLabel: { color: AXIS.color, fontSize: 11 }, axisLine: { lineStyle: { color: AXIS.line } }, axisTick: { show: false } },
      yAxis: { type: "value" as const, axisLabel: { color: AXIS.color, fontSize: 11, formatter: (v: number) => `${Math.round(v * 100)}%` }, splitLine: { lineStyle: { color: AXIS.split } } },
      series: data.results.map((x) => ({ name: x.name, type: "bar" as const, barGap: "10%", data: x.positionDistribution, itemStyle: { color: colour(x.name), borderRadius: [2, 2, 0, 0] } })),
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rec = data.recommendation;
  const deg = data.parameters.degradation ?? {};
  return (
    <div className="space-y-4 p-4">
      {stale && (
        <div className="rounded-[6px] border border-lemon/40 bg-lemon/5 px-3 py-2 text-[13px] text-lemon">These results are from the previous setup. Run again to update them.</div>
      )}
      <div className={`relative overflow-hidden rounded-[8px] border px-4 py-3 ${rec.distinguishable ? "border-f1/60 bg-f1/[0.07]" : "border-line-2 bg-ink-2/60"}`}>
        <span aria-hidden className="ghost absolute -right-2 -top-3 text-[84px] opacity-70">
          {rec.distinguishable ? "Best" : "Tie"}
        </span>
        <div className="relative">
          <div className="mb-1.5 flex items-center gap-2">
            <span className={rec.distinguishable ? "tag" : "tag !bg-ink-3 !text-fg-2"}>{rec.distinguishable ? "Recommended" : "No clear separation"}</span>
            <span className="text-[12px] text-fg-3">Objective: {data.objective}</span>
          </div>
          <div className="display text-[26px]" style={{ color: rec.distinguishable ? colour(rec.name) : undefined }}>
            {rec.name}
          </div>
          <div className="mt-1 max-w-3xl text-[14px] text-fg-2">{rec.reason}</div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label !text-fg">Comparison</span>
          <span className="flex gap-1.5">
            <Chooser label="Metrics" options={METRIC_OPTS} value={metrics} onChange={setMetrics} />
            <Chooser label="Sections" options={SECTION_OPTS} value={sections} onChange={setSections} />
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="num w-full text-[14px]">
            <thead className="label text-left !text-[10px]">
              <tr className="border-b border-line">
                <th className="py-2 pr-3">Strategy</th>
                {m("epos") && <th className="px-2 text-right">E[pos]</th>}
                {m("win") && <th className="px-2">P(win)</th>}
                {m("podium") && <th className="px-2">P(podium)</th>}
                {m("points") && <th className="px-2">P(points)</th>}
                {m("gained") && <th className="px-2 text-right">Gained</th>}
                {m("traffic") && <th className="px-2 text-right">Traffic</th>}
                {m("undercut") && <th className="px-2 text-right">Undercut L1</th>}
                {m("pits") && <th className="px-2 text-right">Pit laps</th>}
                {m("dnf") && <th className="px-2 text-right">DNF</th>}
                {m("time") && <th className="px-2 text-right">Race time</th>}
              </tr>
            </thead>
            <tbody>
              {[...data.results]
                .sort((a, b) => a.expectedPosition - b.expectedPosition)
                .map((r, k) => (
                  <tr key={r.name} className={`h-11 border-b border-line/60 ${r.name === rec.name && rec.distinguishable ? "bg-f1/[0.06]" : ""}`}>
                    <td className="pr-3">
                      <div className="flex items-center gap-2.5">
                        <span className="num w-4 text-[12px] text-fg-3">{k + 1}</span>
                        <span className="h-5 w-[5px] -skew-x-[20deg]" style={{ background: colour(r.name) }} />
                        <div>
                          <div className="font-sans text-[14px] font-semibold">{r.name}</div>
                          <StintMini stints={r.stints} laps={data.totalLaps} />
                        </div>
                      </div>
                    </td>
                    {m("epos") && <td className="px-2 text-right text-[15px] font-bold">{r.expectedPosition.toFixed(2)}</td>}
                    {m("win") && (
                      <td className="px-2">
                        <ProbBar p={r.pWin} />
                      </td>
                    )}
                    {m("podium") && (
                      <td className="px-2">
                        <ProbBar p={r.pPodium} />
                      </td>
                    )}
                    {m("points") && (
                      <td className="px-2">
                        <ProbBar p={r.pPoints} color="#e9e9ec" />
                      </td>
                    )}
                    {m("gained") && (
                      <td className={`px-2 text-right ${r.expectedPositionsGained > 0.05 ? "text-good" : r.expectedPositionsGained < -0.05 ? "text-bad" : "text-fg-2"}`}>{fmtNum(r.expectedPositionsGained, 2, true)}</td>
                    )}
                    {m("traffic") && <td className="px-2 text-right text-fg-2">{fmtPct(r.trafficRiskAfterPit)}</td>}
                    {m("undercut") && <td className="px-2 text-right text-fg-2">{r.undercutGainFirstLap === null ? dash : `${fmtNum(r.undercutGainFirstLap, 2, true)} s`}</td>}
                    {m("pits") && <td className="px-2 text-right text-fg-2">{r.plannedPitLaps.map((p) => `L${p}`).join(" ") || dash}</td>}
                    {m("dnf") && <td className="px-2 text-right text-fg-2">{fmtPct(r.dnfShare)}</td>}
                    {m("time") && <td className="px-2 text-right text-fg-2">{fmtRaceTime(r.expectedRaceTime)}</td>}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {sec("dist") && (
        <div>
          <div className="label mb-1 !text-fg">Finishing position</div>
          <div className="h-56">
            <EChart option={dist} />
          </div>
        </div>
      )}

      {(sec("h2h") || sec("sens") || sec("model")) && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sec("h2h") && (
            <div>
              <div className="label mb-2 !text-fg">Head-to-head</div>
              <div className="space-y-2">
                {data.headToHead.map((h) => (
                  <div key={`${h.a}-${h.b}`} className="text-[13px]">
                    <div className="mb-0.5 flex justify-between gap-2">
                      <span style={{ color: colour(h.a) }}>{h.a}</span>
                      <span style={{ color: colour(h.b) }}>{h.b}</span>
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-[2px]" title={`${h.a} ahead in ${fmtPct(h.pAAheadOfB)} of paired runs`}>
                      <div style={{ width: `${h.pAAheadOfB * 100}%`, background: colour(h.a) }} />
                      <div className="flex-1" style={{ background: colour(h.b), opacity: 0.55 }} />
                    </div>
                    <div className="num mt-0.5 flex justify-between text-[11px] text-fg-3">
                      <span>{fmtPct(h.pAAheadOfB)}</span>
                      <span>{fmtPct(1 - h.pAAheadOfB)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {sec("sens") && (
            <div>
              <div className="label mb-2 !text-fg">Sensitivity · Δ E[pos]</div>
              <table className="num w-full text-[13px]">
                <thead>
                  <tr className="text-fg-3">
                    <th />
                    {data.results.map((r) => (
                      <th key={r.name} className="px-1 text-right">
                        <span className="inline-block h-2 w-2" style={{ background: colour(r.name) }} title={r.name} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.results[0]?.sensitivity.map((s, k) => (
                    <tr key={s.scenario} className="border-b border-line/40">
                      <td className="py-1 pr-2 font-sans text-fg-2">{s.scenario}</td>
                      {data.results.map((r) => {
                        const c = r.sensitivity[k]?.change ?? 0;
                        return (
                          <td key={r.name} className={`px-1 text-right ${c > 0.1 ? "text-bad" : c < -0.1 ? "text-good" : "text-fg-2"}`}>
                            {fmtNum(c, 2, true)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1 text-[11px] text-fg-3">Positive = finishes further back under that scenario.</div>
            </div>
          )}
          {sec("model") && (
            <div>
              <div className="label mb-2 !text-fg">Model inputs used</div>
              <dl className="num grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px]">
                <dt className="font-sans text-fg-2">Pit-lane loss</dt>
                <dd className="text-right">{fmtNum(data.parameters.pitLaneLoss, 1)} s</dd>
                <dt className="font-sans text-fg-2">SC / VSC per lap</dt>
                <dd className="text-right">
                  {fmtNum(data.parameters.scProbabilityPerLap, 4)} / {fmtNum(data.parameters.vscProbabilityPerLap, 4)}
                </dd>
                <dt className="font-sans text-fg-2">Fuel effect</dt>
                <dd className="text-right">{fmtNum(data.parameters.fuelEffectPerLap, 3)} s/lap</dd>
                <dt className="font-sans text-fg-2">Overtake difficulty</dt>
                <dd className="text-right">{fmtNum(data.parameters.overtakeDifficulty, 2)}</dd>
                {(["SOFT", "MEDIUM", "HARD"] as const).map((c) =>
                  deg[c] ? (
                    <div key={c} className="contents">
                      <dt className="flex items-center gap-1.5 font-sans text-fg-2">
                        <TyreDot c={c} size={14} /> degradation
                      </dt>
                      <dd className="text-right">{fmtNum(deg[c]!.slope, 3)} s/lap</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </div>
          )}
        </div>
      )}

      {sec("notes") && (
        <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-fg-3">
          {[...data.notes, ...data.assumptions].map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <div className="num text-[11px] text-fg-3">
        {data.modelVersion} · {data.iterations} iterations · seed {data.seed} (reproducible)
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- screen

const TYPE_LABEL: Record<string, string> = { practice: "Practice", qualifying: "Qualifying", sprint_qualifying: "Sprint quali", sprint: "Sprint", race: "Race" };
const shortName = (s: SessionRow) => s.name.replace("Practice ", "FP").replace("Sprint Qualifying", "Sprint quali");

function readFlag(k: string, d: boolean): boolean {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : v === "1";
  } catch {
    return d;
  }
}

export default function Strategy() {
  const { meetingId, sessionId } = useUi();
  const sessions = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: !!meetingId });
  const all = [...(sessions.data ?? [])].sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  const races = all.filter((s) => s.type === "race" || s.type === "sprint");
  const loaded = all.filter((s) => s.ingestStatus !== "not_ingested" && s.ingestStatus !== "failed");
  const [race, setRace] = useState<string | null>(null);
  const raceRow = races.find((r) => r.id === race) ?? null;
  // Every loaded session before the race can feed the model; the user picks which.
  const inputs = loaded.filter((s) => s.id !== race && (!raceRow || s.dateStart < raceRow.dateStart));
  const [paceIds, setPaceIds] = useState<string[]>([]);
  const [gridId, setGridId] = useState<string>("auto");
  const [qualiPace, setQualiPace] = useState(true);
  const [fitDeg, setFitDeg] = useState(true);
  useEffect(() => {
    if (!race || !races.some((r) => r.id === race)) {
      // the selected race, else the next race that has not finished, else the last one
      const upcoming = races.find((r) => Date.parse(r.dateStart) + 3 * 3600_000 > Date.now());
      setRace(races.find((r) => r.id === sessionId)?.id ?? upcoming?.id ?? races[races.length - 1]?.id ?? null);
    }
  }, [sessions.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // default data: the weekend's practice sessions (sprint weekends: the sprint too) before this race
    setPaceIds(inputs.filter((s) => s.type === "practice" || s.type === "sprint").map((s) => s.id).slice(0, 6));
    setGridId("auto");
  }, [sessions.data, race]); // eslint-disable-line react-hooks/exhaustive-deps

  const preRace = !!raceRow && raceRow.ingestStatus === "not_ingested";
  const bundle = useBundle(race && !preRace ? race : null);
  const rosterId = preRace ? (loaded.filter((s) => raceRow && s.dateStart <= raceRow.dateStart).at(-1)?.id ?? null) : null;
  const roster = useBundle(rosterId);
  const circuit = useCircuit(preRace ? rosterId : null);
  const drivers = (preRace ? roster.data?.drivers : bundle.data?.drivers) ?? [];
  const maxLap = useMemo(() => bundle.data?.laps.reduce((m, l) => Math.max(m, l.lapNumber), 0) ?? 0, [bundle.data]);
  const [driver, setDriver] = useState<number | null>(null);
  const [laps, setLaps] = useState(53);
  const [lapsEstimated, setLapsEstimated] = useState(false);
  useEffect(() => {
    if (!preRace && maxLap > 5) {
      setLaps(maxLap);
      setLapsEstimated(false);
    } else if (preRace && circuit.data) {
      // Race distance rule: fewest laps exceeding 305 km (sprint: 100 km).
      const km = raceRow?.type === "sprint" ? 100_000 : 305_000;
      setLaps(Math.min(100, Math.max(5, Math.ceil(km / circuit.data.lengthM))));
      setLapsEstimated(true);
    }
  }, [maxLap, preRace, circuit.data, raceRow?.type]);
  useEffect(() => {
    if (drivers.length && (driver === null || !drivers.some((d) => d.driverNumber === driver))) setDriver(drivers[0]!.driverNumber);
  }, [drivers]); // eslint-disable-line react-hooks/exhaustive-deps

  const [strats, setStrats] = useState<Strat[]>(() => [TEMPLATES[0]!, TEMPLATES[3]!].map((t) => ({ name: t.name, stints: fromShares(t.shares, 53) })));
  // Keep strategies at race distance when the lap count changes: stints scale proportionally.
  useEffect(() => setStrats((cur) => cur.map((s) => ({ ...s, stints: rescale(s.stints, laps) }))), [laps]);

  // Conditions, expressed per race (what people reason about) and sent per lap.
  const [scRace, setScRace] = useState(0.45);
  const [vscRace, setVscRace] = useState(0.35);
  const [pitLoss, setPitLoss] = useState<number | null>(null);
  const [temp, setTemp] = useState(0);
  const [iterations, setIterations] = useState(1000);
  const [seed, setSeed] = useState(42);
  const [auto, setAutoState] = useState(() => readFlag("lt:strat-auto", true));
  const setAuto = (v: boolean) => {
    setAutoState(v);
    try {
      localStorage.setItem("lt:strat-auto", v ? "1" : "0");
    } catch {
      // ignore
    }
  };
  const perLap = (p: number) => Math.min(0.2, 1 - Math.pow(1 - Math.min(0.99, p), 1 / laps));

  const names = strats.map((s) => s.name.trim());
  const dupes = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const valid = !!race && driver !== null && drivers.length > 0 && dupes.size === 0 && names.every(Boolean) && strats.every((s) => total(s.stints) === laps);

  const body = useMemo(
    () => ({
      sessionId: race,
      paceSessionIds: paceIds.filter((id) => inputs.some((s) => s.id === id)),
      ...(gridId !== "auto" ? { gridSessionId: gridId } : {}),
      include: { qualifyingPace: qualiPace, degradationFit: fitDeg },
      driverNumber: driver,
      totalLaps: laps,
      strategies: strats.map((s) => ({ name: s.name.trim(), stints: s.stints })),
      iterations,
      seed,
      scenario: { safetyCarProbabilityPerLap: Number(perLap(scRace).toFixed(5)), vscProbabilityPerLap: Number(perLap(vscRace).toFixed(5)), trackTempDeltaC: temp, ...(pitLoss !== null ? { pitLossSeconds: pitLoss } : {}) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [race, paceIds, gridId, qualiPace, fitDeg, driver, laps, strats, iterations, seed, scRace, vscRace, temp, pitLoss, sessions.data],
  );
  const key = JSON.stringify(body);
  const [ranKey, setRanKey] = useState<string | null>(null);
  const sim = useMutation({ mutationFn: (b: typeof body) => api<Study>("/api/strategy/simulate", { method: "POST", body: b }) });
  const run = () => {
    setRanKey(key);
    sim.mutate(body);
  };
  // Auto re-run shortly after the last edit, so dragging a stop shows its effect.
  useEffect(() => {
    if (!auto || !valid || key === ranKey || sim.isPending) return;
    const t = setTimeout(run, 700);
    return () => clearTimeout(t);
  }, [auto, valid, key, ranKey, sim.isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!meetingId) return <Empty>Select a race weekend.</Empty>;
  if (sessions.isLoading) return <Loading what="Loading weekend" />;
  if (!races.length) return <Empty>This weekend has no race or sprint session in the calendar.</Empty>;
  if (preRace && !rosterId)
    return <Empty>The race has not run yet and nothing from this weekend is loaded. Load a practice or qualifying session (user menu › Settings › Formula 1 account) to simulate before the race.</Empty>;

  const resultBy = new Map((sim.data?.results ?? []).map((r) => [r.name, r]));
  const gridOptions = [
    { value: "auto", label: preRace ? "Auto · qualifying" : "Auto · race start order", hint: "default" },
    ...[...inputs].sort((a, b) => Number(b.type.includes("qualifying")) - Number(a.type.includes("qualifying"))).map((s) => ({ value: s.id, label: s.name, hint: TYPE_LABEL[s.type] ?? s.type })),
  ];
  const gridIsSession = gridId !== "auto" || preRace;

  return (
    <div className="grid h-full grid-cols-1 panes lg:grid-cols-[360px_minmax(0,1fr)]">
      <Frame title={<>Setup <KindBadge kind="simulated" /></>}>
        <Section title="Race">
          <Field label="Race">
            <Combobox
              ariaLabel="Race"
              className="flex-1"
              value={race}
              onChange={setRace}
              options={races.map((r) => ({
                value: r.id,
                label: r.name,
                hint: new Date(r.dateStart).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
                badge: r.ingestStatus === "not_ingested" ? <Pill tone="warn">Pre-race</Pill> : undefined,
              }))}
            />
          </Field>
          <Field label="Driver">
            <Combobox
              ariaLabel="Driver"
              className="flex-1"
              value={driver}
              onChange={setDriver}
              loading={(preRace ? roster : bundle).isLoading}
              placeholder="Driver…"
              options={drivers.map((d) => ({ value: d.driverNumber, label: `${d.code} · ${d.fullName}`, hint: `#${d.driverNumber}`, color: `#${d.teamColour}`, keywords: d.teamName }))}
            />
          </Field>
          <Field label="Race laps" hint={lapsEstimated ? "Estimated from race distance and the derived circuit length. Set the official count if it differs." : undefined}>
            <Stepper ariaLabel="Race laps" value={laps} min={5} max={100} width={44} onChange={(v) => (setLaps(v), setLapsEstimated(false))} />
            {lapsEstimated && <span className="text-[12px] text-lemon">estimated</span>}
          </Field>
          {preRace && (
            <div className="mt-2 rounded-[6px] border border-lemon/30 bg-lemon/5 px-2.5 py-1.5 text-[12px] text-fg-2">
              Pre-race: entry list from {loaded.find((s) => s.id === rosterId)?.name ?? "the latest session"}.
            </div>
          )}
        </Section>

        <Section title="Data included" right={<span className="text-[12px] text-fg-3">what the model learns from</span>}>
          <div className="mb-1 text-[13px] text-fg-2">Pace &amp; tyre wear from</div>
          {inputs.length === 0 && <div className="text-[13px] text-fg-3">No session of this weekend is loaded before the race.</div>}
          <div className="mb-3 grid grid-cols-2 gap-1">
            {inputs.map((s) => {
              const on = paceIds.includes(s.id);
              return (
                <label
                  key={s.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-[5px] border px-2 py-1.5 text-[13px] transition-colors ${on ? "border-f1/70 bg-f1/10 text-fg" : "border-line-2 text-fg-3 hover:text-fg"}`}
                  title={`${s.name} · ${TYPE_LABEL[s.type] ?? s.type}${s.ingestStatus === "partial" ? " · partially loaded" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && paceIds.length >= 6}
                    onChange={(e) => setPaceIds(e.target.checked ? [...paceIds, s.id] : paceIds.filter((x) => x !== s.id))}
                  />
                  <span className="truncate">{shortName(s)}</span>
                </label>
              );
            })}
          </div>
          <Field label="Starting grid">
            <Combobox ariaLabel="Starting grid source" className="flex-1" value={gridId} onChange={setGridId} options={gridOptions} />
          </Field>
          <Field label="Qualifying pace" hint={gridIsSession ? "One-lap gaps in the grid session, fused with long-run pace." : "Needs a grid session; race start order carries no lap times."}>
            <Switch label="Use qualifying one-lap pace" on={qualiPace} onChange={setQualiPace} disabled={!gridIsSession} />
          </Field>
          <Field label="Tyre wear fit" hint={paceIds.length ? "Off: model default degradation per compound." : "Select a pace session to fit tyre wear."}>
            <Switch label="Fit tyre degradation from the selected sessions" on={fitDeg} onChange={setFitDeg} disabled={!paceIds.length} />
          </Field>
          <Field label="Pit-lane loss" hint={pitLoss === null ? "Measured from stops in the race data, else the model default." : "Manual value for every stop."}>
            <Switch label="Set pit-lane loss manually" on={pitLoss !== null} onChange={(v) => setPitLoss(v ? (sim.data?.parameters.pitLaneLoss ?? 20) : null)} />
            {pitLoss !== null && <Stepper ariaLabel="Pit-lane loss" value={pitLoss} min={5} max={60} step={0.1} digits={1} suffix="s" width={44} onChange={setPitLoss} />}
          </Field>
        </Section>

        <Section title="Conditions">
          <Field label="Safety car" hint={`Chance of at least one in the race · ${fmtNum(perLap(scRace), 4)} per lap`}>
            <input type="range" className="min-w-0 flex-1" min={0} max={0.95} step={0.01} value={scRace} onChange={(e) => setScRace(Number(e.target.value))} aria-label="Safety car chance" />
            <Stepper ariaLabel="Safety car chance" value={Math.round(scRace * 100)} min={0} max={95} width={30} suffix="%" onChange={(v) => setScRace(v / 100)} />
          </Field>
          <Field label="Virtual SC" hint={`${fmtNum(perLap(vscRace), 4)} per lap`}>
            <input type="range" className="min-w-0 flex-1" min={0} max={0.95} step={0.01} value={vscRace} onChange={(e) => setVscRace(Number(e.target.value))} aria-label="Virtual safety car chance" />
            <Stepper ariaLabel="Virtual safety car chance" value={Math.round(vscRace * 100)} min={0} max={95} width={30} suffix="%" onChange={(v) => setVscRace(v / 100)} />
          </Field>
          <Field label="Track temp Δ">
            <input type="range" className="min-w-0 flex-1" min={-20} max={20} step={1} value={temp} onChange={(e) => setTemp(Number(e.target.value))} aria-label="Track temperature change" />
            <Stepper ariaLabel="Track temperature change" value={temp} min={-20} max={20} width={30} suffix="°C" onChange={setTemp} />
          </Field>
          <Field label="Iterations" hint="More runs = steadier percentages, slower.">
            <Stepper ariaLabel="Iterations" value={iterations} min={100} max={20000} step={250} width={52} onChange={setIterations} />
          </Field>
          <Field label="Seed" hint="Same seed + same setup = same result.">
            <Stepper ariaLabel="Seed" value={seed} min={0} max={999999} width={60} onChange={setSeed} />
          </Field>
        </Section>
      </Frame>

      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
        <Frame
          hero
          className="max-h-[52vh]"
          title={
            <>
              Strategies <span className="num text-[12px] font-normal text-fg-3">{laps} laps</span>
            </>
          }
          right={
            <>
              <TemplateMenu disabled={strats.length >= MAX_STRATS} onPick={(t) => setStrats([...strats, { name: uniqueName(t.name, names), stints: fromShares(t.shares, laps) }])} />
              <label className="ml-1 flex items-center gap-1.5 text-[12px] text-fg-2" title="Re-run automatically after each change">
                <Switch label="Auto re-run" on={auto} onChange={setAuto} />
                Auto
              </label>
              <Btn variant="primary" disabled={!valid || sim.isPending} onClick={run}>
                {sim.isPending ? "Simulating…" : "Run"}
              </Btn>
            </>
          }
        >
          <div className="space-y-2.5 p-3">
            {strats.map((s, si) => (
              <StrategyRow
                key={si}
                s={s}
                i={si}
                laps={laps}
                result={resultBy.get(s.name.trim())}
                duplicateName={dupes.has(s.name.trim())}
                canRemove={strats.length > 1}
                canDuplicate={strats.length < MAX_STRATS}
                onChange={(n) => setStrats(strats.map((x, i) => (i === si ? n : x)))}
                onRemove={() => setStrats(strats.filter((_, i) => i !== si))}
                onDuplicate={() => setStrats([...strats.slice(0, si + 1), { name: uniqueName(`${s.name} alt`, names), stints: s.stints.map((x) => ({ ...x })) }, ...strats.slice(si + 1)])}
              />
            ))}
            <div className="text-[12px] text-fg-3">
              Drag a red stop marker (or focus it and use ← →, Shift = 5 laps) · double-click the bar to add a stop · click a stint to change tyre · Delete removes a focused stop
            </div>
          </div>
        </Frame>

        <Frame title={<>Results <KindBadge kind="simulated" /></>} right={sim.isPending ? <span className="label !text-f1-hi">Simulating…</span> : undefined}>
          {sim.isError && <ErrorNote error={sim.error} />}
          {!sim.data && !sim.isError && <Empty>{valid ? (auto ? "Simulating…" : "Press Run to simulate. Results are distributions, not certainties.") : "Pick a driver and give each strategy a unique name."}</Empty>}
          {sim.data && <Results data={sim.data} stale={ranKey !== key && !sim.isPending} />}
        </Frame>
      </div>
    </div>
  );
}
