import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

export interface ComboOption<V extends string | number> {
  value: V;
  label: string;
  /** Secondary text, right-aligned in the list (date, lap time…). */
  hint?: string;
  /** Section heading the option is listed under, in first-seen order. */
  group?: string;
  /** Small status element after the label (e.g. a LIVE pill). */
  badge?: ReactNode;
  /** Colour swatch before the label (team colour, compound…). */
  color?: string;
  disabled?: boolean;
  /** Why it is disabled, shown on hover. */
  disabledReason?: string;
  /** Extra text that search should match (e.g. country, driver number). */
  keywords?: string;
}

/** Case-insensitive match where every query word must appear somewhere in the option's text. */
function matches(o: ComboOption<string | number>, q: string): boolean {
  if (!q) return true;
  const hay = `${o.label} ${o.hint ?? ""} ${o.group ?? ""} ${o.keywords ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function Highlight({ text, q }: { text: string; q: string }) {
  const w = q.trim().split(/\s+/).filter(Boolean)[0];
  if (!w) return <>{text}</>;
  const i = text.toLowerCase().indexOf(w.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-f1/30 text-fg">{text.slice(i, i + w.length)}</mark>
      {text.slice(i + w.length)}
    </>
  );
}

/**
 * Searchable single-select. Opens on click, Enter, Space or ↓, or as soon as the user starts typing
 * while it is focused; arrow keys move, Enter picks, Esc closes. Options can be grouped, carry a
 * hint, a colour swatch and a status badge, and be disabled with a reason.
 */
export function Combobox<V extends string | number>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  ariaLabel,
  className = "",
  minWidth = 120,
  maxListWidth = 380,
  disabled = false,
  loading = false,
  emptyText = "No matches",
}: {
  value: V | null;
  options: ComboOption<V>[];
  onChange: (v: V) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  minWidth?: number;
  maxListWidth?: number;
  disabled?: boolean;
  loading?: boolean;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => options.filter((o) => matches(o as ComboOption<string | number>, query)), [options, query]);
  const enabledIdx = useMemo(() => filtered.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [filtered]);

  const show = (q = "") => {
    if (disabled) return;
    setQuery(q);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = (o: ComboOption<V> | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };

  // highlight the current value when opening, else the first match
  useEffect(() => {
    if (!open) return;
    const cur = filtered.findIndex((o) => o.value === value && !o.disabled);
    setActive(query ? (enabledIdx[0] ?? 0) : cur >= 0 ? cur : (enabledIdx[0] ?? 0));
  }, [open, query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    list.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const move = (dir: 1 | -1) => {
    if (!enabledIdx.length) return;
    const pos = enabledIdx.indexOf(active);
    const next = pos < 0 ? enabledIdx[0]! : enabledIdx[(pos + dir + enabledIdx.length) % enabledIdx.length]!;
    setActive(next);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        show(e.key);
      }
      return;
    }
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Home") (e.preventDefault(), setActive(enabledIdx[0] ?? 0));
    else if (e.key === "End") (e.preventDefault(), setActive(enabledIdx[enabledIdx.length - 1] ?? 0));
    else if (e.key === "Enter") (e.preventDefault(), pick(filtered[active]));
    else if (e.key === "Escape") (e.preventDefault(), close());
    else if (e.key === "Tab") close();
  };

  let lastGroup: string | undefined;
  return (
    <div ref={root} className={`relative ${className}`} style={{ minWidth }} onKeyDown={onKey}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        className={`group flex h-8 w-full items-center gap-2 rounded-md border bg-ink-0/80 px-2.5 text-left text-[14px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? "border-f1 ring-2 ring-f1/25" : "border-line-2 hover:border-fg-3"
        }`}
      >
        {selected?.color && <span className="h-3 w-1 shrink-0 rounded-sm" style={{ background: selected.color }} />}
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-fg" : "text-fg-3"}`}>{selected?.label ?? (loading ? "Loading…" : placeholder)}</span>
        {selected?.badge}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`shrink-0 text-fg-3 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute left-0 top-[calc(100%+4px)] z-[60] overflow-hidden rounded-lg border border-line-2 bg-ink-2/95 shadow-2xl shadow-black/60 backdrop-blur"
          style={{ minWidth: "100%", width: "max-content", maxWidth: maxListWidth }}
        >
          <div className="flex items-center gap-2 border-b border-line px-2.5">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="shrink-0 text-fg-3">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              ref={input}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to filter…"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
              className="h-9 w-full min-w-[160px] !border-0 !bg-transparent !px-0 text-[14px] !outline-none"
            />
            {query && (
              <button type="button" className="text-[13px] text-fg-3 hover:text-fg" onClick={() => (setQuery(""), input.current?.focus())} aria-label="Clear filter">
                ✕
              </button>
            )}
          </div>
          <ul ref={list} id={listId} role="listbox" aria-label={ariaLabel} className="max-h-80 overflow-y-auto py-1">
            {filtered.length === 0 && <li className="px-3 py-2 text-[14px] text-fg-3">{loading ? "Loading…" : emptyText}</li>}
            {filtered.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              const isSel = o.value === value;
              return (
                <li key={String(o.value)} role="presentation">
                  {head && <div className="px-3 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-fg-3">{head}</div>}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    data-idx={i}
                    aria-selected={isSel}
                    aria-disabled={o.disabled || undefined}
                    title={o.disabled ? o.disabledReason : undefined}
                    onMouseEnter={() => !o.disabled && setActive(i)}
                    onMouseDown={(e) => e.preventDefault() /* keep focus in the filter */}
                    onClick={() => pick(o)}
                    className={`mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[14px] ${
                      o.disabled ? "cursor-not-allowed text-fg-3/70" : i === active ? "bg-f1/15 text-fg" : "text-fg-2"
                    }`}
                  >
                    <span className={`w-3 shrink-0 text-[12px] ${isSel ? "text-f1" : "text-transparent"}`}>✓</span>
                    {o.color && <span className="h-3.5 w-1 shrink-0 rounded-sm" style={{ background: o.color }} />}
                    <span className="min-w-0 flex-1 truncate">
                      <Highlight text={o.label} q={query} />
                    </span>
                    {o.badge}
                    {o.hint && <span className="num shrink-0 pl-2 text-[13px] text-fg-3">{o.hint}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Small status pill for option badges. */
export function Pill({ tone, children }: { tone: "live" | "muted" | "warn" | "good"; children: ReactNode }) {
  const cls = {
    live: "border-f1/60 bg-f1/20 text-f1-hi",
    muted: "border-line-2 text-fg-3",
    warn: "border-lemon/50 text-lemon",
    good: "border-good/50 text-good",
  }[tone];
  return (
    <span className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-bold uppercase tracking-wider ${cls}`}>
      {tone === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-f1-hi" />}
      {children}
    </span>
  );
}
