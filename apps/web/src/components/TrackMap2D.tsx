import { useMemo } from "react";
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
    const pad = 60;
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
  const sw = view.w / 300;

  return (
    <svg
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
      <path d={center} fill="none" stroke="#2c313a" strokeWidth={sw * 6} strokeLinejoin="round" />
      {traj("a") && <path d={traj("a")!} fill="none" stroke={COLOR_A} strokeWidth={sw * 0.9} opacity={0.9} />}
      {traj("b") && <path d={traj("b")!} fill="none" stroke={COLOR_B} strokeWidth={sw * 0.9} opacity={0.9} strokeDasharray={`${sw * 3} ${sw * 2}`} />}
      {geo.corners.map((c) => (
        <text key={c.number} x={c.x + sw * 6} y={-c.y} fill="#646b76" fontSize={sw * 9} fontFamily="monospace">
          {c.label}
        </text>
      ))}
      <circle cx={geo.startFinish.x} cy={-geo.startFinish.y} r={sw * 3} fill="#fff" />
      {cur && <circle cx={cur.x} cy={-cur.y} r={sw * 5} fill="none" stroke="#e8d44d" strokeWidth={sw * 1.5} />}
    </svg>
  );
}
