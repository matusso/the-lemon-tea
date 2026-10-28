import { useMemo } from "react";
import { buildTimeline, PLAYBACK_RATES, type PlaybackRate, type TimelineEventKind, type TimingBundle } from "@lemon-tea/synchronization";
import { clock, fmtClock, useClockTime, usePlaying } from "../../state/clock";
import { Btn } from "../../components/ui";

const KIND_COLOR: Partial<Record<TimelineEventKind, string>> = {
  flag: "#e8d44d",
  safety_car: "#ffb020",
  vsc: "#ffb020",
  red_flag: "#ff6b6b",
  pit_stop: "#3fb5c0",
  team_radio: "#b9bbc6",
  start: "#4fc778",
  chequered: "#f5f5f7",
  retirement: "#ff6b6b",
  penalty: "#b38cff",
  investigation: "#b38cff",
};

/** Playback controls, session scrubber and the synchronised event strip. */
export function Playback({ bundle }: { bundle: TimingBundle }) {
  const t = useClockTime(200);
  const playing = usePlaying();
  const events = useMemo(() => buildTimeline(bundle), [bundle]);
  const times = useMemo(() => events.map((e) => e.tMs), [events]);
  const span = Math.max(1, clock.max - clock.min);
  const pct = (x: number) => `${((x - clock.min) / span) * 100}%`;
  const recent = events.filter((e) => e.tMs <= t).slice(-6).reverse();

  return (
    <div className="flex h-full flex-col gap-2 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={() => clock.stepEvent(times, -1)} title="Previous event">
          ⏮
        </Btn>
        <Btn onClick={() => clock.step(-5000)} title="−5 s">
          −5s
        </Btn>
        <Btn variant="primary" onClick={() => clock.toggle()}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </Btn>
        <Btn onClick={() => clock.step(5000)} title="+5 s">
          +5s
        </Btn>
        <Btn onClick={() => clock.stepEvent(times, 1)} title="Next event">
          ⏭
        </Btn>
        <div className="ml-2 flex items-center gap-0.5">
          {PLAYBACK_RATES.map((r) => (
            <Btn key={r} active={clock.rate === r} onClick={() => clock.setRate(r as PlaybackRate)}>
              {r}×
            </Btn>
          ))}
        </div>
        <span className="num ml-3 text-[14px] text-fg">{fmtClock(t)}</span>
        <span className="num text-[11px] text-fg-3">{new Date(bundle.epochMs + t).toISOString().slice(11, 19)} UTC</span>
        <span className="ml-auto rounded border border-line-2 px-2 py-0.5 text-[11px] text-fg-2" title="Source freshness">
          Historical replay · source latency n/a
        </span>
      </div>

      <div className="relative h-9 rounded border border-line bg-ink-0/70">
        {events.map((e, i) => (
          <button
            key={i}
            title={`${fmtClock(e.tMs)} · ${e.label}${e.sourceText ? ` — ${e.sourceText}` : ""}`}
            onClick={() => clock.seek(e.tMs)}
            className="absolute top-1 h-3 w-[3px] -translate-x-1/2 rounded-sm hover:scale-150"
            style={{ left: pct(e.tMs), background: KIND_COLOR[e.kind] ?? "#82858f" }}
          />
        ))}
        <input
          type="range"
          className="absolute inset-x-1 bottom-0.5 w-[calc(100%-8px)]"
          min={clock.min}
          max={clock.max}
          step={100}
          value={t}
          onChange={(e) => clock.seek(Number(e.target.value))}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-[12px]">
          <tbody>
            {recent.map((e, i) => (
              <tr key={i} className="cursor-pointer border-b border-line/50 hover:bg-ink-3" onClick={() => clock.seek(e.tMs)}>
                <td className="num w-16 py-0.5 text-fg-3">{fmtClock(e.tMs)}</td>
                <td className="w-24">
                  <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[e.kind] ?? "#82858f" }} />
                  {e.kind.replaceAll("_", " ")}
                </td>
                <td className="truncate text-fg-2">
                  {e.kind === "team_radio" && e.ref ? (
                    <a href={e.ref} target="_blank" rel="noopener noreferrer" className="text-teal hover:underline" onClick={(ev) => ev.stopPropagation()}>
                      {e.label} ↗ (source link)
                    </a>
                  ) : (
                    (e.sourceText ?? e.label)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
