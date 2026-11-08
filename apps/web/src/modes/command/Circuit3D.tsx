import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { nearestDistance, pointAtDistance } from "@lemon-tea/circuit-engine";
import { positionAt, type LiveBuffer, type TimingBundle } from "@lemon-tea/synchronization";
import type { CircuitResponse, CompareResponse } from "../../api";
import { clock } from "../../state/clock";
import { useUi, type Overlay } from "../../state/store";
import { ReplayCache } from "./replayCache";
import { buildScenery, drsZones, hashString, offsetPoint, sectorOf, speedTrapIndex, type Box, type Span } from "./circuitFeatures";
import { COLOR_A, COLOR_B, DRS_COLOR, SECTOR_COLORS } from "../../components/TelemetryCharts";

type Geo = CircuitResponse["geometry"];

const LEMON = new THREE.Color(COLOR_A);
const TEAL = new THREE.Color(COLOR_B);
const BASE = new THREE.Color("#4a5168");
/** HTML labels inside the canvas stay below the app's menus and dialogs (z-50 and up). */
const LABEL_Z: [number, number] = [10, 0];

/** Source (origin-shifted) metres → scene: x→X, elevation→Y, y→-Z. */
function toScene(x: number, y: number, z = 0): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

function elevationAt(geo: Geo, i: number, ex: number) {
  return geo.z ? geo.z[i]! * ex : 0;
}

/** Scene elevation of the driven line at a lap distance (0 without elevation data). */
function elevationAtDistance(geo: Geo, d: number, ex: number) {
  if (!geo.z) return 0;
  const L = geo.distance[geo.distance.length - 1]!;
  const i = Math.round((((d % L) + L) % L / L) * (geo.x.length - 1));
  return elevationAt(geo, i, ex);
}

/** Per-vertex colours for the overlay, sampled from the comparison traces by lap-distance fraction. */
function overlayColors(geo: Geo, cmp: CompareResponse | undefined, overlay: Overlay): THREE.Color[] {
  const n = geo.x.length;
  const L = geo.distance[n - 1]!;
  const sectorBase = SECTOR_COLORS.map((c) => BASE.clone().lerp(new THREE.Color(c), 0.14));
  const sectorTint = (d: number) => sectorBase[sectorOf(geo, d)]!.clone();
  if (!cmp?.traces || overlay === "none") return geo.distance.map(sectorTint);
  const tr = cmp.traces;
  const dist = tr.a.distance;
  const refL = cmp.reference_length_m;
  const idxOf = (d: number) => Math.max(0, Math.min(dist.length - 1, Math.round((d / L) * refL / tr.resolution_m)));
  return geo.distance.map((d) => {
    const i = idxOf(d);
    if (overlay === "delta") {
      const w = 2;
      const a = tr.delta[Math.max(0, i - w)] ?? 0;
      const b = tr.delta[Math.min(tr.delta.length - 1, i + w)] ?? 0;
      const slope = (b - a) / Math.max(1, (Math.min(tr.delta.length - 1, i + w) - Math.max(0, i - w)) * tr.resolution_m); // s per m
      const k = Math.min(1, Math.abs(slope) / 0.0015);
      return BASE.clone().lerp(slope < 0 ? LEMON : TEAL, k); // negative slope: A gaining
    }
    const ch = overlay === "speed" ? tr.a.speed[i]! / 340 : overlay === "throttle" ? tr.a.throttle[i]! / 100 : tr.a.brake[i]!;
    return new THREE.Color().setHSL(overlay === "brake" ? 0 : 0.55 - 0.55 * ch, overlay === "brake" ? ch * 0.9 : 0.75, 0.25 + 0.3 * ch);
  });
}

