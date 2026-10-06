import { cn } from "@/lib/ui/format";

/**
 * Mark: a search-result "link line" bent into a flight path — the autopilot.
 * Wordmark in Space Grotesk. Colours are fixed (sidebar is always navy) unless `onLight`.
 */
export function Logo({ compact, onLight }: { compact?: boolean; onLight?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden className="shrink-0">
        <rect width="28" height="28" rx="8" fill={onLight ? "#0a1a33" : "#12284a"} />
        <path d="M6 19.5c4.5 0 6-11 11-11h5" stroke="#22d3ee" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <circle cx="22" cy="8.5" r="2.3" fill="#22d3ee" />
        <path d="M6 22h16" stroke="#ffffff" strokeOpacity=".35" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      {!compact && (
        <span
          className={cn(
            "font-[family-name:var(--font-space-grotesk)] text-[16px] font-semibold tracking-[-0.02em]",
            onLight ? "text-ink" : "text-white",
          )}
        >
          SEO Autopilot
        </span>
      )}
      {compact && <span className="sr-only">SEO Autopilot</span>}
    </span>
  );
}
