/**
 * Pure-ish ingest logic for runner uploads (audits, proposals, metrics). The DB access is behind
 * small interfaces so the classification rules can be unit-tested with fakes.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AuditData,
  ChangeType,
  classify,
  diffHash,
  initialStatus,
  parsePayload,
  ResourceRef,
  type PageMetrics,
  type SitePolicy,
  type Tier,
} from "@seo-autopilot/core";
import type { FindingSeverity } from "./types";

// ------------------------------------------------------------------ audits
const SEVERITIES: FindingSeverity[] = ["Critical", "High", "Medium", "Low", "Info"];

export function normalizeSeverity(s: unknown): FindingSeverity {
  const v = String(s ?? "").trim().toLowerCase();
  if (!v) return "Info";
  if (v.startsWith("crit") || v === "p0" || v === "blocker" || v === "severe") return "Critical";
  if (v.startsWith("high") || v === "p1" || v === "major" || v === "error") return "High";
  if (v.startsWith("med") || v === "moderate" || v === "p2" || v === "warning" || v === "warn") return "Medium";
  if (v.startsWith("low") || v === "minor" || v === "p3") return "Low";
  if (v.startsWith("info") || v === "notice" || v === "pass" || v === "ok") return "Info";
  const exact = SEVERITIES.find((x) => x.toLowerCase() === v);
  return exact ?? "Info";
}

export interface FindingInsert {
  category: string;
  severity: FindingSeverity;
  title: string;
  description: string | null;
  recommendation: string | null;
  url: string | null;
}

export function flattenFindings(audit: AuditData): FindingInsert[] {
  const out: FindingInsert[] = [];
  for (const cat of audit.categories ?? []) {
    for (const f of cat.findings ?? []) {
      if (!f.title) continue;
      out.push({
        category: cat.name,
        severity: normalizeSeverity(f.severity),
        title: f.title.slice(0, 500),
        description: f.description || null,
        recommendation: f.recommendation || null,
        url: f.url || null,
      });
    }
  }
  return out;
}

export function auditHealthScore(audit: AuditData): number | null {
  const n = audit.summary?.health_score;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ------------------------------------------------------------------ proposals
export const IncomingProposal = z.object({
  type: ChangeType,
  target: z.object({ url: z.string().url(), resource: ResourceRef.optional() }),
  before: z.unknown().optional(),
  after: z.unknown(),
  rationale: z.string().optional().default(""),
  evidence: z.string().optional(),
  expected_impact: z.string().optional(),
  failure_check: z.string().optional(),
  finding_title: z.string().optional(),
  metrics: z
    .object({
      clicks28d: z.number().optional(),
      impressions28d: z.number().optional(),
      ctr28d: z.number().optional(),
      position28d: z.number().optional(),
      backlinks: z.number().optional(),
    })
    .partial()
    .nullish(),
  capability: z.boolean(),
});
export type IncomingProposal = z.infer<typeof IncomingProposal>;

export const ChangesBody = z.object({
  job_id: z.string().uuid().optional().nullable(),
  audit_id: z.string().uuid().optional().nullable(),
  proposals: z.array(z.unknown()).max(1000),
  manual_recommendations: z.array(z.object({ title: z.string(), detail: z.string(), url: z.string().optional() })).optional().default([]),
});

/** Normalize a URL for metric matching: lowercase host, no hash, no trailing slash (except root). */
export function normalizeUrlKey(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    let p = x.pathname;
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return `${x.protocol}//${x.host.toLowerCase()}${p}${x.search}`;
  } catch {
    return u.replace(/\/+$/, "");
  }
}

export interface IngestContext {
  orgId: string;
  site: { id: string; url: string };
  policy: SitePolicy;
  now: Date;
  batchId: string;
  auditId: string | null;
  /** latest 28-day metrics per normalized URL */
  metricsByUrl: Map<string, PageMetrics>;
  /** changes approved_via='policy' today for the site */
  autoAppliedToday: number;
  /** diff hashes already pending/approved/applied(ish) for the site */
  existingHashes: Set<string>;
  /** finding id by title (latest audit), to link changes back */
  findingIdByTitle: Map<string, string>;
}

