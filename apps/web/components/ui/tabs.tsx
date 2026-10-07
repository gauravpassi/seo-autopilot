"use client";

import Link from "next/link";
import { useRef } from "react";
import { cn } from "@/lib/ui/format";

export type TabItem = { id: string; label: string; count?: number | null };

/**
 * URL-driven tabs (?tab=) so each tab is linkable and server-rendered.
 * Arrow keys move between tabs per the WAI-ARIA tabs pattern.
 */
export type LinkTabItem = TabItem & { href: string };

/** Hrefs are passed as data (not a function) so Server Components can render this. */
export function LinkTabs({ items, active, label }: { items: LinkTabItem[]; active: string; label: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        className="flex min-w-max gap-1 border-b border-line"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          const tabs = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("[role=tab]") ?? []);
          const i = tabs.findIndex((t) => t === document.activeElement);
          const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          next?.focus();
          e.preventDefault();
        }}
      >
        {items.map((t) => {
          const on = t.id === active;
          return (
            <Link
              key={t.id}
              href={t.href}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              scroll={false}
              className={cn(
                "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-[14px] font-medium transition-colors",
                on ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink",
              )}
            >
              {t.label}
              {t.count ? (
                <span className="num rounded-full bg-sunken px-1.5 text-[11px] leading-[18px] text-ink-2">{t.count}</span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Local state tabs for client components. */
export function Tabs({
  items,
  active,
  onChange,
  label,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg bg-sunken p-1">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          onClick={() => onChange(t.id)}
          className={cn(
            "h-8 rounded-md px-3 text-[13px] font-medium transition-colors",
            t.id === active ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count ? <span className="num ml-1.5 text-[11px] text-muted">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
