import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, type SessionRow } from "./api";
import { useInfo, useMe } from "./data";
import { useUi, type Mode } from "./state/store";
import { Btn, ErrorNote, Loading } from "./components/ui";
import { F1AccountPanel } from "./components/F1Account";
import { Combobox, Pill, type ComboOption } from "./components/Combobox";
import { isLiveWindow } from "./state/live";

const CommandCenter = lazy(() => import("./modes/CommandCenter"));
const TelemetryLab = lazy(() => import("./modes/TelemetryLab"));
const Performance = lazy(() => import("./modes/Performance"));
const Strategy = lazy(() => import("./modes/Strategy"));
const Research = lazy(() => import("./modes/Research"));

const MODES: { id: Mode; label: string; short: string; key: string }[] = [
  { id: "command", label: "Command Center", short: "Command", key: "A" },
  { id: "lab", label: "Telemetry Lab", short: "Telemetry", key: "B" },
  { id: "intel", label: "Performance Intelligence", short: "Performance", key: "C" },
  { id: "strategy", label: "Strategy Simulator", short: "Strategy", key: "D" },
  { id: "research", label: "Research", short: "Research", key: "E" },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5 pr-4">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="drop-shadow-[0_0_6px_rgba(255,209,46,0.45)]">
        <circle cx="16" cy="16" r="12" fill="#ffd12e" />
        <circle cx="16" cy="16" r="9.5" fill="#0b0c12" />
        <path d="M16 7.5v17M7.5 16h17M10 10l12 12M22 10 10 22" stroke="#ffd12e" strokeWidth="1.4" opacity=".85" />
        <circle cx="16" cy="16" r="2.2" fill="#e10600" />
      </svg>
      <span className="display whitespace-nowrap text-[18px] leading-none tracking-[0.06em] text-fg">
        Lemon<span className="text-f1">Tea</span>
      </span>
    </div>
  );
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function SessionPicker() {
  const { year, meetingId, sessionId, set } = useUi();
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: get.seasons });
  const meetings = useQuery({ queryKey: ["meetings", year], queryFn: () => get.meetings(year!), enabled: year !== null });
  const sessions = useQuery({ queryKey: ["sessions", meetingId], queryFn: () => get.sessions(meetingId!, false), enabled: !!meetingId, refetchInterval: 60_000 });
  const selectable = (s: SessionRow) => s.ingestStatus !== "not_ingested" || isLiveWindow(s);

  useEffect(() => {
    if (year === null && seasons.data?.length) set({ year: seasons.data[0]!.year });
  }, [seasons.data, year, set]);
  useEffect(() => {
    if (meetings.data && meetings.data.length && !meetings.data.some((m) => m.id === meetingId)) {
      // default to the latest weekend that has started
      const started = meetings.data.filter((m) => Date.parse(m.dateStart) <= Date.now()).sort((a, b) => b.dateStart.localeCompare(a.dateStart));
      set({ meetingId: (started[0] ?? meetings.data[0]!).id });
    }
  }, [meetings.data, meetingId, set]);
  useEffect(() => {
    if (!sessions.data || sessions.data.some((s) => s.id === sessionId)) return;
    const live = sessions.data.find((s) => isLiveWindow(s));
    const ingested = sessions.data.filter((s) => s.ingestStatus !== "not_ingested").sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    const pick = live ?? ingested[ingested.length - 1];
    if (pick) set({ sessionId: pick.id });
  }, [sessions.data, sessionId, set]);

  const yearOptions = useMemo<ComboOption<number>[]>(
    () => (seasons.data ?? []).map((s) => ({ value: s.year, label: String(s.year), hint: `${s.ingested}/${s.sessions} loaded` })),
    [seasons.data],
  );
  const meetingOptions = useMemo<ComboOption<string>[]>(() => {
    const now = Date.now();
    return (meetings.data ?? []).map((m) => {
      const started = Date.parse(m.dateStart) <= now;
      return { value: m.id, label: m.name, hint: fmtDay(m.dateStart), group: started ? "Started" : "Upcoming", keywords: m.circuitShortName };
    });
  }, [meetings.data]);
  const sessionOptions = useMemo<ComboOption<string>[]>(
    () =>
      [...(sessions.data ?? [])]
        .sort((a, b) => a.dateStart.localeCompare(b.dateStart))
        .map((s) => {
          const live = isLiveWindow(s);
          return {
            value: s.id,
            label: s.name,
            hint: fmtWhen(s.dateStart),
            keywords: s.type,
            disabled: !selectable(s),
            disabledReason: Date.parse(s.dateStart) > Date.now() ? "Not started yet" : "Not loaded: load it from your user menu › Settings › Formula 1 account",
            badge: live ? <Pill tone="live">Live</Pill> : s.ingestStatus === "not_ingested" ? <Pill tone="muted">{Date.parse(s.dateStart) > Date.now() ? "Soon" : "Not loaded"}</Pill> : s.ingestStatus === "partial" ? <Pill tone="warn">Partial</Pill> : undefined,
          };
        }),
    [sessions.data], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div className="flex items-center gap-1.5">
      <Combobox ariaLabel="Season" value={year} options={yearOptions} loading={seasons.isLoading} minWidth={92} onChange={(v) => set({ year: v, meetingId: null, sessionId: null })} />
      <Combobox ariaLabel="Race weekend" value={meetingId} options={meetingOptions} loading={meetings.isLoading} minWidth={180} className="max-w-60" placeholder="Weekend…" onChange={(v) => set({ meetingId: v, sessionId: null })} />
      <Combobox
        ariaLabel="Session"
        value={sessionId}
        options={sessionOptions}
        loading={sessions.isLoading}
        minWidth={150}
        placeholder="Session…"
        onChange={(v) => set({ sessionId: v, driverA: null, driverB: null, cursorDistance: null })}
      />
      {seasons.data?.length === 0 && <span className="hidden text-[14px] text-fg-3 2xl:inline">No sessions visible — sign in or ingest data.</span>}
    </div>
  );
}

