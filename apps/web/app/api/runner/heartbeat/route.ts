import { z } from "zod";
import { createAdmin } from "@/lib/supabase/server";
import { authenticateRunner, errorResponse, HttpError, json, readJson } from "@/lib/runner-auth";

export const runtime = "nodejs";

const Body = z.object({
  version: z.string().max(50).optional(),
  status: z.record(z.string(), z.unknown()).optional().default({}),
});

export async function POST(req: Request) {
  try {
    const runner = await authenticateRunner(req);
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, "Invalid heartbeat body");
    const now = new Date().toISOString();
    const db = createAdmin();
    await db
      .from("runners")
      .update({ status: parsed.data.status, version: parsed.data.version ?? undefined, last_seen_at: now })
      .eq("id", runner.id);
    // Keep the running job alive while the runner is busy on it.
    const jobId = (parsed.data.status as { job_id?: unknown }).job_id;
    if (typeof jobId === "string" && /^[0-9a-f-]{36}$/i.test(jobId)) {
      await db.from("jobs").update({ heartbeat_at: now }).eq("id", jobId).eq("runner_id", runner.id).eq("status", "running");
    }
    return json({ ok: true, server_time: now });
  } catch (e) {
    return errorResponse(e);
  }
}
