import type { Metadata } from "next";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Runner } from "@/lib/types";
import { PageHeader } from "@/components/ui/card";
import { RunnersView } from "@/components/runners/runners-view";
import { appUrl } from "@/lib/ui/app-url";

export const metadata: Metadata = { title: "Runners" };

export default async function RunnersPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams;
  const m = await requireMember();
  const supabase = await createClient();
  const [{ data }, { data: sites }, url] = await Promise.all([
    supabase
      .from("runners")
      .select("id, org_id, name, public_key, status, version, last_seen_at, revoked_at, registration_expires_at, created_at")
      .eq("org_id", m.orgId)
      .is("revoked_at", null)
      .order("created_at"),
    supabase.from("sites").select("id, runner_id").eq("org_id", m.orgId).is("archived_at", null),
    appUrl(),
  ]);
  const siteCount: Record<string, number> = {};
  for (const s of (sites ?? []) as Array<{ runner_id: string | null }>) if (s.runner_id) siteCount[s.runner_id] = (siteCount[s.runner_id] ?? 0) + 1;

  return (
    <>
      <PageHeader
        title="Runners"
        description="A runner is a small program on a computer that has Claude Code installed. It picks up jobs from this panel, runs claude-seo, and is the only place site credentials are decrypted."
      />
      <RunnersView runners={(data ?? []) as Runner[]} appUrl={url} canEdit={m.role === "owner" || m.role === "admin"} siteCount={siteCount} openConnect={welcome === "1"} />
    </>
  );
}