function SettingsDialog({ email, role, onClose }: { email: string; role: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/60 p-6 pt-20 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Settings" className="max-h-[85vh] w-[560px] max-w-full overflow-y-auto rounded-xl border border-line-2 bg-ink-1 shadow-2xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-[17px] font-semibold">Settings</span>
          <button className="text-fg-3 hover:text-fg" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>
        <section className="border-b border-line px-5 py-4">
          <div className="label mb-2">Profile</div>
          <div className="text-[15px] text-fg">{email}</div>
          <div className="text-[14px] text-fg-3">Role: {role}</div>
        </section>
        <section className="px-5 py-4">
          <div className="label mb-2">Connected accounts</div>
          <F1AccountPanel />
        </section>
      </div>
    </div>
  );
}

function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  if (!me.data) return null;
  const refresh = () => qc.invalidateQueries();
  if (!me.data.anonymous) {
    const userEmail = me.data.user?.email ?? "";
    return (
      <div ref={menu} className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`flex h-8 items-center gap-2 rounded-full border pl-1 pr-2.5 transition-colors ${open ? "border-f1 bg-f1/10" : "border-line-2 hover:border-fg-3"}`}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-f1 text-[13px] font-bold uppercase text-white">{userEmail.slice(0, 1) || "?"}</span>
          <span className="max-w-40 truncate text-[14px] text-fg-2">{userEmail}</span>
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden className="text-fg-3">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        {open && (
          <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-[70] w-60 overflow-hidden rounded-lg border border-line-2 bg-ink-2 py-1 shadow-2xl">
            <div className="border-b border-line px-3 py-2">
              <div className="truncate text-[14px] text-fg">{userEmail}</div>
              <div className="text-[13px] text-fg-3">{me.data.user?.role}</div>
            </div>
            <button role="menuitem" className="block w-full px-3 py-2 text-left text-[14px] text-fg-2 hover:bg-ink-3 hover:text-fg" onClick={() => (setOpen(false), setSettings(true))}>
              Settings
              <span className="block text-[13px] text-fg-3">Profile · Formula 1 account</span>
            </button>
            <button
              role="menuitem"
              className="block w-full border-t border-line px-3 py-2 text-left text-[14px] text-fg-2 hover:bg-ink-3 hover:text-bad"
              onClick={async () => {
                setOpen(false);
                await api("/api/auth/logout", { method: "POST" });
                refresh();
              }}
            >
              Sign out
            </button>
          </div>
        )}
        {settings && <SettingsDialog email={userEmail} role={me.data.user?.role ?? ""} onClose={() => setSettings(false)} />}
      </div>
    );
  }
  return (
    <div ref={menu} className="relative">
      <Btn variant="primary" onClick={() => setOpen(!open)}>
        Sign in
      </Btn>
      {open && (
        <form
          className="absolute right-0 top-9 z-50 w-72 rounded-lg border border-line-2 bg-ink-2 p-3 shadow-2xl"
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
          {err && <div className="mb-2 text-[14px] text-bad">{err}</div>}
          <button className="h-9 w-full rounded bg-f1 text-[15px] font-semibold text-white hover:bg-f1-hi" type="submit">
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
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-line bg-ink-1/80 px-3 text-[12px] text-fg-3 backdrop-blur">
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
      <header className="shrink-0 bg-ink-1/80 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-3">
          <Brand />
          <nav className="flex items-center gap-1 overflow-x-auto rounded-xl border border-line bg-ink-0/60 p-1">
            {MODES.map((m, i) => (
              <button
                key={m.id}
                title={`${m.label} (Alt+${i + 1})`}
                onClick={() => set({ mode: m.id })}
                className={`h-9 whitespace-nowrap rounded-lg px-3 text-[14px] font-semibold tracking-wide transition-all ${mode === m.id ? "-skew-x-6 bg-gradient-to-b from-f1-hi to-f1 text-white shadow-[0_4px_16px_-4px_rgba(225,6,0,0.9)]" : "text-fg-3 hover:bg-ink-3 hover:text-fg"}`}
              >
                <span className={`inline-block ${mode === m.id ? "skew-x-6" : ""}`}>
                  <span className={`mr-1.5 text-[12px] font-bold ${mode === m.id ? "text-white/70" : "text-fg-3"}`}>{m.key}</span>
                  <span className="hidden 2xl:inline">{m.label}</span>
                  <span className="2xl:hidden">{m.short}</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SessionPicker />
            <Account />
          </div>
        </div>
        <div className="stripe" />
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
