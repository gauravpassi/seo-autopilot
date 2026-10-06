"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { readActionToken, redeemActionToken } from "@/lib/action-tokens";
import { isEmailApprover, supabaseTokenStore } from "@/lib/email-tokens-db";
import { decide } from "@/lib/approvals";
import { auditLog } from "@/lib/audit-log";

/**
 * POST-only decision for email links. Verifies signature + expiry, checks the recipient is still an
 * approver, consumes the jti atomically (single use), then decide(). Redirects to a result view.
 */
export async function confirmEmailDecision(formData: FormData): Promise<void> {
  const token = String(formData.get("t") ?? "");
  const claims = readActionToken(token);
  const h = await headers();
  const meta = { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, ua: h.get("user-agent")?.slice(0, 200) ?? null };

  const r = await redeemActionToken(token, supabaseTokenStore, isEmailApprover);
  if (!r.ok) {
    if (claims) {
      await auditLog({ orgId: claims.org, actor: `email:${claims.rcpt}`, action: "approval.denied", entity: "change", entityId: claims.cids[0], data: { reason: r.reason, jti: claims.jti, ...meta } });
    }
    redirect(`/approve?result=${r.reason}`);
  }
  const c = r.claims;
  const out = await decide(c.cids, c.act, { orgId: c.org, via: "email", label: c.rcpt, auditActor: `email:${c.rcpt}` }, null);
  await auditLog({ orgId: c.org, actor: `email:${c.rcpt}`, action: "approval.email_link_used", entity: "action_token", entityId: c.jti, data: { act: c.act, decided: out.decided.length, skipped: out.skipped.length, ...meta } });
  redirect(`/approve?result=${c.act === "approve" ? "approved" : "rejected"}&n=${out.decided.length}&s=${out.skipped.length}`);
}
