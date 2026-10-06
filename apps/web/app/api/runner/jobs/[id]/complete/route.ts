import { z } from "zod";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { runAfter } from "@/lib/after";
import { notifyEvent } from "@/lib/notify";
import { authenticateRunner, errorResponse, HttpError, json, readJson, runnerActor } from "@/lib/runner-auth";

export const runtime = "nodejs";

const Body = z.object({
  status: z.enum(["succeeded", "failed"]),
  result: z.unknown().optional(),
  error: z.string().max(20000).nullish(),
  cost_usd: z.number().min(0).nullish(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const db = createAdmin();
    const { data: job } = await db
      .from("jobs")
      .select("id, kind, site_id, status, runner_id, cancel_requested, result")
      .eq("id", id)
      .eq("org_id", runner.orgId)
      .maybeSingle();
    if (!job) throw new HttpError(404, "Job not found");
    if (job.runner_id && job.runner_id !== runner.id) throw new HttpError(403, "Job is claimed by another runner");
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return json({ ok: true, already: job.status });

    const { status, error, cost_usd } = parsed.data;
    // A run stopped because the user asked for it is "cancelled", not "failed".
    const final = status === "failed" && job.cancel_requested ? "cancelled" : status;
    // Keep anything the server stored on the job (e.g. propose: manual recommendations) and merge the runner's result.
    const prev = (job.result && typeof job.result === "object" ? job.result : {}) as Record<string, unknown>;
    const incoming = parsed.data.result;
    const result =
      incoming === undefined
        ? (job.result ?? null)
        : incoming && typeof incoming === "object" && !Array.isArray(incoming)
          ? { ...prev, ...(incoming as Record<string, unknown>) }
          : Object.keys(prev).length
            ? { ...prev, value: incoming }
            : incoming;
    await db
      .from("jobs")
      .update({ status: final, result, error: error ?? null, cost_usd: cost_usd ?? null, finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() })
      .eq("id", id);

    await auditLog({
      orgId: runner.orgId,
      actor: runnerActor(runner),
      action: `job.${final}`,
      entity: "job",
      entityId: id,
      data: { kind: job.kind, site_id: job.site_id, cost_usd: cost_usd ?? null, error: error ? error.slice(0, 500) : undefined },
    });

    if (final === "failed") {
      runAfter("notify job_failed", async () => {
        let siteName = "";
        if (job.site_id) {
          const { data: s } = await db.from("sites").select("name").eq("id", job.site_id).maybeSingle();
          siteName = s?.name ?? "";
        }
        await notifyEvent(runner.orgId, "job_failed", {
          title: `${job.kind} job failed${siteName ? ` on ${siteName}` : ""}`,
          lines: [error ? error.slice(0, 500) : "No error message"],
          path: `/jobs/${id}`,
          entity: "job",
          entityId: id,
        });
      });
    }
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
