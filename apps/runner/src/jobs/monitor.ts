/**
 * monitor: 28-day Search Console page metrics via claude-seo's gsc_query.py → POST /metrics.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { claudeSeoLauncher } from "../config";
import type { MetricsRow } from "../api";
import { requireSite, type JobContext, type JobResult } from "./context";

export interface GscRow {
  keys?: string[];
  page?: string;
  clicks?: number;
  impressions?: number;
  ctr?: number; // percent (gsc_query.py multiplies by 100)
  position?: number;
}

export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execLauncher: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    // The launcher is a bash script; run it through bash so it works when the exec bit is lost (zip installs).
    const [cmd, argv] = process.platform === "win32" ? ["bash", [file, ...args]] : [file, args];
    execFile(cmd, argv, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, signal: opts.signal, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export function mapGscRows(rows: GscRow[], periodEnd: string, days: number): MetricsRow[] {
  const out: MetricsRow[] = [];
  for (const r of rows) {
    const url = r.page ?? r.keys?.[0];
    if (!url) continue;
    out.push({
      url,
      period_end: periodEnd,
      days,
      clicks: Math.round(Number(r.clicks ?? 0)),
      impressions: Math.round(Number(r.impressions ?? 0)),
      ctr: Number(r.ctr ?? 0) / 100, // back to a 0..1 ratio
      position: Number(r.position ?? 0),
    });
  }
  return out;
}

export async function monitorJob(ctx: JobContext, exec: ExecFn = execLauncher): Promise<JobResult> {
  const site = requireSite(ctx);
  const property = site.config?.gsc_property;
  const launcher = claudeSeoLauncher(ctx.config);
  if (!property) {
    ctx.log("info", "Search Console not configured (no gsc_property on this site); skipping");
    return { skipped: true, reason: "Search Console not configured" };
  }
  if (!existsSync(launcher)) {
    ctx.log("warn", `claude-seo not found at ${launcher}; run \`seo-autopilot-runner setup\``);
    return { skipped: true, reason: "claude-seo not installed" };
  }

  const auth = await exec(launcher, ["run", "google_auth.py", "--check", "gsc", "--json"], { timeoutMs: 60_000, signal: ctx.signal });
  let authOk = false;
  try {
    const j = JSON.parse(auth.stdout);
    authOk = !!j?.services?.gsc?.available;
  } catch {
    authOk = false;
  }
  if (!authOk) {
    ctx.log("info", "Search Console not configured (claude-seo Google auth missing; run its google_auth.py --setup)");
    return { skipped: true, reason: "Search Console not configured" };
  }

  const days = 28;
  ctx.log("info", `Querying Search Console ${property} (${days} days, by page)`);
  const res = await exec(
    launcher,
    ["run", "gsc_query.py", "--property", property, "--days", String(days), "--dimensions", "page", "--json", "--limit", "5000"],
    { timeoutMs: 10 * 60_000, signal: ctx.signal },
  );
  let data: { rows?: GscRow[]; error?: string | null; date_range?: { start: string; end: string }; warnings?: string[] };
  try {
    data = JSON.parse(res.stdout);
  } catch {
    throw new Error(`gsc_query.py failed (exit ${res.code}): ${(res.stderr || res.stdout).slice(-800)}`);
  }
  if (data.error) throw new Error(`Search Console: ${data.error}`);
  for (const w of data.warnings ?? []) ctx.log("warn", w);
  const periodEnd = data.date_range?.end ?? new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const rows = mapGscRows(data.rows ?? [], periodEnd, days);
  ctx.log("info", `Got ${rows.length} page rows ending ${periodEnd}`);

  let alerts: unknown[] = [];
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await ctx.api.postMetrics(site.id, rows.slice(i, i + 1000));
    alerts = alerts.concat(r.alerts ?? []);
  }
  if (alerts.length) ctx.log("warn", `${alerts.length} traffic alert(s) raised`);
  return { rows: rows.length, period_end: periodEnd, alerts: alerts.length };
}
