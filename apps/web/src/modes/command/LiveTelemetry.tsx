import { useMemo } from "react";
import { nearestDistance } from "@lemon-tea/circuit-engine";
import { liveGap, liveLaps, type LiveBuffer, type LiveLap } from "@lemon-tea/synchronization";
import type { Driver } from "@lemon-tea/shared-types";
import type { CircuitResponse } from "../../api";
import { AXIS, baseTextStyle, EChart, type EOption } from "../../components/EChart";
import { COLOR_A, COLOR_B } from "../../components/TelemetryCharts";
import { Empty, fmtLap } from "../../components/ui";

/** Only the recent past is projected onto the track (enough for the current and previous lap). */
const WINDOW_MS = 5 * 60_000;

function lapsFor(buf: LiveBuffer, dn: number | null, project: (x: number, y: number) => number, L: number): LiveLap[] {
  if (dn === null) return [];
  const car = buf.car.get(dn);
  const pos = buf.positions.get(dn);
  if (!car || !pos) return [];
  const from = buf.latestMs - WINDOW_MS;
  let i = 0;
  while (i < car.t.length && car.t[i]! < from) i++;
  const slice = { t: car.t.slice(i), speed: car.speed.slice(i), throttle: car.throttle.slice(i), brake: car.brake.slice(i) };
  return liveLaps(slice, pos, project, L);
}

/**
 * Live comparison of drivers A and B on the circuit's distance axis: each car's lap in progress
 * (solid) over its last complete lap (faint), plus the on-road gap between them. Built from the
 * live sample stream, so it updates as data arrives (~2×/s).
 */
export function LiveTelemetry({ buffer, revision, circuit, drivers, a, b }: { buffer: LiveBuffer; revision: number; circuit: CircuitResponse; drivers: Driver[]; a: number | null; b: number | null }) {
  const geo = circuit.geometry;
  const L = geo.distance[geo.distance.length - 1]!;
  const project = useMemo(() => (x: number, y: number) => nearestDistance(geo, x - geo.origin.x, y - geo.origin.y).distance, [geo]);
  const { la, lb } = useMemo(() => ({ la: lapsFor(buffer, a, project, L), lb: lapsFor(buffer, b, project, L) }), [buffer, revision, a, b, project, L]); // eslint-disable-line react-hooks/exhaustive-deps
  const gap = useMemo(() => liveGap(la, lb), [la, lb]);
  const code = (dn: number | null) => drivers.find((d) => d.driverNumber === dn)?.code ?? (dn !== null ? `#${dn}` : "—");

  const option = useMemo<EOption>(() => {
    const chans = [
      { key: "speed" as const, label: "Speed km/h" },
      { key: "throttle" as const, label: "Throttle %" },
      { key: "brake" as const, label: "Brake" },
    ];
    const top = 10;
    const gapPct = 4;
    const h = (100 - top - 8 - gapPct * (chans.length - 1)) / chans.length;
    const series: unknown[] = [];
    const add = (laps: LiveLap[], color: string, who: string) => {
      const cur = laps[laps.length - 1];
      const prev = [...laps].reverse().find((l) => l.complete);
      chans.forEach((c, i) => {
        const step = c.key === "brake" ? "end" : undefined;
        if (prev)
          series.push({ name: `${who} last lap`, type: "line", xAxisIndex: i, yAxisIndex: i, showSymbol: false, silent: true, step, lineStyle: { width: 1, color, opacity: 0.35, type: "dashed" }, itemStyle: { color }, data: prev.distance.map((d, k) => [d, prev[c.key][k]!]) });
        if (cur && cur !== prev)
          series.push({ name: `${who} now`, type: "line", xAxisIndex: i, yAxisIndex: i, showSymbol: false, step, lineStyle: { width: 1.8, color }, itemStyle: { color }, data: cur.distance.map((d, k) => [d, cur[c.key][k]!]) });
      });
    };
    add(la, COLOR_A, code(a));
    add(lb, COLOR_B, code(b));
    return {
      animation: false,
      textStyle: baseTextStyle,
      legend: { top: 0, textStyle: { color: "#b9bbc6", fontSize: 13 }, itemWidth: 14 },
      tooltip: { trigger: "axis", backgroundColor: "rgba(18,20,24,0.95)", borderColor: "#31363f", textStyle: { color: "#f5f5f7", fontSize: 13 } },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: chans.map((_, i) => ({ left: 52, right: 14, top: `${top + i * (h + gapPct)}%`, height: `${h}%` })),
      xAxis: chans.map((_, i) => ({
        type: "value" as const,
        gridIndex: i,
        min: 0,
        max: Math.round(L),
        axisLabel: { show: i === chans.length - 1, color: AXIS.color, formatter: (v: number) => `${(v / 1000).toFixed(1)} km` },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: AXIS.line } },
      })),
      yAxis: chans.map((c, i) => ({
        type: "value" as const,
        gridIndex: i,
        name: c.label,
        nameTextStyle: { color: AXIS.color, fontSize: 12, align: "left" as const },
        ...(c.key === "brake" ? { min: 0, max: 1, interval: 1 } : c.key === "throttle" ? { min: 0, max: 100 } : {}),
        axisLabel: { color: AXIS.color },
        splitLine: { lineStyle: { color: AXIS.split } },
      })),
      series: series as EOption["series"],
    };
  }, [la, lb, L, a, b]); // eslint-disable-line react-hooks/exhaustive-deps

  if (a === null || b === null) return <Empty>Select drivers A and B in the timing tower to compare them live.</Empty>;
  const lastLap = (laps: LiveLap[]) => {
    const l = [...laps].reverse().find((x) => x.complete);
    return l ? (l.t[l.t.length - 1]! - l.t[0]!) / 1000 : null;
  };
  const elapsed = (laps: LiveLap[]) => {
    const l = laps[laps.length - 1];
    return l && !l.complete ? (l.t[l.t.length - 1]! - l.startMs) / 1000 : null;
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-1.5 text-[14px]">
        <span>
          <span className="font-bold" style={{ color: COLOR_A }}>
            {code(a)}
          </span>
          <span className="num ml-2 text-fg-3">
            last {fmtLap(lastLap(la))} · now {elapsed(la)?.toFixed(1) ?? "—"} s
          </span>
        </span>
        <span>
          <span className="font-bold" style={{ color: COLOR_B }}>
            {code(b)}
          </span>
          <span className="num ml-2 text-fg-3">
            last {fmtLap(lastLap(lb))} · now {elapsed(lb)?.toFixed(1) ?? "—"} s
          </span>
        </span>
        <span className="ml-auto" title="How long ago the car ahead passed the point where the other car is now (from live positions)">
          On-road gap{" "}
          {gap ? (
            <span className="num font-semibold text-fg">
              {code(gap.ahead === "a" ? a : b)} ahead by {gap.seconds.toFixed(1)} s
            </span>
          ) : (
            <span className="text-fg-3">—</span>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {la.length || lb.length ? (
          <EChart option={option} />
        ) : (
          <Empty>
            Waiting for live car data of {code(a)} and {code(b)}…
          </Empty>
        )}
      </div>
    </div>
  );
}
