import { useMemo } from "react";
import { timingTower, trackStatusAt, weatherAt, type TimingBundle } from "@lemon-tea/synchronization";
import type { CompareResponse } from "../../api";
import { useClockTime } from "../../state/clock";
import { useUi } from "../../state/store";
import { dash, fmtLap, fmtNum, Frame, KindBadge, teamColor, Tyre } from "../../components/ui";

const STATUS_STYLE: Record<string, string> = {
  green: "bg-good/15 text-good border-good/40",
  yellow: "bg-lemon/15 text-lemon border-lemon/40",
  sc: "bg-lemon/20 text-lemon border-lemon/60",
  vsc: "bg-lemon/15 text-lemon border-lemon/40",
  red: "bg-bad/20 text-bad border-bad/50",
  chequered: "bg-fg/10 text-fg border-fg/40",
  unknown: "bg-ink-3 text-fg-3 border-line-2",
};
const STATUS_LABEL: Record<string, string> = { green: "Green", yellow: "Yellow", sc: "Safety Car", vsc: "Virtual SC", red: "Red flag", chequered: "Chequered", unknown: "No flag data yet" };

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded border border-line bg-ink-0/60 px-2 py-1.5">
      <div className="label">{label}</div>
      <div className="num text-[14px] text-fg">
        {value}
        {unit && value !== dash && <span className="ml-0.5 text-[10px] text-fg-3">{unit}</span>}
      </div>
    </div>
  );
}

/** Finding for the corner/straight containing the shared cursor distance. */
export function CursorExplanation({ cmp }: { cmp: CompareResponse | undefined }) {
  const cursor = useUi((s) => s.cursorDistance);
  if (!cmp || cursor === null) return null;
  const corner = cmp.corners.find((c) => cursor >= c.corner.windowStart && cursor <= c.corner.windowEnd);
  const straight = cmp.straights.find((s) => cursor >= s.from && cursor <= s.to);
  const scope = corner?.corner.label ?? straight?.label;
  const finding = cmp.findings.find((f) => f.scope === scope);
  const delta = corner?.delta_change_seconds ?? straight?.deltaChange ?? null;
  return (
    <div className="rounded border border-lemon/30 bg-lemon/5 p-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between">
        <span className="label !text-lemon">
          {cmp.a.driverCode} vs {cmp.b.driverCode} @ {cursor.toFixed(0)} m · {scope ?? "—"}
        </span>
        <KindBadge kind="calculated" />
      </div>
      {delta !== null && (
        <div className="num mb-1 text-fg">
          Δ section {fmtNum(delta, 3, true)} s <span className="text-fg-3">(negative = {cmp.a.driverCode} gained)</span>
        </div>
      )}
      <div className="text-fg-2">
        {finding?.text ?? (delta !== null && Math.abs(delta) < cmp.noise_floor_seconds ? `Difference here is within the ${cmp.noise_floor_seconds}s noise floor.` : "No explained difference in this section.")}
      </div>
    </div>
  );
}

