import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffHash, policyWithDefaults, type ChangeRecord, type ChangeType, type SiteAdapter } from "@seo-autopilot/core";
import type { VerifyResult } from "@seo-autopilot/core/verify";
import type { ChangeUpdate, JobApi, JobRow, SiteRow } from "../src/api";
import type { VerifyDeps } from "../src/jobs/changes";
import type { JobContext } from "../src/jobs/context";

export const SITE: SiteRow = {
  id: "site-1",
  org_id: "org-1",
  name: "Example",
  url: "https://www.example.com",
  platform: "wordpress",
  policy: {},
  config: {},
};

export function change(over: Partial<ChangeRecord> & { type?: ChangeType } = {}): ChangeRecord {
  const type = over.type ?? "title";
  const target = over.target ?? { url: "https://www.example.com/about", resource: { kind: "page", id: "12" } };
  const after = over.after ?? { value: "About Example | Example" };
  return {
    id: over.id ?? `chg-${Math.random().toString(36).slice(2, 10)}`,
    site_id: SITE.id,
    type,
    target,
    before: over.before === undefined ? { value: "About" } : over.before,
    after,
    tier: "approve",
    risk_reasons: [],
    status: over.status ?? "approved",
    diff_hash: over.diff_hash ?? diffHash(type, target.url, after),
    rollback_data: over.rollback_data,
    pr_url: over.pr_url,
  };
}

export class FakeApi implements Partial<JobApi> {
  updates: Array<{ id: string } & ChangeUpdate> = [];
  posted: unknown[] = [];
  constructor(public changes: ChangeRecord[] = []) {}
  async listChanges(_site: string, statuses: string[]) {
    return { changes: this.changes.filter((c) => statuses.includes(c.status)) };
  }
  async updateChange(id: string, body: ChangeUpdate) {
    this.updates.push({ id, ...body });
    return { ok: true as const };
  }
  async postChanges(_site: string, body: unknown) {
    this.posted.push(body);
    return { batch_id: "b1", created: [] };
  }
  statusesFor(id: string): string[] {
    return this.updates.filter((u) => u.id === id).map((u) => u.status);
  }
  last(id: string) {
    return this.updates.filter((u) => u.id === id).at(-1);
  }
}

export class FakeAdapter implements SiteAdapter {
  readonly platform = "wordpress" as const;
  live = new Map<string, unknown>();
  applied: string[] = [];
  rolledBack: string[] = [];
  failApply = false;
  caps: ChangeType[] = ["title", "meta_description", "image_alt", "jsonld_add"];
  key = (c: Pick<ChangeRecord, "type" | "target">) => `${c.type}@${c.target.url}`;
  async capabilities() {
    return this.caps;
  }
  async testConnection() {
    return { ok: true, details: {}, warnings: [] };
  }
  async resolve(url: string) {
    return url.includes("/unmapped") ? null : { kind: "page" as const, id: "12" };
  }
  async read(c: Pick<ChangeRecord, "type" | "target" | "after">) {
    return this.live.has(this.key(c)) ? this.live.get(this.key(c)) : null;
  }
  async apply(c: ChangeRecord) {
    if (this.failApply) throw new Error("WordPress returned 500");
    const prev = this.live.get(this.key(c)) ?? null;
    this.live.set(this.key(c), c.after);
    this.applied.push(c.id);
    return { rollback: { previous: prev } };
  }
  async rollback(c: ChangeRecord) {
    this.live.set(this.key(c), (c.rollback_data as { previous: unknown }).previous);
    this.rolledBack.push(c.id);
  }
  async purge() {}
}

export function verifyDeps(results: (c: ChangeRecord, expect?: string) => boolean): VerifyDeps & { calls: Array<{ id: string; expect?: string }> } {
  const calls: Array<{ id: string; expect?: string }> = [];
  const mk = (c: ChangeRecord, expect?: string): VerifyResult => {
    calls.push({ id: c.id, expect });
    const ok = results(c, expect);
    return { ok, retryable: !ok, checks: [{ name: "value", ok }], checked_url: c.target.url, at: new Date().toISOString() };
  };
  return {
    calls,
    verifyChange: (async (c: ChangeRecord, o: { expect?: string }) => mk(c, o.expect)) as VerifyDeps["verifyChange"],
    verifyWithRetry: (async (c: ChangeRecord, o: { expect?: string }) => mk(c, o.expect)) as VerifyDeps["verifyWithRetry"],
  };
}

export function ctxFor(opts: { api: FakeApi; adapter: SiteAdapter; site?: SiteRow; policy?: Record<string, unknown>; params?: Record<string, unknown>; kind?: JobRow["kind"] }): JobContext & { logs: string[] } {
  const logs: string[] = [];
  const site = opts.site ?? SITE;
  return {
    logs,
    job: { id: "job-1", org_id: "org-1", site_id: site.id, kind: opts.kind ?? "apply", status: "running", params: opts.params ?? {} },
    site,
    secrets: { platform: "wordpress", username: "u", app_password: "p" },
    policy: policyWithDefaults(opts.policy ?? {}),
    api: opts.api as unknown as JobApi,
    config: { server: "https://panel.example.com", runner_id: "r", token: "t", private_key_pem: "k", name: "test" },
    workDir: mkdtempSync(join(tmpdir(), "seo-job-")),
    log: (level, message) => logs.push(`${level}: ${message}`),
    signal: new AbortController().signal,
    adapter: () => opts.adapter,
    claude: async () => {
      throw new Error("claude not available in tests");
    },
    addCost: () => {},
    sleep: async () => {},
    verifyDelaysMs: [0],
  };
}
