import { Bot, Hash, Mail, MessageSquare, Phone, User, Cpu, Settings2 } from "lucide-react";
import type { AuditLogRow } from "@/lib/types";
import { timeAgo } from "@/lib/ui/format";
import { changeTypeLabel, jobKindLabel } from "@/lib/ui/labels";

export function actorParts(actor: string): { icon: typeof User; label: string; via?: string } {
  const [kind, ...rest] = actor.split(":");
  const name = rest.join(":");
  switch (kind) {
    case "runner":
      return { icon: Cpu, label: name || "runner", via: "runner" };
    case "slack":
      return { icon: Hash, label: name, via: "Slack" };
    case "whatsapp":
      return { icon: Phone, label: name, via: "WhatsApp" };
    case "email":
      return { icon: Mail, label: name, via: "email" };
    case "system":
      return { icon: Bot, label: "System" };
    case "policy":
      return { icon: Settings2, label: "Site policy" };
    default:
      return { icon: actor.includes("@") ? User : MessageSquare, label: actor };
  }
}

/** "change.approved" → "Change approved", with a little context from data when present. */
export function describeAction(row: AuditLogRow): string {
  const words = row.action.replace(/[._]/g, " ").trim();
  let s = words.charAt(0).toUpperCase() + words.slice(1);
  const d = row.data ?? {};
  if (typeof d.kind === "string" && row.entity === "job") s += ` · ${jobKindLabel(d.kind)}`;
  if (typeof d.type === "string") s += ` · ${changeTypeLabel(d.type)}`;
  if (typeof d.count === "number") s += ` · ${d.count}`;
  if (typeof d.name === "string") s += ` · ${d.name}`;
  return s;
}

export function ActivityList({ rows, now }: { rows: AuditLogRow[]; now?: number }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => {
        const a = actorParts(r.actor);
        const Icon = a.icon;
        return (
          <li key={r.id} className="flex items-start gap-3 py-2.5">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-ink-2" aria-hidden>
              <Icon size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] text-ink">{describeAction(r)}</p>
              <p className="truncate text-[12px] text-muted">
                {a.label}
                {a.via && a.via !== "runner" ? ` via ${a.via}` : ""}
              </p>
            </div>
            <time dateTime={r.ts} className="shrink-0 text-[12px] text-muted tabular" title={new Date(r.ts).toLocaleString()}>
              {timeAgo(r.ts, now)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
