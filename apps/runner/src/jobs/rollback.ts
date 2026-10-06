/**
 * rollback: undo changes with their rollback_data and check the previous value is back.
 * Repo sites: one revert PR per merged PR (auto-merged when policy.repo_auto_merge).
 */
import { JobParams, type ChangeRecord } from "@seo-autopilot/core";
import type { RepoAdapter } from "../adapters";
import { defaultVerifyDeps, label, prNumberFromUrl, rollbackNonRepo, setStatus, summarizeVerify, type VerifyDeps } from "./changes";
import { requireSite, type JobContext, type JobResult } from "./context";

const ROLLBACKABLE = new Set(["applied", "verified", "verify_failed", "applying", "verifying", "failed"]);

export async function rollbackJob(ctx: JobContext, deps: VerifyDeps = defaultVerifyDeps): Promise<JobResult> {
  const site = requireSite(ctx);
  const params = JobParams.rollback.parse(ctx.job.params ?? {});
  const reason = params.reason ?? "rollback requested";
  const { changes } = await ctx.api.listChanges(site.id, ["applied", "verified", "verify_failed", "applying", "verifying", "failed"]);
  const ids = new Set(params.change_ids);
  const list = changes.filter((c) => ids.has(c.id));
  const missing = params.change_ids.filter((id) => !list.some((c) => c.id === id));
  if (missing.length) ctx.log("warn", `${missing.length} change(s) not found in a state that can be rolled back`);

  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  if (site.platform === "repo") {
    const byPr = new Map<number, ChangeRecord[]>();
    for (const c of list) {
      const n = prNumberFromUrl(c.pr_url) ?? (c.rollback_data as { pr_number?: number } | null)?.pr_number ?? null;
      if (!n) {
        ctx.log("error", `${label(c)}: no PR recorded; cannot roll back`);
        await setStatus(ctx, c, { status: "failed", error: "No pull request recorded for this change" }, false);
        bump("failed");
        continue;
      }
      byPr.set(n, [...(byPr.get(n) ?? []), c]);
    }
    const repo = ctx.adapter() as RepoAdapter;
    for (const [n, group] of byPr) {
      for (const c of group) await setStatus(ctx, c, { status: "rolling_back" }, false);
      try {
        const st = await repo.prStatus(n);
        if (st.state === "open") {
          // Nothing reached production; a person should just close the PR.
          for (const c of group) {
            await setStatus(ctx, c, { status: "rolled_back", error: `PR #${n} was never merged; close it on GitHub` }, false);
            bump("rolled_back");
          }
          continue;
        }
        const r = await repo.revert({ prNumber: n, autoMerge: ctx.policy.repo_auto_merge });
        ctx.log("info", `Opened revert PR ${r.prUrl}${r.merged ? " (merged)" : " (awaiting merge)"}`);
        for (const c of group) {
          if (r.merged) {
            const v = await deps
              .verifyWithRetry(c, { siteUrl: site.url, fetch: ctx.fetch, expect: "before", delaysMs: ctx.verifyDelaysMs ?? [0, 60_000, 180_000], sleep: ctx.sleep })
              .catch(() => null);
            ctx.log(v?.ok ? "info" : "warn", `${label(c)}: ${v ? summarizeVerify(v) : "verification errored"}`);
            await setStatus(ctx, c, { status: "rolled_back", pr_url: r.prUrl, verify_result: { rollback: v } }, false);
          } else {
            await setStatus(ctx, c, { status: "rolled_back", pr_url: r.prUrl, error: `Revert PR awaiting merge: ${r.prUrl}` }, false);
          }
          bump("rolled_back");
        }
      } catch (e) {
        const msg = `Revert of PR #${n} failed: ${(e as Error).message}`;
        ctx.log("error", msg);
        for (const c of group) {
          await setStatus(ctx, c, { status: "failed", error: msg }, false);
          bump("failed");
        }
      }
    }
  } else {
    for (const c of list) {
      if (ctx.signal.aborted) break;
      if (!ROLLBACKABLE.has(c.status) || c.rollback_data == null) {
        ctx.log("warn", `${label(c)}: nothing to roll back (status ${c.status}, no rollback data)`);
        bump("skipped");
        continue;
      }
      bump(await rollbackNonRepo(ctx, c, reason, deps));
    }
  }
  ctx.log("info", `Rollback finished: ${JSON.stringify(counts)}`);
  if (!list.length) throw new Error("None of the requested changes can be rolled back");
  return { requested: params.change_ids.length, counts };
}
