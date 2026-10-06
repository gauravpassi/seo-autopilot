import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import type { RunnerStatus } from "@/lib/types";
import { cn } from "@/lib/ui/format";

const PARTS: Array<{ key: keyof RunnerStatus; label: string }> = [
  { key: "claude", label: "Claude Code" },
  { key: "claude_seo", label: "claude-seo" },
  { key: "python", label: "Python" },
];

export function RunnerHealth({ status, compact }: { status: RunnerStatus | Record<string, never> | null; compact?: boolean }) {
  const s = (status ?? {}) as RunnerStatus;
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1.5", compact ? "text-[12.5px]" : "text-[13px]")}>
      {PARTS.map((p) => {
        const v = s[p.key] as { ok?: boolean; version?: string; auth?: string | boolean } | undefined;
        const Icon = !v ? CircleHelp : v.ok ? CircleCheck : CircleAlert;
        return (
          <li key={p.key} className="inline-flex items-center gap-1.5">
            <Icon size={14} aria-hidden className={!v ? "text-muted" : v.ok ? "text-ok" : "text-bad"} />
            <span className="text-ink-2">{p.label}</span>
            <span className="text-muted">
              {!v ? "unknown" : v.ok ? (v.version ? v.version.replace(/^v?/, "v") : "ok") : "not working"}
              {p.key === "claude" && v && v.auth === false && " · not signed in"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
