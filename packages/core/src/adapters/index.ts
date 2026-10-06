/**
 * Adapter factory. Implementations: wordpress.ts, shopify.ts, repo.ts.
 */
import type { SiteAdapter, SiteConfig, SiteSecrets } from "../schema";
import { createWordPressAdapter } from "./wordpress";
import { createShopifyAdapter } from "./shopify";
import { createRepoAdapter } from "./repo";

export interface AdapterSite {
  id: string;
  url: string;            // site origin
  platform: "wordpress" | "shopify" | "repo" | "other";
  config: SiteConfig;
}

export interface AdapterContext {
  site: AdapterSite;
  secrets: SiteSecrets;
  /** Structured logger supplied by the runner. */
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** Injected fetch, for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Repo adapter only: local directory for git checkouts. */
  workDir?: string;
}

export type AdapterFactory = (ctx: AdapterContext) => SiteAdapter;

/** Create the adapter for a site's platform. "other" sites have no write access. */
export function createAdapter(ctx: AdapterContext, opts: { repoAutoMerge?: boolean } = {}): SiteAdapter | null {
  switch (ctx.site.platform) {
    case "wordpress":
      return createWordPressAdapter(ctx);
    case "shopify":
      return createShopifyAdapter(ctx);
    case "repo":
      return createRepoAdapter(ctx, { repoAutoMerge: opts.repoAutoMerge });
    default:
      return null;
  }
}

/** Errors whose message starts with "manual:" mean "a person has to do this", not a failure. */
export function isManualError(err: unknown): boolean {
  return err instanceof Error && /^manual:/i.test(err.message);
}
