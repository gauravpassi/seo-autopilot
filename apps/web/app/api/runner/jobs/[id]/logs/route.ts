import { z } from "zod";
import { createAdmin } from "@/lib/supabase/server";
import { authenticateRunner, errorResponse, HttpError, json, readJson } from "@/lib/runner-auth";

export const runtime = "nodejs";

const LEVELS = ["debug", "info", "warn", "error", "agent", "tool"] as const;
const MAX_LINES = 500;
const MAX_CHARS = 8000;

const Body = z.object({
  lines: z
    .array(
      z.object({
        ts: z.string().optional(),
        level: z.string().optional(),
        message: z.unknown(),
      }),
    )
    .default([]),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, "Body must be { lines: [{ ts, level, message }] }");
    const db = createAdmin();
    const { data: job } = await db.from("jobs").select("id, runner_id, cancel_requested").eq("id", id).eq("org_id", runner.orgId).maybeSingle();
    if (!job) throw new HttpError(404, "Job not found");
    if (job.runner_id && job.runner_id !== runner.id) throw new HttpError(403, "Job is claimed by another runner");

    const rows = parsed.data.lines.slice(0, MAX_LINES).map((l) => {
      const ts = l.ts && !Number.isNaN(Date.parse(l.ts)) ? new Date(l.ts).toISOString() : new Date().toISOString();
      const level = (LEVELS as readonly string[]).includes(String(l.level)) ? String(l.level) : "info";
      const raw = typeof l.message === "string" ? l.message : JSON.stringify(l.message);
      const message = (raw ?? "").length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS - 12)}…[truncated]` : raw ?? "";
      return { job_id: id, ts, level, message };
    });
    if (rows.length > 0) {
      const { error } = await db.from("job_logs").insert(rows);
      if (error) throw new HttpError(500, error.message);
    }
    await db.from("jobs").update({ heartbeat_at: new Date().toISOString() }).eq("id", id);
    return json({ ok: true, cancel_requested: !!job.cancel_requested, accepted: rows.length });
  } catch (e) {
    return errorResponse(e);
  }
}
