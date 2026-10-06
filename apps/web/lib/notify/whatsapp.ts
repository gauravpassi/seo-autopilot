import "server-only";
import { createHmac } from "node:crypto";
import { safeEqual } from "@seo-autopilot/core";
import { createAdmin } from "../supabase/server";
import { normalizePhone } from "../settings";
import type { ResolvedChannels } from "../types";
import { typeLabel, shortUrl, changeUrl, waTemplateParam, whatsappChangeBody, valueText, truncate, type MiniChange } from "./format";

type WaCfg = NonNullable<ResolvedChannels["whatsapp"]>;

export const WA_GRAPH_VERSION = process.env.WA_GRAPH_VERSION || "v26.0";
const WINDOW_MS = 24 * 3600 * 1000;
/** Per approver per batch; extra changes are summarized with a link to the panel. */
export const WA_MAX_PER_BATCH = 10;

export function whatsappReady(w: ResolvedChannels["whatsapp"]): w is WaCfg {
  return !!w && w.enabled && !!w.phone_number_id && !!w.access_token && w.approvers.length > 0;
}

/** Verify Meta's X-Hub-Signature-256 ("sha256=<hex>") over the raw body with the app secret. */
export function verifyWhatsAppSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, header.trim());
}

/** True when the number messaged us within the last 24 h (free-form/interactive messages allowed). */
export function inServiceWindow(cfg: Pick<WaCfg, "last_inbound">, to: string, now: number = Date.now()): boolean {
  const t = cfg.last_inbound[normalizePhone(to)];
  return !!t && now - Date.parse(t) < WINDOW_MS - 5 * 60 * 1000; // 5 min safety margin
}

export async function waSend(cfg: Pick<WaCfg, "phone_number_id" | "access_token">, body: Record<string, unknown>): Promise<string> {
  const r = await fetch(`https://graph.facebook.com/${WA_GRAPH_VERSION}/${cfg.phone_number_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
  });
  const j = (await r.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { code?: number; message?: string } };
  if (!r.ok || !j.messages?.[0]?.id) {
    throw new Error(`whatsapp ${r.status}: ${j.error?.code ?? ""} ${j.error?.message ?? "send failed"}`.trim());
  }
  return j.messages[0].id;
}

export function interactiveApproval(to: string, c: MiniChange, siteName?: string): Record<string, unknown> {
  return {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Approval needed" },
      body: { text: whatsappChangeBody(c, siteName) },
      footer: { text: "SEO Autopilot" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `approve:${c.id}`, title: "Approve" } },
          { type: "reply", reply: { id: `reject:${c.id}`, title: "Reject" } },
          { type: "reply", reply: { id: `open:${c.id}`, title: "Open link" } },
        ],
      },
    },
  };
}

/**
 * Template `seo_approval_request` (UTILITY, see README-backend.md):
 *   body "SEO Autopilot proposes a change on {{1}}: {{2}}. Approve it?"  buttons: QUICK_REPLY Approve, QUICK_REPLY Reject
 */
export function templateApproval(to: string, c: MiniChange, cfg: Pick<WaCfg, "template_name" | "template_language">): Record<string, unknown> {
  const page = waTemplateParam(shortUrl(changeUrl(c)), 120);
  const what = waTemplateParam(`${typeLabel(c.type)} → ${truncate(valueText(c.type, c.after), 160)}`, 200);
  return {
    to,
    type: "template",
    template: {
      name: cfg.template_name,
      language: { code: cfg.template_language },
      components: [
        { type: "body", parameters: [{ type: "text", text: page }, { type: "text", text: what }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `approve:${c.id}` }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `reject:${c.id}` }] },
      ],
    },
  };
}

export async function sendWhatsAppText(cfg: WaCfg, to: string, text: string, replyTo?: string): Promise<string> {
  return waSend(cfg, {
    to: normalizePhone(to),
    type: "text",
    text: { body: truncate(text, 4096), preview_url: false },
    ...(replyTo ? { context: { message_id: replyTo } } : {}),
  });
}

/** Send approval requests for a batch to every allow-listed approver. */
export async function sendWhatsAppBatch(
  orgId: string,
  cfg: WaCfg,
  changes: MiniChange[],
  opts: { appUrl: string; batchId?: string | null; siteNames?: Record<string, string> },
): Promise<{ sent: number; errors: string[] }> {
  const db = createAdmin();
  const errors: string[] = [];
  let sent = 0;
  for (const to of cfg.approvers) {
    const inWindow = inServiceWindow(cfg, to);
    for (const c of changes.slice(0, WA_MAX_PER_BATCH)) {
      try {
        const body = inWindow ? interactiveApproval(to, c, opts.siteNames?.[c.site_id]) : templateApproval(to, c, cfg);
        const id = await waSend(cfg, body);
        sent++;
        await db.from("approval_messages").insert({
          org_id: orgId,
          change_id: c.id,
          batch_id: opts.batchId ?? null,
          channel: "whatsapp",
          external_id: id,
          recipient: to,
        });
      } catch (e) {
        errors.push(`${to}: ${(e as Error).message}`);
        break; // same failure would repeat for this number
      }
    }
    if (changes.length > WA_MAX_PER_BATCH && inWindow) {
      try {
        await sendWhatsAppText(cfg, to, `…and ${changes.length - WA_MAX_PER_BATCH} more waiting: ${opts.appUrl}/approvals`);
      } catch {
        /* ignore */
      }
    }
  }
  return { sent, errors };
}

/** Parse a button id/payload "approve:<uuid>" | "reject:<uuid>" | "open:<uuid>". */
export function parseWaButton(id: string | undefined | null): { act: "approve" | "reject" | "open"; changeId: string } | null {
  const m = String(id ?? "").match(/^(approve|reject|open):([0-9a-f-]{36})$/i);
  if (!m) return null;
  return { act: m[1].toLowerCase() as "approve" | "reject" | "open", changeId: m[2].toLowerCase() };
}
