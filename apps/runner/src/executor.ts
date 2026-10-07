/**
 * Runs one claimed job: unseal secrets, build the JobContext, call the handler, flush logs and
 * POST /complete. Every error becomes a "failed" completion with a message; the stack goes to
 * the job log only.
 */
import { policyWithDefaults, type JobKind, type SealedEnvelope, type SiteAdapter, type SiteSecrets } from "@seo-autopilot/core";
import { createAdapter } from "./adapters";
import type { JobRow, RunnerApi, SiteRow } from "./api";
import { analysisTools, runClaude, truncate } from "./claude";
import { claudeSeoLauncher, claudeSeoPath, pluginPath, type RunnerConfig } from "./config";
import { HANDLERS } from "./jobs/index";
import type { ClaudeCall, JobContext, JobHandler, JobResult } from "./jobs/context";
import { localTargetFor } from "./local-targets";
import { JobLogger } from "./logger";
import { unsealSecrets } from "./secrets";
import { jobWorkDir } from "./workspace";

export interface ExecuteOptions {
  api: RunnerApi;
  config: RunnerConfig;
  job: JobRow;
  site: SiteRow | null;
  secret: SealedEnvelope | null;
  /** Aborts the job (daemon shutdown). */
  shutdown?: AbortSignal;
  handlers?: Partial<Record<JobKind, JobHandler>>;
  /** Called with the logger once it exists (daemon uses it to flush on shutdown). */
  onLogger?: (l: JobLogger) => void;
}

export interface ExecuteOutcome {
  status: "succeeded" | "failed";
  result?: JobResult;
  error?: string;
  cost_usd: number;
}

export async function executeJob(o: ExecuteOptions): Promise<ExecuteOutcome> {
  const { api, config, job, site } = o;
  const logger = new JobLogger(api, job.id);
  o.onLogger?.(logger);
  const onShutdown = () => logger.abort("runner stopped");
  if (o.shutdown?.aborted) onShutdown();
  o.shutdown?.addEventListener("abort", onShutdown, { once: true });

  let cost = 0;
  let outcome: ExecuteOutcome;
  try {
    logger.info(`Runner ${config.name} picked up ${job.kind} job${site ? ` for ${site.name} (${site.url})` : ""}`);
    const handler = o.handlers?.[job.kind] ?? HANDLERS[job.kind];
    if (!handler) throw new Error(`Unknown job kind ${job.kind}`);

    const secrets: SiteSecrets | null = site ? unsealSecrets(o.secret, config.private_key_pem, site.platform) : null;
    const workDir = jobWorkDir(site?.id ?? null, job.id);
    // Local/private sites (dev server, LAN staging) need claude-seo's explicit opt-in; public sites never get it.
    const localTarget = site ? localTargetFor(site.url) : null;
    if (localTarget) logger.log("info", `Site is on a local/private address; allowing claude-seo to fetch ${localTarget} (CLAUDE_SEO_LOCAL_TARGETS)`);
    const policy = policyWithDefaults(site?.policy ?? {});
    let adapter: SiteAdapter | null = null;

    const ctx: JobContext = {
      job,
      site,
      secrets,
      policy,
      api,
      config,
      workDir,
      log: (level, message) => logger.log(level, message),
      signal: logger.signal,
      adapter() {
        if (!site || !secrets) throw new Error("This job has no site");
        adapter ??= createAdapter(site.platform, {
          site: { id: site.id, url: site.url, platform: site.platform, config: site.config ?? {} },
          secrets,
          log: logger.adapterLog,
          workDir,
        }, { repoAutoMerge: policy.repo_auto_merge });
        return adapter;
      },
      claude: (call: ClaudeCall) => {
        const wanted = call.plugins ?? ["claude-seo", "seo-autopilot"];
        const dirs: string[] = [];
        if (wanted.includes("claude-seo")) dirs.push(claudeSeoPath(config));
        if (wanted.includes("seo-autopilot")) {
          const p = pluginPath(config);
          if (!p) throw new Error("seo-autopilot plugin not found; run `seo-autopilot-runner setup`");
          dirs.push(p);
        }
        return runClaude({
          prompt: call.prompt,
          cwd: call.cwd ?? workDir,
          pluginDirs: dirs,
          requirePlugins: wanted,
          allowedTools: call.allowedTools ?? analysisTools(claudeSeoLauncher(config)),
          addDirs: call.addDirs,
          maxBudgetUsd: call.maxBudgetUsd ?? config.max_budget_usd ?? 10,
          model: config.model,
          jsonSchema: call.jsonSchema,
          resume: call.resume,
          timeoutMs: call.timeoutMs,
          env: localTarget ? { CLAUDE_SEO_LOCAL_TARGETS: localTarget } : undefined,
          signal: logger.signal,
          log: (level, message) => logger.log(level, message),
          claudeBin: config.claude_bin,
        }).then(
          (r) => {
            cost += r.total_cost_usd;
            return r;
          },
          (e) => {
            const partial = (e as { run?: { total_cost_usd?: number } }).run?.total_cost_usd;
            if (typeof partial === "number") cost += partial;
            throw e;
          },
        );
      },
      addCost: (usd) => {
        cost += usd;
      },
    };

    const result = await handler(ctx);
    if (logger.signal.aborted) throw logger.signal.reason instanceof Error ? logger.signal.reason : new Error("Job cancelled");
    logger.info(`Job succeeded${cost ? ` ($${cost.toFixed(4)})` : ""}`);
    outcome = { status: "succeeded", result, cost_usd: cost };
  } catch (e) {
    const err = e as Error;
    const message = logger.signal.aborted && logger.signal.reason instanceof Error ? logger.signal.reason.message : err?.message || String(e);
    logger.error(`Job failed: ${message}`);
    if (err?.stack) logger.debug(truncate(err.stack, 4000));
    outcome = { status: "failed", error: truncate(message, 2000), cost_usd: cost };
  } finally {
    o.shutdown?.removeEventListener("abort", onShutdown);
  }

  await logger.close();
  try {
    await api.complete(job.id, {
      status: outcome.status,
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.cost_usd ? { cost_usd: Number(outcome.cost_usd.toFixed(4)) } : {}),
    });
  } catch (e) {
    process.stderr.write(`Could not report completion of job ${job.id}: ${(e as Error).message}\n`);
  }
  return outcome;
}
