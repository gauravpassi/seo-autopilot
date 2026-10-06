import { requireMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/shell/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const m = await requireMember();
  const supabase = await createClient();
  const [{ data: org }, { count }] = await Promise.all([
    supabase.from("orgs").select("name").eq("id", m.orgId).maybeSingle(),
    supabase
      .from("changes")
      .select("id", { count: "exact", head: true })
      .eq("org_id", m.orgId)
      .eq("status", "pending_approval"),
  ]);
  return (
    <AppShell orgName={org?.name ?? "Your organization"} email={m.email} role={m.role} pendingCount={count ?? 0}>
      {children}
    </AppShell>
  );
}
