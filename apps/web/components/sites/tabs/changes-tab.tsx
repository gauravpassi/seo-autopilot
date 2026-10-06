"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitPullRequest, Undo2, History, ChevronDown } from "lucide-react";
import type { ChangeType } from "@seo-autopilot/core/schema";
import type { Change } from "@/lib/types";
import { requestRollback } from "@/app/actions/changes";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, TierBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, Field, inputClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { DiffView } from "@/components/changes/diff-view";
import { cn, dateTime, pathOf, timeAgo } from "@/lib/ui/format";
import { CHANGE_TYPE } from "@/lib/ui/labels";
import { summarize } from "@/lib/ui/change-values";

const FILTERS: Array<{ id: string; label: string }> = [
  { id: "", label: "All" },
  { id: "pending_approval", label: "Waiting" },
  { id: "approved,applying,applied,verifying", label: "In progress" },
  { id: "verified", label: "Live" },
  { id: "verify_failed,failed", label: "Failed" },
  { id: "rolled_back,rolling_back", label: "Rolled back" },
  { id: "rejected,expired,blocked", label: "Not applied" },
];

const ROLLBACKABLE = new Set(["applied", "verified", "verify_failed"]);

export function ChangesTab({ siteId, changes, status, canEdit }: { siteId: string; changes: Change[]; status: string; canEdit: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [rollback, setRollback] = useState<Change | null>(null);
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div>
      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f.id}
            href={f.id ? `/sites/${siteId}?tab=changes&status=${f.id}` : `/sites/${siteId}?tab=changes`}
            aria-current={status === f.id ? "page" : undefined}
            scroll={false}
            className={cn(
              "h-8 rounded-full px-3 text-[13px] leading-8 font-medium ring-1 ring-inset",
              status === f.id ? "bg-navy text-paper ring-navy" : "bg-surface text-ink-2 ring-line-strong hover:ring-ink-2",
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {changes.length === 0 ? (
        <Card>
          <EmptyState icon={History} title="No changes here">
            {status ? "Nothing matches this filter." : "Proposed fixes appear after an audit. Run one from the Overview tab."}
          </EmptyState>
        </Card>
      ) : (
        <Card as="div">
          <ul className="divide-y divide-line">
            {changes.map((c) => {
              const isOpen = open === c.id;
              return (
                <li key={c.id}>
                  <div className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : c.id)}
                      aria-expanded={isOpen}
                      aria-controls={`chg-${c.id}`}
                      className="mt-0.5 rounded p-0.5 text-muted hover:text-ink"
                      aria-label={isOpen ? "Hide details" : "Show details"}
                    >
                      <ChevronDown size={16} aria-hidden className={cn("transition-transform", isOpen && "rotate-180")} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-[14.5px] font-semibold">{CHANGE_TYPE[c.type as ChangeType]?.label ?? c.type}</span>
                        <StatusBadge status={c.status} />
                        <span className="hidden sm:inline-flex">
                          <TierBadge tier={c.tier} />
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12.5px] text-muted">
                        {pathOf(c.target?.url)} · {timeAgo(c.created_at)}
                        {c.approver_label && ` · decided by ${c.approver_label}${c.approved_via && c.approved_via !== "panel" ? ` via ${c.approved_via}` : ""}`}
                      </p>
                      <p className="mt-0.5 truncate text-[13px] text-ink-2">{summarize(c.type as ChangeType, c.after)}</p>
                      {c.error && <p className="mt-1 text-[12.5px] text-bad-ink">{c.error}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {c.pr_url && (
                        <a href={c.pr_url} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-accent-ink hover:bg-sunken">
                          <GitPullRequest size={15} aria-hidden />
                          <span className="hidden sm:inline">Pull request</span>
                        </a>
                      )}
                      {canEdit && ROLLBACKABLE.has(c.status) && (
                        <Button size="sm" variant="secondary" icon={<Undo2 size={14} aria-hidden />} onClick={() => setRollback(c)}>
                          <span className="hidden sm:inline">Roll back</span>
                          <span className="sr-only sm:hidden">Roll back</span>
                        </Button>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div id={`chg-${c.id}`} className="space-y-3 border-t border-line bg-raised px-4 py-4 sm:px-5 sm:pl-12">
                      <DiffView type={c.type as ChangeType} before={c.before} after={c.after} />
                      {c.rationale && (
                        <p className="text-[13.5px] text-ink-2">
                          <span className="font-semibold text-ink">Why: </span>
                          {c.rationale}
                        </p>
                      )}
                      {c.risk_reasons?.length > 0 && <p className="text-[13px] text-muted">Risk: {c.risk_reasons.join("; ")}</p>}
                      <dl className="grid grid-cols-2 gap-2 text-[12.5px] text-muted sm:grid-cols-4">
                        <div><dt>Proposed</dt><dd className="text-ink-2">{dateTime(c.created_at)}</dd></div>
                        <div><dt>Decided</dt><dd className="text-ink-2">{dateTime(c.decided_at)}</dd></div>
                        <div><dt>Applied</dt><dd className="text-ink-2">{dateTime(c.applied_at)}</dd></div>
                        <div><dt>Verified</dt><dd className="text-ink-2">{dateTime(c.verified_at)}</dd></div>
                      </dl>
                      {c.decision_note && <p className="text-[13px] text-ink-2">Note: {c.decision_note}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Dialog
        open={!!rollback}
        onClose={() => setRollback(null)}
        title="Roll back this change?"
        description={rollback ? `${CHANGE_TYPE[rollback.type as ChangeType]?.label} on ${pathOf(rollback.target?.url)}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRollback(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={pending}
              icon={<Undo2 size={15} aria-hidden />}
              onClick={() =>
                start(async () => {
                  if (!rollback) return;
                  const res = await requestRollback([rollback.id], reason || undefined);
                  if (!res.ok) toast({ tone: "error", title: "Couldn't start the rollback", detail: res.error });
                  else toast({ tone: "success", title: "Rollback queued", detail: "The runner restores the previous value and checks the live page." });
                  setRollback(null);
                  setReason("");
                  router.refresh();
                })
              }
            >
              Roll back
            </Button>
          </>
        }
      >
        <p className="mb-4 text-[14px] text-ink-2">The runner restores the value that was live before this change and confirms it on the page.</p>
        <Field label="Reason" htmlFor="rb-reason" optional>
          <input id="rb-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} placeholder="e.g. client asked to keep the old title" />
        </Field>
      </Dialog>
    </div>
  );
}
