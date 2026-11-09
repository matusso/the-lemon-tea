import { describe, expect, it } from "vitest";
import { buildScenery, drsZones, inSpan, sectorOf, speedTrapIndex, straights } from "./circuitFeatures";

/** Stadium: 1000 m straight from S/F, 100 m-radius hairpin, 1000 m back straight, hairpin. 5 m samples. */
function stadium() {
  const x: number[] = [];
  const y: number[] = [];
  const R = 100;
  const S = 1000;
  const total = 2 * S + 2 * Math.PI * R;
  for (let d = 0; d <= total; d += 5) {
    let px: number, py: number;
    if (d < S / 2) [px, py] = [d, 0];
    else if (d < S / 2 + Math.PI * R) {
      const a = (d - S / 2) / R - Math.PI / 2;
      [px, py] = [S / 2 + R * Math.cos(a), R + R * Math.sin(a)];
    } else if (d < 1.5 * S + Math.PI * R) [px, py] = [S / 2 - (d - S / 2 - Math.PI * R), 2 * R];
    else if (d < 1.5 * S + 2 * Math.PI * R) {
      const a = (d - 1.5 * S - Math.PI * R) / R + Math.PI / 2;
      [px, py] = [-S / 2 + R * Math.cos(a), R + R * Math.sin(a)];
    } else [px, py] = [-S / 2 + (d - 1.5 * S - 2 * Math.PI * R), 0];
    x.push(px);
    y.push(py);
  }
  const distance = x.map((_, i) => i * 5);
  return { x, y, distance, sectorBoundaries: [700, 1500], startFinish: { x: 0, y: 0, heading: 0 } };
}

describe("circuit features", () => {
  const geo = stadium();
  const n = geo.x.length;

  it("finds both straights, including the one wrapping past S/F", () => {
    const s = straights(geo);
    expect(s).toHaveLength(2);
    for (const run of s) expect(run.length).toBeGreaterThan(850);
    expect(s.some((r) => inSpan(r, 0))).toBe(true);
  });

  it("places DRS zones inside the straights and a speed trap near the end of one", () => {
    const zones = drsZones(geo);
    expect(zones).toHaveLength(2);
    const s = straights(geo);
    for (const z of zones) expect(s.some((r) => inSpan(r, z.from) && inSpan(r, z.to))).toBe(true);
    const trap = speedTrapIndex(geo);
    expect(s.some((r) => inSpan(r, trap))).toBe(true);
    // from a speed trace: argmax maps onto the geometry's axis
    const L = geo.distance[n - 1]!;
    const trace = { distance: [0, L / 2, L], speed: [200, 330, 200] };
    expect(Math.abs(speedTrapIndex(geo, trace) - Math.round(n / 2))).toBeLessThan(2);
  });

  it("assigns sectors by boundary", () => {
    expect([sectorOf(geo, 10), sectorOf(geo, 800), sectorOf(geo, 2000)]).toEqual([0, 1, 2]);
  });

  it("builds deterministic scenery that keeps off the track", () => {
    const a = buildScenery(geo, 42);
    const b = buildScenery(geo, 42);
    expect(a.trees.length).toBe(b.trees.length);
    expect(a.pit.length).toBeGreaterThan(3);
    expect(a.trees.length).toBeGreaterThan(100);
    const minDist = (px: number, py: number) => Math.min(...geo.x.map((x, i) => Math.hypot(x - px, geo.y[i]! - py)));
    for (const t of a.trees.slice(0, 200)) expect(minDist(t.x, t.y)).toBeGreaterThan(30);
    for (const box of a.buildings) expect(minDist(box.x, box.y)).toBeGreaterThan(100);
  });
});
