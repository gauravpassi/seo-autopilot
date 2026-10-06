"use client";

import { useId, useState } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  Gauge,
  Pencil,
  ShieldAlert,
  X,
} from "lucide-react";
import type { ChangeType } from "@seo-autopilot/core/schema";
import type { Change } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { TierBadge } from "@/components/ui/badge";
import { textareaClass, inputClass } from "@/components/ui/misc";
import { cn, compact, pathOf, host, remaining } from "@/lib/ui/format";
import { CHANGE_TYPE } from "@/lib/ui/labels";
import { LENGTH_RULES, asObj, editableField, lengthVerdict, textOf } from "@/lib/ui/change-values";
import { DiffView, LengthMeter } from "./diff-view";

export type Decide = (ids: string[], action: "approve" | "reject") => void;
export type EditApprove = (id: string, after: unknown) => void;

export function Countdown({ iso, now }: { iso: string | null; now: number }) {
  const r = remaining(iso, now);
  if (!r) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[12px] font-medium whitespace-nowrap",
        r.urgent ? "text-bad-ink" : "text-muted",
      )}
      title={iso ? `Expires ${new Date(iso).toLocaleString()}` : undefined}
    >
      <Clock size={13} aria-hidden />
      <span className="num">{r.past ? "Expired" : `${r.text} left`}</span>
    </span>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold text-ink-2">{label}</dt>
      <dd className="mt-0.5 text-[14px] leading-relaxed text-ink-2">{children}</dd>
    </div>
  );
}

