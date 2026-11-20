/**
 * Shared building blocks for the dark theme (tokens live in index.css). The library, the scene
 * panel, the assistant and the Providers page all use these so they read as one app.
 */
import { useState, type ComponentProps, type InputHTMLAttributes, type ReactNode } from "react";

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-accent to-[#3a5fd6] shadow-[0_4px_14px_rgba(79,140,255,0.35)]"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* Two converging paths meeting at an impact point. */}
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 20 20" fill="none">
        <path d="M3 16 L10 9" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M17 16 L10 9" stroke="white" strokeOpacity="0.7" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="10" cy="7" r="2.6" fill="#ff5a5a" stroke="white" strokeWidth="1.2" />
      </svg>
    </div>
  );
}

export function Section({ title, action, children, flush = false }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={flush ? "mb-5" : "mb-3 rounded-xl border border-line bg-raised/60 p-3"}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

type Variant = "primary" | "soft" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-strong text-white hover:bg-accent",
  soft: "bg-accent-soft text-accent hover:bg-accent/20",
  ghost: "text-ink-2 hover:bg-white/8 hover:text-ink",
  danger: "bg-crash-soft text-crash hover:bg-crash/20",
};

export function Button({
  variant = "soft",
  size = "sm",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        size === "md" ? "px-4 py-2 text-sm" : "px-2.5 py-1.5 text-xs"
      } ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function IconButton({
  label,
  active = false,
  onClick,
  children,
  size = 28,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  size?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-lg transition-colors ${
        active ? "bg-accent-strong text-white" : "text-ink-2 hover:bg-white/8 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** A switch row: icon, label, on/off. */
export function Toggle({
  icon,
  label,
  checked,
  disabled = false,
  onChange,
  hint,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <label
      title={hint}
      className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${disabled ? "text-ink-3" : "cursor-pointer text-ink hover:bg-white/5"}`}
    >
      <span className={disabled ? "text-ink-3" : "text-ink-2"}>{icon}</span>
      <span className="flex-1">{label}</span>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span
        aria-hidden
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
          checked ? "bg-accent-strong" : "bg-white/15"
        }`}
      >
        <span className={`absolute top-[3px] h-3 w-3 rounded-full bg-white transition-[left] ${checked ? "left-[17px]" : "left-[3px]"}`} />
      </span>
    </label>
  );
}

/**
 * A number input that keeps what you're typing (including "-" or an empty box) and only
 * applies it on Enter or when you leave the field. `live` applies every valid keystroke.
 */
export function NumberField({
  label,
  value,
  step,
  min,
  live = false,
  onCommit,
}: {
  label: string;
  value: number;
  step: string;
  min?: string;
  live?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(parsed)) onCommit(parsed);
    setDraft(null);
  };
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] font-medium text-ink-3">
      {label}
      <input
        type="number"
        inputMode="decimal"
        value={draft ?? fmt(value)}
        step={step}
        min={min}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = Number(event.target.value);
          if (live && event.target.value.trim() !== "" && Number.isFinite(parsed)) onCommit(parsed);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
        className="w-full rounded-lg border border-line bg-sunken px-2 py-1.5 text-sm text-ink tabular-nums outline-none focus:border-accent"
      />
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`min-w-0 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-accent ${props.className ?? ""}`}
    />
  );
}

/** Segmented tabs. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-0.5 rounded-xl border border-line bg-sunken p-0.5">
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 py-1.5 text-xs font-medium transition-colors ${
              selected ? "bg-raised text-ink shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {tab.icon}
            <span className="truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-white/5 px-1 py-px font-sans text-[10px] text-ink-2">{children}</kbd>;
}

/** Remembered UI choice (a tab, a collapsed section). Storage can be unavailable; never throw. */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: the choice just isn't remembered.
  }
}
