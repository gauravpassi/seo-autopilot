/**
 * Storing proposals from a `propose` job: gathers DB context, runs buildChangeRows (pure),
 * inserts, links findings, records manual recommendations on the job, enqueues apply for
 * policy-approved changes. Notifications are left to the caller (after()).
 *
 * Takes a SupabaseClient so tests can pass an in-memory fake.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { policyWithDefaults, type PageMetrics } from "@seo-autopilot/core";
import { ACTIVE_STATUSES, buildChangeRows, normalizeUrlKey, type IngestOutcome } from "./ingest";
import { enqueueApplyIfNone } from "./jobs";

export interface IngestInput {
  orgId: string;
  site: { id: string; url: string; policy: unknown };
  jobId?: string | null;
  auditId?: string | null;
  proposals: unknown[];
  manualRecommendations: Array<{ title: string; detail: string; url?: string }>;
  now?: Date;
}

export interface IngestResult {
  batch_id: string;
  created: Array<{ id: string; tier: string; status: string }>;
  rejected: IngestOutcome["rejected"];
  duplicates: IngestOutcome["duplicates"];
  pendingIds: string[];
  approvedIds: string[];
  applyJobId: string | null;
  manual_recommendations: IngestInput["manualRecommendations"];
}

function startOfUtcDay(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function urlVariants(urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    out.add(u);
    const k = normalizeUrlKey(u);
    out.add(k);
    if (!k.endsWith("/")) out.add(`${k}/`);
  }
  return [...out].slice(0, 500);
}

export async function ingestProposals(db: SupabaseClient, input: IngestInput): Promise<IngestResult> {
  const now = input.now ?? new Date();
  const policy = policyWithDefaults(input.site.policy);
  const batchId = randomUUID();
  const siteId = input.site.id;

  // --- metrics (latest 28-day row per URL)
  const urls = input.proposals
    .map((p) => (p as { target?: { url?: unknown } })?.target?.url)
    .filter((u): u is string => typeof u === "string");
  const metricsByUrl = new Map<string, PageMetrics>();
  if (urls.length > 0) {
    const { data } = await db
      .from("page_metrics")
      .select("url, period_end, days, clicks, impressions, ctr, position")
      .eq("site_id", siteId)
      .eq("days", 28)
      .in("url", urlVariants(urls))
      .order("period_end", { ascending: false });
    for (const m of (data ?? []) as Array<{ url: string; clicks: number | null; impressions: number | null; ctr: number | string | null; position: number | string | null }>) {
      const k = normalizeUrlKey(m.url);
      if (metricsByUrl.has(k)) continue;
      const pm: PageMetrics = {};
      if (m.clicks !== null) pm.clicks28d = Number(m.clicks);
      if (m.impressions !== null) pm.impressions28d = Number(m.impressions);
      if (m.ctr !== null) pm.ctr28d = Number(m.ctr);
      if (m.position !== null) pm.position28d = Number(m.position);
      metricsByUrl.set(k, pm);
    }
  }

  // --- auto approvals already made today (daily cap)
  const { count } = await db
    .from("changes")
    .select("id", { count: "exact", head: true })
    .eq("site_id", siteId)
    .eq("approved_via", "policy")
    .gte("decided_at", startOfUtcDay(now));
  const autoAppliedToday = count ?? 0;

  // --- dedupe against changes already in flight
  const { data: active } = await db.from("changes").select("diff_hash").eq("site_id", siteId).in("status", [...ACTIVE_STATUSES]);
  const existingHashes = new Set(((active ?? []) as Array<{ diff_hash: string }>).map((r) => r.diff_hash));

  // --- findings to link (given audit, else the latest one)
  let auditId = input.auditId ?? null;
  if (!auditId) {
    const { data: latest } = await db.from("audits").select("id").eq("site_id", siteId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    auditId = (latest as { id: string } | null)?.id ?? null;
  }
  const findingIdByTitle = new Map<string, string>();
  if (auditId) {
    const { data: f } = await db.from("findings").select("id, title").eq("audit_id", auditId);
    for (const r of (f ?? []) as Array<{ id: string; title: string }>) if (!findingIdByTitle.has(r.title)) findingIdByTitle.set(r.title, r.id);
  }

  const outcome = buildChangeRows(input.proposals, {
    orgId: input.orgId,
    site: { id: siteId, url: input.site.url },
    policy,
    now,
    batchId,
    auditId: input.auditId ?? auditId,
    metricsByUrl,
    autoAppliedToday,
    existingHashes,
    findingIdByTitle,
  });

  if (outcome.rows.length > 0) {
    for (let i = 0; i < outcome.rows.length; i += 200) {
      const { error } = await db.from("changes").insert(outcome.rows.slice(i, i + 200));
      if (error) throw new Error(`changes insert: ${error.message}`);
    }
  }

  // --- mark linked findings
  const linkedFindingIds = [...new Set(outcome.rows.map((r) => r.finding_id).filter((x): x is string => !!x))];
  if (linkedFindingIds.length > 0) {
    await db.from("findings").update({ status: "fix_proposed" }).in("id", linkedFindingIds).eq("status", "open");
  }

  // --- manual recommendations live on the propose job's result
  if (input.jobId) {
    const { data: job } = await db.from("jobs").select("result").eq("id", input.jobId).eq("org_id", input.orgId).maybeSingle();
    const prev = ((job as { result?: unknown } | null)?.result ?? {}) as Record<string, unknown>;
    await db
      .from("jobs")
      .update({
        result: {
          ...(typeof prev === "object" && prev && !Array.isArray(prev) ? prev : {}),
          batch_id: batchId,
          manual_recommendations: input.manualRecommendations,
          created: outcome.rows.length,
          rejected: outcome.rejected,
          duplicates: outcome.duplicates.length,
        },
      })
      .eq("id", input.jobId)
      .eq("org_id", input.orgId);
  }

  const pendingIds = outcome.rows.filter((r) => r.status === "pending_approval").map((r) => r.id);
  const approvedIds = outcome.rows.filter((r) => r.status === "approved").map((r) => r.id);
  let applyJobId: string | null = null;
  if (approvedIds.length > 0 && policy.mode === "auto") {
    applyJobId = await enqueueApplyIfNone(db, input.orgId, siteId, null);
  }

  return {
    batch_id: batchId,
    created: outcome.rows.map((r) => ({ id: r.id, tier: r.tier, status: r.status })),
    rejected: outcome.rejected,
    duplicates: outcome.duplicates,
    pendingIds,
    approvedIds,
    applyJobId,
    manual_recommendations: input.manualRecommendations,
  };
}
