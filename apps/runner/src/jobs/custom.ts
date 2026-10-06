import { JobParams } from "@seo-autopilot/core";
import { JOB_TIMEOUTS_MS, truncate } from "../claude";
import type { JobContext, JobResult } from "./context";

/** Free prompt with claude-seo loaded; the final text is stored in the job result. */
export async function customJob(ctx: JobContext): Promise<JobResult> {
  const { prompt } = JobParams.custom.parse(ctx.job.params ?? {});
  const full = ctx.site ? `${prompt}\n\n(Site: ${ctx.site.url}. Write any files into the current working directory.)` : prompt;
  const run = await ctx.claude({ prompt: full, timeoutMs: JOB_TIMEOUTS_MS.custom });
  if (run.is_error) throw new Error(`Claude run failed: ${truncate(run.result || run.subtype || "error", 1000)}`);
  return { text: truncate(run.result, 100_000), session_id: run.session_id, turns: run.num_turns ?? null };
}
