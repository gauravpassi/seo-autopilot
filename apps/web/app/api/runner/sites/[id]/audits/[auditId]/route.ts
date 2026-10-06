import { createAdmin } from "@/lib/supabase/server";
import { authenticateRunner, errorResponse, HttpError, json, loadSiteForRunner } from "@/lib/runner-auth";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; auditId: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id, auditId } = await ctx.params;
    await loadSiteForRunner(runner, id);
    const db = createAdmin();
    const { data: audit } = await db.from("audits").select("*").eq("id", auditId).eq("site_id", id).eq("org_id", runner.orgId).maybeSingle();
    if (!audit) throw new HttpError(404, "Audit not found");
    const { data: findings } = await db.from("findings").select("*").eq("audit_id", auditId).order("created_at");
    return json({ audit, findings: findings ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}
