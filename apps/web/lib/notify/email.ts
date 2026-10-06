import "server-only";
import { createAdmin } from "../supabase/server";
import { mintActionToken, type TokenRow } from "../action-tokens";
import { supabaseTokenStore } from "../email-tokens-db";
import type { ResolvedChannels } from "../types";
import { approvalEmail, type EmailChangeLinks, type MiniChange } from "./format";

type EmailCfg = NonNullable<ResolvedChannels["email"]>;

export function emailReady(e: ResolvedChannels["email"]): e is EmailCfg {
  if (!e || !e.enabled || !e.from || e.approvers.length === 0) return false;
  return e.provider === "smtp" ? !!e.smtp_host && !!e.smtp_user && !!e.smtp_pass : !!e.api_key;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
}

/** Send via Resend REST (with Idempotency-Key) or SMTP (nodemailer). Returns a provider message id. */
export async function sendEmail(cfg: EmailCfg, m: OutgoingEmail): Promise<string> {
  if (cfg.provider === "smtp") {
    const nodemailer = await import("nodemailer");
    const port = cfg.smtp_port || 465;
    const tx = nodemailer.createTransport({
      host: cfg.smtp_host,
      port,
      secure: port === 465,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    });
    const info = await tx.sendMail({ from: cfg.from, to: m.to, subject: m.subject, html: m.html, text: m.text });
    return String(info.messageId ?? "");
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      "Content-Type": "application/json",
      ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey.slice(0, 256) } : {}),
    },
    body: JSON.stringify({ from: cfg.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!r.ok) throw new Error(`resend ${r.status}: ${j.message ?? j.name ?? "send failed"}`);
  return j.id ?? "";
}

const DEFAULT_TTL_MS = 72 * 3600 * 1000;

/**
 * One email per approver listing the changes with per-change Approve/Reject links (+ "approve all").
 * Each link is a signed single-use token bound to the recipient; rows go to action_tokens.
 */
export async function sendApprovalEmails(
  orgId: string,
  cfg: EmailCfg,
  changes: Array<MiniChange & { expires_at?: string | null }>,
  opts: { appUrl: string; batchId?: string | null; siteNames?: Record<string, string>; heading?: string; idempotencyPrefix?: string },
): Promise<{ sent: number; errors: string[] }> {
  if (changes.length === 0) return { sent: 0, errors: [] };
  const db = createAdmin();
  const errors: string[] = [];
  let sent = 0;
  const expiryOf = (c: { expires_at?: string | null }) =>
    c.expires_at ? new Date(c.expires_at) : new Date(Date.now() + DEFAULT_TTL_MS);
  for (const to of cfg.approvers) {
    const rows: TokenRow[] = [];
    const link = (t: string) => `${opts.appUrl}/approve?t=${encodeURIComponent(t)}`;
    const items: EmailChangeLinks[] = changes.map((c) => {
      const exp = expiryOf(c);
      const a = mintActionToken({ orgId, changeIds: [c.id], act: "approve", recipient: to, expiresAt: exp });
      const r = mintActionToken({ orgId, changeIds: [c.id], act: "reject", recipient: to, expiresAt: exp });
      rows.push(a.row, r.row);
      return { change: c, approveUrl: link(a.token), rejectUrl: link(r.token) };
    });
    let approveAllUrl: string | undefined;
    if (changes.length > 1) {
      const minExp = new Date(Math.min(...changes.map((c) => expiryOf(c).getTime())));
      const all = mintActionToken({ orgId, changeIds: changes.map((c) => c.id), act: "approve", recipient: to, expiresAt: minExp });
      rows.push(all.row);
      approveAllUrl = link(all.token);
    }
    try {
      await supabaseTokenStore.insert(rows);
      const mail = approvalEmail(items, { appUrl: opts.appUrl, approveAllUrl, siteNames: opts.siteNames, heading: opts.heading });
      const id = await sendEmail(cfg, {
        to,
        ...mail,
        idempotencyKey: `${opts.idempotencyPrefix ?? "approval"}-${opts.batchId ?? changes.map((c) => c.id).join("").slice(0, 64)}-${to}`,
      });
      sent++;
      await db.from("approval_messages").insert(
        changes.map((c) => ({
          org_id: orgId,
          change_id: c.id,
          batch_id: opts.batchId ?? null,
          channel: "email",
          external_id: id || null,
          recipient: to,
        })),
      );
    } catch (e) {
      errors.push(`${to}: ${(e as Error).message}`);
    }
  }
  return { sent, errors };
}
