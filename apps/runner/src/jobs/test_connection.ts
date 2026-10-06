import type { SiteConfig } from "@seo-autopilot/core";
import { requireSite, type JobContext, type JobResult } from "./context";
import type { RepoAdapter } from "../adapters";

/** adapter.testConnection() + capabilities() → POST /sites/:id/connection. */
export async function testConnectionJob(ctx: JobContext): Promise<JobResult> {
  const site = requireSite(ctx);
  const adapter = ctx.adapter();
  ctx.log("info", `Testing ${site.platform} connection to ${site.url}`);
  const conn = await adapter.testConnection();
  let capabilities = conn.ok ? await adapter.capabilities().catch((e) => {
    conn.warnings.push(`Could not list capabilities: ${(e as Error).message}`);
    return [];
  }) : [];

  const config_patch: Partial<SiteConfig> = {};
  const d = conn.details ?? {};
  if (site.platform === "wordpress" && "bridge_version" in d) config_patch.wp_bridge = d.bridge_version != null;
  if (site.platform === "wordpress" && typeof d.wp_bridge === "boolean") config_patch.wp_bridge = d.wp_bridge;
  if (site.platform === "shopify" && typeof d.api_version === "string") config_patch.shopify_api_version = d.api_version;
  if (site.platform === "repo") {
    if (typeof d.framework === "string" && d.framework !== "unknown") config_patch.framework = d.framework;
    if (conn.ok && !config_patch.framework) {
      // Detect from a fresh checkout so the panel can show it and repo-fix gets the right hints.
      try {
        const repo = adapter as RepoAdapter;
        const co = await repo.prepareCheckout({ jobId: ctx.job.id });
        const fw = await repo.detectFramework(co.dir);
        if (fw.framework !== "unknown") config_patch.framework = fw.framework;
        ctx.log("info", `Detected framework: ${fw.framework}`);
      } catch (e) {
        conn.warnings.push(`Framework detection failed: ${(e as Error).message}`);
      }
    }
  }
  if (!conn.ok) capabilities = [];

  for (const w of conn.warnings) ctx.log("warn", w);
  ctx.log(conn.ok ? "info" : "error", `Connection ${conn.ok ? "OK" : "FAILED"}; can apply: ${capabilities.join(", ") || "nothing"}`);
  await ctx.api.postConnection(site.id, {
    ...conn,
    capabilities,
    ...(Object.keys(config_patch).length ? { config_patch } : {}),
  });
  if (!conn.ok) {
    throw new Error(`Connection test failed${conn.warnings.length ? `: ${conn.warnings.join("; ")}` : ""}`);
  }
  return { ok: conn.ok, capabilities, warnings: conn.warnings, config_patch };
}
