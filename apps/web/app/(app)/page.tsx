import type { Metadata } from "next";
import Link from "next/link";
import { Cpu, Globe, Inbox, ListChecks, Plus } from "lucide-react";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { AuditLogRow, Change, Job, Runner, Site } from "@/lib/types";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { Dot, EmptyState } from "@/components/ui/misc";
import { JobStatusBadge } from "@/components/ui/badge";
import { HealthRing } from "@/components/shell/health-ring";
import { ActivityList } from "@/components/shell/activity-list";
import { RunnerHealth } from "@/components/runners/runner-health";
import { ApprovalsQueueCompact } from "@/components/changes/approvals-compact";
import { duration, host, isOnline, timeAgo } from "@/lib/ui/format";
import { JOB_KIND, PLATFORM } from "@/lib/ui/labels";

export const metadata: Metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const m = await requireMember();
  const supabase = await createClient();
  const now = Date.now();
  const [runnersQ, sitesQ, pendingQ, pendingCountQ, jobsQ, activityQ] = await Promise.all([
    supabase.from("runners").select("*").eq("org_id", m.orgId).is("revoked_at", null).order("created_at"),
    supabase.from("sites").select("*").eq("org_id", m.orgId).is("archived_at", null).order("name"),
    supabase
      .from("changes")
      .select("*")
      .eq("org_id", m.orgId)
      .eq("status", "pending_approval")
      .order("expires_at", { ascending: true, nullsFirst: false })
      .limit(5),
    supabase.from("changes").select("site_id").eq("org_id", m.orgId).eq("status", "pending_approval").limit(1000),
    supabase
      .from("jobs")
      .select("*")
      .eq("org_id", m.orgId)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(8),
    supabase.from("audit_log").select("*").eq("org_id", m.orgId).order("ts", { ascending: false }).limit(12),
  ]);

  const runners = (runnersQ.data ?? []) as Runner[];
  const sites = (sitesQ.data ?? []) as Site[];
  const pending = (pendingQ.data ?? []) as Change[];
  const pendingBySite = new Map<string, number>();
  for (const r of (pendingCountQ.data ?? []) as Array<{ site_id: string }>) pendingBySite.set(r.site_id, (pendingBySite.get(r.site_id) ?? 0) + 1);
  const pendingTotal = (pendingCountQ.data ?? []).length;
  const jobs = (jobsQ.data ?? []) as Job[];
  const activity = (activityQ.data ?? []) as AuditLogRow[];
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const online = runners.filter((r) => isOnline(r.last_seen_at, now));

  // First-run guidance
  if (runners.length === 0 && sites.length === 0) {
    return (
      <>
        <PageHeader title="Welcome" description="Two steps and the agent can start auditing." />
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-6">
            <span className="num text-[13px] font-medium text-accent-ink">Step 1</span>
            <h2 className="mt-1 text-lg font-semibold">Connect a runner</h2>
            <p className="mt-1.5 text-[14px] text-muted">
              The runner is a small program on a computer with Claude Code. It does the audits and edits, and it is the only
              place your site passwords are ever decrypted.
            </p>
            <ButtonLink href="/runners" variant="primary" className="mt-5" icon={<Cpu size={16} aria-hidden />}>
              Connect a runner
            </ButtonLink>
          </Card>
          <Card className="p-6 opacity-80">
            <span className="num text-[13px] font-medium text-muted">Step 2</span>
            <h2 className="mt-1 text-lg font-semibold">Add a site</h2>
            <p className="mt-1.5 text-[14px] text-muted">WordPress, Shopify or a GitHub repo. You&apos;ll need admin access to create an API credential.</p>
            <ButtonLink href="/sites?add=1" className="mt-5" icon={<Plus size={16} aria-hidden />}>
              Add a site
            </ButtonLink>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dashboard" description={`${sites.length} ${sites.length === 1 ? "site" : "sites"} under watch`} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Approvals first: this is what someone opening the app on a phone came for */}
        <Card aria-labelledby="dash-approvals">
          <CardHeader
            id="dash-approvals"
            title={
              <span className="flex items-center gap-2">
                Waiting for you
                {pendingTotal > 0 && (
                  <span className="num rounded-full bg-approve-soft px-2 text-[13px] leading-6 text-approve-ink ring-1 ring-approve/30 ring-inset">
                    {pendingTotal}
                  </span>
                )}
              </span>
            }
            description={pendingTotal ? "Soonest to expire first" : undefined}
            action={
              pendingTotal > 0 ? (
                <ButtonLink href="/approvals" size="sm" variant="ghost">
                  Review all
                </ButtonLink>
              ) : undefined
            }
          />
          {pending.length ? (
            <ApprovalsQueueCompact changes={pending} siteNames={Object.fromEntries(siteName)} readOnly={m.role === "viewer"} />
          ) : (
            <EmptyState icon={Inbox} title="Nothing to approve" className="py-8">
              New proposals that need a person will appear here.
            </EmptyState>
          )}
        </Card>

        {/* Runner status */}
        <Card aria-labelledby="dash-runner">
          <CardHeader
            id="dash-runner"
            title="Runner"
            action={
              <ButtonLink href="/runners" size="sm" variant="ghost">
                Manage
              </ButtonLink>
            }
          />
          <CardBody className="space-y-4">
            {runners.length === 0 ? (
              <div>
                <p className="text-[14px] text-muted">No runner connected. Nothing can run until one is online.</p>
                <ButtonLink href="/runners" variant="primary" size="sm" className="mt-3">
                  Connect a runner
                </ButtonLink>
              </div>
            ) : (
              runners.map((r) => {
                const on = isOnline(r.last_seen_at, now);
                const st = r.status as { busy?: boolean };
                return (
                  <div key={r.id}>
                    <div className="flex items-center gap-2">
                      <Dot tone={on ? "ok" : "bad"} />
                      <span className="truncate text-[14px] font-medium text-ink">{r.name}</span>
                      <span className={on ? "text-[12.5px] text-ok-ink" : "text-[12.5px] text-bad-ink"}>
                        {on ? (st.busy ? "Online · working" : "Online") : "Offline"}
                      </span>
                    </div>
                    <p className="mt-0.5 pl-[18px] text-[12px] text-muted">Last seen {timeAgo(r.last_seen_at, now)}</p>
                    <div className="mt-2 pl-[18px]">
                      <RunnerHealth status={r.status} compact />
                    </div>
                  </div>
                );
              })
            )}
            {runners.length > 0 && online.length === 0 && (
              <p className="rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad-ink">
                All runners are offline. Approved changes and schedules wait until one comes back. Run{" "}
                <code className="font-mono">seo-autopilot-runner start</code> on its computer.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Sites */}
      <section aria-labelledby="dash-sites" className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="dash-sites" className="text-[17px] font-semibold">
            Sites
          </h2>
          <ButtonLink href="/sites?add=1" size="sm" variant="ghost" icon={<Plus size={15} aria-hidden />}>
            Add site
          </ButtonLink>
        </div>
        {sites.length === 0 ? (
          <Card>
            <EmptyState icon={Globe} title="No sites yet" action={<ButtonLink href="/sites?add=1" variant="primary">Add a site</ButtonLink>}>
              Add a WordPress, Shopify or repo-based site to start auditing.
            </EmptyState>
          </Card>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sites.map((s) => {
              const p = pendingBySite.get(s.id) ?? 0;
              const conn = s.connection as { ok?: boolean };
              return (
                <li key={s.id}>
                  <Link
                    href={`/sites/${s.id}`}
                    className="flex items-center gap-4 rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong"
                  >
                    <HealthRing score={s.health_score} size={52} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-ink">{s.name}</p>
                      <p className="truncate text-[12.5px] text-muted">
                        {host(s.url)} · {PLATFORM[s.platform]?.label ?? s.platform}
                      </p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                        <span className="text-muted">Audited {timeAgo(s.last_audit_at, now)}</span>
                        {p > 0 && (
                          <span className="font-medium text-approve-ink">
                            <span className="num">{p}</span> waiting
                          </span>
                        )}
                        {conn.ok === false && <span className="font-medium text-bad-ink">Connection failing</span>}
                      </p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="dash-jobs">
          <CardHeader
            id="dash-jobs"
            title="Running now"
            action={
              <ButtonLink href="/jobs" size="sm" variant="ghost">
                All jobs
              </ButtonLink>
            }
          />
          {jobs.length === 0 ? (
            <EmptyState icon={ListChecks} title="No jobs running" className="py-8">
              Scheduled audits start automatically while a runner is online.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line px-5 pb-2">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link href={`/jobs/${j.id}`} className="flex items-center gap-3 py-2.5 hover:text-accent-ink">
                    <JobStatusBadge status={j.status} />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                      {JOB_KIND[j.kind]?.label ?? j.kind}
                      {j.site_id && <span className="text-muted"> · {siteName.get(j.site_id) ?? "site"}</span>}
                    </span>
                    <span className="num text-[12px] text-muted">{j.status === "running" ? duration(j.started_at, null) : timeAgo(j.created_at, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card aria-labelledby="dash-activity">
          <CardHeader
            id="dash-activity"
            title="Recent activity"
            action={
              <ButtonLink href="/activity" size="sm" variant="ghost">
                Full log
              </ButtonLink>
            }
          />
          <CardBody className="pt-0">
            {activity.length ? <ActivityList rows={activity} now={now} /> : <p className="text-[14px] text-muted">Nothing yet.</p>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
