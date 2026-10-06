/**
 * verify: re-check applied / verify_failed changes (slow caches), and repo changes whose PR
 * was merged by a person (applying → applied → verified).
 */
import { JobParams, type ChangeRecord } from "@seo-autopilot/core";
import type { RepoAdapter } from "../adapters";
import { defaultVerifyDeps, label, prNumberFromUrl, setStatus, summarizeVerify, type VerifyDeps } from "./changes";
import { requireSite, type JobContext, type JobResult } from "./context";

export async function verifyJob(ctx: JobContext, deps: VerifyDeps = defaultVerifyDeps): Promise<JobResult> {
  const site = requireSite(ctx);
  const params = JobParams.verify.parse(ctx.job.params ?? {});
  const statuses = site.platform === "repo" ? (["applying", "applied", "verify_failed"] as const) : (["applied", "verify_failed"] as const);
  const { changes } = await ctx.api.listChanges(site.id, [...statuses]);
  let list = changes.filter((c) => (statuses as readonly string[]).includes(c.status));
  if (params.change_ids?.length) {
    const ids = new Set(params.change_ids);
    list = list.filter((c) => ids.has(c.id));
  }
  if (!list.length) {
    ctx.log("info", "Nothing to verify");
    return { checked: 0, counts: {} };
  }

  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const prState = new Map<number, Awaited<ReturnType<RepoAdapter["prStatus"]>> | null>();

  for (const c of list) {
    if (ctx.signal.aborted) break;
    if (site.platform === "repo") {
      const n = prNumberFromUrl(c.pr_url) ?? numberFrom(c.rollback_data);
      if (!n) {
        ctx.log("warn", `${label(c)}: no PR recorded; skipping`);
        bump("skipped");
        continue;
      }
      if (!prState.has(n)) {
        try {
          prState.set(n, await (ctx.adapter() as RepoAdapter).prStatus(n));
        } catch (e) {
          ctx.log("warn", `PR #${n}: status check failed: ${(e as Error).message}`);
          prState.set(n, null);
        }
      }
      const st = prState.get(n);
      if (!st) {
        bump("skipped");
        continue;
      }
      if (st.state === "open") {
        ctx.log("info", `${label(c)}: PR #${n} still awaiting merge`);
        bump("awaiting_merge");
        continue;
      }
      if (st.state === "closed") {
        const msg = `PR #${n} was closed without merging`;
        ctx.log("warn", `${label(c)}: ${msg}`);
        await setStatus(ctx, c, { status: "failed", error: msg }, false);
        bump("failed");
        continue;
      }
      if (c.status === "applying") {
        await setStatus(ctx, c, { status: "applied", pr_url: c.pr_url ?? undefined, rollback_data: { ...(c.rollback_data as object), merge_sha: st.mergeSha } }, false);
      }
    }
    bump(await verifyOne(ctx, c, deps));
  }
  ctx.log("info", `Verify finished: ${JSON.stringify(counts)}`);
  return { checked: list.length, counts };
}

async function verifyOne(ctx: JobContext, c: ChangeRecord, deps: VerifyDeps): Promise<string> {
  let v;
  try {
    v = await deps.verifyChange(c, { siteUrl: ctx.site!.url, fetch: ctx.fetch });
  } catch (e) {
    ctx.log("warn", `${label(c)}: verify errored: ${(e as Error).message}`);
    return "error";
  }
  if (v.ok) {
    await setStatus(ctx, c, { status: "verified", verify_result: v }, false);
    ctx.log("info", `${label(c)}: verified`);
    return "verified";
  }
  ctx.log("warn", `${label(c)}: ${summarizeVerify(v)}`);
  if (c.status !== "verify_failed") {
    await setStatus(ctx, c, { status: "verify_failed", verify_result: v, error: `Verification ${summarizeVerify(v)}` }, false);
  }
  return "verify_failed";
}

function numberFrom(rb: unknown): number | null {
  const n = (rb as { pr_number?: unknown } | null)?.pr_number;
  return typeof n === "number" ? n : null;
}
