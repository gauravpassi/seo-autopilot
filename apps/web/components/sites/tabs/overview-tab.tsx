import Link from "next/link";
import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import type { Audit, Runner, Site } from "@/lib/types";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dot, Stat } from "@/components/ui/misc";
import { Sparkline } from "@/components/shell/health-ring";
import { QuickActions } from "@/components/sites/quick-actions";
import { cn, dateTime, healthTone, isOnline, timeAgo } from "@/lib/ui/format";

export function OverviewTab({
  site,
  audits,
  statusCounts,
  runner,
  canEdit,
}: {
  site: Site;
  audits: Audit[];
  statusCounts: Record<string, number>;
  runner: Pick<Runner, "id" | "name" | "last_seen_at"> | null;
  canEdit: boolean;
}) {
  const latest = audits[0];
  const trend = audits
    .map((a) => a.health_score)
    .filter((v): v is number => typeof v === "number")
    .reverse();
  const delta = trend.length >= 2 ? trend[trend.length - 1] - trend[trend.length - 2] : null;
  const categories = ((latest?.categories ?? []) as Array<{ name?: string; score?: number | string; findings?: unknown[] }>)
    .filter((c) => c.name)
    .map((c) => ({ name: String(c.name), score: c.score === undefined ? null : Number(c.score), findings: Array.isArray(c.findings) ? c.findings.length : 0 }));
  const conn = site.connection as { ok?: boolean; warnings?: string[]; tested_at?: string; capabilities?: string[] };
  const live = (statusCounts.verified ?? 0) + (statusCounts.applied ?? 0);
  const failed = (statusCounts.verify_failed ?? 0) + (statusCounts.failed ?? 0);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Health" description={latest ? `Last audit ${timeAgo(latest.created_at)} · ${latest.depth === "page" ? "page audit" : "full audit"}` : "No audit yet"} />
        <CardBody>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat
              label="Health score"
              value={site.health_score ?? "–"}
              tone={healthTone(site.health_score) === "neutral" ? undefined : healthTone(site.health_score)}
              hint={delta === null ? "out of 100" : `${delta >= 0 ? "+" : ""}${delta} since previous audit`}
            />
            <Stat label="Waiting for approval" value={statusCounts.pending_approval ?? 0} tone={(statusCounts.pending_approval ?? 0) > 0 ? "approve" : undefined} hint={<Link className="underline underline-offset-2" href="/approvals">Review</Link>} />
            <Stat label="Live changes" value={live} tone="ok" hint="Applied and checked" />
            <Stat label="Need attention" value={failed} tone={failed ? "bad" : undefined} hint={failed ? <Link className="underline underline-offset-2" href={`/sites/${site.id}?tab=changes&status=verify_failed,failed`}>See which</Link> : "Failed or not verified"} />
          </div>
          {trend.length >= 2 && (
            <div className="mt-6">
              <p className="mb-1 text-[12px] text-muted">Health over the last {trend.length} audits</p>
              <Sparkline values={trend} width={640} height={64} />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Connection" />
        <CardBody className="space-y-3 text-[14px]">
          <p className="flex items-center gap-2">
            {conn.ok === true ? (
              <CircleCheck size={16} aria-hidden className="text-ok" />
            ) : conn.ok === false ? (
              <CircleAlert size={16} aria-hidden className="text-bad" />
            ) : (
              <CircleHelp size={16} aria-hidden className="text-muted" />
            )}
            <span className="font-medium">{conn.ok === true ? "Connected" : conn.ok === false ? "Connection failing" : "Not tested yet"}</span>
          </p>
          {conn.tested_at && <p className="text-[12.5px] text-muted">Tested {dateTime(conn.tested_at)}</p>}
          {conn.warnings?.length ? (
            <ul className="space-y-1 text-[13px] text-approve-ink">
              {conn.warnings.map((w, i) => (
                <li key={i}>– {w}</li>
              ))}
            </ul>
          ) : null}
          <div className="border-t border-line pt-3">
            <p className="text-[12px] text-muted">Runner</p>
            {runner ? (
              <p className="mt-0.5 flex items-center gap-2">
                <Dot tone={isOnline(runner.last_seen_at) ? "ok" : "bad"} />
                {runner.name}
                <span className="text-[12.5px] text-muted">{isOnline(runner.last_seen_at) ? "online" : "offline"}</span>
              </p>
            ) : (
              <p className="mt-0.5 text-bad-ink">None assigned</p>
            )}
          </div>
          <Link href={`/sites/${site.id}?tab=connection`} className="inline-block text-[13px] font-medium text-accent-ink underline underline-offset-2">
            Manage connection
          </Link>
        </CardBody>
      </Card>

      {canEdit && (
        <Card className="lg:col-span-2">
          <CardHeader title="Run now" description="Schedules run these automatically; use these to run one immediately." />
          <CardBody>
            <QuickActions siteId={site.id} siteUrl={site.url} />
          </CardBody>
        </Card>
      )}

      <Card className={cn(!canEdit && "lg:col-span-3")}>
        <CardHeader title="Scores by category" description={latest ? undefined : "Run an audit to see scores."} />
        <CardBody>
          {categories.length ? (
            <ul className="space-y-3">
              {categories.map((c) => {
                const t = healthTone(c.score);
                return (
                  <li key={c.name}>
                    <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
                      <Link href={`/sites/${site.id}?tab=findings#cat-${encodeURIComponent(c.name)}`} className="truncate text-ink hover:text-accent-ink">
                        {c.name}
                      </Link>
                      <span className="num shrink-0 font-semibold">{c.score ?? "–"}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
                      <div
                        className={cn("h-full rounded-full", t === "ok" ? "bg-ok" : t === "approve" ? "bg-approve" : t === "bad" ? "bg-bad" : "bg-line-strong")}
                        style={{ width: `${Math.max(2, Math.min(100, c.score ?? 0))}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[14px] text-muted">No category scores yet.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
