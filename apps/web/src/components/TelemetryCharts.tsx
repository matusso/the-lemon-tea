import { useEffect, useMemo, useRef } from "react";
import type * as echarts from "echarts";
import type { CompareResponse } from "../api";
import { useUi } from "../state/store";
import { AXIS, baseTextStyle, EChart, type EOption } from "./EChart";

/** Driver A / B: the theme's lemon and teal (--color-lemon / --color-teal). */
export const COLOR_A = "#ffd12e";
export const COLOR_B = "#27c5e8";
/** Map/chart sector colours (S1 red, S2 blue, S3 orange) and the DRS / straight-mode green. */
export const SECTOR_COLORS = ["#e10600", "#2f7bff", "#ff8a1f"] as const;
export const DRS_COLOR = "#00d26a";

/** Shared chart chrome in the season-intro style: carbon tooltip, white cursor, spaced caps. */
export const TOOLTIP = {
  backgroundColor: "rgba(16,16,21,0.96)",
  borderColor: "#3a3a46",
  borderWidth: 1,
  padding: [6, 10],
  extraCssText: "border-radius:6px;box-shadow:0 10px 28px -10px rgba(0,0,0,.9);",
};
export const AXIS_NAME = { color: "#8a8a96", fontSize: 10, fontWeight: 700 as const, fontFamily: "Archivo Variable, Archivo, sans-serif" };
export const CURSOR_LINE = { color: "rgba(255,255,255,0.55)", width: 1 };

/** A driver's line: solid, 2 px, with a faint glow in its own colour so it reads on the carbon background. */
export const driverLine = (color: string, width = 2) => ({ width, color, shadowColor: `${color}55`, shadowBlur: 6 });

type ChannelKey = "speed" | "throttle" | "brake" | "gear" | "rpm" | "acceleration" | "delta";

const CHANNELS: Record<ChannelKey, { label: string; unit: string; min?: number; max?: number; step?: boolean }> = {
  speed: { label: "Speed", unit: "km/h" },
  throttle: { label: "Throttle", unit: "%", min: 0, max: 100 },
  brake: { label: "Brake", unit: "on/off", min: 0, max: 1, step: true },
  gear: { label: "Gear", unit: "", min: 1, max: 8, step: true },
  rpm: { label: "RPM", unit: "rpm" },
  acceleration: { label: "Long. accel", unit: "m/s²" },
  delta: { label: "Δ time A−B", unit: "s" },
};

/**
 * Synchronised channel stack against lap distance. All grids share one axis pointer; hovering
 * writes the shared cursor distance, and external cursor changes (map/track clicks) move it here.
 */
