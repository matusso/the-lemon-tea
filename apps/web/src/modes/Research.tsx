import { useQuery } from "@tanstack/react-query";
import { api, get } from "../api";
import { useUi } from "../state/store";
import { dash, Empty, ErrorNote, Frame, Loading } from "../components/ui";

interface Metrics {
  versions: { id: string; family: string; status: string; createdAt: string; metrics: Record<string, unknown> | null }[];
  backtests: { id: string; modelVersion: string; family: string; windowDesc: string; metrics: Record<string, unknown>; createdAt: string }[];
  builtin: { family: string; version: string }[];
  note?: string;
}
interface HistoryItem {
  id: string;
  kind: string;
  createdAt: string;
  asOf: string;
  modelVersion: string;
  paramsVersion: string;
  inputSessionIds: string[];
  score: { validForEvaluation: boolean; drivers: number; lapTimeMae: number | null; rankSpearman: number | null; poleBrier: number } | null;
}

export default function Research() {
  const { meetingId } = useUi();
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: () => api<Metrics>("/api/models/metrics"), retry: false });
  const sessions = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: !!meetingId });
  const q = sessions.data?.find((s) => s.type === "qualifying" && s.ingestStatus !== "not_ingested");
  const history = useQuery({
    queryKey: ["history", meetingId, q?.id],
    queryFn: () => api<HistoryItem[]>(`/api/predictions/history?${q ? `qualifyingSessionId=${encodeURIComponent(q.id)}` : `meetingId=${encodeURIComponent(meetingId!)}`}`),
    enabled: !!meetingId,
    retry: false,
  });
  const sources = useQuery({ queryKey: ["sources"], queryFn: get.sources, retry: false });

  return (
    <div className="grid h-full grid-cols-1 gap-px bg-line xl:grid-cols-2">
      <div className="grid min-h-0 grid-rows-2 gap-px">
        <Frame title="Prediction history · scored against actual result">
          {history.isLoading && <Loading />}
          {history.isError && <ErrorNote error={history.error} />}
          {history.data && history.data.length === 0 && <Empty>No stored forecasts for this weekend yet. Run a qualifying forecast while signed in.</Empty>}
          {history.data && history.data.length > 0 && (
            <table className="num w-full text-[11px]">
              <thead className="text-left text-[9px] uppercase tracking-wider text-fg-3">
                <tr>
                  <th className="px-2">Created</th>
                  <th>Data as of</th>
                  <th>Inputs</th>
                  <th>Model</th>
                  <th className="text-right">Lap MAE</th>
                  <th className="text-right">Spearman</th>
                  <th className="text-right">Pole Brier</th>
                  <th>Valid</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((h) => (
                  <tr key={h.id} className="border-b border-line/50">
                    <td className="px-2 py-0.5">{h.createdAt.slice(0, 16).replace("T", " ")}</td>
                    <td className="text-fg-2">{h.asOf.slice(0, 16).replace("T", " ")}</td>
                    <td className="text-fg-2">{h.inputSessionIds.map((s) => s.split(":")[1]).join(", ")}</td>
                    <td className="text-fg-3">{h.modelVersion}</td>
                    <td className="text-right">{h.score?.lapTimeMae?.toFixed(3) ?? dash}</td>
                    <td className="text-right">{h.score?.rankSpearman?.toFixed(3) ?? dash}</td>
                    <td className="text-right">{h.score?.poleBrier?.toFixed(4) ?? dash}</td>
                    <td>{h.score ? (h.score.validForEvaluation ? <span className="text-good">yes</span> : <span className="text-bad" title="Made after the target session started">leak</span>) : dash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="p-3 text-[10px] text-fg-3">Only forecasts whose data cut-off precedes the target session are valid for evaluation (no future-information leakage).</div>
        </Frame>
        <Frame title="Models & backtests">
          {metrics.isError && <ErrorNote error={metrics.error} />}
          {metrics.data && (
            <div className="space-y-3 p-3 text-[11px]">
              {metrics.data.note && <div className="rounded border border-lemon/30 bg-lemon/5 p-2 text-lemon">{metrics.data.note}</div>}
              <div>
                <div className="label mb-1">Built-in algorithm versions</div>
                {metrics.data.builtin.map((b) => (
                  <div key={b.family} className="num text-fg-2">
                    {b.family}: {b.version}
                  </div>
                ))}
              </div>
              <div>
                <div className="label mb-1">Registered versions</div>
                {metrics.data.versions.length === 0 ? <div className="text-fg-3">None</div> : metrics.data.versions.map((v) => <div key={v.id} className="num">{v.id} · {v.family} · {v.status}</div>)}
              </div>
              <div>
                <div className="label mb-1">Backtests</div>
                {metrics.data.backtests.length === 0 ? (
                  <div className="text-fg-3">None yet</div>
                ) : (
                  metrics.data.backtests.map((b) => (
                    <div key={b.id} className="num border-b border-line/40 py-1">
                      {b.family} · {b.modelVersion} · {b.windowDesc}
                      <div className="text-fg-3">{JSON.stringify(b.metrics)}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </Frame>
      </div>
      <Frame title="Data source governance · as configured by the operator">
        {sources.isError && <ErrorNote error={sources.error} />}
        <div className="space-y-2 p-3">
          {sources.data?.map((s) => (
            <div key={String(s.id)} className="rounded border border-line bg-ink-0/50 p-2 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{String(s.name)}</span>
                <span className="num text-fg-3">{String(s.id)}</span>
                <span className={`ml-auto rounded border px-1 text-[9px] uppercase ${s.enabled ? "border-good/40 text-good" : "border-line-2 text-fg-3"}`}>{s.enabled ? "enabled" : "disabled"}</span>
                <span className={`rounded border px-1 text-[9px] uppercase ${s.publicDisplayAllowed ? "border-teal/40 text-teal" : "border-line-2 text-fg-3"}`}>{s.publicDisplayAllowed ? "public display" : "not public"}</span>
              </div>
              <div className="mt-1 text-fg-2">{String(s.license ?? dash)}</div>
              <div className="num mt-1 grid grid-cols-2 gap-x-3 text-[10px] text-fg-3">
                <span>redistribution: {String(s.redistribution ?? dash)}</span>
                <span>rate limit: {String(s.rateLimit ?? dash)}</span>
                <span>coverage: {String(s.historicalCoverage ?? dash)}</span>
                <span>updates: {String(s.updateFrequency ?? dash)}</span>
              </div>
              {Array.isArray(s.missingChannels) && s.missingChannels.length > 0 && <div className="mt-1 text-[10px] text-fg-3">missing channels: {(s.missingChannels as string[]).join(", ")}</div>}
              {s.attribution ? <div className="mt-1 text-[10px] text-fg-3">{String(s.attribution)}</div> : null}
            </div>
          ))}
        </div>
      </Frame>
    </div>
  );
}
