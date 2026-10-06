import { z } from "zod";
import { ChangeType, SiteConfig } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { authenticateRunner, errorResponse, HttpError, json, loadSiteForRunner, readJson, runnerActor } from "@/lib/runner-auth";

export const runtime = "nodejs";

const Body = z.object({
  ok: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(z.string()).default([]),
  capabilities: z.array(ChangeType).default([]),
  config_patch: SiteConfig.partial().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const site = await loadSiteForRunner(runner, id);
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    const connection = { ok: b.ok, details: b.details, warnings: b.warnings, capabilities: b.capabilities, tested_at: new Date().toISOString(), runner_id: runner.id };
    const config = b.config_patch ? { ...(site.config ?? {}), ...b.config_patch } : site.config;
    const { error } = await createAdmin().from("sites").update({ connection, config }).eq("id", id).eq("org_id", runner.orgId);
    if (error) throw new HttpError(500, error.message);
    await auditLog({ orgId: runner.orgId, actor: runnerActor(runner), action: b.ok ? "site.connection_ok" : "site.connection_failed", entity: "site", entityId: id, data: { warnings: b.warnings, capabilities: b.capabilities } });
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
