import type { ReactNode } from "react";
import { ApiError } from "../api";

export function Frame({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card flex h-full min-h-0 flex-col ${className}`}>
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line bg-gradient-to-r from-ink-3/70 via-ink-2/40 to-transparent px-3">
        <div className="label flex items-center gap-2 !text-fg">
          <span aria-hidden className="h-3.5 w-1 -skew-x-12 rounded-[1px] bg-f1 shadow-[0_0_8px_rgba(225,6,0,0.8)]" />
          {title}
        </div>
        <div className="flex items-center gap-2">{right}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export type Kind = "measured" | "calculated" | "estimated" | "simulated" | "unavailable";

const KIND_STYLE: Record<Kind, string> = {
  measured: "border-teal/40 bg-teal/10 text-teal",
  calculated: "border-fg-3/40 bg-fg-3/10 text-fg-2",
  estimated: "border-lemon/40 bg-lemon/10 text-lemon",
  simulated: "border-purple/40 bg-purple/10 text-purple",
  unavailable: "border-line-2 bg-ink-3/40 text-fg-3",
};

export function KindBadge({ kind, title }: { kind: Kind; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[11px] font-bold uppercase tracking-wider ${KIND_STYLE[kind]}`}>
      {kind}
    </span>
  );
}

export function Btn({ children, onClick, active, disabled, title, variant = "ghost" }: { children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean; title?: string; variant?: "ghost" | "primary" }) {
  const base = "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2.5 text-[14px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed";
  const style =
    variant === "primary"
      ? "bg-gradient-to-b from-f1-hi to-f1 text-white shadow-[0_4px_14px_-4px_rgba(225,6,0,0.8)] hover:brightness-110"
      : active
        ? "border border-f1/70 bg-f1/20 text-fg shadow-[0_0_12px_-2px_rgba(225,6,0,0.6)]"
        : "border border-line-2 bg-ink-2/60 text-fg-2 hover:border-fg-3 hover:bg-ink-3 hover:text-fg";
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className={`${base} ${style}`}>
      {children}
    </button>
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

export function ProbBar({ p, color = "#e8d44d" }: { p: number; color?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-ink-3">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, p * 100)}%`, background: color }} />
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
