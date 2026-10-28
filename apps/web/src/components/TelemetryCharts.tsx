import { useEffect, useMemo, useRef } from "react";
import type * as echarts from "echarts";
import type { CompareResponse } from "../api";
import { useUi } from "../state/store";
import { AXIS, baseTextStyle, EChart, type EOption } from "./EChart";

export const COLOR_A = "#e8d44d";
export const COLOR_B = "#3fb5c0";

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
    const corners = cmp.corners.map((c) => ({ xAxis: c.corner.minSpeedDistance, label: { show: true, formatter: c.corner.label, color: "#82858f", fontSize: 10, position: "insideStartTop" as const } }));
    const series: echarts.SeriesOption[] = [];
    chans.forEach((ch, i) => {
      const xy = (arr: number[] | undefined) => (arr ? tr.a.distance.map((d, k) => [d, arr[k] ?? null]) : []);
      if (ch === "delta") {
        series.push({
          name: "Δ A−B",
          type: "line",
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          lineStyle: { width: 1.4, color: "#f5f5f7" },
          areaStyle: { color: "rgba(232,212,77,0.08)", origin: 0 },
          data: tr.a.distance.map((d, k) => [d, tr.delta[k] ?? null]),
          markLine: { silent: true, symbol: "none", lineStyle: { color: "#2a2e36", type: "dashed" }, data: [{ yAxis: 0 }, ...corners] },
        });
        return;
      }
      const step = CHANNELS[ch].step ? ("end" as const) : undefined;
      for (const [who, color, dash] of [["a", COLOR_A, "solid"], ["b", COLOR_B, "dashed"]] as const) {
        series.push({
          name: `${who === "a" ? cmp.a.driverCode : cmp.b.driverCode} ${CHANNELS[ch].label}`,
          type: "line",
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          sampling: "lttb",
          ...(step ? { step } : {}),
          lineStyle: { width: 1.2, color, type: dash },
          data: xy(tr[who][ch as Exclude<ChannelKey, "delta">]),
        });
      }
    });
    return {
      animation: false,
      textStyle: baseTextStyle,
      axisPointer: { link: [{ xAxisIndex: "all" }], label: { show: false }, lineStyle: { color: "#e8d44d", width: 1 } },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(18,20,24,0.95)",
        borderColor: "#31363f",
        textStyle: { ...baseTextStyle, color: "#f5f5f7" },
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
        name: `${CHANNELS[ch].label}${CHANNELS[ch].unit ? ` (${CHANNELS[ch].unit})` : ""}`,
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: "#82858f", fontSize: 10 },
        scale: CHANNELS[ch].min === undefined,
        ...(CHANNELS[ch].min !== undefined ? { min: CHANNELS[ch].min } : {}),
        ...(CHANNELS[ch].max !== undefined ? { max: CHANNELS[ch].max } : {}),
        splitNumber: 2,
        axisLabel: { color: AXIS.color, fontSize: 10 },
        splitLine: { lineStyle: { color: AXIS.split } },
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
      <div className="absolute left-14 top-1 z-10 flex items-center gap-3 text-[11px]">
        <span style={{ color: COLOR_A }}>━ A {cmp.a.driverCode} L{cmp.a.lapNumber}</span>
        <span style={{ color: COLOR_B }}>╍ B {cmp.b.driverCode} L{cmp.b.lapNumber}</span>
        <span className="text-fg-3">Δ negative = A ahead · scroll to zoom</span>
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
