/**
 * Typed client for the runner ⇄ server API (docs/ARCHITECTURE.md section 5).
 *
 * Bearer auth, JSON in/out, retries with jittered exponential backoff for network errors,
 * 408/425/429 and 5xx. 4xx responses fail immediately with ApiError carrying the server's
 * `{ error }` message.
 */
import type {
  AuditData,
  ChangeRecord,
  ChangeStatus,
  ChangeType,
  ConnectionResult,
  JobKind,
  PageMetrics,
  SealedEnvelope,
  SiteConfig,
  Target,
} from "@seo-autopilot/core";

// ------------------------------------------------------------------ DB row shapes (snake_case)
export interface JobRow {
  id: string;
  org_id: string;
  site_id: string | null;
  kind: JobKind;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  params: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
  cancel_requested?: boolean;
  created_at?: string;
  started_at?: string | null;
}

export interface SiteRow {
  id: string;
  org_id: string;
  name: string;
  url: string;
  platform: "wordpress" | "shopify" | "repo" | "other";
  runner_id?: string | null;
  policy: Record<string, unknown>;
  config: SiteConfig & Record<string, unknown>;
  connection?: Record<string, unknown>;
  health_score?: number | null;
}

export interface LogLine {
  ts: string;
  level: "debug" | "info" | "warn" | "error" | "agent" | "tool";
  message: string;
}

export interface RunnerHealth {
  claude: { ok: boolean; version?: string | null; auth?: string | null };
  claude_seo: { ok: boolean; version?: string | null; path?: string | null };
  python: { ok: boolean; version?: string | null };
  busy: boolean;
  job_id?: string;
}

export interface ProposalPayload {
  type: ChangeType;
  target: Target;
  before: unknown;
  after: unknown;
  rationale: string;
  evidence?: string;
  expected_impact?: string;
  failure_check?: string;
  finding_title?: string;
  metrics?: PageMetrics;
  capability: boolean;
}

export interface ManualRecommendation {
  title: string;
  detail: string;
  url?: string;
}

export interface FindingRow {
  id: string;
  category: string;
  severity: string;
  title: string;
  description?: string | null;
  recommendation?: string | null;
  url?: string | null;
  status?: string;
}

export interface AuditRow {
  id: string;
  site_id: string;
  depth: string;
  health_score: number | null;
  business_type?: string | null;
  summary: Record<string, unknown>;
  categories: unknown[];
  action_plan?: unknown;
  report_md?: string | null;
  action_plan_md?: string | null;
  created_at?: string;
}

export interface ChangeUpdate {
  status: ChangeStatus;
  before?: unknown;
  rollback_data?: unknown;
  verify_result?: unknown;
  pr_url?: string;
  error?: string;
}

export interface MetricsRow {
  url: string;
  period_end: string;
  days: number;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

// ------------------------------------------------------------------ errors
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** Network failures (status 0), timeouts, throttling and server errors are worth retrying. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}

export interface ApiOptions {
  server: string;
  token?: string;
  fetch?: typeof fetch;
  /** Retries after the first attempt (default 3). */
  retries?: number;
  /** Base backoff in ms (default 500). */
  backoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RunnerApi {
  private readonly server: string;
  private readonly token?: string;
  private readonly f: typeof fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(opts: ApiOptions) {
    this.server = opts.server.replace(/\/+$/, "");
    this.token = opts.token;
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.retries = opts.retries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.userAgent = opts.userAgent ?? "seo-autopilot-runner";
  }

  /** Low-level request with retries. `auth: false` skips the bearer header (register). */
  async request<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    const url = `${this.server}${path}`;
    let attempt = 0;
    for (;;) {
      try {
        return await this.once<T>(method, url, path, body, opts.auth !== false);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(String((e as Error)?.message ?? e), 0, path);
        if (!err.retryable || attempt >= this.retries) throw err;
        const base = this.backoffMs * 2 ** attempt;
        const jitter = Math.random() * base;
        attempt++;
        await this.sleep(Math.min(30_000, base + jitter));
      }
    }
  }

