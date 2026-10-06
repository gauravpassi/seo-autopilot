import { policyWithDefaults, type SealedEnvelope } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { authenticateRunner, errorResponse, HttpError, json } from "@/lib/runner-auth";
import type { Job, Site } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const runner = await authenticateRunner(req);
    const db = createAdmin();
    const { data, error } = await db.rpc("claim_job", { p_runner: runner.id });
    if (error) throw new HttpError(500, error.message);
    const job = ((Array.isArray(data) ? data[0] : data) ?? null) as Job | null;
    if (!job || !job.id) return json({ job: null, site: null, secret: null });

    let site: Site | null = null;
    let secret: SealedEnvelope | null = null;
    if (job.site_id) {
      const { data: s } = await db.from("sites").select("*").eq("id", job.site_id).eq("org_id", runner.orgId).maybeSingle();
      if (s) {
        site = { ...(s as Site), policy: policyWithDefaults((s as Site).policy) as unknown as Record<string, unknown> };
        const { data: sec } = await db
          .from("site_secrets")
          .select("ciphertext, runner_id")
          .eq("site_id", job.site_id)
          .eq("org_id", runner.orgId)
          .maybeSingle();
        if (sec && sec.runner_id === runner.id) secret = sec.ciphertext as SealedEnvelope;
      }
    }
    return json({ job, site, secret });
  } catch (e) {
    return errorResponse(e);
  }
}
