import type { Metadata } from "next";
import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Change } from "@/lib/types";
import { PageHeader } from "@/components/ui/card";
import { ApprovalsQueue } from "@/components/changes/approvals-queue";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const m = await requireMember();
  const supabase = await createClient();
  const [{ data: changes }, { data: sites }] = await Promise.all([
    supabase
      .from("changes")
      .select("*")
      .eq("org_id", m.orgId)
      .eq("status", "pending_approval")
      .order("expires_at", { ascending: true, nullsFirst: false })
      .limit(200),
    supabase.from("sites").select("id, name").eq("org_id", m.orgId).is("archived_at", null).order("name"),
  ]);
  const list = (changes ?? []) as Change[];

  return (
    <>
      <PageHeader
        title="Approvals"
        description={
          list.length
            ? "Each card shows exactly what will change on the live site, why, and what the risk check found. Nothing is applied until someone approves it."
            : undefined
        }
      />
      <ApprovalsQueue changes={list} sites={sites ?? []} readOnly={m.role === "viewer"} />
    </>
  );
}
