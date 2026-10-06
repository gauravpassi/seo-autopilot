import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { diffHash } from "@seo-autopilot/core";
import { ingestProposals } from "../lib/change-ingest";
import { computeTrafficAlerts, flattenFindings, normalizeSeverity, normalizeUrlKey } from "../lib/ingest";
import { FakeDb } from "./fake-supabase";

const ORG = "org-1";
const SITE = { id: "site-1", url: "https://www.example.com" };
const NOW = new Date("2026-10-06T10:00:00Z");

const prop = (over: Record<string, unknown> = {}) => ({
  type: "meta_description",
  target: { url: "https://www.example.com/blog/post-a" },
  before: null,
  after: { value: "A helpful description of post A." },
  rationale: "Missing meta description",
  capability: true,
  ...over,
});

function setup(tables: Record<string, Array<Record<string, unknown>>> = {}) {
  const db = new FakeDb({
    changes: [],
    page_metrics: [],
    audits: [{ id: "audit-1", site_id: SITE.id, created_at: "2026-10-05T00:00:00Z" }],
    findings: [{ id: "f-1", audit_id: "audit-1", title: "Missing meta descriptions", status: "open" }],
    jobs: [{ id: "job-1", org_id: ORG, kind: "propose", status: "running", result: null }],
    ...tables,
  });
  return { db, sb: db as unknown as SupabaseClient };
}

