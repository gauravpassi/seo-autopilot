import { safeEqual } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { loadChannels } from "@/lib/settings";
import { emailReady, sendApprovalEmails } from "@/lib/notify/email";
import { updateApprovalMessages } from "@/lib/approvals";
import { appUrl } from "@/lib/notify";
import type { MiniChange } from "@/lib/notify/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DIGEST_MAX = 50;

/**
 * Daily (vercel.json: 02:30 UTC = 08:00 IST). Authorization: Bearer CRON_SECRET.
 *  1. Expire pending changes past expires_at (status expired) and refresh their Slack messages.
 *  2. Per org with email digest on: one email per approver listing pending changes (signed links).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = createAdmin();
  const now = new Date().toISOString();
  const { data: expired, error } = await db
    .from("changes")
    .update({ status: "expired" })
    .eq("status", "pending_approval")
    .lt("expires_at", now)
    .select("id, org_id, site_id");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const byOrg = new Map<string, string[]>();
  for (const c of expired ?? []) byOrg.set(c.org_id as string, [...(byOrg.get(c.org_id as string) ?? []), c.id as string]);
  for (const [orgId, ids] of byOrg) {
    await auditLog(ids.map((id) => ({ orgId, actor: "system", action: "change.expired", entity: "change", entityId: id })));
    await updateApprovalMessages(orgId, ids);
  }

  // Also release action tokens that can no longer be used (housekeeping).
  await db.from("action_tokens").delete().lt("expires_at", new Date(Date.now() - 30 * 86400000).toISOString());
  await db.from("webhook_events").delete().lt("received_at", new Date(Date.now() - 14 * 86400000).toISOString());

  const digests: Record<string, string> = {};
  const { data: orgs } = await db.from("org_settings").select("org_id");
  for (const { org_id: orgId } of orgs ?? []) {
    try {
      const ch = await loadChannels(orgId as string);
      if (!emailReady(ch.email) || !ch.email.digest || !ch.notify_on.includes("pending_approval")) continue;
      const { data: pending, count } = await db
        .from("changes")
        .select("id, site_id, type, target, before, after, risk_reasons, status, approver_label, rationale, expires_at", { count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "pending_approval")
        .order("created_at", { ascending: true })
        .limit(DIGEST_MAX);
      if (!pending || pending.length === 0) continue;
      const { data: sites } = await db.from("sites").select("id, name").eq("org_id", orgId);
      const siteNames = Object.fromEntries((sites ?? []).map((s) => [s.id as string, s.name as string]));
      const total = count ?? pending.length;
      const r = await sendApprovalEmails(orgId as string, ch.email, pending as unknown as MiniChange[], {
        appUrl: appUrl(),
        siteNames,
        heading: `Daily digest: ${total} change${total === 1 ? "" : "s"} waiting for approval${total > pending.length ? ` (showing ${pending.length})` : ""}`,
        idempotencyPrefix: `digest-${now.slice(0, 10)}`,
        batchId: null,
      });
      digests[orgId as string] = `sent ${r.sent}${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`;
      await auditLog({ orgId: orgId as string, actor: "system", action: "notify.digest", data: { pending: total, result: digests[orgId as string] } });
    } catch (e) {
      digests[orgId as string] = `error: ${(e as Error).message}`;
    }
  }
  return Response.json({ ok: true, expired: expired?.length ?? 0, digests });
}
