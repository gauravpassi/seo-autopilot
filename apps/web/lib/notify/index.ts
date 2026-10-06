import "server-only";
import { createAdmin } from "../supabase/server";
import { loadChannels } from "../settings";
import { auditLog } from "../audit-log";
import type { NotifyKind, ResolvedChannels } from "../types";
import { eventEmail, slackEventMessage, type MiniChange } from "./format";
import { postSlackBatch, postSlackMessage, slackReady } from "./slack";
import { sendWhatsAppBatch, sendWhatsAppText, whatsappReady, inServiceWindow } from "./whatsapp";
import { emailReady, sendApprovalEmails, sendEmail } from "./email";

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

const CHANGE_COLS = "id, site_id, batch_id, type, target, before, after, risk_reasons, status, approver_label, rationale, expires_at";

async function siteNamesFor(orgId: string, siteIds: string[]): Promise<Record<string, string>> {
  if (siteIds.length === 0) return {};
  const { data } = await createAdmin().from("sites").select("id, name").eq("org_id", orgId).in("id", siteIds);
  return Object.fromEntries((data ?? []).map((s) => [s.id as string, s.name as string]));
}

export interface NotifyReport {
  slack?: string;
  whatsapp?: string;
  email?: string;
}

/**
 * Announce pending approvals on every enabled channel (if "pending_approval" ∈ notify_on).
 * One batch message per channel (Slack: one message; WhatsApp: one interactive message per change per
 * approver; email: one email per approver). Accepts change ids or rows; only still-pending ones are sent.
 * Never throws — call it inside after().
 */
export async function notifyPending(orgId: string, changes: Array<string | { id: string }>): Promise<NotifyReport> {
  const report: NotifyReport = {};
  try {
    const ids = changes.map((c) => (typeof c === "string" ? c : c.id));
    if (ids.length === 0) return report;
    const ch = await loadChannels(orgId);
    if (!ch.notify_on.includes("pending_approval")) return report;
    const { data } = await createAdmin().from("changes").select(CHANGE_COLS).eq("org_id", orgId).in("id", ids).eq("status", "pending_approval");
    const rows = (data ?? []) as unknown as Array<MiniChange & { batch_id: string | null; expires_at: string | null }>;
    if (rows.length === 0) return report;
    const siteNames = await siteNamesFor(orgId, [...new Set(rows.map((r) => r.site_id))]);
    const batchId = rows[0].batch_id ?? null;
    const opts = { appUrl: appUrl(), batchId, siteNames };

    const tasks: Array<Promise<void>> = [];
    if (slackReady(ch.slack)) {
      const cfg = ch.slack;
      tasks.push(
        postSlackBatch(orgId, cfg, rows, opts).then(
          (id) => void (report.slack = `posted ${id}`),
          (e) => void (report.slack = `error: ${(e as Error).message}`),
        ),
      );
    }
    if (whatsappReady(ch.whatsapp)) {
      const cfg = ch.whatsapp;
      tasks.push(
        sendWhatsAppBatch(orgId, cfg, rows, opts).then(
          (r) => void (report.whatsapp = `sent ${r.sent}${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`),
          (e) => void (report.whatsapp = `error: ${(e as Error).message}`),
        ),
      );
    }
    if (emailReady(ch.email)) {
      const cfg = ch.email;
      tasks.push(
        sendApprovalEmails(orgId, cfg, rows, opts).then(
          (r) => void (report.email = `sent ${r.sent}${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`),
          (e) => void (report.email = `error: ${(e as Error).message}`),
        ),
      );
    }
    await Promise.all(tasks);
    if (tasks.length > 0)
      await auditLog({ orgId, actor: "system", action: "notify.pending", entity: "batch", entityId: batchId, data: { count: rows.length, ...report } });
  } catch (e) {
    console.error("notifyPending failed", e);
  }
  return report;
}

export interface EventPayload {
  title: string;
  lines?: string[];
  /** Panel path, e.g. /sites/<id> or /jobs/<id> */
  path?: string;
  entity?: string;
  entityId?: string;
}