describe("ingestProposals", () => {
  it("suggest mode: auto-tier changes wait for approval with the suggest reason and an expiry", async () => {
    const { db, sb } = setup();
    const r = await ingestProposals(sb, { orgId: ORG, site: { ...SITE, policy: {} }, jobId: "job-1", proposals: [prop()], manualRecommendations: [], now: NOW });
    expect(r.created).toHaveLength(1);
    const row = db.tables.changes[0];
    expect(row.status).toBe("pending_approval");
    expect(row.tier).toBe("approve");
    expect(row.risk_reasons).toContain("Site is in suggest mode: every change needs approval");
    expect(row.expires_at).toBe(new Date(NOW.getTime() + 72 * 3600e3).toISOString());
    expect(row.diff_hash).toBe(diffHash("meta_description", "https://www.example.com/blog/post-a", { value: "A helpful description of post A." }));
    expect(r.pendingIds).toEqual([row.id]);
    expect(r.applyJobId).toBeNull();
  });

  it("auto mode: approves by policy, stamps approver, and enqueues one apply job", async () => {
    const { db, sb } = setup();
    const r = await ingestProposals(sb, {
      orgId: ORG,
      site: { ...SITE, policy: { mode: "auto" } },
      proposals: [prop(), prop({ target: { url: "https://www.example.com/blog/post-b" } })],
      manualRecommendations: [],
      now: NOW,
    });
    expect(r.approvedIds).toHaveLength(2);
    for (const c of db.tables.changes) {
      expect(c.status).toBe("approved");
      expect(c.approved_via).toBe("policy");
      expect(c.approver_label).toBe("auto policy");
      expect(c.decided_at).toBe(NOW.toISOString());
      expect(c.expires_at).toBeNull();
    }
    expect(db.tables.jobs.filter((j) => j.kind === "apply")).toHaveLength(1);
    expect(r.applyJobId).toBeTruthy();
  });

  it("does not stack an apply job when one is already queued", async () => {
    const { db, sb } = setup({ jobs: [{ id: "apply-0", org_id: ORG, site_id: SITE.id, kind: "apply", status: "queued" }] });
    const r = await ingestProposals(sb, { orgId: ORG, site: { ...SITE, policy: { mode: "auto" } }, proposals: [prop()], manualRecommendations: [], now: NOW });
    expect(r.applyJobId).toBeNull();
    expect(db.tables.jobs.filter((j) => j.kind === "apply")).toHaveLength(1);
  });

  it("enforces the daily auto cap including earlier policy approvals and this batch", async () => {
    const earlier = Array.from({ length: 2 }, (_, i) => ({
      id: `old-${i}`, site_id: SITE.id, approved_via: "policy", decided_at: "2026-10-06T01:00:00Z", status: "applied", diff_hash: `h${i}`,
    }));
    const yesterday = { id: "old-y", site_id: SITE.id, approved_via: "policy", decided_at: "2026-10-05T23:00:00Z", status: "verified", diff_hash: "hy" };
    const { db, sb } = setup({ changes: [...earlier, yesterday] });
    await ingestProposals(sb, {
      orgId: ORG,
      site: { ...SITE, policy: { mode: "auto", max_auto_per_day: 3 } },
      proposals: ["a", "b", "c"].map((p) => prop({ target: { url: `https://www.example.com/${p}` } })),
      manualRecommendations: [],
      now: NOW,
    });
    const fresh = db.tables.changes.filter((c) => !String(c.id).startsWith("old"));
    expect(fresh.map((c) => c.status)).toEqual(["approved", "pending_approval", "pending_approval"]);
    expect(fresh[1].risk_reasons).toContain("Daily auto limit of 3 reached");
  });

  it("blocks types the platform cannot apply", async () => {
    const { db, sb } = setup();
    await ingestProposals(sb, { orgId: ORG, site: { ...SITE, policy: { mode: "auto" } }, proposals: [prop({ type: "h1", after: { value: "New" }, capability: false })], manualRecommendations: [], now: NOW });
    const c = db.tables.changes[0];
    expect(c.status).toBe("blocked");
    expect(c.tier).toBe("never");
    expect(c.risk_reasons).toEqual(["This platform can't apply h1 automatically — do it by hand"]);
    expect(c.expires_at).toBeNull();
  });

  it("rejects invalid payloads without storing them", async () => {
    const { db, sb } = setup();
    const r = await ingestProposals(sb, {
      orgId: ORG,
      site: { ...SITE, policy: {} },
      proposals: [prop({ after: { value: "" } }), prop({ type: "nope" }), prop({ target: { url: "not a url" } })],
      manualRecommendations: [],
      now: NOW,
    });
    expect(r.created).toHaveLength(0);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(db.tables.changes).toHaveLength(0);
  });

  it("dedupes against active changes and within the batch, but not against rejected ones", async () => {
    const p = prop();
    const hash = diffHash(p.type, p.target.url, p.after);
    const { sb } = setup({ changes: [{ id: "x", site_id: SITE.id, diff_hash: hash, status: "pending_approval" }] });
    const r1 = await ingestProposals(sb, { orgId: ORG, site: { ...SITE, policy: {} }, proposals: [p, p], manualRecommendations: [], now: NOW });
    expect(r1.created).toHaveLength(0);
    expect(r1.duplicates).toHaveLength(2);

    const { sb: sb2 } = setup({ changes: [{ id: "x", site_id: SITE.id, diff_hash: hash, status: "rejected" }] });
    const r2 = await ingestProposals(sb2, { orgId: ORG, site: { ...SITE, policy: {} }, proposals: [p, p], manualRecommendations: [], now: NOW });
    expect(r2.created).toHaveLength(1);
    expect(r2.duplicates).toHaveLength(1);
  });

  it("enriches with stored page metrics (trailing slash tolerant) and lets runner metrics override", async () => {
    const { db, sb } = setup({
      page_metrics: [
        { site_id: SITE.id, url: "https://www.example.com/blog/post-a/", period_end: "2026-09-30", days: 28, clicks: 40, impressions: 900, ctr: 0.04, position: 8.1 },
        { site_id: SITE.id, url: "https://www.example.com/blog/post-a/", period_end: "2026-08-31", days: 28, clicks: 1, impressions: 2, ctr: 0.5, position: 50 },
      ],
    });
    await ingestProposals(sb, { orgId: ORG, site: { ...SITE, policy: { mode: "auto" } }, proposals: [prop({ metrics: { backlinks: 3, position28d: 7 } })], manualRecommendations: [], now: NOW });
    const c = db.tables.changes[0];
    expect(c.page_metrics).toEqual({ clicks28d: 40, impressions28d: 900, ctr28d: 0.04, position28d: 7, backlinks: 3 });
    // traffic escalator: auto -> approve on an important page, even in auto mode
    expect(c.status).toBe("pending_approval");
    expect((c.risk_reasons as string[]).some((r) => r.startsWith("Page has traffic"))).toBe(true);
  });

  it("links findings, marks them fix_proposed, and stores manual recommendations on the job", async () => {
    const { db, sb } = setup();
    await ingestProposals(sb, {
      orgId: ORG,
      site: { ...SITE, policy: {} },
      jobId: "job-1",
      proposals: [prop({ finding_title: "Missing meta descriptions" })],
      manualRecommendations: [{ title: "Speed up LCP", detail: "Compress hero image" }],
      now: NOW,
    });
    expect(db.tables.changes[0].finding_id).toBe("f-1");
    expect(db.tables.changes[0].audit_id).toBe("audit-1");
    expect(db.tables.findings[0].status).toBe("fix_proposed");
    const job = db.tables.jobs.find((j) => j.id === "job-1")!;
    expect((job.result as { manual_recommendations: unknown[] }).manual_recommendations).toHaveLength(1);
  });

  it("protected paths and robots disallow-all are never automated", async () => {
    const { db, sb } = setup();
    await ingestProposals(sb, {
      orgId: ORG,
      site: { ...SITE, policy: { mode: "auto", protected_paths: ["/checkout"] } },
      proposals: [
        prop({ target: { url: "https://www.example.com/checkout/cart" } }),
        prop({ type: "robots_txt", target: { url: "https://www.example.com/robots.txt" }, after: { content: "User-agent: *\nDisallow: /" } }),
      ],
      manualRecommendations: [],
      now: NOW,
    });
    expect(db.tables.changes.map((c) => c.status)).toEqual(["blocked", "blocked"]);
  });
});

