/**
 * apply: push approved changes to the site.
 *
 * Non-repo (WordPress / Shopify): per change — diff-hash check → applying → re-read `before`
 * (abort when someone edited it since the proposal) → adapter.apply → applied + rollback_data →
 * purge → verify with retries → verified | verify_failed → auto rollback when the policy says so.
 *
 * Repo: one batch — checkout → locate → Claude edits files (repo-fix skill, file tools only,
 * scoped to the checkout) → non-empty diff → optional build → PR → preview verification →
 * optional auto-merge.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { JobParams, isManualError, stableStringify, type ChangeRecord } from "@seo-autopilot/core";
import type { RepoAdapter } from "../adapters";
import { JOB_TIMEOUTS_MS, REPO_EDIT_TOOLS, truncate } from "../claude";
import {
  VERIFY_DELAYS_MS,
  bypassFetch,
  defaultVerifyDeps,
  diffHashMatches,
  label,
  onOrigin,
  rollbackNonRepo,
  setStatus,
  summarizeVerify,
  type VerifyDeps,
} from "./changes";
import { requireSite, throwIfAborted, type JobContext, type JobResult } from "./context";

const pExecFile = promisify(execFile);

export const MSG_HASH_MISMATCH = "approval does not match change";
export const MSG_BEFORE_CHANGED = "value changed on the site since the proposal; re-run propose";

type Outcome = "verified" | "verify_failed" | "rolled_back" | "failed" | "applying" | "applied" | "skipped";

async function loadApproved(ctx: JobContext): Promise<ChangeRecord[]> {
  const site = requireSite(ctx);
  const params = JobParams.apply.parse(ctx.job.params ?? {});
  const { changes } = await ctx.api.listChanges(site.id, ["approved"]);
  let list = changes.filter((c) => c.status === "approved");
  if (params.change_ids?.length) {
    const ids = new Set(params.change_ids);
    list = list.filter((c) => ids.has(c.id));
    const missing = params.change_ids.filter((id) => !list.some((c) => c.id === id));
    if (missing.length) ctx.log("warn", `${missing.length} requested change(s) are not approved any more; skipping`);
  }
  return list;
}

export async function applyJob(ctx: JobContext, deps: VerifyDeps = defaultVerifyDeps): Promise<JobResult> {
  const site = requireSite(ctx);
  const changes = await loadApproved(ctx);
  if (!changes.length) {
    ctx.log("info", "No approved changes to apply");
    return { applied: 0, counts: {} };
  }
  ctx.log("info", `Applying ${changes.length} approved change(s) to ${site.platform} site ${site.url}`);

  // The approval binds to the diff hash; refuse anything edited after approval.
  const valid: ChangeRecord[] = [];
  const outcomes: Record<string, Outcome> = {};
  for (const c of changes) {
    if (!diffHashMatches(c)) {
      ctx.log("error", `${label(c)}: ${MSG_HASH_MISMATCH}`);
      await setStatus(ctx, c, { status: "failed", error: MSG_HASH_MISMATCH }, false);
      outcomes[c.id] = "failed";
    } else valid.push(c);
  }

  if (site.platform === "repo") {
    Object.assign(outcomes, await applyRepoBatch(ctx, valid, deps));
  } else {
    for (const c of valid) {
      if (ctx.signal.aborted) {
        ctx.log("warn", `Cancelled; ${label(c)} left approved`);
        outcomes[c.id] = "skipped";
        continue;
      }
      outcomes[c.id] = await applyOne(ctx, c, deps);
    }
    throwIfAborted(ctx.signal);
  }

  const counts: Record<string, number> = {};
  for (const o of Object.values(outcomes)) counts[o] = (counts[o] ?? 0) + 1;
  ctx.log("info", `Apply finished: ${JSON.stringify(counts)}`);
  return { applied: changes.length, counts, outcomes };
}

/** One non-repo change, end to end. Never throws for per-change problems. */
export async function applyOne(ctx: JobContext, c: ChangeRecord, deps: VerifyDeps = defaultVerifyDeps): Promise<Outcome> {
  const site = ctx.site!;
  const adapter = ctx.adapter();
  try {
    await setStatus(ctx, c, { status: "applying" });

    const current = await adapter.read({ type: c.type, target: c.target, after: c.after });
    if (stableStringify(current ?? null) !== stableStringify(c.before ?? null)) {
      // Already exactly the approved value (e.g. a re-run after a crash) is fine; anything else isn't.
      if (stableStringify(current ?? null) !== stableStringify(c.after)) {
        ctx.log("error", `${label(c)}: ${MSG_BEFORE_CHANGED}`);
        await setStatus(ctx, c, { status: "failed", error: MSG_BEFORE_CHANGED, before: current ?? null }, false);
        return "failed";
      }
      ctx.log("warn", `${label(c)}: the approved value is already live; applying anyway to record rollback data`);
    }

    const res = await adapter.apply(c);
    c.rollback_data = res.rollback;
    if (res.note) ctx.log("info", `${label(c)}: ${res.note}`);
    await setStatus(ctx, c, { status: "applied", rollback_data: res.rollback ?? null });
    ctx.log("info", `${label(c)}: applied`);
  } catch (e) {
    const msg = (e as Error).message;
    if (isManualError(e)) {
      // The platform can't do this one (e.g. a theme image on Shopify): turn it into advice for a person.
      ctx.log("warn", `${label(c)}: needs a person: ${msg}`);
      await setStatus(ctx, c, { status: "blocked", error: truncate(msg, 1000) }, false);
      return "failed";
    }
    ctx.log("error", `${label(c)}: apply failed: ${msg}`);
    await setStatus(ctx, c, { status: "failed", error: truncate(msg, 1000) }, false);
    return "failed";
  }

  try {
    await adapter.purge?.([c.target.url]);
  } catch (e) {
    ctx.log("warn", `${label(c)}: cache purge failed: ${(e as Error).message}`);
  }

  await setStatus(ctx, c, { status: "verifying" }, false);
  let v;
  try {
    v = await deps.verifyWithRetry(c, {
      siteUrl: site.url,
      fetch: ctx.fetch,
      delaysMs: ctx.verifyDelaysMs ?? VERIFY_DELAYS_MS[site.platform],
      sleep: ctx.sleep,
      onAttempt: (n, r) => {
        if (!r.ok) ctx.log("debug", `${label(c)}: verify attempt ${n}: ${summarizeVerify(r)}`);
      },
    });
  } catch (e) {
    v = { ok: false, retryable: true, checks: [], checked_url: c.target.url, at: new Date().toISOString(), notes: [(e as Error).message] };
  }
  if (v.ok) {
    await setStatus(ctx, c, { status: "verified", verify_result: v }, false);
    ctx.log("info", `${label(c)}: verified (${summarizeVerify(v)})`);
    return "verified";
  }
  ctx.log("warn", `${label(c)}: verification ${summarizeVerify(v)}`);
  await setStatus(ctx, c, { status: "verify_failed", verify_result: v, error: `Verification ${summarizeVerify(v)}` }, false);
  if (ctx.policy.auto_rollback && !ctx.signal.aborted) {
    ctx.log("info", `${label(c)}: rolling back (policy auto_rollback)`);
    return rollbackNonRepo(ctx, c, "verification failed", deps);
  }
  return "verify_failed";
}

