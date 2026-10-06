import { getMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** GET /api/ui/overview → { runners, pending_count, running_jobs, recent_changes } (session + RLS). */
export async function GET() {
  const m = await getMembership();
  if (!m) return Response.json({ error: "unauthorized" }, { status: 401 });
  const supabase = await createClient();
  const [runners, pending, running, recent] = await Promise.all([
    supabase
      .from("runners")
      .select("id, org_id, name, public_key, status, version, last_seen_at, revoked_at, registration_expires_at, created_at")
      .eq("org_id", m.orgId)
      .is("revoked_at", null)
      .order("created_at"),
    supabase.from("changes").select("id", { count: "exact", head: true }).eq("org_id", m.orgId).eq("status", "pending_approval"),
    supabase.from("jobs").select("*").eq("org_id", m.orgId).in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(20),
    supabase
      .from("changes")
      .select("id, site_id, type, target, status, tier, approved_via, approver_label, decided_at, applied_at, verified_at, pr_url, updated_at")
      .eq("org_id", m.orgId)
      .order("updated_at", { ascending: false })
      .limit(10),
  ]);
  return Response.json(
    { runners: runners.data ?? [], pending_count: pending.count ?? 0, running_jobs: running.data ?? [], recent_changes: recent.data ?? [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