describe("audit flattening", () => {
  it("normalizes severities", () => {
    expect(["critical", "HIGH", "Medium", "warning", "low", "info", "", "weird", "P0"].map(normalizeSeverity)).toEqual([
      "Critical", "High", "Medium", "Medium", "Low", "Info", "Info", "Info", "Critical",
    ]);
  });
  it("flattens categories into findings", () => {
    const f = flattenFindings({
      summary: {},
      categories: [
        { name: "Technical", findings: [{ title: "No sitemap", severity: "high", description: "", recommendation: "Add one" }] },
        { name: "Schema", findings: [{ title: "Invalid JSON-LD", severity: "Critical", description: "d", recommendation: "", url: "https://x.com/a" }] },
      ],
    });
    expect(f).toEqual([
      { category: "Technical", severity: "High", title: "No sitemap", description: null, recommendation: "Add one", url: null },
      { category: "Schema", severity: "Critical", title: "Invalid JSON-LD", description: "d", recommendation: null, url: "https://x.com/a" },
    ]);
  });
});

describe("traffic alerts", () => {
  const change = {
    id: "c1",
    type: "title",
    target: { url: "https://www.example.com/page/" },
    applied_at: "2026-08-01T00:00:00Z",
    verified_at: "2026-08-01T01:00:00Z",
    page_metrics: { clicks28d: 100 },
  };
  it("flags drops at or above the threshold using the newest period ending ≥ 14 days after apply", () => {
    const alerts = computeTrafficAlerts(
      [change],
      [
        { url: "https://www.example.com/page", period_end: "2026-08-10", days: 28, clicks: 10 }, // too early, ignored
        { url: "https://www.example.com/page", period_end: "2026-09-30", days: 28, clicks: 75 },
        { url: "https://www.example.com/page", period_end: "2026-09-01", days: 28, clicks: 95 },
      ],
      20,
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ change_id: "c1", baseline_clicks: 100, current_clicks: 75, drop_pct: 25, period_end: "2026-09-30" });
  });
  it("ignores small drops, recent changes, and changes without a baseline", () => {
    const m = [{ url: "https://www.example.com/page", period_end: "2026-09-30", days: 28, clicks: 85 }];
    expect(computeTrafficAlerts([change], m, 20, NOW)).toHaveLength(0);
    expect(computeTrafficAlerts([{ ...change, applied_at: "2026-09-30T00:00:00Z" }], m, 10, NOW)).toHaveLength(0);
    expect(computeTrafficAlerts([{ ...change, page_metrics: null }], m, 10, NOW)).toHaveLength(0);
  });
  it("normalizes URLs", () => {
    expect(normalizeUrlKey("https://WWW.Example.com/a/b/#x")).toBe("https://www.example.com/a/b");
    expect(normalizeUrlKey("https://example.com/")).toBe("https://example.com/");
  });
});
