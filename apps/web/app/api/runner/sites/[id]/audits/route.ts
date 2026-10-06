import { z } from "zod";
import { AuditData, policyWithDefaults } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { enqueueJobRow } from "@/lib/jobs";
import { auditHealthScore, flattenFindings } from "@/lib/ingest";
import { authenticateRunner, errorResponse, HttpError, json, loadSiteForRunner, readJson, runnerActor } from "@/lib/runner-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  job_id: z.string().uuid().nullish(),
  depth: z.string().max(20).default("full"),
  audit_data: z.unknown(),
  report_md: z.string().max(2_000_000).nullish(),
  action_plan_md: z.string().max(2_000_000).nullish(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const site = await loadSiteForRunner(runner, id);
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const audit = AuditData.safeParse(parsed.data.audit_data);
    if (!audit.success)
      throw new HttpError(400, `audit_data: ${audit.error.issues.slice(0, 5).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    const a = audit.data;
    const db = createAdmin();
    const health = auditHealthScore(a);
    const now = new Date().toISOString();

    const { data: inserted, error } = await db
      .from("audits")
      .insert({
        org_id: runner.orgId,
        site_id: id,
        job_id: parsed.data.job_id ?? null,
        depth: parsed.data.depth,
        health_score: health,
        business_type: a.summary?.business_type ?? null,
        summary: a.summary ?? {},
        categories: a.categories ?? [],
        action_plan: a.action_plan ?? null,
        report_md: parsed.data.report_md ?? null,
        action_plan_md: parsed.data.action_plan_md ?? null,
      })
      .select("id")
      .single();
    if (error) throw new HttpError(500, error.message);
    const auditId = inserted.id as string;

    const findings = flattenFindings(a).map((f) => ({ ...f, org_id: runner.orgId, site_id: id, audit_id: auditId }));
    for (let i = 0; i < findings.length; i += 500) {
      const { error: fe } = await db.from("findings").insert(findings.slice(i, i + 500));
      if (fe) throw new HttpError(500, `findings: ${fe.message}`);
    }

    // Page-level audits do not move the site's health score.
    const sitePatch: Record<string, unknown> = { last_audit_at: now };
    if (health !== null && parsed.data.depth !== "page") sitePatch.health_score = health;
    await db.from("sites").update(sitePatch).eq("id", id).eq("org_id", runner.orgId);

    let proposeJobId: string | undefined;
    const policy = policyWithDefaults(site.policy);
    if (policy.auto_propose && policy.mode !== "off" && !site.archived_at) {
      proposeJobId = await enqueueJobRow(db, {
        orgId: runner.orgId,
        siteId: id,
        kind: "propose",
        params: { audit_id: auditId },
        parentJobId: parsed.data.job_id ?? null,
      });
    }

    await auditLog({
      orgId: runner.orgId,
      actor: runnerActor(runner),
      action: "audit.stored",
      entity: "audit",
      entityId: auditId,
      data: { site_id: id, health_score: health, findings: findings.length, propose_job_id: proposeJobId ?? null },
    });
    return json({ audit_id: auditId, ...(proposeJobId ? { propose_job_id: proposeJobId } : {}) });
  } catch (e) {
    return errorResponse(e);
  }
}
