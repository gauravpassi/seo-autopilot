/**
 * Adapter factory. Platform adapters live in @seo-autopilot/core/adapters/*.
 */
import type { AdapterContext } from "@seo-autopilot/core/adapters/index";
import type { ChangeRecord, ChangeType, ConnectionResult, Platform, ResourceRef, SiteAdapter } from "@seo-autopilot/core";
import { createWordPressAdapter } from "@seo-autopilot/core/adapters/wordpress";
import { createShopifyAdapter } from "@seo-autopilot/core/adapters/shopify";
import { createRepoAdapter, type RepoAdapter } from "@seo-autopilot/core/adapters/repo";

export type { RepoAdapter };

/** Sites on "other" can't be written to; everything becomes manual advice. */
export function createOtherAdapter(ctx: AdapterContext): SiteAdapter {
  return {
    platform: "other",
    async capabilities(): Promise<ChangeType[]> {
      return [];
    },
    async testConnection(): Promise<ConnectionResult> {
      const f = ctx.fetch ?? fetch;
      try {
        const res = await f(ctx.site.url, { redirect: "follow" });
        return {
          ok: res.ok,
          details: { status: res.status, final_url: res.url },
          warnings: res.ok ? ["Platform 'other': fixes are proposed as manual advice only"] : [`Site returned HTTP ${res.status}`],
        };
      } catch (e) {
        return { ok: false, details: { error: (e as Error).message }, warnings: [] };
      }
    },
    async resolve(): Promise<ResourceRef | null> {
      return null;
    },
    async read(): Promise<unknown> {
      return null;
    },
    async apply(_c: ChangeRecord): Promise<never> {
      throw new Error("This site's platform is 'other'; changes can't be applied automatically");
    },
    async rollback(_c: ChangeRecord): Promise<never> {
      throw new Error("This site's platform is 'other'; nothing to roll back");
    },
  };
}

export function createAdapter(platform: Platform, ctx: AdapterContext, opts: { repoAutoMerge?: boolean } = {}): SiteAdapter {
  switch (platform) {
    case "wordpress":
      return createWordPressAdapter(ctx);
    case "shopify":
      return createShopifyAdapter(ctx);
    case "repo":
      return createRepoAdapter(ctx, { repoAutoMerge: opts.repoAutoMerge });
    case "other":
      return createOtherAdapter(ctx);
    default:
      throw new Error(`Unknown platform ${String(platform)}`);
  }
}
