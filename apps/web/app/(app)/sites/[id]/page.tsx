import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Audit, Change, Finding, Runner, Schedule, Site } from "@/lib/types";
import { policyWithDefaults, type AutopilotMode } from "@seo-autopilot/core/schema";
import { LinkTabs } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { host } from "@/lib/ui/format";
import { MODE, PLATFORM } from "@/lib/ui/labels";
import { OverviewTab } from "@/components/sites/tabs/overview-tab";
import { FindingsTab } from "@/components/sites/tabs/findings-tab";
import { ChangesTab } from "@/components/sites/tabs/changes-tab";
import { ReportTab } from "@/components/sites/tabs/report-tab";
import { SchedulesTab } from "@/components/sites/tabs/schedules-tab";
import { PolicyEditor } from "@/components/sites/tabs/policy-editor";
import { ConnectionTab } from "@/components/sites/tabs/connection-tab";
import { HealthRing } from "@/components/shell/health-ring";

const TABS = ["overview", "findings", "changes", "report", "schedules", "policy", "connection"] as const;
type Tab = (typeof TABS)[number];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("sites").select("name").eq("id", id).maybeSingle();
  return { title: data?.name ?? "Site" };
}

export default async function SitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; status?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "overview";
  const m = await requireMember();
  const supabase = await createClient();
  const { data: siteRow } = await supabase.from("sites").select("*").eq("id", id).eq("org_id", m.orgId).maybeSingle();
  if (!siteRow) notFound();
  const site = siteRow as Site;
  const canEdit = m.role !== "viewer"; // run jobs, roll back
  const isAdmin = m.role === "owner" || m.role === "admin"; // policy, schedules, connection
  const policy = policyWithDefaults(site.policy);

  const [{ count: pendingCount }, { data: latestAudit }] = await Promise.all([
    supabase.from("changes").select("id", { count: "exact", head: true }).eq("site_id", id).eq("status", "pending_approval"),
    supabase.from("audits").select("id, created_at, health_score").eq("site_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  let body: React.ReactNode = null;
  if (tab === "overview") {
    const [{ data: audits }, { data: recent }, { data: runner }] = await Promise.all([
      supabase
        .from("audits")
        .select("id, health_score, created_at, categories, depth, business_type")
        .eq("site_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase.from("changes").select("status").eq("site_id", id).limit(2000),
      site.runner_id
        ? supabase.from("runners").select("id, name, last_seen_at").eq("id", site.runner_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    body = (
      <OverviewTab
        site={site}
        audits={(audits ?? []) as Audit[]}
        statusCounts={countBy((recent ?? []) as Array<{ status: string }>)}
        runner={runner as Pick<Runner, "id" | "name" | "last_seen_at"> | null}
        canEdit={canEdit}
      />
    );
  } else if (tab === "findings") {
    const { data } = latestAudit
      ? await supabase.from("findings").select("*").eq("audit_id", latestAudit.id).limit(1000)
      : { data: [] };
    body = <FindingsTab findings={(data ?? []) as Finding[]} auditAt={latestAudit?.created_at ?? null} />;
  } else if (tab === "changes") {
    let q = supabase.from("changes").select("*").eq("site_id", id).order("created_at", { ascending: false }).limit(300);
    if (sp.status) q = q.in("status", sp.status.split(","));
    const { data } = await q;
    body = <ChangesTab siteId={id} changes={(data ?? []) as Change[]} status={sp.status ?? ""} canEdit={canEdit} />;
  } else if (tab === "report") {
    const { data } = await supabase
      .from("audits")
      .select("id, created_at, report_md, action_plan_md, health_score")
      .eq("site_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    body = <ReportTab audit={data as Pick<Audit, "id" | "created_at" | "report_md" | "action_plan_md" | "health_score"> | null} />;
  } else if (tab === "schedules") {
    const { data } = await supabase.from("schedules").select("*").eq("site_id", id).order("created_at");
    body = <SchedulesTab siteId={id} schedules={(data ?? []) as Schedule[]} canEdit={isAdmin} hasGsc={!!(site.config as { gsc_property?: string }).gsc_property} />;
  } else if (tab === "policy") {
    body = <PolicyEditor siteId={id} platform={site.platform} initial={policy} canEdit={isAdmin} />;
  } else if (tab === "connection") {
    const [{ data: runners }, { data: secret }] = await Promise.all([
      supabase.from("runners").select("id, name, public_key, last_seen_at, version").eq("org_id", m.orgId).is("revoked_at", null),
      supabase.from("site_secrets").select("runner_id, hint, updated_at").eq("site_id", id).maybeSingle(),
    ]);
    body = (
      <ConnectionTab
        site={site}
        runners={(runners ?? []) as Pick<Runner, "id" | "name" | "public_key" | "last_seen_at" | "version">[]}
        secret={secret as { runner_id: string; hint: string | null; updated_at: string } | null}
        canEdit={isAdmin}
      />
    );
  }

  const mode = (policy.mode ?? "suggest") as AutopilotMode;

  return (
    <>
      <header className="mb-5 flex items-center gap-4">
        <HealthRing score={site.health_score ?? (latestAudit as { health_score?: number | null } | null)?.health_score ?? null} size={60} className="hidden sm:grid" />
        <div className="min-w-0">
          <h1 className="truncate text-[26px] leading-tight font-semibold sm:text-[30px]">{site.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-muted">
            <a href={site.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-accent-ink">
              {host(site.url)}
              <ExternalLink size={13} aria-hidden />
              <span className="sr-only">(opens site)</span>
            </a>
            <span>{PLATFORM[site.platform]?.label}</span>
            <Badge tone={mode === "auto" ? "auto" : mode === "off" ? "never" : "neutral"} title={MODE[mode].detail}>
              {MODE[mode].label} mode
            </Badge>
          </p>
        </div>
      </header>
      <LinkTabs
        label="Site sections"
        active={tab}
        items={([
          { id: "overview", label: "Overview" },
          { id: "findings", label: "Findings" },
          { id: "changes", label: "Changes", count: pendingCount },
          { id: "report", label: "Report" },
          { id: "schedules", label: "Schedules" },
          { id: "policy", label: "Policy" },
          { id: "connection", label: "Connection" },
        ] as Array<{ id: string; label: string; count?: number | null }>).map((t) => ({
          ...t,
          href: t.id === "overview" ? `/sites/${id}` : `/sites/${id}?tab=${t.id}`,
        }))}
      />
      <div className="mt-6" role="tabpanel" aria-label={tab}>
        {body}
      </div>
    </>
  );
}

function countBy(rows: Array<{ status: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}
