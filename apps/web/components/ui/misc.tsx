import { cn } from "@/lib/ui/format";
import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon && (
        <div className="mb-4 grid size-12 place-items-center rounded-full bg-sunken text-muted ring-1 ring-line">
          <Icon size={22} aria-hidden />
        </div>
      )}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1.5 max-w-[46ch] text-sm text-muted">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "ok" | "approve" | "bad" | "neutral" | "auto";
  className?: string;
}) {
  const color =
    tone === "ok"
      ? "text-ok-ink"
      : tone === "approve"
        ? "text-approve-ink"
        : tone === "bad"
          ? "text-bad-ink"
          : tone === "auto"
            ? "text-auto-ink"
            : "text-ink";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[13px] text-muted">{label}</div>
      <div className={cn("num mt-0.5 text-[28px] leading-none font-semibold", color)}>{value}</div>
      {hint && <div className="mt-1.5 text-[12px] text-muted">{hint}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  optional,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
  optional?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
        {optional && <span className="ml-1.5 font-normal text-muted">optional</span>}
      </label>
      {children}
      {hint && !error && <p className="text-[12px] leading-relaxed text-muted">{hint}</p>}
      {error && (
        <p className="text-[12px] font-medium text-bad-ink" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const inputClass =
  "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[14px] text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:bg-sunken disabled:text-muted aria-invalid:border-bad";

export const textareaClass =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink leading-relaxed placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 aria-invalid:border-bad";

export const selectClass =
  "h-10 w-full appearance-none rounded-lg border border-line-strong bg-surface bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9 pl-3 text-[14px] text-ink focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 " +
  "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%235b6b84' stroke-width='2' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]";

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-accent" : "bg-line-strong",
        )}
      >
        <span className="sr-only">{checked ? "On" : "Off"}</span>
        <span
          className={cn(
            "inline-block size-5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5.5" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</kbd>
  );
}

export function Dot({ tone }: { tone: "ok" | "bad" | "never" | "approve" | "auto" }) {
  const c = {
    ok: "bg-ok",
    bad: "bg-bad",
    never: "bg-never",
    approve: "bg-approve",
    auto: "bg-auto",
  }[tone];
  return (
    <span className="relative inline-flex size-2.5" aria-hidden>
      {tone === "ok" && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-40", c)} />}
      <span className={cn("relative inline-flex size-2.5 rounded-full", c)} />
    </span>
  );
}
