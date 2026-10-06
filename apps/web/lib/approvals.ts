import "server-only";
import { createAdmin } from "./supabase/server";
import { auditLog } from "./audit-log";
import { enqueueApplyIfNone } from "./jobs";
import { loadChannels } from "./settings";
import { refreshSlackMessages, slackReady } from "./notify/slack";
import { appUrl } from "./notify";
import type { ApprovedVia, Change } from "./types";

export interface DecideActor {
  /** Org the decision is made in; change ids from other orgs are skipped. */
  orgId: string;
  via: ApprovedVia;
  /** Shown to people: "alice@x.com", "Slack: Alice", "+9198…" */
  label: string;
  userId?: string | null;
  /** audit_log actor; defaults to the email (panel) or "<via>:<label>". */
  auditActor?: string;
}

export interface DecideResult {
  decided: Change[];
  /** Ids that were not pending/unexpired (someone decided first), unknown, or in another org. */
  skipped: string[];
  applyJobs: Array<{ siteId: string; jobId: string | null }>;
}

export interface DecideOptions {
  /** Slack messages already updated by the caller (e.g. via response_url), "channel:ts". */
  skipSlackExternalIds?: string[];
  /** Skip chat-message updates (tests / bulk housekeeping). */
  skipMessageUpdates?: boolean;
}

/**
 * The one decision path used by the panel, Slack, WhatsApp and email.
 * `decide_change` RPC per id (first decision wins, binds to pending + unexpired), audit_log,
 * Slack messages updated to show the decision, one `apply` job per site with new approvals
 * (skipped if an apply job is already queued for that site).
 */
export async function decide(
  changeIds: string[],
  action: "approve" | "reject",
  actor: DecideActor,
  note?: string | null,
  opts: DecideOptions = {},
): Promise<DecideResult> {
  const db = createAdmin();
  const ids = [...new Set(changeIds)];
  const result: DecideResult = { decided: [], skipped: [], applyJobs: [] };
  if (ids.length === 0) return result;

  const { data: owned } = await db.from("changes").select("id").eq("org_id", actor.orgId).in("id", ids);
  const ownedIds = new Set((owned ?? []).map((r) => r.id as string));

  for (const id of ids) {
    if (!ownedIds.has(id)) {
      result.skipped.push(id);
      continue;
    }
    const { data, error } = await db.rpc("decide_change", {
      p_change: id,
      p_action: action,
      p_via: actor.via,
      p_label: actor.label,
      p_user: actor.userId ?? null,
      p_note: note ?? null,
    });
    // decide_change returns a composite; PostgREST gives an object with null fields when nothing matched.
    const row = (Array.isArray(data) ? data[0] : data) as Change | null;
    if (error || !row || !row.id) {
      if (error) console.error("decide_change", id, error.message);
      result.skipped.push(id);
      continue;
    }
    result.decided.push(row);
  }

  const who = actor.auditActor ?? (actor.via === "panel" ? actor.label : `${actor.via}:${actor.label}`);
  await auditLog(
    result.decided.map((c) => ({
      orgId: actor.orgId,
      actor: who,
      action: action === "approve" ? "change.approved" : "change.rejected",
      entity: "change",
      entityId: c.id,
      data: { via: actor.via, site_id: c.site_id, type: c.type, diff_hash: c.diff_hash, note: note ?? undefined },
    })),
  );
  if (result.skipped.length > 0) {
    await auditLog({
      orgId: actor.orgId,
      actor: who,
      action: "change.decision_skipped",
      entity: "change",
      data: { ids: result.skipped, action, via: actor.via, reason: "not pending, expired, or decided first elsewhere" },
    });
  }

  if (action === "approve") {
    const sites = [...new Set(result.decided.map((c) => c.site_id))];
    for (const siteId of sites) {
      try {
        const jobId = await enqueueApplyIfNone(db, actor.orgId, siteId, actor.userId ?? null);
        result.applyJobs.push({ siteId, jobId });
        if (jobId)
          await auditLog({ orgId: actor.orgId, actor: who, action: "job.enqueued", entity: "job", entityId: jobId, data: { kind: "apply", site_id: siteId } });
      } catch (e) {
        console.error("enqueue apply failed", (e as Error).message);
      }
    }
  }

  if (!opts.skipMessageUpdates && result.decided.length > 0) {
    await updateApprovalMessages(actor.orgId, result.decided.map((c) => c.id), opts.skipSlackExternalIds ?? []);
  }
  return result;
}

/** Re-render Slack batch messages for these changes (WhatsApp messages can't be edited; email is static). */
export async function updateApprovalMessages(orgId: string, changeIds: string[], skipSlack: string[] = []): Promise<void> {
  try {
    const ch = await loadChannels(orgId);
    if (slackReady(ch.slack)) await refreshSlackMessages(orgId, ch.slack, changeIds, appUrl(), skipSlack);
  } catch (e) {
    console.error("updateApprovalMessages failed", (e as Error).message);
  }
}
