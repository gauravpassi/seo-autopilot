import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock,
  Hand,
  LoaderCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/ui/format";
import { CHANGE_STATUS, JOB_STATUS, TIER, changeStatus, type Tone } from "@/lib/ui/labels";
import type { Tier } from "@seo-autopilot/core/schema";

const tones: Record<Tone, string> = {
  auto: "bg-auto-soft text-auto-ink ring-auto/30",
  approve: "bg-approve-soft text-approve-ink ring-approve/35",
  never: "bg-never-soft text-never-ink ring-never/30",
  ok: "bg-ok-soft text-ok-ink ring-ok/30",
  bad: "bg-bad-soft text-bad-ink ring-bad/30",
  info: "bg-accent-soft text-accent-ink ring-accent/25",
  neutral: "bg-sunken text-ink-2 ring-line-strong/60",
};

export function Badge({
  tone = "neutral",
  icon: Icon,
  children,
  className,
  title,
  spin,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
  title?: string;
  spin?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium leading-5 ring-1 ring-inset whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {Icon && <Icon size={13} strokeWidth={2.25} aria-hidden className={spin ? "animate-spin" : undefined} />}
      {children}
    </span>
  );
}

const tierIcon: Record<Tier, LucideIcon> = { auto: Zap, approve: Hand, never: Ban };

export function TierBadge({ tier, className }: { tier: string; className?: string }) {
  const t = TIER[tier as Tier];
  if (!t) return <Badge className={className}>{tier}</Badge>;
  return (
    <Badge tone={t.tone} icon={tierIcon[tier as Tier]} title={t.help} className={className}>
      {t.label}
    </Badge>
  );
}

const busy = new Set(["applying", "verifying", "rolling_back", "running"]);

function iconFor(tone: Tone, status: string): LucideIcon {
  if (busy.has(status)) return LoaderCircle;
  if (status === "pending_approval") return Clock;
  switch (tone) {
    case "ok":
      return CircleCheck;
    case "bad":
      return CircleAlert;
    case "never":
      return Ban;
    default:
      return CircleDot;
  }
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const s = changeStatus(status);
  return (
    <Badge tone={s.tone} icon={iconFor(s.tone, status)} spin={busy.has(status)} title={s.help} className={className}>
      {s.label}
    </Badge>
  );
}

export function JobStatusBadge({ status, className }: { status: string; className?: string }) {
  const s = JOB_STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge tone={s.tone} icon={iconFor(s.tone, status)} spin={busy.has(status)} className={className}>
      {s.label}
    </Badge>
  );
}

export { CHANGE_STATUS };
