"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleCheck, Filter, X } from "lucide-react";
import type { ChangeType } from "@seo-autopilot/core/schema";
import type { Change } from "@/lib/types";
import { decideChanges, editChangeAfter } from "@/app/actions/changes";
import { Button } from "@/components/ui/button";
import { EmptyState, selectClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/ui/format";
import { CHANGE_TYPE, TIER } from "@/lib/ui/labels";
import { useNow } from "@/lib/ui/use-now";
import { ChangeCard } from "./change-card";

type SiteLite = { id: string; name: string };

type Result = { ok: true; decided?: number; skipped?: number } | { ok: false; error: string };

/** Lets the dev preview run the UI without a backend. */
export type QueueActions = {
  decide: (ids: string[], action: "approve" | "reject") => Promise<Result>;
  edit: (id: string, after: unknown) => Promise<Result>;
};

const liveActions: QueueActions = {
  decide: (ids, action) => decideChanges(ids, action) as Promise<Result>,
  edit: (id, after) => editChangeAfter(id, after) as Promise<Result>,
};

export function ApprovalsQueue({
  changes,
  sites,
  readOnly,
  actions = liveActions,
  initialNow,
  showFilters = true,
  showSite = true,
}: {
  changes: Change[];
  sites: SiteLite[];
  readOnly?: boolean;
  actions?: QueueActions;
  initialNow?: number;
  showFilters?: boolean;
  showSite?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const now = useNow(30_000, initialNow);
  const [pending, startTransition] = useTransition();
  const [hidden, hide] = useOptimistic<Set<string>, string[]>(new Set(), (s, ids) => new Set([...s, ...ids]));
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [site, setSite] = useState("");
  const [type, setType] = useState("");
  const [tier, setTier] = useState("");

  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const visible = changes.filter((c) => !hidden.has(c.id) && !decided.has(c.id));
  const filtered = visible.filter(
    (c) => (!site || c.site_id === site) && (!type || c.type === type) && (!tier || c.tier === tier),
  );
  const types = Array.from(new Set(visible.map((c) => c.type))).sort();
  const selectedVisible = filtered.filter((c) => selected.has(c.id)).map((c) => c.id);
  const allSelected = filtered.length > 0 && selectedVisible.length === filtered.length;

  function run(ids: string[], label: string, fn: () => Promise<Result>) {
    setBusyIds((s) => new Set([...s, ...ids]));
    startTransition(async () => {
      hide(ids);
      try {
        const res = await fn();
        if (!res.ok) {
          toast({ tone: "error", title: `Couldn't ${label.toLowerCase()}`, detail: res.error });
        } else {
          setDecided((s) => new Set([...s, ...ids]));
          const skipped = res.skipped ?? 0;
          const n = res.decided ?? ids.length;
          toast({
            tone: skipped ? "info" : "success",
            title: `${label === "Approve" ? "Approved" : label === "Reject" ? "Rejected" : "Saved and approved"} ${n} ${n === 1 ? "change" : "changes"}`,
            detail: skipped
              ? `${skipped} skipped: someone else decided first or it expired.`
              : label === "Reject"
                ? "Nothing on the site was changed."
                : "The runner will apply and verify it on its next check.",
          });
          setSelected((s) => {
            const n2 = new Set(s);
            ids.forEach((i) => n2.delete(i));
            return n2;
          });
        }
        router.refresh();
      } catch (e) {
        toast({ tone: "error", title: `Couldn't ${label.toLowerCase()}`, detail: e instanceof Error ? e.message : undefined });
      } finally {
        setBusyIds((s) => {
          const n2 = new Set(s);
          ids.forEach((i) => n2.delete(i));
          return n2;
        });
      }
    });
  }

  const decide = (ids: string[], action: "approve" | "reject") =>
    run(ids, action === "approve" ? "Approve" : "Reject", () => actions.decide(ids, action));

  const editApprove = (id: string, after: unknown) =>
    run([id], "Save and approve", async () => {
      const r = await actions.edit(id, after);
      if (!r.ok) return r;
      return actions.decide([id], "approve");
    });

  if (changes.length > 0 && visible.length === 0) {
    return (
      <EmptyState icon={CircleCheck} title="All caught up">
        Every change in this queue has a decision. Approved changes are applied by the runner and checked on the live page.
      </EmptyState>
    );
  }
  if (visible.length === 0) {
    return (
      <EmptyState icon={CircleCheck} title="Nothing waiting for approval">
        When the agent proposes a change that needs a person, it shows up here and in your notification channels.
      </EmptyState>
    );
  }

  return (
    <div className={cn(!readOnly && "pb-28 sm:pb-24")}>
      {showFilters && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            {!readOnly && (
              <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedVisible.length > 0 && !allSelected;
                  }}
                  onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((c) => c.id)) : new Set())}
                  className="size-[18px] rounded accent-[var(--accent)]"
                />
                Select all
              </label>
            )}
            <span className="num text-[13px] text-muted" aria-live="polite">
              {filtered.length} of {visible.length}
            </span>
          </div>
          <Filter size={15} aria-hidden className="hidden shrink-0 text-muted sm:block" />
          <div className="grid flex-1 auto-cols-fr grid-flow-col items-center gap-2 sm:flex sm:justify-end" role="group" aria-label="Filter changes">
                        {sites.length > 1 && (
              <select aria-label="Filter by site" value={site} onChange={(e) => setSite(e.target.value)} className={cn(selectClass, "h-9 sm:w-44")}>
                <option value="">All sites</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            <select aria-label="Filter by change type" value={type} onChange={(e) => setType(e.target.value)} className={cn(selectClass, "h-9 sm:w-48")}>
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {CHANGE_TYPE[t as ChangeType]?.label ?? t}
                </option>
              ))}
            </select>
            <select aria-label="Filter by risk tier" value={tier} onChange={(e) => setTier(e.target.value)} className={cn(selectClass, "h-9 sm:w-44")}>
              <option value="">Any risk</option>
              <option value="auto">{TIER.auto.label} (suggest mode)</option>
              <option value="approve">{TIER.approve.label}</option>
              <option value="never">{TIER.never.label}</option>
            </select>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon={Filter} title="No changes match these filters" action={<Button size="sm" onClick={() => { setSite(""); setType(""); setTier(""); }}>Clear filters</Button>} />
      ) : (
        <ol className="flex flex-col gap-4" aria-label="Changes waiting for approval">
          {filtered.map((c) => (
            <li key={c.id}>
              <ChangeCard
                change={c}
                siteName={showSite ? siteName.get(c.site_id) : undefined}
                selected={selected.has(c.id)}
                onSelect={(v) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (v) n.add(c.id);
                    else n.delete(c.id);
                    return n;
                  })
                }
                onDecide={decide}
                onEditApprove={editApprove}
                busy={busyIds.has(c.id)}
                now={now}
                readOnly={readOnly}
              />
            </li>
          ))}
        </ol>
      )}

      {!readOnly && selectedVisible.length > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-pop backdrop-blur md:left-64"
        >
          <div className="mx-auto flex max-w-4xl items-center gap-2">
            <p className="mr-auto text-[14px] text-ink">
              <span className="num font-semibold">{selectedVisible.length}</span> selected
              <button type="button" className="ml-3 text-[13px] text-muted underline-offset-2 hover:underline" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </p>
            <Button variant="reject" icon={<X size={16} aria-hidden />} disabled={pending} onClick={() => decide(selectedVisible, "reject")}>
              Reject
            </Button>
            <Button variant="approve" icon={<Check size={16} aria-hidden />} disabled={pending} onClick={() => decide(selectedVisible, "approve")}>
              Approve {selectedVisible.length}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
