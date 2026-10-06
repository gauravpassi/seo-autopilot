import type { SiteAdapter, SitePolicy, SiteSecrets } from "@seo-autopilot/core";
import type { JobApi, JobRow, SiteRow } from "../api";
import type { ClaudeRunOptions, ClaudeRunResult, LogFn } from "../claude";
import type { RunnerConfig } from "../config";

export interface JobContext {
  job: JobRow;
  site: SiteRow | null;
  /** Decrypted secrets (null for jobs without a site). */
  secrets: SiteSecrets | null;
  policy: SitePolicy;
  api: JobApi;
  config: RunnerConfig;
  /** Fresh per-job directory (~/.seo-autopilot/work/<site>/<job>). */
  workDir: string;
  log: LogFn;
  signal: AbortSignal;
  /** Lazily created platform adapter for the site. */
  adapter(): SiteAdapter;
  /** Runs `claude -p` with the runner's defaults (plugins, rules, budget, model, cancel signal). */
  claude(opts: ClaudeCall): Promise<ClaudeRunResult>;
  /** Add to the job's cost total (complete() reports it). */
  addCost(usd: number): void;
  /** Injected for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Override verify delays (tests). */
  verifyDelaysMs?: number[];
}

export type ClaudeCall = Pick<ClaudeRunOptions, "prompt" | "jsonSchema" | "resume" | "addDirs" | "timeoutMs"> & {
  cwd?: string;
  /** Default: analysis tools (section 8). */
  allowedTools?: string[];
  /** Plugins to load (and require). Default: ["claude-seo", "seo-autopilot"]. */
  plugins?: Array<"claude-seo" | "seo-autopilot">;
  maxBudgetUsd?: number;
};

export type JobResult = Record<string, unknown>;

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export function requireSite(ctx: JobContext): SiteRow {
  if (!ctx.site) throw new Error(`Job ${ctx.job.kind} needs a site`);
  return ctx.site;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const r = signal.reason;
    throw r instanceof Error ? r : new Error(typeof r === "string" ? r : "Job cancelled");
  }
}
