import { policyWithDefaults, type SealedEnvelope } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { authenticateRunner, errorResponse, json, loadSiteForRunner } from "@/lib/runner-auth";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const site = await loadSiteForRunner(runner, id);
    const { data: sec } = await createAdmin().from("site_secrets").select("ciphertext, runner_id").eq("site_id", id).eq("org_id", runner.orgId).maybeSingle();
    const secret = sec && sec.runner_id === runner.id ? (sec.ciphertext as SealedEnvelope) : null;
    return json({ site: { ...site, policy: policyWithDefaults(site.policy) }, secret });
  } catch (e) {
    return errorResponse(e);
  }
}
