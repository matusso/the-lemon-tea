import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get } from "./api";
import { useInfo, useMe } from "./data";
import { useUi, type Mode } from "./state/store";
import { Btn, ErrorNote, Loading } from "./components/ui";
import { F1AccountPanel } from "./components/F1Account";

const CommandCenter = lazy(() => import("./modes/CommandCenter"));
const TelemetryLab = lazy(() => import("./modes/TelemetryLab"));
const Performance = lazy(() => import("./modes/Performance"));
const Strategy = lazy(() => import("./modes/Strategy"));
const Research = lazy(() => import("./modes/Research"));

const MODES: { id: Mode; label: string; key: string }[] = [
  { id: "command", label: "Command Center", key: "A" },
  { id: "lab", label: "Telemetry Lab", key: "B" },
  { id: "intel", label: "Performance Intelligence", key: "C" },
  { id: "strategy", label: "Strategy Simulator", key: "D" },
  { id: "research", label: "Research", key: "E" },
];

function Brand() {
  return (
    <div className="flex items-center gap-2 pr-3">
      <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
        <circle cx="16" cy="16" r="10" fill="none" stroke="#e8d44d" strokeWidth="2.5" />
        <path d="M16 6v20M6 16h20M9 9l14 14M23 9 9 23" stroke="#e8d44d" strokeWidth="1.2" opacity=".6" />
      </svg>
      <span className="text-[12px] font-bold tracking-[0.22em] text-fg">THE LEMON TEA</span>
    </div>
  );
}

function SessionPicker() {
  const { year, meetingId, sessionId, set } = useUi();
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: get.seasons });
  const meetings = useQuery({ queryKey: ["meetings", year], queryFn: () => get.meetings(year!), enabled: year !== null });
  const sessions = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: !!meetingId });

  useEffect(() => {
    if (year === null && seasons.data?.length) set({ year: seasons.data[0]!.year });
  }, [seasons.data, year, set]);
  useEffect(() => {
    if (meetings.data && meetings.data.length && !meetings.data.some((m) => m.id === meetingId)) set({ meetingId: meetings.data[0]!.id });
  }, [meetings.data, meetingId, set]);
  useEffect(() => {
    const ingested = sessions.data?.filter((s) => s.ingestStatus !== "not_ingested") ?? [];
    if (sessions.data && !sessions.data.some((s) => s.id === sessionId) && ingested.length) set({ sessionId: ingested[ingested.length - 1]!.id });
  }, [sessions.data, sessionId, set]);

  const sorted = [...(sessions.data ?? [])].sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  return (
    <div className="flex items-center gap-1.5">
      <select value={year ?? ""} onChange={(e) => set({ year: Number(e.target.value), meetingId: null, sessionId: null })}>
        {seasons.data?.map((s) => (
          <option key={s.year} value={s.year}>
            {s.year}
          </option>
        ))}
      </select>
      <select className="max-w-52" value={meetingId ?? ""} onChange={(e) => set({ meetingId: e.target.value, sessionId: null })}>
        {meetings.data?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <select value={sessionId ?? ""} onChange={(e) => set({ sessionId: e.target.value, driverA: null, driverB: null, cursorDistance: null })}>
        {sorted.map((s) => (
          <option key={s.id} value={s.id} disabled={s.ingestStatus === "not_ingested"}>
            {s.name}
            {s.ingestStatus === "not_ingested" ? " (not ingested)" : s.ingestStatus === "partial" ? " (partial)" : ""}
          </option>
        ))}
      </select>
      {seasons.data?.length === 0 && <span className="text-[11px] text-fg-3">No sessions visible — sign in or ingest data.</span>}
    </div>
  );
}

function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!me.data) return null;
  const refresh = () => qc.invalidateQueries();
  if (!me.data.anonymous)
    return (
      <div className="relative flex items-center gap-2">
        <Btn active={open} onClick={() => setOpen(!open)} title="Connect your Formula 1 account to read F1 live timing">
          F1 account
        </Btn>
        {open && <F1AccountPanel onClose={() => setOpen(false)} />}
        <span className="text-[11px] text-fg-2">{me.data.user?.email}</span>
        <Btn
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST" });
            refresh();
          }}
        >
          Sign out
        </Btn>
      </div>
    );
  return (
    <div className="relative">
      <Btn variant="primary" onClick={() => setOpen(!open)}>
        Sign in
      </Btn>
      {open && (
        <form
          className="absolute right-0 top-8 z-50 w-64 rounded-md border border-line-2 bg-ink-2 p-3 shadow-2xl"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await api("/api/auth/login", { method: "POST", body: { email, password } });
              setOpen(false);
              setPassword("");
              refresh();
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          <div className="label mb-1">Email</div>
          <input className="mb-2 w-full" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <div className="label mb-1">Password</div>
          <input className="mb-3 w-full" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {err && <div className="mb-2 text-[11px] text-bad">{err}</div>}
          <button className="h-7 w-full rounded bg-lemon text-[12px] font-semibold text-ink-0" type="submit">
            Sign in
          </button>
        </form>
      )}
    </div>
  );
}

function Footer() {
  const sessionId = useUi((s) => s.sessionId);
  const info = useInfo(sessionId);
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-4 border-t border-line bg-ink-1 px-3 text-[10px] text-fg-3">
      <span className="truncate">{info.data?.attribution ?? "Select a session"}</span>
      <span className="shrink-0">Independent open-source project · not affiliated with or endorsed by Formula 1</span>
    </footer>
  );
}

export function App() {
  const { mode, set, sessionId } = useUi();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.altKey && /^[1-5]$/.test(e.key)) set({ mode: MODES[Number(e.key) - 1]!.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);
  const info = useInfo(sessionId);
  const [visitedCommand, setVisitedCommand] = useState(mode === "command");
  useEffect(() => {
    if (mode === "command") setVisitedCommand(true);
  }, [mode]);

  return (
    <div className="grid-bg flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-ink-1 px-3">
        <Brand />
        <nav className="flex items-center gap-0.5 overflow-x-auto">
          {MODES.map((m, i) => (
            <button
              key={m.id}
              title={`Alt+${i + 1}`}
              onClick={() => set({ mode: m.id })}
              className={`h-11 whitespace-nowrap border-b-2 px-3 text-[11px] font-medium tracking-wide transition-colors ${mode === m.id ? "border-lemon text-fg" : "border-transparent text-fg-3 hover:text-fg-2"}`}
            >
              <span className="mr-1.5 text-fg-3">{m.key}</span>
              {m.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <SessionPicker />
          <Account />
        </div>
      </header>
      <main className="min-h-0 flex-1">
        {info.isError && <ErrorNote error={info.error} />}
        <Suspense fallback={<Loading />}>
          {/* Kept mounted once visited: the WebGL canvas and replay cache survive mode switches,
              and its render loop is paused while hidden. */}
          {(mode === "command" || visitedCommand) && (
            <div className={mode === "command" ? "h-full" : "hidden"}>
              <CommandCenter active={mode === "command"} />
            </div>
          )}
          {mode === "lab" && <TelemetryLab />}
          {mode === "intel" && <Performance />}
          {mode === "strategy" && <Strategy />}
          {mode === "research" && <Research />}
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
