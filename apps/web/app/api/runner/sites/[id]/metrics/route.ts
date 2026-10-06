import { policyWithDefaults, type PageMetrics } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { runAfter } from "@/lib/after";
import { notifyEvent } from "@/lib/notify";
import { computeTrafficAlerts, MetricsBody, normalizeUrlKey } from "@/lib/ingest";
import { typeLabel, shortUrl } from "@/lib/notify/format";
import { authenticateRunner, errorResponse, HttpError, json, loadSiteForRunner, readJson, runnerActor } from "@/lib/runner-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const runner = await authenticateRunner(req);
    const { id } = await ctx.params;
    const site = await loadSiteForRunner(runner, id);
    const parsed = MetricsBody.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const db = createAdmin();
    const rows = parsed.data.rows.map((r) => ({
      site_id: id,
      org_id: runner.orgId,
      url: r.url,
      period_end: r.period_end.slice(0, 10),
      days: r.days,
      clicks: r.clicks ?? null,
      impressions: r.impressions ?? null,
      ctr: r.ctr ?? null,
      position: r.position ?? null,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await db.from("page_metrics").upsert(rows.slice(i, i + 1000), { onConflict: "site_id,url,period_end,days" });
      if (error) throw new HttpError(500, error.message);
    }

    // Traffic guard: changes applied ≥ 14 days ago (verified) on the URLs we just got numbers for.
    const policy = policyWithDefaults(site.policy);
    const urlKeys = new Set(rows.map((r) => normalizeUrlKey(r.url)));
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: changes } = await db
      .from("changes")
      .select("id, type, target, applied_at, verified_at, page_metrics, status")
      .eq("site_id", id)
      .eq("org_id", runner.orgId)
      .eq("status", "verified")
      .lte("applied_at", cutoff)
      .limit(2000);
    const relevant = ((changes ?? []) as Array<{ id: string; type: string; target: { url: string }; applied_at: string | null; verified_at: string | null; page_metrics: PageMetrics | null }>).filter((c) =>
      urlKeys.has(normalizeUrlKey(c.target?.url ?? "")),
    );
    let alerts = computeTrafficAlerts(relevant, rows, policy.rollback_on_click_drop_pct);

    // Alert once per change: skip changes that already have a traffic_alert in the audit log.
    if (alerts.length > 0) {
      const { data: prior } = await db
        .from("audit_log")
        .select("entity_id")
        .eq("org_id", runner.orgId)
        .eq("action", "change.traffic_alert")
        .in("entity_id", alerts.map((a) => a.change_id));
      const seen = new Set((prior ?? []).map((p) => p.entity_id as string));
      alerts = alerts.filter((a) => !seen.has(a.change_id));
    }

    if (alerts.length > 0) {
      await auditLog(
        alerts.map((a) => ({
          orgId: runner.orgId,
          actor: runnerActor(runner),
          action: "change.traffic_alert",
          entity: "change",
          entityId: a.change_id,
          data: { ...a, site_id: id, threshold_pct: policy.rollback_on_click_drop_pct },
        })),
      );
      runAfter("notify traffic_alert", () =>
        notifyEvent(runner.orgId, "traffic_alert", {
          title: `Clicks dropped on ${alerts.length} changed page${alerts.length === 1 ? "" : "s"} (${site.name})`,
          lines: [
            ...alerts
              .slice(0, 10)
              .map((a) => `${typeLabel(a.type)} on ${shortUrl(a.url)}: ${a.baseline_clicks} → ${a.current_clicks} clicks/28d (−${a.drop_pct}%)`),
            "Nothing was rolled back automatically. Review and roll back from the panel if needed.",
          ],
          path: `/sites/${id}?tab=changes`,
          entity: "site",
          entityId: id,
        }),
      );
    }
    return json({ ok: true, upserted: rows.length, alerts });
  } catch (e) {
    return errorResponse(e);
  }
}
