import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export type EOption = echarts.EChartsOption;

export const AXIS = { color: "#646b76", line: "#262a31", split: "rgba(255,255,255,0.04)" };

/**
 * Thin ECharts wrapper: one instance per element, option updates merged (notMerge optional),
 * resize-observed, and an `onReady` hook to attach events or drive the axis pointer imperatively.
 */
export function EChart({
  option,
  notMerge = true,
  className = "",
  style,
  onReady,
}: {
  option: EOption;
  notMerge?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onReady?: (c: echarts.ECharts) => void | (() => void);
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    const cleanup = onReady?.(c);
    return () => {
      if (typeof cleanup === "function") cleanup();
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge });
  }, [option, notMerge]);

  return <div ref={el} className={className} style={{ width: "100%", height: "100%", ...style }} />;
}

export const baseTextStyle = { color: "#9aa1ab", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 10 };
