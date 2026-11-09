import { useMemo } from "react";
import { nearestDistance } from "@lemon-tea/circuit-engine";
import { liveGap, liveLaps, type LiveBuffer, type LiveLap } from "@lemon-tea/synchronization";
import type { Driver } from "@lemon-tea/shared-types";
import { estimateWingsOpen } from "@lemon-tea/telemetry-core";
import type { CircuitResponse } from "../../api";
import { AXIS, baseTextStyle, EChart, type EOption } from "../../components/EChart";
import { AXIS_NAME, COLOR_A, COLOR_B, CURSOR_LINE, driverLine, TOOLTIP } from "../../components/TelemetryCharts";
import { Empty, fmtLap, KindBadge } from "../../components/ui";

type Chan = "speed" | "throttle" | "brake" | "aero";
const values = (l: LiveLap & { aero: number[] }, k: Chan) => l[k];

/** Live laps with the estimated active-aero state per point. */
const withAero = (laps: LiveLap[]) => laps.map((l) => ({ ...l, aero: estimateWingsOpen(l) }));

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
  const { la, lb } = useMemo(() => ({ la: withAero(lapsFor(buffer, a, project, L)), lb: withAero(lapsFor(buffer, b, project, L)) }), [buffer, revision, a, b, project, L]); // eslint-disable-line react-hooks/exhaustive-deps
  const gap = useMemo(() => liveGap(la, lb), [la, lb]);
  const code = (dn: number | null) => drivers.find((d) => d.driverNumber === dn)?.code ?? (dn !== null ? `#${dn}` : "—");

  const option = useMemo<EOption>(() => {
    const chans: { key: Chan; label: string }[] = [
      { key: "speed", label: "Speed km/h" },
      { key: "throttle", label: "Throttle %" },
      { key: "brake", label: "Brake" },
      { key: "aero", label: "Wings open (est.)" },
    ];
    const top = 10;
    const gapPct = 4;
    const h = (100 - top - 8 - gapPct * (chans.length - 1)) / chans.length;
    const series: unknown[] = [];
    const add = (laps: (LiveLap & { aero: number[] })[], color: string, who: string) => {
      const cur = laps[laps.length - 1];
      const prev = [...laps].reverse().find((l) => l.complete);
      chans.forEach((c, i) => {
        const step = c.key === "brake" || c.key === "aero" ? "end" : undefined;
        if (prev)
          series.push({ name: `${who} last lap`, type: "line", xAxisIndex: i, yAxisIndex: i, showSymbol: false, silent: true, step, lineStyle: { width: 1.2, color, opacity: 0.4, type: [4, 3] }, itemStyle: { color }, data: prev.distance.map((d, k) => [d, values(prev, c.key)[k]!]) });
        if (cur && cur !== prev)
          series.push({ name: `${who} now`, type: "line", xAxisIndex: i, yAxisIndex: i, showSymbol: false, step, z: 3, lineStyle: driverLine(color), itemStyle: { color }, data: cur.distance.map((d, k) => [d, values(cur, c.key)[k]!]) });
      });
    };
    add(la, COLOR_A, code(a));
    add(lb, COLOR_B, code(b));
    return {
      animation: false,
      textStyle: baseTextStyle,
      legend: { top: 0, textStyle: { color: "#c9c9d1", fontSize: 12 }, itemWidth: 16, itemHeight: 3, icon: "rect" },
      tooltip: { trigger: "axis", ...TOOLTIP, textStyle: { ...baseTextStyle, color: "#ffffff" } },
      axisPointer: { link: [{ xAxisIndex: "all" }], label: { show: false }, lineStyle: CURSOR_LINE },
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
        name: c.label.toUpperCase(),
        nameTextStyle: { ...AXIS_NAME, align: "left" as const },
        ...(c.key === "brake" || c.key === "aero" ? { min: 0, max: 1, interval: 1 } : c.key === "throttle" ? { min: 0, max: 100 } : {}),
        axisLabel: { color: AXIS.color },
        splitLine: { lineStyle: { color: AXIS.split, type: "dashed" as const } },
      })),
      series: series as EOption["series"],
    };
  }, [la, lb, L, a, b]); // eslint-disable-line react-hooks/exhaustive-deps

  if (a === null || b === null) return <Empty>Select drivers A and B in the timing tower to compare them live.</Empty>;
  const aeroNow = (laps: (LiveLap & { aero: number[] })[]) => {
    const l = laps[laps.length - 1];
    return l?.aero.length ? l.aero[l.aero.length - 1] === 1 : null;
  };
  const AeroTag = ({ open }: { open: boolean | null }) =>
    open === null ? null : (
      <span
        className={`ml-2 rounded px-1.5 py-px text-[12px] font-bold tracking-wide ${open ? "bg-teal/20 text-teal" : "bg-ink-3 text-fg-3"}`}
        title="Estimated: front and rear wing flaps open (2026 straight-line mode) when flat out above 180 km/h for 1 s without braking. F1 live timing publishes no aero channel."
      >
        {open ? "WINGS OPEN" : "CORNER MODE"}
      </span>
    );
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
          <AeroTag open={aeroNow(la)} />
        </span>
        <span>
          <span className="font-bold" style={{ color: COLOR_B }}>
            {code(b)}
          </span>
          <span className="num ml-2 text-fg-3">
            last {fmtLap(lastLap(lb))} · now {elapsed(lb)?.toFixed(1) ?? "—"} s
          </span>
          <AeroTag open={aeroNow(lb)} />
        </span>
        <KindBadge kind="estimated" title="Wing state is inferred from throttle, brake and speed; tyre temperatures are not published by F1 live timing" />
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
