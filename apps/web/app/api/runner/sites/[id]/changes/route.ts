import { ChangeStatus } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { runAfter } from "@/lib/after";
import { notifyPending } from "@/lib/notify";
import { ingestProposals } from "@/lib/change-ingest";
import { ChangesBody } from "@/lib/ingest";
import { authenticateRunner, errorResponse, HttpError, json, loadSiteForRunner, readJson, runnerActor } from "@/lib/runner-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const site = await loadSiteForRunner(runner, id);
    const parsed = ChangesBody.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const db = createAdmin();

    const r = await ingestProposals(db, {
      orgId: runner.orgId,
      site,
      jobId: parsed.data.job_id ?? null,
      auditId: parsed.data.audit_id ?? null,
      proposals: parsed.data.proposals,
      manualRecommendations: parsed.data.manual_recommendations,
    });

    await auditLog({
      orgId: runner.orgId,
      actor: runnerActor(runner),
      action: "changes.proposed",
      entity: "batch",
      entityId: r.batch_id,
      data: {
        site_id: id,
        job_id: parsed.data.job_id ?? null,
        created: r.created.length,
        pending: r.pendingIds.length,
        auto_approved: r.approvedIds.length,
        blocked: r.created.filter((c) => c.status === "blocked").length,
        rejected: r.rejected.length,
        duplicates: r.duplicates.length,
        apply_job_id: r.applyJobId,
      },
    });

    if (r.pendingIds.length > 0) runAfter("notify pending", () => notifyPending(runner.orgId, r.pendingIds));

    return json({
      batch_id: r.batch_id,
      created: r.created,
      rejected: r.rejected,
      duplicates: r.duplicates,
      apply_job_id: r.applyJobId,
      manual_recommendations: r.manual_recommendations,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    await loadSiteForRunner(runner, id);
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const idsParam = url.searchParams.get("ids");
    let q = createAdmin().from("changes").select("*").eq("site_id", id).eq("org_id", runner.orgId).order("created_at");
    if (statusParam) {
      const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = statuses.filter((s) => !ChangeStatus.safeParse(s).success);
      if (bad.length) throw new HttpError(400, `Unknown status: ${bad.join(", ")}`);
      q = q.in("status", statuses);
    }
    if (idsParam) q = q.in("id", idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500));
    const { data, error } = await q.limit(1000);
    if (error) throw new HttpError(500, error.message);
    return json({ changes: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}
