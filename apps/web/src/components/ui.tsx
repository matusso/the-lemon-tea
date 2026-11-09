import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";

export function Frame({ title, right, children, className = "", hero = false }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; hero?: boolean }) {
  return (
    <section className={`card ${hero ? "card-hero" : ""} flex h-full min-h-0 flex-col ${className}`}>
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="h-4 w-[5px] shrink-0 -skew-x-[20deg] bg-f1" />
          <div className="display flex min-w-0 items-center gap-2 truncate text-[13px] tracking-[0.04em] text-fg">{title}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{right}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export type Kind = "measured" | "calculated" | "estimated" | "simulated" | "unavailable";

const KIND_STYLE: Record<Kind, string> = {
  measured: "border-teal/50 text-teal",
  calculated: "border-fg-3/50 text-fg-2",
  estimated: "border-lemon/50 text-lemon",
  simulated: "border-purple/60 text-purple",
  unavailable: "border-line-2 text-fg-3",
};

/** Where a number comes from. Kept outlined so it never competes with the red chrome. */
export function KindBadge({ kind, title }: { kind: Kind; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex h-[17px] items-center rounded-[3px] border px-1.5 font-sans text-[10px] font-bold uppercase tracking-[0.12em] [font-stretch:100%] ${KIND_STYLE[kind]}`}
    >
      {kind}
    </span>
  );
}

export function Btn({
  children,
  onClick,
  active,
  disabled,
  title,
  variant = "ghost",
  size = "md",
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  variant?: "ghost" | "primary";
  size?: "sm" | "md" | "lg";
}) {
  const h = size === "sm" ? "h-6 px-2 text-[12px]" : size === "lg" ? "h-10 px-5 text-[14px]" : "h-7 px-2.5 text-[13px]";
  const base = `inline-flex ${h} items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40`;
  const style =
    variant === "primary"
      ? "display !text-[13px] tracking-[0.06em] bg-f1 text-white hover:bg-f1-hi"
      : active
        ? "border border-f1 bg-f1 text-white"
        : "border border-line-2 bg-transparent text-fg-2 hover:border-fg-3 hover:text-fg";
  return (
    <button type="button" title={title} disabled={disabled} aria-pressed={variant === "ghost" && active !== undefined ? active : undefined} onClick={onClick} className={`${base} ${style}`}>
      {children}
    </button>
  );
}

/** Popover listing on/off options: which columns, panels or inputs to include. */
export function Chooser<K extends string>({
  label,
  options,
  value,
  onChange,
  align = "right",
}: {
  label: ReactNode;
  options: { id: K; label: string; hint?: string }[];
  value: K[];
  onChange: (v: K[]) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => (window.removeEventListener("mousedown", onDown), window.removeEventListener("keydown", onKey));
  }, [open]);
  const on = new Set(value);
  const toggle = (id: K) => onChange(options.filter((o) => (o.id === id ? !on.has(id) : on.has(o.id))).map((o) => o.id));
  return (
    <div ref={root} className="relative">
      <Btn active={open} onClick={() => setOpen(!open)} title="Choose what to show">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M1 3h10M3 6h6M5 9h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {label}
        <span className="num text-[11px] opacity-70">
          {value.length}/{options.length}
        </span>
      </Btn>
      {open && (
        <div className={`absolute top-[calc(100%+6px)] z-[70] w-64 rounded-lg border border-line-2 bg-ink-2 p-1.5 shadow-2xl shadow-black/70 ${align === "right" ? "right-0" : "left-0"}`}>
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <span className="label">Show</span>
            <span className="flex gap-2 text-[12px]">
              <button className="text-fg-3 hover:text-fg" onClick={() => onChange(options.map((o) => o.id))}>
                All
              </button>
              <button className="text-fg-3 hover:text-fg" onClick={() => onChange([])}>
                None
              </button>
            </span>
          </div>
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[14px] hover:bg-ink-3">
              <input type="checkbox" checked={on.has(o.id)} onChange={() => toggle(o.id)} />
              <span className="flex-1">{o.label}</span>
              {o.hint && <span className="text-[12px] text-fg-3">{o.hint}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Persisted list of chosen ids (per-browser convenience; falls back to the default). */
export function useChoice<K extends string>(key: string, all: readonly K[], initial: readonly K[] = all): [K[], (v: K[]) => void] {
  const [v, setV] = useState<K[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "null");
      if (Array.isArray(raw)) return all.filter((k) => raw.includes(k));
    } catch {
      // storage unavailable: use the default
    }
    return [...initial];
  });
  const set = (n: K[]) => {
    setV(n);
    try {
      localStorage.setItem(key, JSON.stringify(n));
    } catch {
      // ignore
    }
  };
  return [v, set];
}

/** Number field with − / + buttons; arrow keys step, Shift steps ×10. */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  digits = 0,
  suffix,
  width = 64,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  digits?: number;
  suffix?: string;
  width?: number;
  ariaLabel: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Number(v.toFixed(Math.max(digits, 4)))));
  const [text, setText] = useState(value.toFixed(digits));
  useEffect(() => setText(value.toFixed(digits)), [value, digits]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n)) onChange(clamp(n));
    else setText(value.toFixed(digits));
  };
  const b = "flex h-7 w-6 items-center justify-center text-fg-3 hover:bg-ink-3 hover:text-fg disabled:opacity-30";
  return (
    <span className="inline-flex items-center overflow-hidden rounded-[5px] border border-line-2 bg-ink-0">
      <button type="button" className={b} aria-label={`Decrease ${ariaLabel}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      <input
        aria-label={ariaLabel}
        className="num h-7 !rounded-none !border-0 !border-x !border-line-2 !bg-transparent !px-1 text-center !text-[13px] !shadow-none"
        style={{ width }}
        inputMode="decimal"
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            onChange(clamp(value + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
          }
        }}
      />
      {suffix && <span className="px-1.5 text-[12px] text-fg-3">{suffix}</span>}
      <button type="button" className={b} aria-label={`Increase ${ariaLabel}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
        +
      </button>
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-24 items-center justify-center p-4 text-center text-[15px] text-fg-3">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof ApiError ? `${error.message}${error.status === 401 || error.status === 404 ? " — sign in if this data is private." : ""}` : String((error as Error)?.message ?? error);
  return <div className="m-3 rounded border border-bad/40 bg-bad/10 p-2 text-[15px] text-bad">{msg}</div>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <Empty>{what}…</Empty>;
}

export const dash = "—";

export function fmtLap(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return dash;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m ? `${m}:${r.toFixed(3).padStart(6, "0")}` : r.toFixed(3);
}

export function fmtNum(v: number | null | undefined, digits = 3, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  const s = v.toFixed(digits);
  return signed && v > 0 ? `+${s}` : s;
}

export function fmtPct(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return dash;
  return `${(p * 100).toFixed(p < 0.1 && p > 0 ? 1 : 0)}%`;
}

export function ProbBar({ p, color = "#e10600" }: { p: number; color?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-14 overflow-hidden bg-ink-3">
        <div className="h-full" style={{ width: `${Math.min(100, p * 100)}%`, background: color }} />
      </div>
      <span className="num w-10 text-right text-[14px] text-fg-2">{fmtPct(p)}</span>
    </div>
  );
}

export const COMPOUND_COLOR: Record<string, string> = {
  SOFT: "#ff4d4d",
  MEDIUM: "#ffd23f",
  HARD: "#e8e8e8",
  INTERMEDIATE: "#43c46b",
  WET: "#3b8cff",
};

export function Tyre({ compound, age }: { compound: string | null; age?: number | null }) {
  if (!compound) return <span className="text-fg-3">{dash}</span>;
  const c = COMPOUND_COLOR[compound] ?? "#888";
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border-[2.5px] bg-ink-0 text-[10px] font-black" style={{ borderColor: c, color: c, boxShadow: `0 0 6px ${c}55` }}>
        {compound[0]}
      </span>
      {age !== undefined && <span className="num text-[14px] text-fg-2">{age ?? dash}</span>}
    </span>
  );
}

export function teamColor(hex: string | undefined | null): string {
  return hex ? `#${hex}` : "#888888";
}