/** Send a one-off event (verify_failed, rolled_back, job_failed, traffic_alert) to enabled channels. Never throws. */
export async function notifyEvent(orgId: string, kind: NotifyKind, payload: EventPayload): Promise<NotifyReport> {
  const report: NotifyReport = {};
  try {
    const ch = await loadChannels(orgId);
    if (!ch.notify_on.includes(kind)) return report;
    await sendEvent(ch, kind, payload, report);
  } catch (e) {
    console.error("notifyEvent failed", e);
  }
  return report;
}

async function sendEvent(ch: ResolvedChannels, kind: NotifyKind, p: EventPayload, report: NotifyReport): Promise<void> {
  const link = p.path ? `${appUrl()}${p.path}` : undefined;
  const lines = p.lines ?? [];
  const icon: Record<NotifyKind, string> = {
    pending_approval: "📝",
    verify_failed: "⚠️",
    rolled_back: "↩️",
    job_failed: "❌",
    traffic_alert: "📉",
  };
  const title = `${icon[kind]} ${p.title}`;
  const tasks: Array<Promise<void>> = [];
  if (slackReady(ch.slack)) {
    const cfg = ch.slack;
    tasks.push(
      postSlackMessage(cfg, slackEventMessage(title, lines, link)).then(
        () => void (report.slack = "posted"),
        (e) => void (report.slack = `error: ${(e as Error).message}`),
      ),
    );
  }
  if (whatsappReady(ch.whatsapp)) {
    const cfg = ch.whatsapp;
    // Free-form text only works inside the 24 h window; outside it we skip (no event template).
    const targets = cfg.approvers.filter((n) => inServiceWindow(cfg, n));
    tasks.push(
      Promise.all(targets.map((to) => sendWhatsAppText(cfg, to, `${title}\n${lines.join("\n")}${link ? `\n${link}` : ""}`))).then(
        () => void (report.whatsapp = `sent ${targets.length}`),
        (e) => void (report.whatsapp = `error: ${(e as Error).message}`),
      ),
    );
  }
  if (emailReady(ch.email)) {
    const cfg = ch.email;
    const mail = eventEmail(title, lines, link);
    tasks.push(
      Promise.all(cfg.approvers.map((to) => sendEmail(cfg, { to, ...mail }))).then(
        () => void (report.email = `sent ${cfg.approvers.length}`),
        (e) => void (report.email = `error: ${(e as Error).message}`),
      ),
    );
  }
  await Promise.all(tasks);
}

/** Test message for the settings page. Throws with a readable error when the channel isn't configured. */
export async function sendTestMessage(orgId: string, channel: "slack" | "whatsapp" | "email"): Promise<string> {
  const ch = await loadChannels(orgId);
  const title = "✅ SEO Autopilot test notification";
  const lines = ["If you can read this, notifications on this channel work."];
  if (channel === "slack") {
    if (!slackReady(ch.slack)) throw new Error("Slack is not enabled or is missing the bot token / channel id");
    await postSlackMessage(ch.slack, slackEventMessage(title, lines, appUrl()));
    return "Posted to Slack";
  }
  if (channel === "whatsapp") {
    if (!whatsappReady(ch.whatsapp)) throw new Error("WhatsApp is not enabled or is missing the phone number id / token / approvers");
    const cfg = ch.whatsapp;
    const out: string[] = [];
    for (const to of cfg.approvers) {
      if (inServiceWindow(cfg, to)) {
        await sendWhatsAppText(cfg, to, `${title}\n${lines[0]}`);
        out.push(`${to}: text`);
      } else {
        out.push(`${to}: outside the 24h window — send any message to the business number first, then retry`);
      }
    }
    return out.join("; ");
  }
  if (!emailReady(ch.email)) throw new Error("Email is not enabled or is missing the from address / API key / approvers");
  const cfg = ch.email;
  const mail = eventEmail(title, lines, appUrl());
  for (const to of cfg.approvers) await sendEmail(cfg, { to, ...mail });
  return `Sent to ${cfg.approvers.join(", ")}`;
}

export { sendApprovalEmails };
