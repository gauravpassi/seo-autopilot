/**
 * Helpers shared by apply / verify / rollback.
 */
import { diffHash, type ChangeRecord, type Platform } from "@seo-autopilot/core";
import { verifyChange, verifyWithRetry, type VerifyResult } from "@seo-autopilot/core/verify";
import type { ChangeUpdate } from "../api";
import type { JobContext } from "./context";

/** Verify retry schedules per platform (caches: WordPress ~2 min, Shopify up to 30 min). */
export const VERIFY_DELAYS_MS: Record<Platform, number[]> = {
  wordpress: [0, 15_000, 45_000, 120_000],
  shopify: [0, 30_000, 120_000, 300_000, 600_000, 900_000],
  repo: [0, 30_000, 90_000],
  other: [0, 15_000],
};

export interface VerifyDeps {
  verifyChange: typeof verifyChange;
  verifyWithRetry: typeof verifyWithRetry;
}

export const defaultVerifyDeps: VerifyDeps = { verifyChange, verifyWithRetry };

export function diffHashMatches(c: Pick<ChangeRecord, "type" | "target" | "after" | "diff_hash">): boolean {
  return diffHash(c.type, c.target.url, c.after) === c.diff_hash;
}

export function prNumberFromUrl(url: string | null | undefined): number | null {
  const m = /\/pull\/(\d+)/.exec(url ?? "");
  return m ? Number(m[1]) : null;
}

/** Post a status update; errors are logged and (unless `strict`) swallowed. */
export async function setStatus(ctx: JobContext, change: ChangeRecord, update: ChangeUpdate, strict = true): Promise<boolean> {
  try {
    await ctx.api.updateChange(change.id, update);
    change.status = update.status;
    return true;
  } catch (e) {
    ctx.log(strict ? "error" : "debug", `Could not set change ${change.id.slice(0, 8)} to ${update.status}: ${(e as Error).message}`);
    if (strict) throw e;
    return false;
  }
}

export function summarizeVerify(v: VerifyResult): string {
  const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
  return v.ok ? `all ${v.checks.length} check(s) passed` : `failed: ${failed.join(", ") || "no checks ran"}${v.notes?.length ? ` (${v.notes.join("; ")})` : ""}`;
}

export function label(c: Pick<ChangeRecord, "type" | "target" | "id">): string {
  return `${c.type} ${c.target.url} [${c.id.slice(0, 8)}]`;
}

/** Fetch that adds the Vercel deployment-protection bypass header. */
export function bypassFetch(secret: string | undefined, base: typeof fetch = fetch): typeof fetch {
  if (!secret) return base;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("x-vercel-protection-bypass", secret);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

/** The same change, pointed at another origin (preview deployments). */
export function onOrigin(change: ChangeRecord, origin: string): ChangeRecord {
  const swap = (u: string) => {
    try {
      const x = new URL(u);
      const o = new URL(origin);
      x.protocol = o.protocol;
      x.host = o.host;
      return x.toString();
    } catch {
      return u;
    }
  };
  const after = change.after as Record<string, unknown> | null;
  // Canonical / hreflang / og:image values stay production URLs on purpose: they are what the
  // preview must print, so only the page URL moves.
  return { ...change, target: { ...change.target, url: swap(change.target.url) }, after };
}

/**
 * Undo one change on a non-repo platform and check the old value is back.
 * Returns the final status written.
 */
export async function rollbackNonRepo(
  ctx: JobContext,
  change: ChangeRecord,
  reason: string,
  deps: VerifyDeps = defaultVerifyDeps,
): Promise<"rolled_back" | "failed"> {
  const site = ctx.site!;
  await setStatus(ctx, change, { status: "rolling_back" }, false);
  try {
    await ctx.adapter().rollback(change);
    await ctx.adapter().purge?.([change.target.url]).catch(() => undefined);
  } catch (e) {
    const msg = `Rollback failed (${reason}): ${(e as Error).message}`;
    ctx.log("error", `${label(change)}: ${msg}`);
    await setStatus(ctx, change, { status: "failed", error: msg }, false);
    return "failed";
  }
  const v = await deps.verifyWithRetry(change, {
    siteUrl: site.url,
    fetch: ctx.fetch,
    expect: "before",
    delaysMs: ctx.verifyDelaysMs ?? VERIFY_DELAYS_MS[site.platform],
    sleep: ctx.sleep,
  });
  ctx.log(v.ok ? "info" : "warn", `${label(change)}: rollback verification ${summarizeVerify(v)}`);
  await setStatus(ctx, change, {
    status: "rolled_back",
    verify_result: { rollback: v },
    ...(v.ok ? {} : { error: `Rolled back (${reason}), but the previous value is not visible yet: ${summarizeVerify(v)}` }),
  });
  return "rolled_back";
}
