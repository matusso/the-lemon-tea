import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Group, Panel, Separator, usePanelRef, useGroupRef, type Layout } from "react-resizable-panels";
import { sessionEndMs } from "./command/sessionEnd";
import { get } from "../api";
import { useBundle, useCircuit, useInfo, useSelectionCompare } from "../data";
import { isLiveWindow, useLiveFeed, type LiveStatus } from "../state/live";
import { clock } from "../state/clock";
import { useUi, type CameraMode, type MapLayers, type Overlay } from "../state/store";
import { Btn, Empty, ErrorNote, Frame, KindBadge, Loading } from "../components/ui";
import { TelemetryStack } from "../components/TelemetryCharts";
import { TimingTower } from "./command/TimingTower";
import { Circuit3D } from "./command/Circuit3D";
import { RaceIntel } from "./command/RaceIntel";
import { Playback } from "./command/Playback";
import { LiveTelemetry } from "./command/LiveTelemetry";

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
  { id: "none", label: "Plain" },
  { id: "delta", label: "Δ gain" },
  { id: "speed", label: "Speed A" },
  { id: "throttle", label: "Throttle A" },
  { id: "brake", label: "Brake A" },
];

const LAYERS: { id: keyof MapLayers; label: string; title: string }[] = [
  { id: "sectors", label: "Sectors", title: "Sector colour bands and boundaries" },
  { id: "drs", label: "DRS", title: "Estimated DRS / straight-mode zones" },
  { id: "trap", label: "Trap", title: "Speed trap (estimated position, measured speed)" },
  { id: "scenery", label: "Scenery", title: "Illustrative pit building, grandstands, buildings and trees" },
];

