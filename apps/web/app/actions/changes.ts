"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { diffHash, parsePayload, type ChangeType } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { act, parse, UserError, Uuid } from "@/lib/action-utils";
import { decide } from "@/lib/approvals";
import { enqueueJobRow } from "@/lib/jobs";

const SUGGEST_REASON = "Site is in suggest mode";

function revalidateChanges(siteIds: string[]) {
  revalidatePath("/approvals");
  revalidatePath("/");
  for (const s of new Set(siteIds)) revalidatePath(`/sites/${s}`);
}

export async function decideChanges(ids: string[], action: "approve" | "reject", note?: string) {
  return act(async () => {
    const m = await requireRole("member");
    const list = parse(z.array(Uuid).min(1).max(500), ids);
    const a = parse(z.enum(["approve", "reject"]), action);
    const n = note ? parse(z.string().max(2000), note) : null;
    const r = await decide(list, a, { orgId: m.orgId, via: "panel", label: m.email, userId: m.user.id, auditActor: m.email }, n);
    revalidateChanges(r.decided.map((c) => c.site_id));
    return { decided: r.decided.length, skipped: r.skipped.length, apply_jobs: r.applyJobs.map((j) => j.jobId).filter(Boolean) as string[] };
  });
}

/**
 * Approve pending changes on a site that the classifier rated "auto" and that only wait because
 * the site is in suggest mode (the suggest-mode reason is only ever added to auto-tier changes).
 */
export async function approveAllAuto(siteId: string) {
  return act(async () => {
    const m = await requireRole("member");
    const sid = parse(Uuid, siteId);
    const { data } = await createAdmin()
      .from("changes")
      .select("id, risk_reasons")
      .eq("org_id", m.orgId)
      .eq("site_id", sid)
      .eq("status", "pending_approval");
    const ids = (data ?? [])
      .filter((c) => (c.risk_reasons as string[]).some((r) => r.startsWith(SUGGEST_REASON)))
      .map((c) => c.id as string);
    if (ids.length === 0) return { decided: 0, skipped: 0 };
    const r = await decide(ids, "approve", { orgId: m.orgId, via: "panel", label: m.email, userId: m.user.id, auditActor: m.email }, "Approved all low-risk (suggest mode)");
    revalidateChanges([sid]);
    return { decided: r.decided.length, skipped: r.skipped.length };
  });
}

export async function editChangeAfter(id: string, after: unknown) {
  return act(async () => {
    const m = await requireRole("member");
    const cid = parse(Uuid, id);
    const db = createAdmin();
    const { data: c } = await db.from("changes").select("id, site_id, type, target, after, status, diff_hash").eq("id", cid).eq("org_id", m.orgId).maybeSingle();
    if (!c) throw new UserError("Change not found");
    if (c.status !== "pending_approval") throw new UserError(`Only pending changes can be edited (this one is ${c.status})`);
    const p = parsePayload(c.type as ChangeType, after);
    if (!p.success) throw new UserError(p.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
    const hash = diffHash(c.type, (c.target as { url: string }).url, p.data);
    const { data: updated, error } = await db
      .from("changes")
      .update({ after: p.data, diff_hash: hash, status: "pending_approval" })
      .eq("id", cid)
      .eq("status", "pending_approval")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new UserError("Someone decided this change while you were editing it");
    await auditLog({ orgId: m.orgId, actor: m.email, action: "change.edited", entity: "change", entityId: cid, data: { before_after: c.after, after: p.data, old_hash: c.diff_hash, diff_hash: hash } });
    revalidateChanges([c.site_id as string]);
    return { diff_hash: hash };
  });
}

const ROLLBACKABLE = ["applied", "verified", "verify_failed", "failed"];

export async function requestRollback(ids: string[], reason?: string) {
  return act(async () => {
    const m = await requireRole("member");
    const list = parse(z.array(Uuid).min(1).max(500), ids);
    const why = reason ? parse(z.string().max(1000), reason) : undefined;
    const db = createAdmin();
    const { data } = await db.from("changes").select("id, site_id, status").eq("org_id", m.orgId).in("id", list);
    const ok = (data ?? []).filter((c) => ROLLBACKABLE.includes(c.status as string));
    if (ok.length === 0) throw new UserError("None of these changes can be rolled back (only applied, verified, verify-failed or failed ones)");
    const bySite = new Map<string, string[]>();
    for (const c of ok) bySite.set(c.site_id as string, [...(bySite.get(c.site_id as string) ?? []), c.id as string]);
    const jobIds: string[] = [];
    for (const [siteId, changeIds] of bySite) {
      const jid = await enqueueJobRow(db, { orgId: m.orgId, siteId, kind: "rollback", params: { change_ids: changeIds, ...(why ? { reason: why } : {}) }, createdBy: m.user.id });
      jobIds.push(jid);
      await auditLog({ orgId: m.orgId, actor: m.email, action: "change.rollback_requested", entity: "job", entityId: jid, data: { site_id: siteId, change_ids: changeIds, reason: why } });
    }
    revalidateChanges([...bySite.keys()]);
    revalidatePath("/jobs");
    return { job_ids: jobIds, skipped: list.length - ok.length };
  });
}