function Track({ geo, cmp, onPick }: { geo: Geo; cmp: CompareResponse | undefined; onPick: (d: number) => void }) {
  const { overlay, elevationExaggeration: ex } = useUi();
  const geometry = useMemo(() => {
    const n = geo.x.length;
    const half = 7; // visual ribbon half-width; NOT the real track width (unknown)
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const colors = overlayColors(geo, cmp, overlay);
    for (let i = 0; i < n; i++) {
      const j = Math.min(n - 1, i + 1);
      const k = Math.max(0, i - 1);
      const dx = geo.x[j]! - geo.x[k]!;
      const dy = geo.y[j]! - geo.y[k]!;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const z = elevationAt(geo, i, ex);
      const l = toScene(geo.x[i]! + nx * half, geo.y[i]! + ny * half, z);
      const r = toScene(geo.x[i]! - nx * half, geo.y[i]! - ny * half, z);
      pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
      const c = colors[i]!;
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (i < n - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [geo, cmp, overlay, ex]);

  // White edge lines on both sides of the ribbon and a soft red glow underneath it.
  const { edges, glow } = useMemo(() => {
    const n = geo.x.length;
    const side = (off: number, lift: number) =>
      geo.x.map((x, i) => {
        const j = Math.min(n - 1, i + 1);
        const k = Math.max(0, i - 1);
        const dx = geo.x[j]! - geo.x[k]!;
        const dy = geo.y[j]! - geo.y[k]!;
        const len = Math.hypot(dx, dy) || 1;
        return toScene(x - (dy / len) * off, geo.y[i]! + (dx / len) * off, elevationAt(geo, i, ex) + lift);
      });
    const strip = (half: number, lift: number) => {
      const l = side(half, lift);
      const r = side(-half, lift);
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        pos.push(l[i]!.x, l[i]!.y, l[i]!.z, r[i]!.x, r[i]!.y, r[i]!.z);
        if (i < n - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      return g;
    };
    return {
      edges: [side(7.5, 0.4), side(-7.5, 0.4)].map((pts) => new THREE.BufferGeometry().setFromPoints(pts)),
      glow: [strip(22, -0.4), strip(40, -0.6)],
    };
  }, [geo, ex]);

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const p = e.point;
    onPick(nearestDistance(geo, p.x, -p.z).distance);
  };

  return (
    <group>
      {glow.map((g, i) => (
        <mesh key={i} geometry={g} renderOrder={-1}>
          <meshBasicMaterial color="#e10600" transparent opacity={i === 0 ? 0.16 : 0.07} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
        </mesh>
      ))}
      <mesh geometry={geometry} onClick={click}>
        <meshBasicMaterial vertexColors side={THREE.DoubleSide} />
      </mesh>
      {edges.map((g, i) => (
        <line key={i}>
          <primitive object={g} attach="geometry" />
          <lineBasicMaterial color="#f5f5f7" transparent opacity={0.8} />
        </line>
      ))}
    </group>
  );
}

/** Strips on both sides of the line between offsets `inner`..`outer` (m) over consecutive sample indices. */
function sideBands(geo: Geo, ex: number, idx: number[], inner: number, outer: number, lift: number, color: (i: number) => THREE.Color) {
  const n = geo.x.length;
  const pos: number[] = [];
  const col: number[] = [];
  const tri: number[] = [];
  for (const sgn of [1, -1]) {
    let prev = -1;
    let prevI = -1;
    for (const i of idx) {
      const a = offsetPoint(geo, i, sgn * inner);
      const b = offsetPoint(geo, i, sgn * outer);
      const z = elevationAt(geo, i, ex) + lift;
      const pa = toScene(a.x, a.y, z);
      const pb = toScene(b.x, b.y, z);
      const v = pos.length / 3;
      pos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      const c = color(i);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (prev >= 0 && (prevI + 1) % n === i) tri.push(prev, prev + 1, v, prev + 1, v + 1, v);
      prev = v;
      prevI = i;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(tri);
  return g;
}

const spanIdx = (s: Span, n: number) => {
  const out: number[] = [];
  for (let i = s.from; out.length <= n; i = (i + 1) % n) {
    out.push(i);
    if (i === s.to) break;
  }
  return out;
};

/** Sector colour bands along both kerbs. */
function SectorBands({ geo }: { geo: Geo }) {
  const ex = useUi((s) => s.elevationExaggeration);
  const g = useMemo(() => {
    const cols = SECTOR_COLORS.map((c) => new THREE.Color(c));
    return sideBands(geo, ex, geo.x.map((_, i) => i), 8.5, 14, 0.2, (i) => cols[sectorOf(geo, geo.distance[i]!)]!);
  }, [geo, ex]);
  useEffect(() => () => g.dispose(), [g]);
  return (
    <mesh geometry={g} renderOrder={1}>
      <meshBasicMaterial vertexColors transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

/** Estimated DRS / straight-mode zones: green bands outside the sector bands, numbered at activation. */
function DrsZones({ geo, zones }: { geo: Geo; zones: Span[] }) {
  const ex = useUi((s) => s.elevationExaggeration);
  const n = geo.x.length;
  const g = useMemo(() => {
    const c = new THREE.Color(DRS_COLOR);
    return sideBands(geo, ex, zones.flatMap((z) => spanIdx(z, n)), 16, 30, 0.3, () => c);
  }, [geo, ex, zones, n]);
  useEffect(() => () => g.dispose(), [g]);
  return (
    <group>
      <mesh geometry={g} renderOrder={1}>
        <meshBasicMaterial vertexColors transparent opacity={0.75} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {zones.map((z, k) => {
        const p = offsetPoint(geo, z.from, 0);
        return (
          <group key={k}>
            <mesh position={toScene(p.x, p.y, elevationAt(geo, z.from, ex) + 0.6)} rotation={[0, p.h, 0]}>
              <boxGeometry args={[2.5, 0.6, 30]} />
              <meshBasicMaterial color={DRS_COLOR} />
            </mesh>
            <Html position={toScene(p.x, p.y, elevationAt(geo, z.from, ex) + 8)} center zIndexRange={LABEL_Z}>
              <div className="map-tag" style={{ background: DRS_COLOR, color: "#04140b" }} title="Estimated from the longest straights: the feeds publish no zone positions">
                DRS {k + 1}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** Speed-trap gantry across the track at the estimated trap position. */
function SpeedTrap({ geo, index, top }: { geo: Geo; index: number; top: { speed: number; code: string } | null }) {
  const ex = useUi((s) => s.elevationExaggeration);
  const p = offsetPoint(geo, index, 0);
  const z = elevationAt(geo, index, ex);
  return (
    <group position={toScene(p.x, p.y, z)} rotation={[0, p.h, 0]}>
      <mesh position={[0, 0.7, 0]}>
        <boxGeometry args={[2, 0.4, 15]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      {[-24, 24].map((s) => (
        <mesh key={s} position={[0, 9, s]}>
          <boxGeometry args={[1.6, 18, 1.6]} />
          <meshStandardMaterial color="#d6d6dc" />
        </mesh>
      ))}
      <mesh position={[0, 18, 0]}>
        <boxGeometry args={[2.4, 2.4, 50]} />
        <meshBasicMaterial color="#e10600" />
      </mesh>
      <Html position={[0, 28, 0]} center zIndexRange={LABEL_Z}>
        <div className="map-tag" title="Position estimated (fastest point of the reference lap or end of the longest straight); speed measured by the official trap">
          SPEED TRAP{top && <span className="ml-1.5 font-mono font-normal opacity-90">{top.speed.toFixed(0)} km/h {top.code}</span>}
        </div>
      </Html>
    </group>
  );
}

const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const CONE = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0);

/** Instanced boxes with their outline (and an optional coloured roof line), standing on the nearest track elevation. */
function Boxes({ geo, boxes, color, edge, edgeOpacity = 0.55, roof }: { geo: Geo; boxes: Box[]; color: string; edge: string; edgeOpacity?: number; roof?: string }) {
  const ex = useUi((s) => s.elevationExaggeration);
  const { mesh, lines, roofLines } = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(BOX, mat, boxes.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const seg: number[] = [];
    const roofSeg: number[] = [];
    boxes.forEach((b, k) => {
      const base = toScene(b.x, b.y, elevationAt(geo, b.near, ex) - 0.5);
      q.setFromEuler(e.set(0, b.heading, 0));
      m.compose(base, q, new THREE.Vector3(b.w, b.h, b.d));
      mesh.setMatrixAt(k, m);
      const corner = (u: number, h: number, v: number) => new THREE.Vector3(u * b.w, h, v * b.d).applyQuaternion(q).add(base);
      const c = [-0.5, 0.5];
      const lo = [corner(c[0]!, 0, c[0]!), corner(c[1]!, 0, c[0]!), corner(c[1]!, 0, c[1]!), corner(c[0]!, 0, c[1]!)];
      const hi = [corner(c[0]!, b.h, c[0]!), corner(c[1]!, b.h, c[0]!), corner(c[1]!, b.h, c[1]!), corner(c[0]!, b.h, c[1]!)];
      for (let s = 0; s < 4; s++) {
        const t = (s + 1) % 4;
        (roof ? roofSeg : seg).push(hi[s]!.x, hi[s]!.y, hi[s]!.z, hi[t]!.x, hi[t]!.y, hi[t]!.z);
        seg.push(lo[s]!.x, lo[s]!.y, lo[s]!.z, hi[s]!.x, hi[s]!.y, hi[s]!.z);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: edgeOpacity }));
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.Float32BufferAttribute(roofSeg, 3));
    const roofLines = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: roof ?? edge, transparent: true, opacity: 0.9 }));
    return { mesh, lines, roofLines };
  }, [geo, boxes, color, edge, edgeOpacity, roof, ex]);
  useEffect(
    () => () => {
      mesh.dispose();
      (mesh.material as THREE.Material).dispose();
      for (const l of [lines, roofLines]) {
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
    },
    [mesh, lines, roofLines],
  );
  return (
    <group>
      <primitive object={mesh} />
      <primitive object={lines} />
      {roof && <primitive object={roofLines} />}
    </group>
  );
}

const TREE_DARK = new THREE.Color("#1d3a28");
const TREE_LIGHT = new THREE.Color("#3a6146");

/**
 * Illustrative surroundings (pit building, paddock, grandstands, buildings, woodland) placed
 * deterministically around the driven line. Not mapped from real-world data.
 */
function Scenery({ geo, seed }: { geo: Geo; seed: number }) {
  const ex = useUi((s) => s.elevationExaggeration);
  const sc = useMemo(() => buildScenery(geo, seed), [geo, seed]);
  const trees = useMemo(() => {
    const mesh = new THREE.InstancedMesh(CONE, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), sc.trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    sc.trees.forEach((t, k) => {
      m.compose(toScene(t.x, t.y, elevationAt(geo, t.near, ex) - 1), q, new THREE.Vector3(t.r, t.h, t.r));
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, c.copy(TREE_DARK).lerp(TREE_LIGHT, t.shade));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }, [geo, sc, ex]);
  const pitLane = useMemo(() => {
    const pts = sc.pitLane.map((p) => toScene(p.x, p.y, elevationAt(geo, p.near, ex) + 0.3));
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [geo, sc, ex]);
  useEffect(
    () => () => {
      trees.dispose();
      (trees.material as THREE.Material).dispose();
      pitLane.dispose();
    },
    [trees, pitLane],
  );
  return (
    <group>
      <primitive object={trees} />
      <line>
        <primitive object={pitLane} attach="geometry" />
        <lineBasicMaterial color="#6a6a78" transparent opacity={0.7} />
      </line>
      <Boxes geo={geo} boxes={sc.buildings} color="#2a2a35" edge="#6a6a7c" edgeOpacity={0.5} />
      <Boxes geo={geo} boxes={sc.paddock} color="#30303c" edge="#7a7a8a" />
      <Boxes geo={geo} boxes={sc.stands} color="#3a3a48" edge="#9a9aaa" edgeOpacity={0.6} />
      <Boxes geo={geo} boxes={sc.pit} color="#3a3a46" edge="#b0b0bc" edgeOpacity={0.7} roof="#e10600" />
    </group>
  );
}

function Markers({ geo }: { geo: Geo }) {
  const { set, elevationExaggeration: ex, layers } = useUi();
  const sf = geo.startFinish;
  const ticks = geo.sectorBoundaries.map((d) => ({ d, p: pointAtDistance(geo, d) }));
  return (
    <group>
      <mesh position={toScene(sf.x, sf.y, (geo.z?.[0] ?? 0) * ex + 0.5)} rotation={[0, sf.heading, 0]}>
        <boxGeometry args={[3, 1, 18]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <Html position={toScene(sf.x, sf.y, (geo.z?.[0] ?? 0) * ex + 6)} center zIndexRange={LABEL_Z}>
        <div className="map-tag">START / FINISH</div>
      </Html>
      {layers.sectors &&
        ticks.map((t, i) => (
          <group key={i}>
            <mesh position={toScene(t.p.x, t.p.y, elevationAtDistance(geo, t.d, ex) + 0.5)}>
              <cylinderGeometry args={[2.4, 2.4, 1, 16]} />
              <meshBasicMaterial color={SECTOR_COLORS[i + 1]} />
            </mesh>
            <Html position={toScene(t.p.x, t.p.y, elevationAtDistance(geo, t.d, ex) + 6)} center zIndexRange={LABEL_Z}>
              <div className="map-tag" style={{ background: SECTOR_COLORS[i + 1] }} title={`Sector ${i + 2} starts at ${t.d.toFixed(0)} m`}>
                S{i + 2}
              </div>
            </Html>
          </group>
        ))}
      {geo.corners.map((c) => (
        <Html key={c.number} position={toScene(c.x, c.y, elevationAtDistance(geo, c.distance, ex) + 10)} center zIndexRange={LABEL_Z}>
          <button
            onClick={() => set({ focusCorner: c.number, camera: "corner" })}
            className="rounded border border-line-2 bg-ink-1/85 px-1 font-mono text-[13px] text-fg-2 hover:border-lemon hover:text-lemon"
            title={`Detected corner ${c.label} at ${c.distance.toFixed(0)} m (not an official turn number)`}
          >
            {c.label}
          </button>
        </Html>
      ))}
    </group>
  );
}

function Cursor({ geo, cmp }: { geo: Geo; cmp: CompareResponse | undefined }) {
  const cursor = useUi((s) => s.cursorDistance);
  const ex = useUi((s) => s.elevationExaggeration);
  if (cursor === null) return null;
  const L = geo.distance[geo.distance.length - 1]!;
  const d = cmp ? (cursor / cmp.reference_length_m) * L : cursor;
  const p = pointAtDistance(geo, d);
  return (
    <mesh position={toScene(p.x, p.y, elevationAtDistance(geo, d, ex) + 2)}>
      <torusGeometry args={[11, 1.4, 8, 32]} />
      <meshBasicMaterial color={COLOR_A} />
    </mesh>
  );
}

interface CarRef {
  group: THREE.Group;
  label: HTMLDivElement | null;
}

function Cars({ geo, bundle, sessionId, origin, live }: { geo: Geo; bundle: TimingBundle; sessionId: string; origin: Geo["origin"]; live: LiveBuffer | null }) {
  const { driverA, driverB, camera, elevationExaggeration: ex } = useUi();
  const refs = useRef(new Map<number, CarRef>());
  // Live: positions come straight from the WebSocket buffer; replay: windows fetched from the API.
  const cache = useMemo(() => live ?? new ReplayCache(sessionId, clock.min, clock.max || Infinity), [sessionId, live]);
  const target = useRef(new THREE.Vector3());
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;

  useFrame((state) => {
    const t = clock.now();
    const data = cache.at(t);
    for (const d of bundle.drivers) {
      const r = refs.current.get(d.driverNumber);
      if (!r) continue;
      const s = data?.get(d.driverNumber);
      const p = s ? positionAt(s, t) : null;
      r.group.visible = !!p;
      if (!p) continue;
      const x = p.x - origin.x;
      const y = p.y - origin.y;
      let z = 0;
      if (geo.z) {
        const i = Math.round((nearestDistance(geo, x, y).distance / geo.distance[geo.distance.length - 1]!) * (geo.x.length - 1));
        z = (geo.z[i] ?? 0) * ex;
      }
      r.group.position.copy(toScene(x, y, z + 3));
      if (camera === "follow" && d.driverNumber === driverA) {
        target.current.lerp(r.group.position, 0.15);
        if (controls) {
          const offset = state.camera.position.clone().sub(controls.target);
          controls.target.copy(target.current);
          state.camera.position.copy(target.current.clone().add(offset));
        }
      }
    }
  });

  return (
    <group>
      {bundle.drivers.map((d) => {
        const sel = d.driverNumber === driverA ? "a" : d.driverNumber === driverB ? "b" : null;
        const color = `#${d.teamColour}`;
        return (
          <group
            key={d.driverNumber}
            visible={false}
            ref={(g) => {
              if (g) refs.current.set(d.driverNumber, { group: g, label: null });
              else refs.current.delete(d.driverNumber);
            }}
          >
            <mesh>
              <sphereGeometry args={[sel ? 9 : 6.5, 16, 12]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
            </mesh>
            {sel && (
              <mesh rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[14, 1.4, 8, 32]} />
                <meshBasicMaterial color={sel === "a" ? COLOR_A : COLOR_B} />
              </mesh>
            )}
            <Html zIndexRange={LABEL_Z}>
              <div className="car-label" style={{ color: sel === "a" ? COLOR_A : sel === "b" ? COLOR_B : color, borderLeft: `2px solid ${color}` }}>
                {d.code}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function CameraRig({ geo }: { geo: Geo }) {
  const { camera: mode, focusCorner } = useUi();
  const cam = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const bounds = useMemo(() => {
    const b = new THREE.Box3();
    geo.x.forEach((x, i) => b.expandByPoint(toScene(x, geo.y[i]!, 0)));
    return b;
  }, [geo]);

  useEffect(() => {
    const center = bounds.getCenter(new THREE.Vector3());
    // Fit the whole circuit: distance from the bounding-sphere radius and the narrower of the
    // vertical and horizontal fields of view (a wide, short panel is limited vertically).
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const fit = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.82;
    // Top view: fit the footprint itself (the bounding sphere wastes the panel's corners).
    const size = bounds.getSize(new THREE.Vector3());
    const topFit = Math.max(size.z / 2 / Math.tan(vfov / 2), size.x / 2 / Math.tan(hfov / 2)) * 1.12;
    let pos: THREE.Vector3;
    let target = center;
    if (mode === "top") pos = center.clone().add(new THREE.Vector3(0, topFit, 0.01));
    else if (mode === "corner" && focusCorner !== null) {
      const c = geo.corners.find((k) => k.number === focusCorner);
      target = c ? toScene(c.x, c.y, 0) : center;
      pos = target.clone().add(new THREE.Vector3(180, 220, 180));
    } else if (mode === "follow") pos = center.clone().add(new THREE.Vector3(0, 320, 320));
    else pos = center.clone().add(new THREE.Vector3(0.45, 0.8, 0.75).normalize().multiplyScalar(fit));
    cam.position.copy(pos);
    cam.lookAt(target);
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }, [mode, focusCorner, bounds, cam, controls, geo, aspect]);
  return null;
}

/** Interactive 3D circuit: derived driven line, corners, sectors, live/replay car markers. */
export function Circuit3D({
  circuit,
  bundle,
  sessionId,
  cmp,
  active = true,
  live = null,
}: {
  circuit: CircuitResponse;
  bundle: TimingBundle;
  sessionId: string;
  cmp: CompareResponse | undefined;
  active?: boolean;
  live?: LiveBuffer | null;
}) {
  const set = useUi((s) => s.set);
  const layers = useUi((s) => s.layers);
  const driverA = useUi((s) => s.driverA);
  const geo = circuit.geometry;
  const zones = useMemo(() => drsZones(geo), [geo]);
  const trap = useMemo(() => speedTrapIndex(geo, cmp?.traces?.a), [geo, cmp]);
  // Highest official speed-trap reading of the session (driver A's best when one is selected).
  const top = useMemo(() => {
    let best: { speed: number; code: string } | null = null;
    for (const l of bundle.laps) {
      if (l.stSpeed == null || (driverA !== null && l.driverNumber !== driverA)) continue;
      if (!best || l.stSpeed > best.speed) best = { speed: l.stSpeed, code: bundle.drivers.find((d) => d.driverNumber === l.driverNumber)?.code ?? `#${l.driverNumber}` };
    }
    return best;
  }, [bundle, driverA]);
  const onPick = (dGeo: number) => {
    const L = geo.distance[geo.distance.length - 1]!;
    set({ cursorDistance: cmp ? (dGeo / L) * cmp.reference_length_m : dGeo });
  };
  return (
    <Canvas frameloop={active ? "always" : "never"} camera={{ fov: 40, near: 5, far: 40000, position: [0, 2000, 2000] }} dpr={[1, 2]} gl={{ antialias: true }} onPointerMissed={() => undefined}>
      <color attach="background" args={["#090a10"]} />
      <fog attach="fog" args={["#090a10", 6000, 16000]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[500, 1500, 300]} intensity={1.2} />
      <gridHelper args={[12000, 120, "#2a2130", "#151722"]} position={[0, -1, 0]} />
      {layers.scenery && <Scenery geo={geo} seed={hashString(circuit.circuitId)} />}
      <Track geo={geo} cmp={cmp} onPick={onPick} />
      {layers.sectors && <SectorBands geo={geo} />}
      {layers.drs && <DrsZones geo={geo} zones={zones} />}
      {layers.trap && <SpeedTrap geo={geo} index={trap} top={top} />}
      <Markers geo={geo} />
      <Cursor geo={geo} cmp={cmp} />
      <Cars geo={geo} bundle={bundle} sessionId={sessionId} origin={geo.origin} live={live} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI / 2.05} />
      <CameraRig geo={geo} />
    </Canvas>
  );
}
