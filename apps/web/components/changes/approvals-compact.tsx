"use client";

import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import type { ChangeType } from "@seo-autopilot/core/schema";
import type { Change } from "@/lib/types";
import { decideChanges } from "@/app/actions/changes";
import { TierBadge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { pathOf } from "@/lib/ui/format";
import { CHANGE_TYPE } from "@/lib/ui/labels";
import { summarize } from "@/lib/ui/change-values";
import { useNow } from "@/lib/ui/use-now";
import { Countdown } from "./change-card";

/** Dashboard list: one line per change with quick approve / reject. Full diff lives on /approvals. */
export function ApprovalsQueueCompact({
  changes,
  siteNames,
  readOnly,
}: {
  changes: Change[];
  siteNames: Record<string, string>;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const now = useNow();
  const [, start] = useTransition();
  const [gone, remove] = useOptimistic<Set<string>, string>(new Set(), (s, id) => new Set([...s, id]));

  const act = (c: Change, action: "approve" | "reject") =>
    start(async () => {
      remove(c.id);
      const res = await decideChanges([c.id], action);
      if (!res.ok) toast({ tone: "error", title: `Couldn't ${action}`, detail: res.error });
      else
        toast({
          tone: res.skipped ? "info" : "success",
          title: res.skipped ? "Already decided" : action === "approve" ? "Approved" : "Rejected",
          detail: res.skipped ? "Someone else decided first, or it expired." : undefined,
        });
      router.refresh();
    });

  return (
    <ul className="divide-y divide-line border-t border-line">
      {changes
        .filter((c) => !gone.has(c.id))
        .map((c) => {
          const label = CHANGE_TYPE[c.type as ChangeType]?.label ?? c.type;
          return (
            <li key={c.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link href={`/approvals#${c.id}`} className="text-[14px] font-semibold text-ink hover:text-accent-ink">
                    {label}
                  </Link>
                  <TierBadge tier={c.tier} className="hidden sm:inline-flex" />
                  <Countdown iso={c.expires_at} now={now} />
                </div>
                <p className="truncate text-[12.5px] text-muted">
                  {siteNames[c.site_id] ?? "Site"} · {pathOf(c.target?.url)}
                </p>
                <p className="mt-0.5 truncate text-[13px] text-ink-2">{summarize(c.type as ChangeType, c.after)}</p>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => act(c, "reject")}
                    className="grid size-10 place-items-center rounded-lg border border-line-strong text-bad-ink hover:border-bad hover:bg-bad-soft"
                    aria-label={`Reject ${label} on ${pathOf(c.target?.url)}`}
                  >
                    <X size={18} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => act(c, "approve")}
                    className="grid size-10 place-items-center rounded-lg bg-ok text-white hover:brightness-95 dark:text-[#03200f]"
                    aria-label={`Approve ${label} on ${pathOf(c.target?.url)}`}
                  >
                    <Check size={18} aria-hidden />
                  </button>
                </div>
              )}
            </li>
          );
        })}
    </ul>
  );
}