function LiveBadge({ status, follow, onFollow }: { status: LiveStatus; follow: boolean; onFollow: () => void }) {
  const tone =
    status.state === "live" ? "border-f1/70 bg-f1/15 text-fg" : status.state === "error" || status.state === "unavailable" ? "border-bad/50 text-bad" : "border-lemon/50 text-lemon";
  const label = { live: "LIVE", connecting: "Connecting", waiting: "Waiting for data", degraded: "Degraded", unavailable: "Live unavailable", error: "Live error", closed: "Offline" }[status.state];
  return (
    <span className="flex items-center gap-2">
      <span className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[13px] font-bold tracking-wider ${tone}`} title={status.message ?? undefined}>
        <span className={`h-2 w-2 rounded-full ${status.state === "live" ? "animate-pulse bg-f1-hi" : "bg-current"}`} />
        {label}
        {status.state === "live" && status.lagMs !== null && <span className="num font-normal text-fg-3">lag {(status.lagMs / 1000).toFixed(1)} s</span>}
      </span>
      {status.message && status.state !== "live" && <span className="max-w-72 truncate text-[13px] text-fg-3">{status.message}</span>}
      <Btn active={follow} onClick={onFollow} title="Keep the clock at the live edge">
        {follow ? "● Following live" : "Go live"}
      </Btn>
    </span>
  );
}

export default function CommandCenter({ active = true }: { active?: boolean }) {
  const { sessionId, meetingId, camera, overlay, set, driverA, driverB, elevationExaggeration, layers } = useUi();
  const bundle = useBundle(sessionId);
  const circuit = useCircuit(sessionId);
  const cmp = useSelectionCompare();
  const info = useInfo(sessionId);
  const session = info.data?.session ?? null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const isLive = !!session && isLiveWindow(session, now);
  const [follow, setFollow] = useState(true);
  const feed = useLiveFeed(sessionId, bundle.data?.epochMs ?? null, isLive && active);

  // A live session that is not ingested has no entry list yet: borrow it from the weekend's latest session.
  const needRoster = isLive && !!bundle.data && bundle.data.drivers.length === 0;
  const weekend = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: needRoster && !!meetingId });
  const rosterId = needRoster
    ? ([...(weekend.data ?? [])].filter((x) => x.id !== sessionId && x.ingestStatus !== "not_ingested").sort((a, b) => b.dateStart.localeCompare(a.dateStart))[0]?.id ?? null)
    : null;
  const roster = useBundle(rosterId);
  const view = useMemo(() => {
    const b = bundle.data;
    if (!b || !isLive) return b;
    const t = feed.timing;
    const laps = new Map(b.laps.map((l) => [`${l.driverNumber}:${l.lapNumber}`, l]));
    for (const l of t.laps) laps.set(`${l.driverNumber}:${l.lapNumber}`, l);
    return {
      ...b,
      drivers: b.drivers.length ? b.drivers : (roster.data?.drivers ?? []),
      laps: [...laps.values()],
      positionHistory: [...b.positionHistory, ...t.positionHistory],
      intervals: [...b.intervals, ...t.intervals],
      raceControl: [...b.raceControl, ...t.raceControl],
      weather: [...b.weather, ...t.weather],
    };
  }, [bundle.data, isLive, feed.timing, roster.data]);

  // Follow the live edge: play in real time, re-sync when drifting, extend the range as data arrives.
  useEffect(() => {
    if (!isLive || !follow || !feed.buffer) return;
    const buf = feed.buffer;
    const id = setInterval(() => {
      if (buf.latestMs === -Infinity) return;
      const edge = buf.latestMs - 1500; // stay just behind the newest sample so cars interpolate
      clock.setRange(Math.min(clock.min, edge), buf.latestMs);
      if (Math.abs(clock.now() - edge) > 2500) clock.seek(edge);
      if (!clock.playing) clock.play();
    }, 250);
    return () => clearInterval(id);
  }, [isLive, follow, feed.buffer]);
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
  const toggle = (r: ReturnType<typeof usePanelRef>) => {
    if (r.current?.isCollapsed()) r.current.expand();
    else r.current?.collapse();
    syncOpen();
  };
  const [open, setOpen] = useState({ tower: true, intel: true, bottom: true });
  const syncOpen = () =>
    requestAnimationFrame(() =>
      setOpen({ tower: !towerRef.current?.isCollapsed(), intel: !intelRef.current?.isCollapsed(), bottom: !bottomRef.current?.isCollapsed() }),
    );
  const [mapInfo, setMapInfo] = useState(false);

  if (!sessionId) return <Empty>Select a season, weekend and session in the top bar.</Empty>;
  if (bundle.isLoading) return <Loading what="Loading session timing" />;
  if (bundle.isError) return <ErrorNote error={bundle.error} />;
  const b = view!;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto px-4">
        <span className="label mr-1">Layout</span>
        {(Object.keys(PRESETS) as Preset[]).map((p) => (
          <Btn key={p} active={preset === p} onClick={() => applyPreset(p)}>
            {p}
          </Btn>
        ))}
        <span className="mx-2 h-4 w-px bg-line" />
        <span className="label mr-1">Panels</span>
        <Btn active={open.tower} onClick={() => toggle(towerRef)} title="Show or hide the timing tower">
          Tower
        </Btn>
        <Btn active={open.intel} onClick={() => toggle(intelRef)} title="Show or hide race intel">
          Intel
        </Btn>
        <Btn active={open.bottom} onClick={() => toggle(bottomRef)} title="Show or hide timeline and telemetry">
          Timeline
        </Btn>
        {isLive && <span className="mx-2 h-4 w-px bg-line" />}
        {isLive && <LiveBadge status={feed.status} follow={follow} onFollow={() => setFollow(!follow)} />}
        <span className="ml-auto whitespace-nowrap text-[13px] text-fg-3">
          {driverA === null ? "Click a driver for A, Ctrl/Cmd-click for B" : driverB === null ? "Ctrl/Cmd-click a second driver to compare" : "Comparing fastest laps of A and B"}
        </span>
      </div>
      <Group orientation="vertical" groupRef={rows} defaultLayout={initial.current.rows} onLayoutChanged={() => (setPreset("Custom"), persist(), syncOpen())} className="min-h-0 flex-1 px-2 pb-2">
        <Panel id="top" minSize="25%">
          <Group orientation="horizontal" groupRef={cols} defaultLayout={initial.current.cols} onLayoutChanged={() => (setPreset("Custom"), persist(), syncOpen())}>
            <Panel id="tower" panelRef={towerRef} collapsible minSize="15%" collapsedSize={0}>
              <TimingTower bundle={b} />
            </Panel>
            <Separator className="mx-[3px] w-[2px]" />
            <Panel id="center" minSize="25%">
              <Frame
                hero
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
                {/* `isolate` keeps the canvas's HTML labels in their own stacking context, under the app menus. */}
                <div className="relative isolate h-full">
                  {circuit.isLoading && <Loading what="Deriving circuit geometry" />}
                  {circuit.isError && <ErrorNote error={circuit.error} />}
                  {circuit.data && <Circuit3D circuit={circuit.data} bundle={b} sessionId={sessionId} cmp={cmp.data} active={active} live={isLive ? feed.buffer : null} />}
                  {circuit.data && (
                    <div className="absolute left-2 top-2 max-w-[min(420px,90%)] text-[13px]">
                      <button
                        type="button"
                        onClick={() => setMapInfo(!mapInfo)}
                        aria-expanded={mapInfo}
                        className="flex items-center gap-2 rounded-[5px] border border-line-2 bg-ink-0/85 px-2 py-1 text-fg-2 hover:text-fg"
                        title={JSON.stringify(circuit.data.provenance, null, 1)}
                      >
                        <span className="num text-fg">{circuit.data.lengthM.toFixed(0)} m</span>
                        <span className="text-fg-3">±{circuit.data.accuracyM?.toFixed(1) ?? "?"} m · {circuit.data.confidence}</span>
                        <span className="text-fg-3">{mapInfo ? "▴" : "ⓘ"}</span>
                      </button>
                      {mapInfo && (
                        <div className="mt-1 space-y-1 rounded-[5px] border border-line-2 bg-ink-0/90 px-2 py-1.5 text-fg-3">
                          <div>Driven line estimated from measured car positions.</div>
                          <div>Corners C1… are detected from speed, not official turn numbers. Ribbon width is visual only.</div>
                          <div>Markers interpolate between position samples (~4 Hz) and hide when no sample is within 2 s.</div>
                          <div>DRS / straight-mode zones and the speed-trap position are estimated from the longest straights (the trap speed itself is measured). Buildings, stands and trees are illustrative, not mapped.</div>
                        </div>
                      )}
                    </div>
                  )}
                  {circuit.data && (
                    <div className="absolute bottom-2 left-2 flex flex-wrap items-center gap-1 rounded-[6px] border border-line-2 bg-ink-0/85 px-2 py-1">
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
                        <span className="ml-1 text-[13px]">
                          <span className="text-lemon">■ {cmp.data.a.driverCode} gaining</span> <span className="text-teal">■ {cmp.data.b.driverCode} gaining</span>
                        </span>
                      )}
                      <span className="mx-1 h-4 w-px bg-line-2" />
                      <span className="label mr-1">Layers</span>
                      {LAYERS.map((l) => (
                        <Btn key={l.id} active={layers[l.id]} onClick={() => set({ layers: { ...layers, [l.id]: !layers[l.id] } })} title={l.title}>
                          {l.label}
                        </Btn>
                      ))}
                      {cmp.isLoading && <span className="text-[13px] text-fg-3">comparing…</span>}
                      {cmp.isError && <span className="text-[13px] text-bad">{(cmp.error as Error).message}</span>}
                      <span className="text-[13px] text-fg-3">· click track to set cursor</span>
                    </div>
                  )}
                </div>
              </Frame>
            </Panel>
            <Separator className="mx-[3px] w-[2px]" />
            <Panel id="intel" panelRef={intelRef} collapsible minSize="15%" collapsedSize={0}>
              <RaceIntel bundle={b} cmp={cmp.data} />
            </Panel>
          </Group>
        </Panel>
        <Separator className="my-[3px] h-[2px]" />
        <Panel id="bottom" panelRef={bottomRef} collapsible minSize="12%" collapsedSize={0}>
          <Group orientation="horizontal">
            <Panel id="playback" defaultSize="45%" minSize="25%">
              <Frame title="Session timeline">
                <Playback bundle={b} />
              </Frame>
            </Panel>
            <Separator className="mx-[3px] w-[2px]" />
            <Panel id="tele" minSize="25%">
              {isLive ? (
                <Frame title={<>Live telemetry <KindBadge kind="measured" title="Live car data; track distance from live positions projected on the derived circuit" /></>}>
                  {feed.buffer && circuit.data ? (
                    <LiveTelemetry buffer={feed.buffer} revision={feed.revision} circuit={circuit.data} drivers={b.drivers} a={driverA} b={driverB} />
                  ) : (
                    <Empty>{circuit.data ? "Connecting to the live feed…" : "Live telemetry needs the circuit layout (ingest any session at this circuit)."}</Empty>
                  )}
                </Frame>
              ) : (
                <Frame title={<>Telemetry {cmp.data && <KindBadge kind="measured" title="Channels measured; distance alignment calculated" />}</>}>
                  {cmp.data?.traces ? <TelemetryStack cmp={cmp.data} channels={["delta", "speed", "throttle"]} /> : <Empty>Select drivers A and B in the timing tower to compare their fastest laps.</Empty>}
                </Frame>
              )}
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  );
}