export function TelemetryStack({ cmp, channels, height = "100%" }: { cmp: CompareResponse; channels?: ChannelKey[]; height?: string | number }) {
  const tr = cmp.traces!;
  const chans = (channels ?? (["delta", "speed", "throttle", "brake", "gear", "rpm", "acceleration"] as ChannelKey[])).filter((c) =>
    c === "delta" ? true : c === "rpm" || c === "gear" ? !!tr.a[c] && !!tr.b[c] : true,
  );
  const chartRef = useRef<echarts.ECharts | null>(null);
  const lastEmit = useRef<number | null>(null);

  const option = useMemo<EOption>(() => {
    // ECharts grid positions accept px or %, not calc(): lay the stack out in percentages.
    const n = chans.length;
    const top = 7;
    const bottom = 7;
    const gap = n > 4 ? 1.6 : 3;
    const h = (100 - top - bottom - gap * (n - 1)) / n;
    const grids = chans.map((_, i) => ({ left: 52, right: 14, top: `${top + i * (h + gap)}%`, height: `${h}%` }));
    const corners = cmp.corners.map((c) => ({ xAxis: c.corner.minSpeedDistance, label: { show: true, formatter: c.corner.label, color: "#8a8a96", fontSize: 11, position: "insideStartTop" as const } }));
    // Sector bands behind every channel (alternating tint), labelled on the top grid.
    const L = Math.ceil(cmp.reference_length_m);
    const bounds = cmp.sectors.map((x) => x.boundaryDistance).filter((d): d is number => d !== null && d > 0 && d < L).sort((a, b) => a - b);
    const edges = [0, ...bounds, L];
    const sectorArea = (label: boolean) => ({
      silent: true,
      data: edges.slice(0, -1).map((from, k) => [
        {
          xAxis: from,
          itemStyle: { color: k % 2 ? "rgba(255,255,255,0.028)" : "rgba(0,0,0,0)" },
          label: { show: label, formatter: `S${k + 1}`, position: "insideTopLeft" as const, color: SECTOR_COLORS[k] ?? "#8a8a96", fontSize: 10, fontWeight: 800 as const },
        },
        { xAxis: edges[k + 1]! },
      ] as [object, object]),
    }) as echarts.LineSeriesOption["markArea"];
    const series: echarts.SeriesOption[] = [];
    chans.forEach((ch, i) => {
      const xy = (arr: number[] | undefined) => (arr ? tr.a.distance.map((d, k) => [d, arr[k] ?? null]) : []);
      if (ch === "delta") {
        // Split at zero so each side carries its driver's colour: below = A ahead, above = B ahead.
        const part = (sign: 1 | -1, color: string, name: string, extra: object) =>
          series.push({
            name,
            type: "line",
            xAxisIndex: i,
            yAxisIndex: i,
            showSymbol: false,
            lineStyle: { width: 2, color },
            itemStyle: { color },
            areaStyle: { color, opacity: 0.16, origin: 0 },
            // Only this side's samples (plus a zero at each crossing so the line meets the axis).
            data: tr.a.distance.map((d, k) => {
              const on = (j: number) => (tr.delta[j] ?? NaN) * sign > 0;
              if (on(k)) return [d, tr.delta[k]!];
              return [d, on(k - 1) || on(k + 1) ? 0 : null];
            }),
            ...extra,
          });
        part(-1, COLOR_A, `${cmp.a.driverCode} ahead`, {
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: "rgba(255,255,255,0.14)", type: "dashed" }, data: [{ yAxis: 0 }, ...corners] },
          markArea: sectorArea(i === 0),
        });
        part(1, COLOR_B, `${cmp.b.driverCode} ahead`, {});
        return;
      }
      const step = CHANNELS[ch].step ? ("end" as const) : undefined;
      for (const [who, color] of [["a", COLOR_A], ["b", COLOR_B]] as const) {
        series.push({
          name: `${who === "a" ? cmp.a.driverCode : cmp.b.driverCode} ${CHANNELS[ch].label}`,
          type: "line",
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          sampling: "lttb",
          ...(step ? { step } : {}),
          // B underneath A, both solid: dashes break up fast-changing traces and are hard to follow.
          z: who === "a" ? 3 : 2,
          lineStyle: driverLine(color),
          itemStyle: { color },
          data: xy(tr[who][ch as Exclude<ChannelKey, "delta">]),
          ...(who === "a" ? { markArea: sectorArea(i === 0) } : {}),
        });
      }
    });
    return {
      animation: false,
      textStyle: baseTextStyle,
      axisPointer: { link: [{ xAxisIndex: "all" }], label: { show: false }, lineStyle: CURSOR_LINE },
      tooltip: {
        trigger: "axis",
        ...TOOLTIP,
        textStyle: { ...baseTextStyle, color: "#ffffff" },
        valueFormatter: (v) => (typeof v === "number" ? v.toFixed(Math.abs(v) < 10 ? 3 : 0) : String(v)),
      },
      grid: grids,
      xAxis: chans.map((_, i) => ({
        type: "value",
        gridIndex: i,
        min: 0,
        max: Math.ceil(cmp.reference_length_m),
        axisLabel: { show: i === chans.length - 1, color: AXIS.color, formatter: (v: number) => `${v} m` },
        axisLine: { lineStyle: { color: AXIS.line } },
        splitLine: { show: false },
        axisPointer: { show: true, triggerTooltip: i === 0 },
      })),
      yAxis: chans.map((ch, i) => ({
        type: "value",
        gridIndex: i,
        name: `${CHANNELS[ch].label}${CHANNELS[ch].unit ? ` ${CHANNELS[ch].unit}` : ""}`.toUpperCase(),
        nameLocation: "middle",
        nameGap: 36,
        nameTextStyle: AXIS_NAME,
        scale: CHANNELS[ch].min === undefined,
        ...(CHANNELS[ch].min !== undefined ? { min: CHANNELS[ch].min } : {}),
        ...(CHANNELS[ch].max !== undefined ? { max: CHANNELS[ch].max } : {}),
        splitNumber: 2,
        axisLabel: { color: AXIS.color, fontSize: 12 },
        splitLine: { lineStyle: { color: AXIS.split, type: "dashed" } },
      })),
      dataZoom: [{ type: "inside", xAxisIndex: chans.map((_, i) => i), filterMode: "none" }],
      series,
    };
  }, [cmp, chans.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // External cursor → axis pointer
  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        if (s.cursorDistance === prev.cursorDistance || s.cursorDistance === null || s.cursorDistance === lastEmit.current) return;
        chartRef.current?.dispatchAction({ type: "updateAxisPointer", seriesIndex: 0, dataIndex: Math.round(s.cursorDistance / tr.resolution_m) });
        chartRef.current?.setOption({ xAxis: chans.map(() => ({ axisPointer: { value: s.cursorDistance, status: "show" } })) });
      }),
    [chans, tr.resolution_m],
  );

  return (
    <div style={{ height }} className="relative">
      <div className="absolute left-14 top-1 z-10 flex items-center gap-3 text-[13px]">
        <DriverKey color={COLOR_A} who="A" code={cmp.a.driverCode} lap={cmp.a.lapNumber} />
        <DriverKey color={COLOR_B} who="B" code={cmp.b.driverCode} lap={cmp.b.lapNumber} />
        <span className="text-fg-3">Δ below zero = A ahead · scroll to zoom</span>
      </div>
      <EChart
        option={option}
        onReady={(c) => {
          chartRef.current = c;
          let raf = 0;
          const handler = (e: unknown) => {
            const info = (e as { axesInfo?: { value: number }[] }).axesInfo?.[0];
            if (!info) return;
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
              lastEmit.current = info.value;
              useUi.getState().set({ cursorDistance: info.value });
            });
          };
          c.on("updateAxisPointer", handler);
          return () => c.off("updateAxisPointer", handler);
        }}
      />
    </div>
  );
}

/** Legend chip: a thick colour bar with the driver code, matching the chart line. */
export function DriverKey({ color, who, code, lap }: { color: string; who: string; code: string; lap?: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-[3px] w-4 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}88` }} />
      <span className="label !text-[10px] !text-fg-3">{who}</span>
      <span className="font-bold" style={{ color }}>
        {code}
      </span>
      {lap !== undefined && <span className="num text-fg-3">L{lap}</span>}
    </span>
  );
}