  private async once<T>(method: string, url: string, path: string, body: unknown, auth: boolean): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": this.userAgent };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError("Runner token missing; register first", 401, path);
      headers.authorization = `Bearer ${this.token}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const msg = (e as Error)?.name === "AbortError" ? `Request timed out after ${this.timeoutMs} ms` : String((e as Error)?.message ?? e);
      throw new ApiError(`${method} ${path}: ${msg}`, 0, path);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const serverMsg =
        parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 300) || res.statusText;
      throw new ApiError(`${method} ${path} failed (${res.status}): ${serverMsg}`, res.status, path, parsed);
    }
    if (parsed === undefined) {
      if (!text) return {} as T;
      throw new ApiError(`${method} ${path}: response is not JSON`, res.status, path, text.slice(0, 300));
    }
    return parsed as T;
  }

  // ------------------------------------------------------------------ routes
  register(body: { code: string; name: string; public_key: string; version: string }) {
    return this.request<{ runner_id: string; token: string; org_id: string }>("POST", "/api/runner/register", body, { auth: false });
  }

  heartbeat(body: { version: string; status: RunnerHealth }) {
    return this.request<{ ok: true; server_time: string }>("POST", "/api/runner/heartbeat", body);
  }

  claim() {
    return this.request<{ job: JobRow | null; site: SiteRow | null; secret: SealedEnvelope | null }>("POST", "/api/runner/claim", {});
  }

  logs(jobId: string, lines: LogLine[]) {
    return this.request<{ ok: true; cancel_requested: boolean }>("POST", `/api/runner/jobs/${enc(jobId)}/logs`, { lines });
  }

  complete(jobId: string, body: { status: "succeeded" | "failed"; result?: unknown; error?: string; cost_usd?: number }) {
    return this.request<{ ok: true }>("POST", `/api/runner/jobs/${enc(jobId)}/complete`, body);
  }

  getSite(siteId: string) {
    return this.request<{ site: SiteRow; secret: SealedEnvelope | null }>("GET", `/api/runner/sites/${enc(siteId)}`);
  }

  postConnection(siteId: string, body: ConnectionResult & { capabilities: ChangeType[]; config_patch?: Partial<SiteConfig> }) {
    return this.request<{ ok: true }>("POST", `/api/runner/sites/${enc(siteId)}/connection`, body);
  }

  postAudit(
    siteId: string,
    body: { job_id: string; depth: "full" | "page"; audit_data: AuditData; report_md?: string; action_plan_md?: string },
  ) {
    return this.request<{ audit_id: string; propose_job_id?: string }>("POST", `/api/runner/sites/${enc(siteId)}/audits`, body);
  }

  getAudit(siteId: string, auditId: string) {
    return this.request<{ audit: AuditRow; findings: FindingRow[] }>(
      "GET",
      `/api/runner/sites/${enc(siteId)}/audits/${enc(auditId)}`,
    );
  }

  postChanges(
    siteId: string,
    body: { job_id: string; audit_id?: string; proposals: ProposalPayload[]; manual_recommendations: ManualRecommendation[] },
  ) {
    return this.request<{ batch_id: string; created: Array<{ id: string; tier: string; status: string }> }>(
      "POST",
      `/api/runner/sites/${enc(siteId)}/changes`,
      body,
    );
  }

  listChanges(siteId: string, statuses: ChangeStatus[]) {
    const q = statuses.length ? `?status=${statuses.map(encodeURIComponent).join(",")}` : "";
    return this.request<{ changes: ChangeRecord[] }>("GET", `/api/runner/sites/${enc(siteId)}/changes${q}`);
  }

  updateChange(changeId: string, body: ChangeUpdate) {
    return this.request<{ ok: true }>("POST", `/api/runner/changes/${enc(changeId)}`, body);
  }

  postMetrics(siteId: string, rows: MetricsRow[]) {
    return this.request<{ ok: true; alerts: unknown[] }>("POST", `/api/runner/sites/${enc(siteId)}/metrics`, { rows });
  }
}

const enc = encodeURIComponent;

/** The subset of RunnerApi job handlers use; lets tests pass a fake. */
export type JobApi = Pick<
  RunnerApi,
  "getSite" | "postConnection" | "postAudit" | "getAudit" | "postChanges" | "listChanges" | "updateChange" | "postMetrics"
>;