// ------------------------------------------------------------------ repo batch
interface RepoFixReportItem {
  change_id: string;
  files?: string[];
  done: boolean;
  note?: string;
}

function readRepoReport(workDir: string): RepoFixReportItem[] | null {
  const p = join(workDir, "repo-fix-report.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.changes) ? raw.changes : null;
    return items?.filter((i: unknown) => i && typeof (i as RepoFixReportItem).change_id === "string") ?? null;
  } catch {
    return null;
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await pExecFile("git", args, { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** Permission rules confining Edit/Write to the checkout (+ the report file). */
export function repoEditTools(checkout: string, workDir: string): string[] {
  if (process.platform === "win32") return REPO_EDIT_TOOLS; // path rules use POSIX syntax; fall back to plain tools
  const abs = (p: string) => `/${p.replace(/\/+$/, "")}`; // "//abs/path" = absolute path rule
  return [
    "Read",
    "Glob",
    "Grep",
    `Edit(${abs(checkout)}/**)`,
    `Write(${abs(checkout)}/**)`,
    `Write(${abs(workDir)}/repo-fix-report.json)`,
  ];
}

export async function applyRepoBatch(ctx: JobContext, changes: ChangeRecord[], deps: VerifyDeps = defaultVerifyDeps): Promise<Record<string, Outcome>> {
  const site = ctx.site!;
  const out: Record<string, Outcome> = {};
  if (!changes.length) return out;
  const repo = ctx.adapter() as RepoAdapter;
  const failAll = async (list: ChangeRecord[], msg: string) => {
    ctx.log("error", msg);
    for (const c of list) {
      await setStatus(ctx, c, { status: "failed", error: truncate(msg, 2000) }, false);
      out[c.id] = "failed";
    }
  };

  let co;
  try {
    co = await repo.prepareCheckout({ jobId: ctx.job.id });
    const fw = await repo.detectFramework(co.dir);
    ctx.log("info", `Framework: ${fw.framework}; SEO files: ${fw.seoFiles.slice(0, 15).join(", ") || "none found"}`);

    const items = [];
    for (const c of changes) {
      const loc = await repo.locate(co.dir, c).catch((e) => ({ file: undefined, hint: `locate failed: ${(e as Error).message}` }));
      items.push({ change_id: c.id, type: c.type, url: c.target.url, before: c.before, after: c.after, rationale: c.rationale ?? null, locate: loc });
    }
    writeFileSync(
      join(ctx.workDir, "approved-changes.json"),
      JSON.stringify({ site_url: site.url, framework: fw.framework, checkout: co.dir, seo_files: fw.seoFiles.slice(0, 200), changes: items }, null, 2),
    );
  } catch (e) {
    await failAll(changes, `Could not prepare the repository checkout: ${(e as Error).message}`);
    return out;
  }
  throwIfAborted(ctx.signal);

  const prompt =
    `/seo-autopilot:repo-fix\n\n` +
    `Implement exactly the approved SEO changes listed in ./approved-changes.json (in the current working directory) ` +
    `inside the git checkout at ${co.dir}. Use the "locate" hints for each change. Change only what is listed, keep the ` +
    `existing code style, add no dependencies, never touch secrets or .env files, and do not run git or any command. ` +
    `When finished, write ./repo-fix-report.json: {"changes":[{"change_id","files":[...],"done":true|false,"note"}]}.`;
  try {
    const run = await ctx.claude({
      prompt,
      addDirs: [co.dir],
      allowedTools: repoEditTools(co.dir, ctx.workDir),
      plugins: ["seo-autopilot"],
      timeoutMs: JOB_TIMEOUTS_MS.repo_edit,
    });
    if (run.is_error) throw new Error(run.result || run.subtype || "repo-fix run failed");
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    await failAll(changes, `Claude could not edit the repository: ${(e as Error).message}`);
    return out;
  }

  const status = (await git(co.dir, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "")).trim();
  const stat = (await git(co.dir, ["diff", "--stat"]).catch(() => "")).trim();
  if (!status) {
    await failAll(changes, "repo-fix made no file changes");
    return out;
  }
  ctx.log("info", `Diff:\n${stat || status}`);

  // Changes Claude says it could not implement don't go into the PR as "applied".
  const report = readRepoReport(ctx.workDir);
  let todo = changes;
  if (report) {
    const notDone = new Map(report.filter((r) => r.done === false).map((r) => [r.change_id, r.note ?? "not implemented"]));
    for (const c of changes) {
      if (notDone.has(c.id)) {
        const msg = `repo-fix could not implement this change: ${notDone.get(c.id)}`;
        ctx.log("warn", `${label(c)}: ${msg}`);
        await setStatus(ctx, c, { status: "failed", error: msg }, false);
        out[c.id] = "failed";
      }
    }
    todo = changes.filter((c) => !notDone.has(c.id));
    if (!todo.length) return out;
  } else {
    ctx.log("warn", "repo-fix-report.json missing; assuming every change was implemented");
  }

  const buildCmd = site.config?.build_command;
  if (buildCmd) {
    ctx.log("info", `Building: ${buildCmd}`);
    const b = await repo.runBuild(co.dir, buildCmd);
    if (!b.ok) {
      await failAll(todo, `Build failed after the edits; nothing was pushed.\n${b.output.slice(-1500)}`);
      return out;
    }
    ctx.log("info", "Build passed");
  }
  throwIfAborted(ctx.signal);

  let pr;
  try {
    pr = await repo.commitAndOpenPR({ dir: co.dir, branch: co.branch, changes: todo, title: `SEO Autopilot: ${todo.length} approved SEO fix${todo.length === 1 ? "" : "es"}` });
  } catch (e) {
    await failAll(todo, `Could not open the pull request: ${(e as Error).message}`);
    return out;
  }
  ctx.log("info", `Opened PR #${pr.prNumber}: ${pr.prUrl} (${pr.filesChanged.length} file(s))`);
  const rollback = { pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha, base_sha: co.baseSha, branch: co.branch, files: pr.filesChanged };
  for (const c of todo) {
    c.rollback_data = rollback;
    c.pr_url = pr.prUrl;
    await setStatus(ctx, c, { status: "applying", pr_url: pr.prUrl, rollback_data: rollback }, false);
    out[c.id] = "applying";
  }

  // Preview deployment checks
  const preview = await repo.waitForPreview({ headSha: pr.headSha }).catch((e) => {
    ctx.log("warn", `Waiting for the preview failed: ${(e as Error).message}`);
    return { url: null, state: "error" };
  });
  let allPass = false;
  const previewResults: Record<string, unknown> = {};
  if (preview.url) {
    const origin = new URL(preview.url).origin;
    const secrets = ctx.secrets?.platform === "repo" ? ctx.secrets : null;
    const f = bypassFetch(secrets?.vercel_bypass_secret, ctx.fetch ?? fetch);
    ctx.log("info", `Verifying on preview ${origin}`);
    allPass = true;
    for (const c of todo) {
      const v = await deps
        .verifyWithRetry(onOrigin(c, origin), { siteUrl: origin, fetch: f, delaysMs: ctx.verifyDelaysMs ?? [0, 20_000], sleep: ctx.sleep })
        .catch((e) => ({ ok: false, retryable: false, checks: [], checked_url: c.target.url, at: new Date().toISOString(), notes: [(e as Error).message] }));
      previewResults[c.id] = v;
      ctx.log(v.ok ? "info" : "warn", `${label(c)}: preview ${summarizeVerify(v)}`);
      if (!v.ok) allPass = false;
    }
  } else {
    ctx.log("warn", `No preview deployment (${preview.state}); the PR needs a human check`);
  }

  if (allPass && ctx.policy.repo_auto_merge) {
    try {
      const m = await repo.merge(pr.prNumber, pr.headSha);
      if (!m.merged) throw new Error("GitHub did not merge the PR");
      const merged = { ...rollback, merge_sha: m.sha };
      for (const c of todo) {
        await setStatus(ctx, c, { status: "applied", pr_url: pr.prUrl, rollback_data: merged, verify_result: { preview: previewResults[c.id] } }, false);
        out[c.id] = "applied";
      }
      ctx.log("info", `Merged PR #${pr.prNumber}; a verify job will check production after deploy`);
    } catch (e) {
      ctx.log("warn", `Auto-merge failed: ${(e as Error).message}; PR awaiting merge`);
    }
  } else {
    if (preview.url) {
      for (const c of todo) {
        await setStatus(ctx, c, { status: "applying", pr_url: pr.prUrl, verify_result: { preview: previewResults[c.id], note: "PR awaiting merge" } }, false);
      }
    }
    ctx.log(
      "info",
      `PR awaiting merge: ${pr.prUrl}${preview.url ? (allPass ? " (preview checks passed)" : " (preview checks failed — review before merging)") : ""}`,
    );
  }
  return out;
}
