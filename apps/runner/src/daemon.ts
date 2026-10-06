/**
 * Daemon loop: heartbeat every 30 s, claim every 5 s when idle (backoff to 30 s on network
 * errors), one job at a time, graceful SIGINT/SIGTERM.
 */
import { RunnerApi, type RunnerHealth } from "./api";
import type { RunnerConfig } from "./config";
import { doctor } from "./doctor";
import { executeJob, type ExecuteOutcome } from "./executor";
import type { JobLogger } from "./logger";
import { cleanupWorkDirs } from "./workspace";
import { RUNNER_VERSION } from "./version";

const HEARTBEAT_MS = 30_000;
const CLAIM_IDLE_MS = 5_000;
const CLAIM_MAX_BACKOFF_MS = 30_000;
const HEALTH_TTL_MS = 10 * 60_000;
const CLEANUP_EVERY_MS = 6 * 60 * 60_000;

const say = (m: string) => process.stdout.write(`[${new Date().toISOString()}] ${m}\n`);

export function createApi(cfg: RunnerConfig): RunnerApi {
  return new RunnerApi({ server: cfg.server, token: cfg.token, userAgent: `seo-autopilot-runner/${RUNNER_VERSION}` });
}

export class Daemon {
  private readonly api: RunnerApi;
  private readonly stopCtrl = new AbortController();
  private health: Omit<RunnerHealth, "busy" | "job_id"> | null = null;
  private healthAt = 0;
  private currentJob: string | null = null;
  private currentLogger: JobLogger | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly cfg: RunnerConfig, api?: RunnerApi) {
    this.api = api ?? createApi(cfg);
  }

  get stopping(): boolean {
    return this.stopCtrl.signal.aborted;
  }

  stop(reason = "runner stopped"): void {
    if (this.stopping) return;
    say(this.currentJob ? `Stopping: aborting job ${this.currentJob} (${reason})…` : "Stopping…");
    this.stopCtrl.abort(new Error(reason));
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  private async refreshHealth(force = false): Promise<void> {
    if (!force && this.health && Date.now() - this.healthAt < HEALTH_TTL_MS) return;
    try {
      const r = await doctor(this.cfg);
      this.health = r.health;
      this.healthAt = Date.now();
      const bad = r.checks.filter((c) => !c.ok && !c.optional).map((c) => c.name);
      if (bad.length) say(`Health problems: ${bad.join(", ")} (run \`seo-autopilot-runner doctor\`)`);
    } catch (e) {
      say(`Health check failed: ${(e as Error).message}`);
    }
  }

  async heartbeat(): Promise<void> {
    await this.refreshHealth();
    const status: RunnerHealth = {
      ...(this.health ?? { claude: { ok: false }, claude_seo: { ok: false }, python: { ok: false } }),
      busy: !!this.currentJob,
      ...(this.currentJob ? { job_id: this.currentJob } : {}),
    };
    try {
      await this.api.heartbeat({ version: RUNNER_VERSION, status });
    } catch (e) {
      say(`Heartbeat failed: ${(e as Error).message}`);
    }
  }

  /** Claim and run at most one job. Returns null when there was nothing to do. */
  async runOnce(): Promise<ExecuteOutcome | null> {
    const claimed = await this.api.claim();
    if (!claimed.job) return null;
    const { job, site, secret } = claimed;
    this.currentJob = job.id;
    say(`Claimed ${job.kind} job ${job.id}${site ? ` for ${site.url}` : ""}`);
    void this.heartbeat();
    try {
      const out = await executeJob({
        api: this.api,
        config: this.cfg,
        job,
        site,
        secret,
        shutdown: this.stopCtrl.signal,
        onLogger: (l) => (this.currentLogger = l),
      });
      say(`Job ${job.id} ${out.status}${out.error ? `: ${out.error}` : ""}`);
      return out;
    } finally {
      this.currentJob = null;
      this.currentLogger = null;
      void this.heartbeat();
    }
  }

  async start(): Promise<void> {
    say(`SEO Autopilot runner ${RUNNER_VERSION} "${this.cfg.name}" → ${this.cfg.server}`);
    const onSignal = (sig: string) => () => {
      if (this.stopping) {
        say(`Second ${sig}; exiting now`);
        process.exit(130);
      }
      this.stop("runner stopped");
    };
    const sigint = onSignal("SIGINT");
    const sigterm = onSignal("SIGTERM");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);

    try {
      const removed = cleanupWorkDirs(14);
      if (removed) say(`Removed ${removed} work dir(s) older than 14 days`);
    } catch {
      /* ignore */
    }
    let lastCleanup = Date.now();

    await this.refreshHealth(true);
    await this.heartbeat();
    const hb = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);

    let delay = CLAIM_IDLE_MS;
    try {
      while (!this.stopping) {
        try {
          const out = await this.runOnce();
          delay = out ? 0 : CLAIM_IDLE_MS;
        } catch (e) {
          delay = Math.min(CLAIM_MAX_BACKOFF_MS, Math.max(CLAIM_IDLE_MS, delay * 2));
          say(`Claim failed: ${(e as Error).message}; retrying in ${Math.round(delay / 1000)} s`);
        }
        if (Date.now() - lastCleanup > CLEANUP_EVERY_MS) {
          lastCleanup = Date.now();
          try {
            cleanupWorkDirs(14);
          } catch {
            /* ignore */
          }
        }
        if (delay > 0 && !this.stopping) await this.sleep(delay);
      }
    } finally {
      clearInterval(hb);
      await this.currentLogger?.close().catch(() => undefined);
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      say("Runner stopped");
    }
  }
}
