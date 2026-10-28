import { useEffect, useMemo, useRef, useState } from "react";
import { nearestDistance, pointAtDistance } from "@lemon-tea/circuit-engine";
import type { CircuitResponse, CompareResponse } from "../api";
import { useUi } from "../state/store";
import { COLOR_A, COLOR_B } from "./TelemetryCharts";

/**
 * 2D map: derived centreline, both drivers' measured trajectories (from the comparison traces),
 * corner labels and the shared cursor. Clicking sets the cursor distance.
 */
export function TrackMap2D({ circuit, cmp }: { circuit: CircuitResponse; cmp: CompareResponse | undefined }) {
  const geo = circuit.geometry;
  const { cursorDistance, set } = useUi();
  const L = geo.distance[geo.distance.length - 1]!;
  const refL = cmp?.reference_length_m ?? L;

  const view = useMemo(() => {
    const xs = geo.x;
    const ys = geo.y.map((v) => -v);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 90;
    return { minX: minX - pad, minY: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  }, [geo]);

  const path = (xs: number[], ys: number[]) => xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${(-ys[i]!).toFixed(1)}`).join("");
  const center = useMemo(() => path(geo.x, geo.y), [geo]); // eslint-disable-line react-hooks/exhaustive-deps
  const traj = (who: "a" | "b") => {
    const t = cmp?.traces?.[who];
    if (!t?.x || !t.y) return null;
    const xs = t.x.map((v) => v - geo.origin.x);
    const ys = t.y.map((v) => v - geo.origin.y);
    if (xs.some((v) => !Number.isFinite(v))) return null;
    return path(xs, ys);
  };
  const cur = cursorDistance !== null ? pointAtDistance(geo, (cursorDistance / refL) * L) : null;
  // One screen pixel in track metres (the SVG is letterboxed), so strokes and labels keep a
  // constant on-screen size whatever the panel or circuit shape.
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: 300, h: 300 });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setBox({ w: Math.max(1, e.contentRect.width), h: Math.max(1, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sw = Math.max(view.w / box.w, view.h / box.h);

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
      className="h-full w-full cursor-crosshair"
      onClick={(e) => {
        const svg = e.currentTarget;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
        const d = nearestDistance(geo, p.x, -p.y).distance;
        set({ cursorDistance: (d / L) * refL });
      }}
    >
      <path d={center} fill="none" stroke="#3a3a49" strokeWidth={sw * 9} strokeLinejoin="round" strokeLinecap="round" />
      <path d={center} fill="none" stroke="#5a5b6b" strokeWidth={sw * 1} strokeLinejoin="round" />
      {traj("a") && <path d={traj("a")!} fill="none" stroke={COLOR_A} strokeWidth={sw * 2} opacity={0.95} />}
      {traj("b") && <path d={traj("b")!} fill="none" stroke={COLOR_B} strokeWidth={sw * 2} opacity={0.95} strokeDasharray={`${sw * 5} ${sw * 3}`} />}
      {geo.corners.map((c) => (
        <text key={c.number} x={c.x + sw * 7} y={-c.y + sw * 4} fill="#b9bbc6" fontSize={sw * 11} fontWeight={600} fontFamily="monospace">
          {c.label}
        </text>
      ))}
      <circle cx={geo.startFinish.x} cy={-geo.startFinish.y} r={sw * 5} fill="#e10600" stroke="#fff" strokeWidth={sw * 1.2} />
      {cur && <circle cx={cur.x} cy={-cur.y} r={sw * 7} fill="none" stroke="#ffffff" strokeWidth={sw * 2} />}
    </svg>
  );
}
