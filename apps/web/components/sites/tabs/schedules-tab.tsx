"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import type { Schedule } from "@/lib/types";
import { deleteSchedule, upsertSchedule } from "@/app/actions/schedules";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState, selectClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { cn, dateTime, timeAgo } from "@/lib/ui/format";

const KINDS: Array<{ id: Schedule["kind"]; label: string; help: string }> = [
  { id: "audit", label: "Full audit", help: "Crawl and score the site" },
  { id: "propose", label: "Propose fixes", help: "Turn the latest audit into changes" },
  { id: "verify", label: "Re-verify", help: "Re-check applied changes" },
  { id: "monitor", label: "Traffic monitor", help: "Watch clicks after changes (needs Search Console)" },
];

const EVERY: Array<{ h: number; label: string }> = [
  { h: 6, label: "Every 6 hours" },
  { h: 12, label: "Every 12 hours" },
  { h: 24, label: "Daily" },
  { h: 72, label: "Every 3 days" },
  { h: 168, label: "Weekly" },
  { h: 336, label: "Every 2 weeks" },
  { h: 720, label: "Monthly" },
];

function everyLabel(h: number) {
  return EVERY.find((e) => e.h === h)?.label ?? `Every ${h} hours`;
}

export function SchedulesTab({ siteId, schedules, canEdit, hasGsc }: { siteId: string; schedules: Schedule[]; canEdit: boolean; hasGsc: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<Schedule["kind"]>("audit");
  const [newEvery, setNewEvery] = useState(168);

  const save = (key: string, input: Parameters<typeof upsertSchedule>[0], ok: string) =>
    start(async () => {
      setBusy(key);
      const res = await upsertSchedule(input);
      setBusy(null);
      if (!res.ok) toast({ tone: "error", title: "Couldn't save the schedule", detail: res.error });
      else toast({ tone: "success", title: ok });
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Schedules" description="Schedules run whenever a runner is online. If it was offline, a missed run starts as soon as it reconnects." />
        {schedules.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No schedules" className="py-8">
            Add a weekly audit so the agent keeps finding new issues.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {schedules.map((s) => {
              const k = KINDS.find((x) => x.id === s.kind);
              const needsGsc = s.kind === "monitor" && !hasGsc;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-medium">{k?.label ?? s.kind}</p>
                    <p className="text-[12.5px] text-muted">
                      {s.enabled ? `Next ${timeAgo(s.next_run_at)}` : "Paused"} · last run {s.last_run_at ? dateTime(s.last_run_at) : "never"}
                      {needsGsc && <span className="text-approve-ink"> · add a Search Console property on the Connection tab first</span>}
                    </p>
                  </div>
                  <select
                    aria-label={`How often: ${k?.label ?? s.kind}`}
                    disabled={!canEdit || pending}
                    value={s.every_hours}
                    onChange={(e) => save(s.id, { id: s.id, site_id: siteId, kind: s.kind, every_hours: Number(e.target.value), enabled: s.enabled, params: s.params }, "Schedule updated")}
                    className={cn(selectClass, "h-9 w-40")}
                  >
                    {!EVERY.some((e) => e.h === s.every_hours) && <option value={s.every_hours}>{everyLabel(s.every_hours)}</option>}
                    {EVERY.map((e) => (
                      <option key={e.h} value={e.h}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={s.enabled}
                    aria-label={`${k?.label ?? s.kind} schedule ${s.enabled ? "on" : "off"}`}
                    disabled={!canEdit || pending || (needsGsc && !s.enabled)}
                    onClick={() =>
                      save(s.id, { id: s.id, site_id: siteId, kind: s.kind, every_hours: s.every_hours, enabled: !s.enabled, params: s.params }, s.enabled ? "Schedule paused" : "Schedule turned on")
                    }
                    className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50", s.enabled ? "bg-accent" : "bg-line-strong")}
                  >
                    <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", s.enabled ? "translate-x-5.5" : "translate-x-0.5")} />
                  </button>
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${k?.label ?? s.kind} schedule`}
                      loading={pending && busy === `del-${s.id}`}
                      icon={<Trash2 size={15} aria-hidden />}
                      onClick={() =>
                        start(async () => {
                          setBusy(`del-${s.id}`);
                          const res = await deleteSchedule(s.id);
                          setBusy(null);
                          if (!res.ok) toast({ tone: "error", title: "Couldn't delete", detail: res.error });
                          else toast({ tone: "success", title: "Schedule deleted" });
                          router.refresh();
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {canEdit && (
        <Card className="p-5">
          <h3 className="text-[15px] font-semibold">Add a schedule</h3>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <select aria-label="What to run" value={newKind} onChange={(e) => setNewKind(e.target.value as Schedule["kind"])} className={cn(selectClass, "sm:w-56")}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} — {k.help}
                </option>
              ))}
            </select>
            <select aria-label="How often" value={newEvery} onChange={(e) => setNewEvery(Number(e.target.value))} className={cn(selectClass, "sm:w-44")}>
              {EVERY.map((e) => (
                <option key={e.h} value={e.h}>
                  {e.label}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              icon={<Plus size={16} aria-hidden />}
              loading={pending && busy === "new"}
              onClick={() => save("new", { site_id: siteId, kind: newKind, every_hours: newEvery, enabled: true, params: newKind === "audit" ? { depth: "full" } : {} }, "Schedule added")}
            >
              Add
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
