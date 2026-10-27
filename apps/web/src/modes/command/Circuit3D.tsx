import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { nearestDistance, pointAtDistance } from "@lemon-tea/circuit-engine";
import { positionAt, type TimingBundle } from "@lemon-tea/synchronization";
import type { CircuitResponse, CompareResponse } from "../../api";
import { clock } from "../../state/clock";
import { useUi, type Overlay } from "../../state/store";
import { ReplayCache } from "./replayCache";

type Geo = CircuitResponse["geometry"];

const LEMON = new THREE.Color("#e8d44d");
const TEAL = new THREE.Color("#3fb5c0");
const BASE = new THREE.Color("#3a3f48");

/** Source (origin-shifted) metres → scene: x→X, elevation→Y, y→-Z. */
function toScene(x: number, y: number, z = 0): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

function elevationAt(geo: Geo, i: number, ex: number) {
  return geo.z ? geo.z[i]! * ex : 0;
}

/** Per-vertex colours for the overlay, sampled from the comparison traces by lap-distance fraction. */
function overlayColors(geo: Geo, cmp: CompareResponse | undefined, overlay: Overlay): THREE.Color[] {
  const n = geo.x.length;
  const L = geo.distance[n - 1]!;
  const sectorTint = (d: number) => {
    const s = geo.sectorBoundaries;
    const k = d < (s[0] ?? Infinity) ? 0 : d < (s[1] ?? Infinity) ? 1 : 2;
    return BASE.clone().offsetHSL(0, 0, k * 0.03);
  };
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

  const edge = useMemo(() => {
    const pts = geo.x.map((x, i) => toScene(x, geo.y[i]!, elevationAt(geo, i, ex) + 0.3));
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [geo, ex]);

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const p = e.point;
    onPick(nearestDistance(geo, p.x, -p.z).distance);
  };

  return (
    <group>
      <mesh geometry={geometry} onClick={click}>
        <meshBasicMaterial vertexColors side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={edge}>
        <lineBasicMaterial color="#5b616c" transparent opacity={0.35} />
      </lineSegments>
    </group>
  );
}

function Markers({ geo }: { geo: Geo }) {
  const { set, elevationExaggeration: ex } = useUi();
  const sf = geo.startFinish;
  const ticks = geo.sectorBoundaries.map((d) => ({ d, p: pointAtDistance(geo, d) }));
  return (
    <group>
      <mesh position={toScene(sf.x, sf.y, (geo.z?.[0] ?? 0) * ex + 0.5)} rotation={[0, sf.heading, 0]}>
        <boxGeometry args={[3, 1, 18]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <Html position={toScene(sf.x, sf.y, 6)} center>
        <div className="car-label !transform-none text-fg">S/F</div>
      </Html>
      {ticks.map((t, i) => (
        <group key={i}>
          <mesh position={toScene(t.p.x, t.p.y, 0.5)}>
            <cylinderGeometry args={[1.6, 1.6, 1, 12]} />
            <meshBasicMaterial color="#9aa1ab" />
          </mesh>
          <Html position={toScene(t.p.x, t.p.y, 6)} center>
            <div className="car-label !transform-none text-fg-2">S{i + 1}|S{i + 2}</div>
          </Html>
        </group>
      ))}
      {geo.corners.map((c) => (
        <Html key={c.number} position={toScene(c.x, c.y, 10)} center zIndexRange={[10, 0]}>
          <button
            onClick={() => set({ focusCorner: c.number, camera: "corner" })}
            className="rounded border border-line-2 bg-ink-1/85 px-1 font-mono text-[10px] text-fg-2 hover:border-lemon hover:text-lemon"
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
  if (cursor === null) return null;
  const L = geo.distance[geo.distance.length - 1]!;
  const d = cmp ? (cursor / cmp.reference_length_m) * L : cursor;
  const p = pointAtDistance(geo, d);
  return (
    <mesh position={toScene(p.x, p.y, 2)}>
      <torusGeometry args={[11, 1.4, 8, 32]} />
      <meshBasicMaterial color="#e8d44d" />
    </mesh>
  );
}

interface CarRef {
  group: THREE.Group;
  label: HTMLDivElement | null;
}

function Cars({ geo, bundle, sessionId, origin }: { geo: Geo; bundle: TimingBundle; sessionId: string; origin: Geo["origin"] }) {
  const { driverA, driverB, camera, elevationExaggeration: ex } = useUi();
  const refs = useRef(new Map<number, CarRef>());
  const cache = useMemo(() => new ReplayCache(sessionId, clock.min, clock.max || Infinity), [sessionId]);
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
                <meshBasicMaterial color={sel === "a" ? "#e8d44d" : "#3fb5c0"} />
              </mesh>
            )}
            <Html zIndexRange={[20, 0]}>
              <div className="car-label" style={{ color: sel === "a" ? "#e8d44d" : sel === "b" ? "#3fb5c0" : color, borderLeft: `2px solid ${color}` }}>
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
  const cam = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const bounds = useMemo(() => {
    const b = new THREE.Box3();
    geo.x.forEach((x, i) => b.expandByPoint(toScene(x, geo.y[i]!, 0)));
    return b;
  }, [geo]);

  useEffect(() => {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z);
    let pos: THREE.Vector3;
    let target = center;
    if (mode === "top") pos = center.clone().add(new THREE.Vector3(0, r * 1.45, 0.01));
    else if (mode === "corner" && focusCorner !== null) {
      const c = geo.corners.find((k) => k.number === focusCorner);
      target = c ? toScene(c.x, c.y, 0) : center;
      pos = target.clone().add(new THREE.Vector3(180, 220, 180));
    } else if (mode === "follow") pos = center.clone().add(new THREE.Vector3(0, 320, 320));
    else pos = center.clone().add(new THREE.Vector3(r * 0.55, r * 0.95, r * 0.85));
    cam.position.copy(pos);
    cam.lookAt(target);
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }, [mode, focusCorner, bounds, cam, controls, geo]);
  return null;
}

/** Interactive 3D circuit: derived driven line, corners, sectors, live/replay car markers. */
export function Circuit3D({ circuit, bundle, sessionId, cmp, active = true }: { circuit: CircuitResponse; bundle: TimingBundle; sessionId: string; cmp: CompareResponse | undefined; active?: boolean }) {
  const set = useUi((s) => s.set);
  const geo = circuit.geometry;
  const onPick = (dGeo: number) => {
    const L = geo.distance[geo.distance.length - 1]!;
    set({ cursorDistance: cmp ? (dGeo / L) * cmp.reference_length_m : dGeo });
  };
  return (
    <Canvas frameloop={active ? "always" : "never"} camera={{ fov: 40, near: 5, far: 40000, position: [0, 2000, 2000] }} dpr={[1, 2]} gl={{ antialias: true }} onPointerMissed={() => undefined}>
      <color attach="background" args={["#0b0c0e"]} />
      <fog attach="fog" args={["#0b0c0e", 4000, 14000]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[500, 1500, 300]} intensity={1.2} />
      <gridHelper args={[12000, 120, "#1d2027", "#15171c"]} position={[0, -1, 0]} />
      <Track geo={geo} cmp={cmp} onPick={onPick} />
      <Markers geo={geo} />
      <Cursor geo={geo} cmp={cmp} />
      <Cars geo={geo} bundle={bundle} sessionId={sessionId} origin={geo.origin} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI / 2.05} />
      <CameraRig geo={geo} />
    </Canvas>
  );
}