export interface ChangeInsert {
  id: string;
  org_id: string;
  site_id: string;
  audit_id: string | null;
  finding_id: string | null;
  batch_id: string;
  type: string;
  target: unknown;
  before: unknown;
  after: unknown;
  rationale: string | null;
  evidence: string | null;
  expected_impact: string | null;
  failure_check: string | null;
  tier: Tier;
  risk_reasons: string[];
  status: "approved" | "pending_approval" | "blocked";
  diff_hash: string;
  page_metrics: PageMetrics | null;
  approved_via: string | null;
  approver_label: string | null;
  decided_at: string | null;
  expires_at: string | null;
}

export interface IngestOutcome {
  rows: ChangeInsert[];
  rejected: Array<{ index: number; error: string }>;
  duplicates: Array<{ index: number; diff_hash: string }>;
  findingTitles: string[];
}

/**
 * Validate, hash, enrich, classify and dedupe a batch of proposals. No I/O.
 *   - payload validated with parsePayload (invalid → rejected, not stored)
 *   - metrics: page_metrics row for the URL merged with (overridden by) runner-provided metrics
 *   - autoAppliedToday includes approvals earlier in this same batch
 *   - capability=false → tier never, status blocked, reason "This platform can't apply …"
 *   - status = initialStatus(tier, mode); policy approvals carry approved_via='policy'
 *   - identical diff_hash already active for the site (or earlier in this batch) → skipped
 */
