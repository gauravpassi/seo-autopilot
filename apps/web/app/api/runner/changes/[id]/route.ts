import { z } from "zod";
import { ChangeStatus } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { runAfter } from "@/lib/after";
import { notifyEvent } from "@/lib/notify";
import { updateApprovalMessages } from "@/lib/approvals";
import { canTransition, notifyKindFor, timestampsFor } from "@/lib/transitions";
import { typeLabel, shortUrl, valueText } from "@/lib/notify/format";
import { authenticateRunner, errorResponse, HttpError, json, readJson, runnerActor } from "@/lib/runner-auth";

export const runtime = "nodejs";

const Body = z.object({
  status: ChangeStatus,
  before: z.unknown().optional(),
  rollback_data: z.unknown().optional(),
  verify_result: z.unknown().optional(),
  pr_url: z.string().url().nullish(),
  error: z.string().max(20000).nullish(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    const db = createAdmin();
    const { data: change } = await db.from("changes").select("id, site_id, status, type, target, after").eq("id", id).eq("org_id", runner.orgId).maybeSingle();
    if (!change) throw new HttpError(404, "Change not found");
    if (!canTransition(change.status, b.status)) throw new HttpError(409, `Transition ${change.status} → ${b.status} is not allowed`);

    const patch: Record<string, unknown> = { status: b.status, ...timestampsFor(b.status) };
    if (b.before !== undefined) patch.before = b.before;
    if (b.rollback_data !== undefined) patch.rollback_data = b.rollback_data;
    if (b.verify_result !== undefined) patch.verify_result = b.verify_result;
    if (b.pr_url !== undefined) patch.pr_url = b.pr_url;
    if (b.error !== undefined) patch.error = b.error;
    if (b.status === "rolled_back") patch.verified_at = null;

    // Compare-and-set on the old status so concurrent reports cannot skip a step.
    const { data: updated, error } = await db.from("changes").update(patch).eq("id", id).eq("status", change.status).select("id").maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!updated) throw new HttpError(409, "Change status changed concurrently; re-read and retry");

    await auditLog({
      orgId: runner.orgId,
      actor: runnerActor(runner),
      action: `change.${b.status}`,
      entity: "change",
      entityId: id,
      data: { from: change.status, site_id: change.site_id, pr_url: b.pr_url ?? undefined, error: b.error ? b.error.slice(0, 500) : undefined },
    });

    const kind = notifyKindFor(b.status);
    runAfter("change status side effects", async () => {
      await updateApprovalMessages(runner.orgId, [id]);
      if (!kind) return;
      const { data: s } = await db.from("sites").select("name").eq("id", change.site_id).maybeSingle();
      const url = (change.target as { url?: string })?.url ?? "";
      const verb = b.status === "verify_failed" ? "failed verification" : b.status === "rolled_back" ? "was rolled back" : "failed to apply";
      await notifyEvent(runner.orgId, kind, {
        title: `${typeLabel(change.type)} on ${shortUrl(url)} ${verb}${s?.name ? ` (${s.name})` : ""}`,
        lines: [`Change: ${valueText(change.type, change.after).slice(0, 300)}`, ...(b.error ? [`Error: ${b.error.slice(0, 500)}`] : [])],
        path: `/sites/${change.site_id}?tab=changes`,
        entity: "change",
        entityId: id,
      });
    });
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
