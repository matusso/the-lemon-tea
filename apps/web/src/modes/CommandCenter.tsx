import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef, useGroupRef, type Layout } from "react-resizable-panels";
import { sessionEndMs } from "./command/sessionEnd";
import { useBundle, useCircuit, useSelectionCompare } from "../data";
import { clock } from "../state/clock";
import { useUi, type CameraMode, type Overlay } from "../state/store";
import { Btn, Empty, ErrorNote, Frame, KindBadge, Loading } from "../components/ui";
import { TelemetryStack } from "../components/TelemetryCharts";
import { TimingTower } from "./command/TimingTower";
import { Circuit3D } from "./command/Circuit3D";
import { RaceIntel } from "./command/RaceIntel";
import { Playback } from "./command/Playback";

type Preset = "Live Race" | "Qualifying" | "Strategy" | "Telemetry Comparison";
const PRESETS: Record<Preset, { cols: Layout; rows: Layout }> = {
  "Live Race": { cols: { tower: 28, center: 50, intel: 22 }, rows: { top: 72, bottom: 28 } },
  Qualifying: { cols: { tower: 34, center: 46, intel: 20 }, rows: { top: 70, bottom: 30 } },
  Strategy: { cols: { tower: 30, center: 38, intel: 32 }, rows: { top: 62, bottom: 38 } },
  "Telemetry Comparison": { cols: { tower: 24, center: 40, intel: 20 }, rows: { top: 50, bottom: 50 } },
};

function load<T>(k: string): T | undefined {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // ignore: layout persistence is a convenience
  }
}

const CAMERAS: { id: CameraMode; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "iso", label: "Iso" },
  { id: "orbit", label: "Orbit" },
  { id: "follow", label: "Follow A" },
];
const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: "none", label: "Sectors" },
  { id: "delta", label: "Δ gain" },
  { id: "speed", label: "Speed A" },
  { id: "throttle", label: "Throttle A" },
  { id: "brake", label: "Brake A" },
];