export function buildChangeRows(rawProposals: unknown[], ctx: IngestContext): IngestOutcome {
  const out: IngestOutcome = { rows: [], rejected: [], duplicates: [], findingTitles: [] };
  const seen = new Set(ctx.existingHashes);
  const parsed: Array<{ index: number; p: IncomingProposal; after: unknown }> = [];
  rawProposals.forEach((raw, index) => {
    const r = IncomingProposal.safeParse(raw);
    if (!r.success) {
      out.rejected.push({ index, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const pay = parsePayload(r.data.type, r.data.after);
    if (!pay.success) {
      out.rejected.push({ index, error: `after: ${pay.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
      return;
    }
    parsed.push({ index, p: r.data, after: pay.data });
  });

  const batchSize = parsed.length;
  let autoToday = ctx.autoAppliedToday;
  const nowIso = ctx.now.toISOString();
  const expires = new Date(ctx.now.getTime() + ctx.policy.approval_ttl_hours * 3600 * 1000).toISOString();

  for (const { index, p, after } of parsed) {
    const url = p.target.url;
    const hash = diffHash(p.type, url, after);
    if (seen.has(hash)) {
      out.duplicates.push({ index, diff_hash: hash });
      continue;
    }
    seen.add(hash);

    const stored = ctx.metricsByUrl.get(normalizeUrlKey(url));
    const provided = Object.fromEntries(Object.entries(p.metrics ?? {}).filter(([, v]) => v !== undefined && v !== null));
    const metrics: PageMetrics | null = stored || Object.keys(provided).length ? { ...(stored ?? {}), ...provided } : null;

    let tier: Tier;
    let reasons: string[];
    let status: ChangeInsert["status"];
    if (!p.capability) {
      tier = "never";
      reasons = [`This platform can't apply ${p.type} automatically — do it by hand`];
      status = "blocked";
    } else {
      const d = classify(
        {
          type: p.type,
          url,
          siteUrl: ctx.site.url,
          before: p.before ?? null,
          after,
          metrics,
          batchSize,
          autoAppliedToday: autoToday,
          resourceFile: p.target.resource?.file,
        },
        ctx.policy,
      );
      tier = d.tier;
      reasons = d.reasons;
      status = initialStatus(tier, ctx.policy.mode);
    }
    if (status === "approved") autoToday++;

    if (p.finding_title) out.findingTitles.push(p.finding_title);
    out.rows.push({
      id: randomUUID(),
      org_id: ctx.orgId,
      site_id: ctx.site.id,
      audit_id: ctx.auditId,
      finding_id: p.finding_title ? (ctx.findingIdByTitle.get(p.finding_title) ?? null) : null,
      batch_id: ctx.batchId,
      type: p.type,
      target: p.target,
      before: p.before ?? null,
      after,
      rationale: p.rationale || null,
      evidence: p.evidence ?? null,
      expected_impact: p.expected_impact ?? null,
      failure_check: p.failure_check ?? null,
      tier,
      risk_reasons: reasons,
      status,
      diff_hash: hash,
      page_metrics: metrics,
      approved_via: status === "approved" ? "policy" : null,
      approver_label: status === "approved" ? "auto policy" : null,
      decided_at: status === "approved" ? nowIso : null,
      expires_at: status === "pending_approval" ? expires : null,
    });
  }
  return out;
}

/** Statuses that make a diff_hash "already in flight" for dedupe. */
export const ACTIVE_STATUSES = ["pending_approval", "approved", "applying", "applied", "verifying", "verified"] as const;

// ------------------------------------------------------------------ metrics / traffic alerts
export const MetricsBody = z.object({
  rows: z
    .array(
      z.object({
        url: z.string().min(1),
        period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
        days: z.number().int().min(1).max(366).default(28),
        clicks: z.number().nullable().optional(),
        impressions: z.number().nullable().optional(),
        ctr: z.number().nullable().optional(),
        position: z.number().nullable().optional(),
      }),
    )
    .max(25000),
});

export interface AlertCandidate {
  change_id: string;
  url: string;
  type: string;
  applied_at: string;
  baseline_clicks: number;
  current_clicks: number;
  drop_pct: number;
  period_end: string;
}

/**
 * For changes verified ≥ 14 days after apply: compare clicks in the newest 28-day period that ends
 * after applied_at with the clicks stored on the change at proposal time (page_metrics.clicks28d).
 */
export function computeTrafficAlerts(
  changes: Array<{ id: string; type: string; target: { url: string }; applied_at: string | null; verified_at: string | null; page_metrics: PageMetrics | null }>,
  metrics: Array<{ url: string; period_end: string; days: number; clicks: number | null }>,
  dropPct: number,
  now: Date = new Date(),
): AlertCandidate[] {
  const DAY = 86400000;
  const byUrl = new Map<string, Array<{ period_end: string; clicks: number }>>();
  for (const m of metrics) {
    if (m.days !== 28 || m.clicks === null || m.clicks === undefined) continue;
    const k = normalizeUrlKey(m.url);
    const list = byUrl.get(k) ?? [];
    list.push({ period_end: m.period_end.slice(0, 10), clicks: m.clicks });
    byUrl.set(k, list);
  }
  const alerts: AlertCandidate[] = [];
  for (const c of changes) {
    if (!c.applied_at) continue;
    const applied = Date.parse(c.applied_at);
    if (now.getTime() - applied < 14 * DAY) continue;
    const baseline = c.page_metrics?.clicks28d;
    if (typeof baseline !== "number" || baseline <= 0) continue;
    const list = (byUrl.get(normalizeUrlKey(c.target.url)) ?? [])
      .filter((m) => Date.parse(m.period_end) >= applied + 14 * DAY)
      .sort((a, b) => b.period_end.localeCompare(a.period_end));
    const latest = list[0];
    if (!latest) continue;
    const drop = ((baseline - latest.clicks) / baseline) * 100;
    if (drop >= dropPct) {
      alerts.push({
        change_id: c.id,
        url: c.target.url,
        type: c.type,
        applied_at: c.applied_at,
        baseline_clicks: baseline,
        current_clicks: latest.clicks,
        drop_pct: Math.round(drop * 10) / 10,
        period_end: latest.period_end,
      });
    }
  }
  return alerts;
}