export function ChangeCard({
  change,
  siteName,
  selected,
  onSelect,
  onDecide,
  onEditApprove,
  busy,
  now,
  readOnly,
}: {
  change: Change;
  siteName?: string;
  selected: boolean;
  onSelect: (v: boolean) => void;
  onDecide: Decide;
  onEditApprove: EditApprove;
  busy: boolean;
  now: number;
  readOnly?: boolean;
}) {
  const id = useId();
  const type = change.type as ChangeType;
  const meta = CHANGE_TYPE[type];
  const editable = editableField(type);
  const [editing, setEditing] = useState(false);
  const initialText = editable ? (textOf(change.after, editable.key) ?? "") : "";
  const [draft, setDraft] = useState(initialText);
  const [open, setOpen] = useState(false);

  const rule = LENGTH_RULES[type];
  const verdict = editable ? lengthVerdict(type, [...draft].length) : null;
  const draftError =
    draft.trim().length === 0
      ? "Can't be empty"
      : rule && [...draft].length > rule.hardMax
        ? `Must be ${rule.hardMax} characters or fewer`
        : type === "canonical" && !/^https?:\/\//.test(draft.trim())
          ? "Must be a full URL starting with https://"
          : null;

  const url = change.target?.url ?? "";
  const m = change.page_metrics;
  const hasDetails = !!(change.evidence || change.expected_impact || failureCheck(change));

  return (
    <article
      id={change.id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "group relative scroll-mt-20 rounded-2xl border bg-surface shadow-card transition-[border-color,box-shadow]",
        selected ? "border-accent ring-2 ring-accent/25" : "border-line",
        busy && "opacity-60",
      )}
    >
      {/* header: what + where */}
      <header className="flex gap-3 px-4 pt-4 sm:px-5">
        {!readOnly && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            aria-label={`Select ${meta?.label ?? type} change on ${pathOf(url)}`}
            className="mt-1 size-[18px] shrink-0 cursor-pointer rounded accent-[var(--accent)]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h3 id={`${id}-title`} className="text-[17px] leading-tight font-semibold text-ink">
              {meta?.label ?? type}
            </h3>
            <TierBadge tier={change.tier} />
          </div>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
            {siteName && <span className="shrink-0 font-medium text-ink-2">{siteName}</span>}
            {siteName && <span aria-hidden>/</span>}
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-w-0 items-center gap-1 hover:text-accent-ink"
              title={url}
            >
              <span className="truncate">{pathOf(url) === "/" ? `${host(url)} (homepage)` : pathOf(url)}</span>
              <ExternalLink size={12} aria-hidden className="shrink-0" />
              <span className="sr-only">(opens live page)</span>
            </a>
            <span className="ml-auto shrink-0 pl-2">
              <Countdown iso={change.expires_at} now={now} />
            </span>
          </p>
        </div>
      </header>

      {/* the diff */}
      <div className="px-4 pt-4 sm:px-5 sm:pl-[52px]">
        {editing && editable ? (
          <div className="rounded-xl border border-accent/50 bg-accent-soft/40 p-3">
            <label htmlFor={`${id}-edit`} className="mb-1.5 flex items-center justify-between text-[12px] font-medium text-ink">
              <span>Edit proposed {meta?.short.toLowerCase() ?? "value"}</span>
              <LengthMeter type={type} text={draft} />
            </label>
            {editable.multiline ? (
              <textarea
                id={`${id}-edit`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={type === "robots_txt" || type === "llms_txt" ? 10 : 3}
                aria-invalid={!!draftError}
                aria-describedby={`${id}-edit-hint`}
                className={cn(textareaClass, (type === "robots_txt" || type === "llms_txt") && "font-mono text-[13px]")}
                autoFocus
              />
            ) : (
              <input
                id={`${id}-edit`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={!!draftError}
                aria-describedby={`${id}-edit-hint`}
                className={inputClass}
                autoFocus
              />
            )}
            <p id={`${id}-edit-hint`} className={cn("mt-1.5 text-[12px]", draftError ? "font-medium text-bad-ink" : "text-muted")}>
              {draftError ?? rule?.label ?? "Your edit is checked again before it is applied."}
              {!draftError && verdict && verdict !== "ok" && rule && " — current length is outside that range."}
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft(initialText);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="approve"
                icon={<Check size={15} aria-hidden />}
                disabled={!!draftError || busy}
                onClick={() => {
                  const base = asObj(change.after) ?? {};
                  onEditApprove(change.id, { ...base, [editable.key]: draft.trim() === draft ? draft : draft.trim() });
                  setEditing(false);
                }}
              >
                Save and approve
              </Button>
            </div>
          </div>
        ) : (
          <DiffView type={type} before={change.before} after={change.after} />
        )}
      </div>

      {/* why + risk */}
      <div className="grid gap-4 px-4 pt-4 sm:px-5 sm:pl-[52px] lg:grid-cols-[1fr_minmax(0,18rem)]">
        <div className="min-w-0">
          {change.rationale && (
            <p className="text-[14px] leading-relaxed text-ink-2">
              <span className="font-semibold text-ink">Why: </span>
              {change.rationale}
            </p>
          )}
          {m && (m.clicks28d !== undefined || m.impressions28d !== undefined) && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-muted">
              <Gauge size={14} aria-hidden />
              <span className="num">{compact(m.clicks28d ?? 0)}</span> clicks ·{" "}
              <span className="num">{compact(m.impressions28d ?? 0)}</span> impressions in the last 28 days
            </p>
          )}
        </div>
        {change.risk_reasons?.length > 0 && (
          <div
            className={cn(
              "rounded-xl px-3 py-2.5",
              change.tier === "never" ? "bg-never-soft" : change.tier === "approve" ? "bg-approve-soft" : "bg-auto-soft",
            )}
          >
            <p
              className={cn(
                "mb-1 flex items-center gap-1.5 text-[12px] font-semibold",
                change.tier === "approve" ? "text-approve-ink" : change.tier === "never" ? "text-never-ink" : "text-auto-ink",
              )}
            >
              <ShieldAlert size={14} aria-hidden />
              Risk check
            </p>
            <ul className="space-y-0.5 text-[13px] leading-snug text-ink-2">
              {change.risk_reasons.map((r, i) => (
                <li key={i} className="flex gap-1.5">
                  <span aria-hidden className="text-muted">
                    –
                  </span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {hasDetails && (
        <div className="px-4 pt-3 sm:px-5 sm:pl-[52px]">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={`${id}-more`}
            className="inline-flex items-center gap-1 rounded text-[13px] font-medium text-accent-ink hover:underline"
          >
            <ChevronDown size={15} aria-hidden className={cn("transition-transform", open && "rotate-180")} />
            {open ? "Hide evidence" : "Evidence, expected impact and how we check it"}
          </button>
          {open && (
            <dl id={`${id}-more`} className="mt-3 grid gap-3 border-l-2 border-line pl-4 sm:grid-cols-3">
              {change.evidence && <Detail label="Evidence">{change.evidence}</Detail>}
              {change.expected_impact && <Detail label="Expected impact">{change.expected_impact}</Detail>}
              {failureCheck(change) && <Detail label="How we'd know it failed">{failureCheck(change)}</Detail>}
            </dl>
          )}
        </div>
      )}

      {/* actions */}
      {!readOnly ? (
        <footer className="mt-4 flex items-center gap-2 border-t border-line px-4 py-3 sm:px-5 sm:pl-[52px]">
          <Button
            variant="reject"
            size="md"
            icon={<X size={16} aria-hidden />}
            onClick={() => onDecide([change.id], "reject")}
            disabled={busy || editing}
            className="flex-1 sm:flex-none"
          >
            Reject
          </Button>
          {editable && (
            <Button
              variant="ghost"
              size="md"
              icon={<Pencil size={15} aria-hidden />}
              onClick={() => setEditing(true)}
              disabled={busy || editing}
              className="flex-1 sm:flex-none"
              aria-label={`Edit before approving`}
            >
              Edit
            </Button>
          )}
          <Button
            variant="approve"
            size="md"
            icon={<Check size={16} aria-hidden />}
            onClick={() => onDecide([change.id], "approve")}
            disabled={busy || editing}
            className="flex-[1.4] sm:ml-auto sm:flex-none sm:px-6"
          >
            Approve
          </Button>
        </footer>
      ) : (
        <div className="h-4" />
      )}
    </article>
  );
}

function failureCheck(c: Change): string | null {
  const r = c as Change & { failure_check?: string | null };
  if (r.failure_check) return r.failure_check;
  const vr = asObj(c.verify_result);
  return typeof vr?.failure_check === "string" ? vr.failure_check : null;
}
