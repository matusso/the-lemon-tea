import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Btn } from "./ui";

interface ConnectionStatus {
  provider: string;
  name: string;
  status: "connected" | "expired" | "not_connected";
  expiresAt: string | null;
  method: "password" | "token" | null;
  connectedAt: string | null;
  details: Record<string, string>;
}

interface Listing {
  sessionKey: string;
  meetingKey: string;
  name: string;
  circuitShortName: string;
  countryName: string | null;
  dateStart: string;
}

interface Job {
  jobId: string;
  kind: string;
  status: string;
  progress: number;
  error: { message?: string } | null;
}

const PROVIDER = "f1lt";

/**
 * Connect the user's own Formula 1 account (F1 TV subscription) to read F1 live timing — the
 * feed FastF1 uses. The password goes to this server only to be forwarded to Formula 1's sign-in
 * service; it is never stored. Loaded sessions are private to the user's tenant.
 */
export function F1AccountPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["connection", PROVIDER], queryFn: () => api<ConnectionStatus>(`/api/connections/${PROVIDER}`) });
  const [mode, setMode] = useState<"password" | "token">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const connected = status.data?.status === "connected";
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "password") await api(`/api/connections/${PROVIDER}/sign-in`, { method: "POST", body: { username, password } });
      else await api(`/api/connections/${PROVIDER}/token`, { method: "POST", body: { token } });
      setPassword("");
      setToken("");
      await qc.invalidateQueries({ queryKey: ["connection", PROVIDER] });
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute right-0 top-8 z-50 w-[440px] rounded-md border border-line-2 bg-ink-2 p-3 text-[13px] shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-fg">Formula 1 account</span>
        <button className="text-fg-3 hover:text-fg" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <StatusLine s={status.data} />

      {connected ? (
        <>
          <SessionLoader />
          <div className="mt-3 flex justify-end">
            <Btn
              onClick={async () => {
                await api(`/api/connections/${PROVIDER}`, { method: "DELETE" });
                await qc.invalidateQueries({ queryKey: ["connection", PROVIDER] });
              }}
            >
              Disconnect
            </Btn>
          </div>
        </>
      ) : (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="mb-2 flex gap-1">
            <Btn active={mode === "password"} onClick={() => setMode("password")}>
              Sign in
            </Btn>
            <Btn active={mode === "token"} onClick={() => setMode("token")}>
              Paste token
            </Btn>
          </div>
          {mode === "password" ? (
            <>
              <div className="label mb-1">F1 account email</div>
              <input className="mb-2 w-full" type="email" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
              <div className="label mb-1">Password</div>
              <input className="mb-2 w-full" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <p className="mb-2 text-[11px] leading-snug text-fg-3">
                Sent once to Formula 1&apos;s sign-in service (id.formula1.com, as used by account.formula1.com). The password is never stored; only the resulting F1 TV
                subscription token is kept, encrypted. An active F1 TV subscription is required.
              </p>
            </>
          ) : (
            <>
              <div className="label mb-1">F1 TV subscription token</div>
              <textarea className="mb-2 h-20 w-full font-mono text-[11px]" value={token} onChange={(e) => setToken(e.target.value)} required spellCheck={false} />
              <p className="mb-2 text-[11px] leading-snug text-fg-3">The JWT FastF1 stores after signing in (f1auth_token.json, field &quot;value&quot;). It is stored encrypted and never shown again.</p>
            </>
          )}
          {err && <div className="mb-2 text-[12px] text-bad">{err}</div>}
          <button className="h-8 w-full rounded bg-f1 text-[13px] font-semibold text-white hover:bg-f1-hi disabled:opacity-50" type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      )}
      <p className="mt-3 text-[11px] leading-snug text-fg-3">
        Data read with your subscription stays private to your account here and is not shared with other users. Use is subject to Formula 1&apos;s terms.
      </p>
    </div>
  );
}

function StatusLine({ s }: { s: ConnectionStatus | undefined }) {
  if (!s) return <div className="text-fg-3">Checking…</div>;
  if (s.status === "connected")
    return (
      <div className="text-good">
        Connected
        {s.details.SubscribedProduct ? ` · ${s.details.SubscribedProduct}` : ""}
        {s.details.SubscriptionStatus ? ` (${s.details.SubscriptionStatus})` : ""}
        {s.expiresAt ? ` · token valid until ${new Date(s.expiresAt).toLocaleString()}` : ""}
      </div>
    );
  if (s.status === "expired") return <div className="text-lemon">Token expired or rejected — sign in again.</div>;
  return <div className="text-fg-3">Not connected.</div>;
}

