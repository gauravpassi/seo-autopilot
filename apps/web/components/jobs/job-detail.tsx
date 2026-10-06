"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, Bot, CircleAlert, Info, Pause, Play, Square, TriangleAlert, Wrench } from "lucide-react";
import type { Job, JobLog } from "@/lib/types";
import { cancelJob } from "@/app/actions/jobs";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JobStatusBadge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/ui/code-block";
import { Stat } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { cn, dateTime, duration, money } from "@/lib/ui/format";
import { JOB_KIND } from "@/lib/ui/labels";

const LIVE = new Set(["queued", "running"]);

function LogLine({ l }: { l: JobLog }) {
  const t = new Date(l.ts).toLocaleTimeString("en", { hour12: false });
  if (l.level === "agent")
    return (
      <li className="flex gap-3 py-2">
        <Bot size={15} aria-hidden className="mt-1 shrink-0 text-auto" />
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink">{l.message}</p>
        </div>
        <time className="shrink-0 pt-0.5 text-[11px] text-muted tabular">{t}</time>
      </li>
    );
  const Icon = l.level === "tool" ? Wrench : l.level === "error" ? CircleAlert : l.level === "warn" ? TriangleAlert : Info;
  return (
    <li
      className={cn(
        "flex gap-3 rounded-md px-2 py-1",
        l.level === "error" && "bg-bad-soft",
        l.level === "warn" && "bg-approve-soft",
      )}
    >
      <Icon
        size={13}
        aria-label={l.level}
        className={cn(
          "mt-[3px] shrink-0",
          l.level === "error" ? "text-bad" : l.level === "warn" ? "text-approve" : "text-muted",
        )}
      />
      <p
        className={cn(
          "min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap",
          l.level === "error" ? "text-bad-ink" : l.level === "warn" ? "text-approve-ink" : l.level === "tool" ? "text-ink-2" : "text-muted",
        )}
      >
        {l.message}
      </p>
      <time className="shrink-0 text-[11px] text-muted tabular">{t}</time>
    </li>
  );
}

export function JobDetail({
  initialJob,
  initialLogs,
  site,
  canEdit,
}: {
  initialJob: Job;
  initialLogs: JobLog[];
  site: { id: string; name: string } | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [job, setJob] = useState(initialJob);
  const [logs, setLogs] = useState(initialLogs);
  const [follow, setFollow] = useState(true);
  const [showDebug, setShowDebug] = useState(false);
  const [pending, start] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);
  const lastId = logs.length ? logs[logs.length - 1].id : 0;
  const lastIdRef = useRef(lastId);
  lastIdRef.current = lastId;
  const live = LIVE.has(job.status);

  // poll for new lines while the job is live
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/ui/jobs/${job.id}?after=${lastIdRef.current}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { job: Job; logs: JobLog[] };
          if (!alive) return;
          setJob(data.job);
          if (data.logs?.length) setLogs((xs) => [...xs, ...data.logs.filter((l) => l.id > (xs[xs.length - 1]?.id ?? 0))]);
          if (!LIVE.has(data.job.status)) router.refresh();
        }
      } catch {
        /* transient; keep polling */
      }
      if (alive) timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [job.id, live, router]);

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, follow]);

  const visible = useMemo(() => logs.filter((l) => showDebug || l.level !== "debug"), [logs, showDebug]);
  const counts = useMemo(() => {
    const c = { agent: 0, tool: 0, error: 0 };
    for (const l of logs) if (l.level in c) c[l.level as keyof typeof c]++;
    return c;
  }, [logs]);

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-[26px] font-semibold">
            {JOB_KIND[job.kind]?.label ?? job.kind}
            <JobStatusBadge status={job.status} />
          </h1>
          <p className="mt-1 text-[14px] text-muted">
            {site ? (
              <Link href={`/sites/${site.id}`} className="text-ink-2 hover:text-accent-ink">
                {site.name}
              </Link>
            ) : (
              "No site"
            )}
            {" · "}queued {dateTime(job.created_at)}
            {job.schedule_id && " by a schedule"}
          </p>
        </div>
        {canEdit && live && (
          <Button
            variant="reject"
            icon={<Square size={14} aria-hidden />}
            loading={pending}
            disabled={job.cancel_requested}
            onClick={() =>
              start(async () => {
                const res = await cancelJob(job.id);
                if (!res.ok) toast({ tone: "error", title: "Couldn't cancel", detail: res.error });
                else {
                  toast({ tone: "info", title: job.status === "queued" ? "Job cancelled" : "Stopping the job", detail: job.status === "running" ? "The runner stops at the next safe point." : undefined });
                  setJob((j) => ({ ...j, cancel_requested: true }));
                }
              })
            }
          >
            {job.cancel_requested ? "Stopping…" : "Cancel job"}
          </Button>
        )}
      </header>

      <Card className="p-5">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="Duration" value={duration(job.started_at, job.finished_at)} />
          <Stat label="Cost" value={money(job.cost_usd)} hint="Claude usage" />
          <Stat label="Agent messages" value={counts.agent} />
          <Stat label="Errors" value={counts.error} tone={counts.error ? "bad" : undefined} />
        </div>
        {job.error && (
          <p role="alert" className="mt-4 rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] break-words text-bad-ink">
            {job.error}
          </p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Log"
          description={live ? "Updating every few seconds" : `${logs.length} lines`}
          action={
            <div className="flex items-center gap-1">
              <label className="mr-2 hidden items-center gap-1.5 text-[12.5px] text-muted sm:inline-flex">
                <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} className="accent-[var(--accent)]" />
                Debug lines
              </label>
              {live && (
                <Button size="sm" variant="ghost" onClick={() => setFollow((f) => !f)} icon={follow ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />} aria-pressed={!follow}>
                  {follow ? "Pause scroll" : "Follow"}
                </Button>
              )}
            </div>
          }
        />
        <div className="relative">
          <div
            ref={boxRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (!atBottom && follow && live) setFollow(false);
            }}
            className="max-h-[60vh] min-h-48 overflow-y-auto border-t border-line bg-raised px-3 py-2 sm:px-4"
            role="log"
            aria-live={live ? "polite" : "off"}
            aria-label="Job log"
            tabIndex={0}
          >
            {visible.length === 0 ? (
              <p className="py-10 text-center text-[14px] text-muted">
                {job.status === "queued" ? "Waiting for a runner to pick this up." : "No log lines."}
              </p>
            ) : (
              <ol className="space-y-0.5">
                {visible.map((l) => (
                  <LogLine key={l.id} l={l} />
                ))}
              </ol>
            )}
          </div>
          {live && !follow && (
            <button
              type="button"
              onClick={() => setFollow(true)}
              className="absolute right-4 bottom-3 inline-flex items-center gap-1.5 rounded-full bg-navy px-3 py-1.5 text-[12.5px] font-medium text-paper shadow-pop"
            >
              <ArrowDown size={14} aria-hidden /> Jump to latest
            </button>
          )}
        </div>
      </Card>

      {job.result !== null && job.result !== undefined && (
        <Card>
          <CardHeader title="Result" />
          <CardBody>
            <CodeBlock code={JSON.stringify(job.result, null, 2)} maxHeight={420} />
          </CardBody>
        </Card>
      )}
      {Object.keys(job.params ?? {}).length > 0 && (
        <details className="text-[13px] text-muted">
          <summary className="cursor-pointer">Parameters</summary>
          <CodeBlock code={JSON.stringify(job.params, null, 2)} className="mt-2" copy={false} />
        </details>
      )}
    </div>
  );
}