export default function CommandCenter({ active = true }: { active?: boolean }) {
  const { sessionId, camera, overlay, set, driverA, driverB, elevationExaggeration } = useUi();
  const bundle = useBundle(sessionId);
  const circuit = useCircuit(sessionId);
  const cmp = useSelectionCompare();
  const cols = useGroupRef();
  const rows = useGroupRef();
  const towerRef = usePanelRef();
  const intelRef = usePanelRef();
  const bottomRef = usePanelRef();
  const [preset, setPreset] = useState<Preset | "Custom">(load<Preset>("lt:preset") ?? "Live Race");
  const initial = useRef(load<{ cols: Layout; rows: Layout }>("lt:layout") ?? PRESETS["Live Race"]);

  useEffect(() => {
    if (!bundle.data) return;
    const b = bundle.data;
    const starts = b.laps.filter((l) => l.dateStart).map((l) => Date.parse(l.dateStart!) - b.epochMs);
    const min = Math.max(0, Math.min(0, ...starts) - 30_000);
    const max = sessionEndMs(b);
    clock.pause();
    clock.setRange(min, max);
    clock.seek(starts.length ? Math.max(min, Math.min(...starts) - 10_000) : min);
  }, [bundle.data]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    save("lt:preset", p);
    cols.current?.setLayout(PRESETS[p].cols);
    rows.current?.setLayout(PRESETS[p].rows);
    save("lt:layout", PRESETS[p]);
  };
  const persist = () => {
    if (cols.current && rows.current) save("lt:layout", { cols: cols.current.getLayout(), rows: rows.current.getLayout() });
  };
  const toggle = (r: ReturnType<typeof usePanelRef>) => (r.current?.isCollapsed() ? r.current.expand() : r.current?.collapse());

  if (!sessionId) return <Empty>Select a season, weekend and session in the top bar.</Empty>;
  if (bundle.isLoading) return <Loading what="Loading session timing" />;
  if (bundle.isError) return <ErrorNote error={bundle.error} />;
  const b = bundle.data!;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-ink-1/80 px-3">
        <span className="label">Workspace</span>
        {(Object.keys(PRESETS) as Preset[]).map((p) => (
          <Btn key={p} active={preset === p} onClick={() => applyPreset(p)}>
            {p}
          </Btn>
        ))}
        <span className="mx-2 h-4 w-px bg-line" />
        <Btn onClick={() => toggle(towerRef)}>Tower</Btn>
        <Btn onClick={() => toggle(intelRef)}>Intel</Btn>
        <Btn onClick={() => toggle(bottomRef)}>Timeline</Btn>
        <span className="ml-auto text-[11px] text-fg-3">
          {driverA === null ? "Click a driver for A, Ctrl/Cmd-click for B" : driverB === null ? "Ctrl/Cmd-click a second driver to compare" : "Comparing fastest laps of A and B"}
        </span>
      </div>
      <Group orientation="vertical" groupRef={rows} defaultLayout={initial.current.rows} onLayoutChanged={() => (setPreset("Custom"), persist())} className="min-h-0 flex-1">
        <Panel id="top" minSize="25%">
          <Group orientation="horizontal" groupRef={cols} defaultLayout={initial.current.cols} onLayoutChanged={() => (setPreset("Custom"), persist())}>
            <Panel id="tower" panelRef={towerRef} collapsible minSize="15%" collapsedSize={0}>
              <TimingTower bundle={b} />
            </Panel>
            <Separator className="w-px" />
            <Panel id="center" minSize="25%">
              <Frame
                title={
                  <>
                    Circuit {circuit.data && <KindBadge kind="estimated" title="Driven line derived from measured positions" />}
                  </>
                }
                right={
                  <>
                    {CAMERAS.map((c) => (
                      <Btn key={c.id} active={camera === c.id} onClick={() => set({ camera: c.id })} disabled={c.id === "follow" && driverA === null}>
                        {c.label}
                      </Btn>
                    ))}
                  </>
                }
              >
                <div className="relative h-full">
                  {circuit.isLoading && <Loading what="Deriving circuit geometry" />}
                  {circuit.isError && <ErrorNote error={circuit.error} />}
                  {circuit.data && <Circuit3D circuit={circuit.data} bundle={b} sessionId={sessionId} cmp={cmp.data} active={active} />}
                  {circuit.data && (
                    <div className="pointer-events-none absolute left-2 top-2 space-y-1 text-[11px]">
                      <div className="pointer-events-auto rounded border border-line-2 bg-ink-1/90 px-2 py-1 text-fg-2" title={JSON.stringify(circuit.data.provenance, null, 1)}>
                        Driven-line estimate · ±{circuit.data.accuracyM?.toFixed(1) ?? "?"} m · {circuit.data.confidence} · {circuit.data.lengthM.toFixed(0)} m
                      </div>
                      <div className="rounded border border-line-2 bg-ink-1/90 px-2 py-1 text-fg-3">
                        Corners C1… are detected from speed, not official turn numbers · ribbon width is visual only
                        <br />
                        Markers interpolate between measured position samples (~4 Hz); hidden when no sample within 2 s
                      </div>
                    </div>
                  )}
                  {circuit.data && (
                    <div className="absolute bottom-2 left-2 flex flex-wrap items-center gap-1 rounded border border-line-2 bg-ink-1/90 px-2 py-1">
                      <span className="label mr-1">Overlay</span>
                      {OVERLAYS.map((o) => (
                        <Btn key={o.id} active={overlay === o.id} onClick={() => set({ overlay: o.id })} disabled={o.id !== "none" && !cmp.data}>
                          {o.label}
                        </Btn>
                      ))}
                      {circuit.data.geometry.z && (
                        <Btn active={elevationExaggeration > 1} onClick={() => set({ elevationExaggeration: elevationExaggeration > 1 ? 1 : 5 })} title="Exaggerate elevation 5×">
                          Elev ×5
                        </Btn>
                      )}
                      {overlay === "delta" && cmp.data && (
                        <span className="ml-1 text-[11px]">
                          <span className="text-lemon">■ {cmp.data.a.driverCode} gaining</span> <span className="text-teal">■ {cmp.data.b.driverCode} gaining</span>
                        </span>
                      )}
                      {cmp.isLoading && <span className="text-[11px] text-fg-3">comparing…</span>}
                      {cmp.isError && <span className="text-[11px] text-bad">{(cmp.error as Error).message}</span>}
                      <span className="text-[11px] text-fg-3">· click track to set cursor</span>
                    </div>
                  )}
                </div>
              </Frame>
            </Panel>
            <Separator className="w-px" />
            <Panel id="intel" panelRef={intelRef} collapsible minSize="15%" collapsedSize={0}>
              <RaceIntel bundle={b} cmp={cmp.data} />
            </Panel>
          </Group>
        </Panel>
        <Separator className="h-px" />
        <Panel id="bottom" panelRef={bottomRef} collapsible minSize="12%" collapsedSize={0}>
          <Group orientation="horizontal">
            <Panel id="playback" defaultSize="45%" minSize="25%">
              <Frame title="Session timeline">
                <Playback bundle={b} />
              </Frame>
            </Panel>
            <Separator className="w-px" />
            <Panel id="tele" minSize="25%">
              <Frame title={<>Telemetry {cmp.data && <KindBadge kind="measured" title="Channels measured; distance alignment calculated" />}</>}>
                {cmp.data?.traces ? <TelemetryStack cmp={cmp.data} channels={["delta", "speed", "throttle"]} /> : <Empty>Select drivers A and B in the timing tower to compare their fastest laps.</Empty>}
              </Frame>
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  );
}
