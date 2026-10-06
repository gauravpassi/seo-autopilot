import type { Metadata } from "next";
import Link from "next/link";
import { Globe, Plus } from "lucide-react";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Runner, Site } from "@/lib/types";
import { Card, PageHeader } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Table, THead, Th, Td, Tr } from "@/components/ui/table";
import { HealthRing } from "@/components/shell/health-ring";
import { AddSiteWizard } from "@/components/sites/add-site-wizard";
import { host, timeAgo } from "@/lib/ui/format";
import { MODE, PLATFORM } from "@/lib/ui/labels";
import type { AutopilotMode } from "@seo-autopilot/core/schema";

export const metadata: Metadata = { title: "Sites" };

export default async function SitesPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
  const { add } = await searchParams;
  const m = await requireMember();
  const supabase = await createClient();
  const [{ data: sitesData }, { data: runnersData }, { data: pend }] = await Promise.all([
    supabase.from("sites").select("*").eq("org_id", m.orgId).is("archived_at", null).order("name"),
    supabase
      .from("runners")
      .select("id, name, public_key, last_seen_at, version, revoked_at")
      .eq("org_id", m.orgId)
      .is("revoked_at", null)
      .order("created_at"),
    supabase.from("changes").select("site_id").eq("org_id", m.orgId).eq("status", "pending_approval").limit(1000),
  ]);
  const sites = (sitesData ?? []) as Site[];
  const runners = (runnersData ?? []) as Pick<Runner, "id" | "name" | "public_key" | "last_seen_at" | "version">[];
  const pending = new Map<string, number>();
  for (const r of (pend ?? []) as Array<{ site_id: string }>) pending.set(r.site_id, (pending.get(r.site_id) ?? 0) + 1);
  const canEdit = m.role === "owner" || m.role === "admin";
  const showWizard = add === "1" && canEdit;

  return (
    <>
      <PageHeader
        title="Sites"
        description="Every site the agent audits. Open one to see findings, changes and its autopilot policy."
        actions={
          canEdit && !showWizard ? (
            <ButtonLink href="/sites?add=1" variant="primary" icon={<Plus size={16} aria-hidden />}>
              Add site
            </ButtonLink>
          ) : undefined
        }
      />

      {showWizard && (
        <div className="mb-8">
          <AddSiteWizard runners={runners} />
        </div>
      )}

      {sites.length === 0 ? (
        !showWizard && (
          <Card>
            <EmptyState
              icon={Globe}
              title="No sites yet"
              action={canEdit ? <ButtonLink href="/sites?add=1" variant="primary">Add your first site</ButtonLink> : undefined}
            >
              You&apos;ll need admin access to the site to create an API credential for the agent.
            </EmptyState>
          </Card>
        )
      ) : (
        <Card>
          {/* phones: stacked list */}
          <ul className="divide-y divide-line md:hidden">
            {sites.map((s) => (
              <li key={s.id}>
                <Link href={`/sites/${s.id}`} className="flex items-center gap-3 px-4 py-3">
                  <HealthRing score={s.health_score} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold">{s.name}</p>
                    <p className="truncate text-[12.5px] text-muted">
                      {host(s.url)} · {PLATFORM[s.platform]?.label}
                    </p>
                  </div>
                  {(pending.get(s.id) ?? 0) > 0 && <Badge tone="approve">{pending.get(s.id)} waiting</Badge>}
                </Link>
              </li>
            ))}
          </ul>
          <Table className="hidden md:block" label="Sites">
            <THead>
              <Th>Site</Th>
              <Th>Health</Th>
              <Th>Platform</Th>
              <Th>Mode</Th>
              <Th>Waiting</Th>
              <Th>Connection</Th>
              <Th>Last audit</Th>
            </THead>
            <tbody>
              {sites.map((s) => {
                const conn = s.connection as { ok?: boolean };
                const mode = ((s.policy as { mode?: AutopilotMode }).mode ?? "suggest") as AutopilotMode;
                return (
                  <Tr key={s.id}>
                    <Td>
                      <Link href={`/sites/${s.id}`} className="font-semibold text-ink hover:text-accent-ink">
                        {s.name}
                      </Link>
                      <div className="text-[12.5px] text-muted">{host(s.url)}</div>
                    </Td>
                    <Td>
                      <HealthRing score={s.health_score} size={36} />
                    </Td>
                    <Td className="text-ink-2">{PLATFORM[s.platform]?.label ?? s.platform}</Td>
                    <Td>
                      <Badge tone={mode === "auto" ? "auto" : mode === "off" ? "never" : "neutral"}>{MODE[mode].label}</Badge>
                    </Td>
                    <Td>
                      {(pending.get(s.id) ?? 0) > 0 ? (
                        <Link href="/approvals" className="num font-semibold text-approve-ink hover:underline">
                          {pending.get(s.id)}
                        </Link>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </Td>
                    <Td>
                      {conn.ok === true ? (
                        <Badge tone="ok">Connected</Badge>
                      ) : conn.ok === false ? (
                        <Badge tone="bad">Failing</Badge>
                      ) : (
                        <Badge>Not tested</Badge>
                      )}
                    </Td>
                    <Td className="text-[13px] whitespace-nowrap text-muted">{timeAgo(s.last_audit_at)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
