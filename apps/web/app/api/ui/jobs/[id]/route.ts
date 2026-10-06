import { getMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** GET /api/ui/jobs/:id?after=<logId> → { job, logs } (session + RLS). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const m = await getMembership();
  if (!m) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0) || 0;
  const supabase = await createClient();
  const { data: job } = await supabase.from("jobs").select("*").eq("id", id).maybeSingle();
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const { data: logs } = await supabase.from("job_logs").select("*").eq("job_id", id).gt("id", after).order("id", { ascending: true }).limit(1000);
  return Response.json({ job, logs: logs ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