export function RaceIntel({ bundle, cmp }: { bundle: TimingBundle; cmp: CompareResponse | undefined }) {
  const t = useClockTime(500);
  const { driverA } = useUi();
  const status = trackStatusAt(bundle, t);
  const wx = weatherAt(bundle, t);
  const at = bundle.epochMs + t;
  const rc = useMemo(() => bundle.raceControl.filter((e) => Date.parse(e.date) <= at).slice(-30).reverse(), [bundle, at]);
  const pits = useMemo(() => bundle.pitEvents.filter((p) => Date.parse(p.date) <= at).slice(-12).reverse(), [bundle, at]);
  const row = useMemo(() => (driverA !== null ? timingTower(bundle, t).find((r) => r.driverNumber === driverA) : undefined), [bundle, t, driverA]);
  const drv = bundle.drivers.find((d) => d.driverNumber === driverA);

  return (
    <Frame title="Race intelligence">
      <div className="space-y-3 p-2.5">
        <div className={`flex items-center justify-between rounded border px-2 py-1.5 ${STATUS_STYLE[status.status]}`}>
          <span className="text-[12px] font-semibold uppercase tracking-wider">{STATUS_LABEL[status.status]}</span>
          <KindBadge kind="measured" title="From race-control messages" />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="label">Weather</span>
            <KindBadge kind={wx ? "measured" : "unavailable"} />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Stat label="Air" value={fmtNum(wx?.airTemperature, 1)} unit="°C" />
            <Stat label="Track" value={fmtNum(wx?.trackTemperature, 1)} unit="°C" />
            <Stat label="Humidity" value={fmtNum(wx?.humidity, 0)} unit="%" />
            <Stat label="Wind" value={fmtNum(wx?.windSpeed, 1)} unit="m/s" />
            <Stat label="Dir" value={fmtNum(wx?.windDirection, 0)} unit="°" />
            <Stat label="Rain" value={wx?.rainfall === null || wx?.rainfall === undefined ? dash : wx.rainfall ? "Yes" : "No"} />
          </div>
          <div className="mt-1 text-[10px] text-fg-3">Grip / track condition: unavailable — no measured channel; not estimated here.</div>
        </div>

        <CursorExplanation cmp={cmp} />

        {drv && (
          <div className="rounded border border-line bg-ink-0/60 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="h-4 w-1 rounded" style={{ background: teamColor(drv.teamColour) }} />
              <span className="font-bold">{drv.code}</span>
              <span className="text-fg-2">{drv.fullName}</span>
              <span className="ml-auto text-[10px] text-fg-3">{drv.teamName}</span>
            </div>
            {row && (
              <div className="num grid grid-cols-3 gap-1.5 text-[11px]">
                <Stat label="Pos" value={String(row.position ?? dash)} />
                <Stat label="Lap" value={String(row.currentLap || dash)} />
                <Stat label="Best" value={fmtLap(row.bestLap)} />
                <Stat label="Last" value={fmtLap(row.lastLap)} />
                <div className="col-span-2 flex items-center gap-2 rounded border border-line bg-ink-0/60 px-2">
                  <span className="label">Tyre</span>
                  <Tyre compound={row.compound} age={row.tyreAge} />
                  <span className="label ml-auto">Pits</span>
                  <span>{row.pitStops}</span>
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="label">Race control</span>
            <span className="text-[9px] text-fg-3">source text · untrusted</span>
          </div>
          <ul className="space-y-1">
            {rc.length === 0 && <li className="text-[11px] text-fg-3">No messages yet.</li>}
            {rc.map((e, i) => (
              <li key={`${e.date}-${i}`} className="rounded border border-line/70 bg-ink-0/40 px-2 py-1 text-[11px]">
                <span className="num mr-2 text-fg-3">{new Date(e.date).toISOString().slice(11, 19)}</span>
                {e.flag && <span className="mr-1 text-lemon">{e.flag}</span>}
                <span className="text-fg-2">{e.message}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="label mb-1">Pit stops</div>
          {pits.length === 0 ? (
            <div className="text-[11px] text-fg-3">None yet.</div>
          ) : (
            <table className="num w-full text-[11px]">
              <tbody>
                {pits.map((p) => (
                  <tr key={`${p.driverNumber}-${p.lapNumber}`} className="border-b border-line/50">
                    <td className="py-0.5">{bundle.drivers.find((d) => d.driverNumber === p.driverNumber)?.code ?? p.driverNumber}</td>
                    <td className="text-fg-3">L{p.lapNumber}</td>
                    <td className="text-right">{fmtNum(p.laneDuration, 1)} s lane</td>
                    <td className="text-right text-fg-2">{p.stopDuration !== null ? `${p.stopDuration.toFixed(1)} s stop` : dash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="text-[10px] text-fg-3">Pit-stop and strategy predictions: run them in Strategy Simulator (simulated, with uncertainty).</div>
      </div>
    </Frame>
  );
}
