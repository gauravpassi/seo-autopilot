import type { Metadata } from "next";
import Link from "next/link";
import { Activity } from "lucide-react";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { AuditLogRow } from "@/lib/types";
import { Card, PageHeader } from "@/components/ui/card";
import { EmptyState, inputClass, selectClass } from "@/components/ui/misc";
import { Table, THead, Th, Td, Tr } from "@/components/ui/table";
import { actorParts, describeAction } from "@/components/shell/activity-list";
import { cn, dateTime } from "@/lib/ui/format";

export const metadata: Metadata = { title: "Activity" };

const PAGE = 100;

const ENTITY_HREF: Record<string, (id: string) => string> = {
  site: (id) => `/sites/${id}`,
  job: (id) => `/jobs/${id}`,
};

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ q?: string; entity?: string; actor?: string; before?: string }> }) {
  const sp = await searchParams;
  const m = await requireMember();
  const supabase = await createClient();
  let q = supabase.from("audit_log").select("*").eq("org_id", m.orgId).order("id", { ascending: false }).limit(PAGE);
  if (sp.entity) q = q.eq("entity", sp.entity);
  if (sp.actor) q = q.ilike("actor", `%${sp.actor.replace(/[%_]/g, "")}%`);
  if (sp.q) q = q.ilike("action", `%${sp.q.replace(/[%_]/g, "")}%`);
  if (sp.before && /^\d+$/.test(sp.before)) q = q.lt("id", Number(sp.before));
  const { data } = await q;
  const rows = (data ?? []) as AuditLogRow[];
  const nextQs = new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.entity ? { entity: sp.entity } : {}), ...(sp.actor ? { actor: sp.actor } : {}), before: String(rows[rows.length - 1]?.id ?? "") });

  return (
    <>
      <PageHeader title="Activity" description="Every decision and state change, from the panel, chat channels, runners and the system." />
      <form className="mb-4 flex flex-wrap gap-2" aria-label="Filter activity">
        <label className="sr-only" htmlFor="act-q">Action contains</label>
        <input id="act-q" name="q" defaultValue={sp.q ?? ""} placeholder="Action, e.g. approved" className={cn(inputClass, "h-9 w-52")} />
        <label className="sr-only" htmlFor="act-actor">Actor contains</label>
        <input id="act-actor" name="actor" defaultValue={sp.actor ?? ""} placeholder="Who, e.g. slack or an email" className={cn(inputClass, "h-9 w-56")} />
        <select name="entity" defaultValue={sp.entity ?? ""} aria-label="Kind of item" className={cn(selectClass, "h-9 w-40")}>
          <option value="">Everything</option>
          <option value="change">Changes</option>
          <option value="job">Jobs</option>
          <option value="site">Sites</option>
          <option value="runner">Runners</option>
          <option value="batch">Notifications</option>
          <option value="member">Team</option>
        </select>
        <button className="h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-raised">Filter</button>
        {(sp.q || sp.actor || sp.entity) && (
          <Link href="/activity" className="h-9 px-2 text-[13px] leading-9 text-muted hover:text-ink">
            Clear
          </Link>
        )}
      </form>
      <Card>
        {rows.length === 0 ? (
          <EmptyState icon={Activity} title="No activity matches">
            Try a broader filter.
          </EmptyState>
        ) : (
          <Table label="Activity log">
            <THead>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
              <Th>Item</Th>
            </THead>
            <tbody>
              {rows.map((r) => {
                const a = actorParts(r.actor);
                const Icon = a.icon;
                const href = r.entity && r.entity_id && ENTITY_HREF[r.entity]?.(r.entity_id);
                return (
                  <Tr key={r.id}>
                    <Td className="text-[13px] whitespace-nowrap text-muted tabular">{dateTime(r.ts)}</Td>
                    <Td>
                      <span className="inline-flex max-w-56 items-center gap-1.5 text-[13.5px]">
                        <Icon size={14} aria-hidden className="shrink-0 text-muted" />
                        <span className="truncate">{a.label}</span>
                        {a.via && a.via !== "runner" && <span className="shrink-0 text-[12px] text-muted">via {a.via}</span>}
                      </span>
                    </Td>
                    <Td className="text-[13.5px]">{describeAction(r)}</Td>
                    <Td className="text-[13px]">
                      {href ? (
                        <Link href={href} className="text-accent-ink hover:underline">
                          {r.entity}
                        </Link>
                      ) : (
                        <span className="text-muted">{r.entity ?? "—"}</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {rows.length === PAGE && (
        <div className="mt-4 text-center">
          <Link href={`/activity?${nextQs}`} className="text-[14px] font-medium text-accent-ink underline underline-offset-4">
            Older activity
          </Link>
        </div>
      )}
    </>
  );
}
