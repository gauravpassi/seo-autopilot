/**
 * Job logger: buffers lines and flushes them to POST /api/runner/jobs/:id/logs every 2 s or
 * every 200 lines. The server's `cancel_requested` flag aborts `signal`.
 */
import type { LogLine, RunnerApi } from "./api";

export type Level = LogLine["level"];

export interface JobLoggerOptions {
  flushIntervalMs?: number;
  maxBuffer?: number;
  /** Also echo to the local console (default true). */
  echo?: boolean;
}

const MAX_MESSAGE = 8000;
const MAX_PER_REQUEST = 500;

export class JobLogger {
  private buf: LogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private readonly ctrl = new AbortController();
  private readonly flushIntervalMs: number;
  private readonly maxBuffer: number;
  private readonly echo: boolean;
  private closed = false;

  constructor(
    private readonly api: Pick<RunnerApi, "logs">,
    readonly jobId: string,
    opts: JobLoggerOptions = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBuffer = opts.maxBuffer ?? 200;
    this.echo = opts.echo ?? true;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Aborted when the server reports cancel_requested (or abort() is called locally). */
  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  abort(reason: string): void {
    if (!this.ctrl.signal.aborted) this.ctrl.abort(new Error(reason));
  }

  log(level: Level, message: string): void {
    const msg = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}… [truncated]` : message;
    const line: LogLine = { ts: new Date().toISOString(), level, message: msg };
    if (this.echo) {
      const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
      out.write(`[${line.ts}] [${this.jobId.slice(0, 8)}] ${level.padEnd(5)} ${msg.split("\n")[0]}\n`);
    }
    if (this.closed) return;
    this.buf.push(line);
    if (this.buf.length >= this.maxBuffer) void this.flush();
  }

  debug(m: string) {
    this.log("debug", m);
  }
  info(m: string) {
    this.log("info", m);
  }
  warn(m: string) {
    this.log("warn", m);
  }
  error(m: string) {
    this.log("error", m);
  }

  /** Adapter-compatible log function. */
  get adapterLog(): (level: "debug" | "info" | "warn" | "error", message: string) => void {
    return (level, message) => this.log(level, message);
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (this.buf.length === 0) return;
    }
    if (this.buf.length === 0) return;
    const batch = this.buf.splice(0, MAX_PER_REQUEST);
    this.flushing = (async () => {
      try {
        const res = await this.api.logs(this.jobId, batch);
        if (res?.cancel_requested) this.abort("Job cancelled from the control panel");
      } catch (e) {
        // Keep the lines for the next attempt, but don't grow without bound.
        this.buf.unshift(...batch);
        if (this.buf.length > 5000) this.buf.splice(0, this.buf.length - 5000);
        if (this.echo) process.stderr.write(`log upload failed: ${(e as Error).message}\n`);
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
    if (this.buf.length >= this.maxBuffer) await this.flush();
  }

  /** Stop the timer and flush everything left (best effort, a few attempts). */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (let i = 0; i < 3 && this.buf.length > 0; i++) await this.flush();
    this.closed = true;
  }
}
