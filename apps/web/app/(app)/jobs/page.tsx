import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Job } from "@/lib/types";
import { Card, PageHeader } from "@/components/ui/card";
import { JobStatusBadge } from "@/components/ui/badge";
import { EmptyState, selectClass } from "@/components/ui/misc";
import { Table, THead, Th, Td, Tr } from "@/components/ui/table";
import { cn, dateTime, duration, money, timeAgo } from "@/lib/ui/format";
import { JOB_KIND, JOB_STATUS } from "@/lib/ui/labels";
import { AutoRefresh } from "@/components/jobs/auto-refresh";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ status?: string; kind?: string; site?: string }> }) {
  const sp = await searchParams;
  const m = await requireMember();
  const supabase = await createClient();
  let q = supabase.from("jobs").select("*").eq("org_id", m.orgId).order("created_at", { ascending: false }).limit(100);
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.kind) q = q.eq("kind", sp.kind);
  if (sp.site) q = q.eq("site_id", sp.site);
  const [{ data }, { data: sites }] = await Promise.all([q, supabase.from("sites").select("id, name").eq("org_id", m.orgId)]);
  const jobs = (data ?? []) as Job[];
  const siteName = new Map((sites ?? []).map((s: { id: string; name: string }) => [s.id, s.name]));
  const live = jobs.some((j) => j.status === "running" || j.status === "queued");

  return (
    <>
      <PageHeader title="Jobs" description="Everything the runner has done or is about to do. Open a job to watch its log live." />
      <AutoRefresh enabled={live} />
      <form className="mb-4 flex flex-wrap gap-2" aria-label="Filter jobs">
        <select name="status" defaultValue={sp.status ?? ""} aria-label="Status" className={cn(selectClass, "h-9 w-40")}>
          <option value="">Any status</option>
          {Object.entries(JOB_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select name="kind" defaultValue={sp.kind ?? ""} aria-label="Kind" className={cn(selectClass, "h-9 w-44")}>
          <option value="">Any kind</option>
          {Object.entries(JOB_KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select name="site" defaultValue={sp.site ?? ""} aria-label="Site" className={cn(selectClass, "h-9 w-44")}>
          <option value="">All sites</option>
          {(sites ?? []).map((s: { id: string; name: string }) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-raised">Apply</button>
      </form>
      <Card>
        {jobs.length === 0 ? (
          <EmptyState icon={ListChecks} title="No jobs yet">
            Jobs appear when you run an audit from a site, or when a schedule fires while a runner is online.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line md:hidden">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link href={`/jobs/${j.id}`} className="block px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14.5px] font-semibold">{JOB_KIND[j.kind]?.label ?? j.kind}</span>
                      <JobStatusBadge status={j.status} />
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-muted">
                      {j.site_id ? siteName.get(j.site_id) ?? "Site" : "No site"} · {timeAgo(j.created_at)} · {duration(j.started_at, j.finished_at)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
            <Table className="hidden md:block" label="Jobs">
              <THead>
                <Th>Job</Th>
                <Th>Site</Th>
                <Th>Status</Th>
                <Th>Started</Th>
                <Th className="text-right">Duration</Th>
                <Th className="text-right">Cost</Th>
              </THead>
              <tbody>
                {jobs.map((j) => (
                  <Tr key={j.id}>
                    <Td>
                      <Link href={`/jobs/${j.id}`} className="font-medium text-ink hover:text-accent-ink">
                        {JOB_KIND[j.kind]?.label ?? j.kind}
                      </Link>
                      {j.schedule_id && <span className="ml-2 text-[12px] text-muted">scheduled</span>}
                      {j.error && <p className="max-w-md truncate text-[12px] text-bad-ink">{j.error}</p>}
                    </Td>
                    <Td className="text-ink-2">{j.site_id ? siteName.get(j.site_id) ?? "—" : "—"}</Td>
                    <Td>
                      <JobStatusBadge status={j.status} />
                    </Td>
                    <Td className="text-[13px] whitespace-nowrap text-muted">{dateTime(j.started_at ?? j.created_at)}</Td>
                    <Td className="num text-right text-[13px] text-ink-2">{duration(j.started_at, j.finished_at)}</Td>
                    <Td className="num text-right text-[13px] text-ink-2">{money(j.cost_usd)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card>
    </>
  );
}