function SessionLoader() {
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["f1lt-sessions", year],
    queryFn: () => api<Listing[]>(`/api/ingest/discover?source=${PROVIDER}&year=${year}`),
    retry: false,
  });

  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return;
    const t = setTimeout(async () => {
      try {
        const j = await api<Job>(`/api/jobs/${job.jobId}`);
        setJob(j);
        if (j.status === "succeeded") void qc.invalidateQueries();
      } catch (x) {
        setErr((x as Error).message);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [job, qc]);

  const running = !!job && !["succeeded", "failed", "cancelled"].includes(job.status);
  const past = (list.data ?? []).filter((s) => Date.parse(s.dateStart) < Date.now());
  // One group per race weekend, newest weekend first, sessions in running order (FP1 → race).
  const byMeeting = new Map<string, Listing[]>();
  for (const s of past) byMeeting.set(s.meetingKey, [...(byMeeting.get(s.meetingKey) ?? []), s]);
  const weekends = [...byMeeting.values()]
    .map((ss) => ss.sort((a, b) => a.dateStart.localeCompare(b.dateStart)))
    .sort((a, b) => b[0]!.dateStart.localeCompare(a[0]!.dateStart));
  const start = async (path: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      setJob(await api<Job>(path, { method: "POST", body: { ...body, channels: ["timing", "car_data", "location"], visibility: "private" } }));
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="label">Load from F1 live timing</span>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {Array.from({ length: new Date().getUTCFullYear() - 2017 }, (_, i) => new Date().getUTCFullYear() - i).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      {list.isLoading && <div className="text-fg-3">Loading calendar…</div>}
      {list.isError && <div className="text-bad">{(list.error as Error).message}</div>}
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {weekends.map((ss) => {
          const w = ss[0]!;
          return (
            <details key={w.meetingKey} className="group rounded border border-line bg-ink-1 open:border-line-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 select-none hover:bg-ink-3/60">
                <span className="w-3 text-fg-3 transition-transform group-open:rotate-90">›</span>
                <span className="h-4 w-1 shrink-0 rounded-sm bg-f1" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold text-fg">{w.countryName ?? w.circuitShortName}</span>
                  <span className="ml-2 text-fg-3">
                    {w.circuitShortName} · {fmtDay(w.dateStart)}
                  </span>
                </span>
                <span
                  onClick={(e) => e.preventDefault() /* keep the dropdown state when loading */}
                  className="shrink-0"
                >
                  <Btn variant="primary" disabled={running} onClick={() => void start("/api/ingest/weekend", { source: PROVIDER, year, meetingKey: w.meetingKey })}>
                    Load weekend
                  </Btn>
                </span>
              </summary>
              <div className="border-t border-line px-2 py-1">
                {ss.map((s) => (
                  <div key={s.sessionKey} className="flex items-center justify-between gap-2 py-0.5 pl-5">
                    <span className="truncate text-fg-2">
                      {s.name}
                      <span className="ml-2 text-fg-3">{fmtDay(s.dateStart)}</span>
                    </span>
                    <Btn disabled={running} onClick={() => void start("/api/ingest", { sessionId: `${PROVIDER}:${s.sessionKey}` })}>
                      Load
                    </Btn>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
      {job && (
        <div className="mt-3">
          {job.status !== "failed" && (
            <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-ink-3">
              <div className={`h-full rounded-full transition-all ${job.status === "succeeded" ? "bg-good" : "bg-f1"}`} style={{ width: `${Math.round((job.status === "succeeded" ? 1 : job.progress) * 100)}%` }} />
            </div>
          )}
          <div className="text-[13px] text-fg-2">
            {job.status === "failed" ? <span className="text-bad">Failed: {job.error?.message ?? "unknown error"}</span> : `${job.kind === "ingest_weekend" ? "Weekend" : "Session"} ${job.status} · ${Math.round(job.progress * 100)}%`}
            {job.status === "succeeded" && ` — choose ${job.kind === "ingest_weekend" ? "the sessions" : "it"} in the session picker (private to you).`}
          </div>
        </div>
      )}
      {err && <div className="mt-1 text-[13px] text-bad">{err}</div>}
    </div>
  );
}
