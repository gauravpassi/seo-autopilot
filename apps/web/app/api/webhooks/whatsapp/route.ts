import { safeEqual } from "@seo-autopilot/core";
import { listOrgChannels, normalizePhone, recordWhatsAppInbound, resolveChannels } from "@/lib/settings";
import { parseWaButton, sendWhatsAppText, verifyWhatsAppSignature } from "@/lib/notify/whatsapp";
import { firstDelivery } from "@/lib/webhook-dedupe";
import { decide } from "@/lib/approvals";
import { auditLog } from "@/lib/audit-log";
import { runAfter } from "@/lib/after";
import { appUrl } from "@/lib/notify";
import { createAdmin } from "@/lib/supabase/server";
import { typeLabel, shortUrl } from "@/lib/notify/format";
import type { ResolvedChannels } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Subscription handshake: hub.verify_token must equal some org's channels.whatsapp.verify_token. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const token = q.get("hub.verify_token") ?? "";
  if (q.get("hub.mode") !== "subscribe" || !token) return new Response("forbidden", { status: 403 });
  const orgs = await listOrgChannels();
  const match = orgs.some((o) => o.stored.whatsapp?.verify_token && safeEqual(o.stored.whatsapp.verify_token, token));
  if (!match) return new Response("forbidden", { status: 403 });
  return new Response(q.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
}

interface WaMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  context?: { id?: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
  button?: { payload?: string; text?: string };
  text?: { body: string };
}

interface WaBody {
  object?: string;
  entry?: Array<{ changes?: Array<{ field?: string; value?: { metadata?: { phone_number_id?: string }; messages?: WaMessage[] } }> }>;
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  let body: WaBody;
  try {
    body = JSON.parse(raw) as WaBody;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  // Org is resolved by phone_number_id; the signature must verify with THAT org's app secret.
  const phoneIds = new Set<string>();
  for (const e of body.entry ?? []) for (const c of e.changes ?? []) if (c.value?.metadata?.phone_number_id) phoneIds.add(c.value.metadata.phone_number_id);
  const orgs = (await listOrgChannels()).map((o) => ({ orgId: o.orgId, ch: resolveChannels(o.stored) }));
  const candidates = orgs.filter((o) => o.ch.whatsapp?.app_secret && (phoneIds.size === 0 || phoneIds.has(o.ch.whatsapp.phone_number_id)));
  const org = candidates.find((o) => verifyWhatsAppSignature(raw, sig, o.ch.whatsapp!.app_secret));
  if (!org) return new Response("invalid signature", { status: 401 });

  runAfter("whatsapp webhook", async () => {
    const wa = org.ch.whatsapp!;
    for (const e of body.entry ?? [])
      for (const c of e.changes ?? []) {
        if (c.value?.metadata?.phone_number_id && c.value.metadata.phone_number_id !== wa.phone_number_id) continue;
        for (const m of c.value?.messages ?? []) await handleMessage(org.orgId, wa, m);
      }
  });
  return new Response("OK", { status: 200 });
}

async function handleMessage(orgId: string, wa: NonNullable<ResolvedChannels["whatsapp"]>, m: WaMessage) {
  if (!m?.id || !m.from) return;
  if (!(await firstDelivery("whatsapp", m.id))) return;
  const from = normalizePhone(m.from);
  const allowed = wa.approvers.includes(from);
  // Any inbound message opens the 24 h window for that number.
  if (allowed) await recordWhatsAppInbound(orgId, from, m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date());

  const id = m.type === "interactive" && m.interactive?.type === "button_reply" ? m.interactive.button_reply?.id : m.type === "button" ? m.button?.payload : null;
  const btn = parseWaButton(id);
  if (!btn) {
    if (allowed && m.type === "text") {
      await sendWhatsAppText(wa, from, `Hi! Pending SEO approvals live here: ${appUrl()}/approvals`, m.id).catch(() => undefined);
    }
    return;
  }
  if (!allowed) {
    await auditLog({ orgId, actor: `whatsapp:+${from}`, action: "approval.denied", entity: "change", entityId: btn.changeId, data: { reason: "not in WhatsApp approver allow-list", message_id: m.id } });
    return;
  }
  const db = createAdmin();
  const { data: change } = await db.from("changes").select("id, type, target, status, approver_label").eq("id", btn.changeId).eq("org_id", orgId).maybeSingle();
  if (!change) {
    await sendWhatsAppText(wa, from, "That change no longer exists.", m.id).catch(() => undefined);
    return;
  }
  const what = `${typeLabel(change.type)} on ${shortUrl((change.target as { url: string }).url)}`;
  if (btn.act === "open") {
    await sendWhatsAppText(wa, from, `${what}\n${appUrl()}/approvals`, m.id).catch(() => undefined);
    return;
  }
  const r = await decide([btn.changeId], btn.act, { orgId, via: "whatsapp", label: `+${from}`, auditActor: `whatsapp:+${from}` });
  let reply: string;
  if (r.decided.length > 0) {
    reply = btn.act === "approve" ? `✅ Approved: ${what}. It will be applied by the runner shortly.` : `❌ Rejected: ${what}.`;
  } else {
    const { data: now } = await db.from("changes").select("status, approver_label").eq("id", btn.changeId).maybeSingle();
    reply = `Nothing changed — ${what} is already ${String(now?.status ?? change.status).replace(/_/g, " ")}${now?.approver_label ? ` (by ${now.approver_label})` : ""}.`;
  }
  await sendWhatsAppText(wa, from, reply, m.id).catch((e) => console.error("wa reply", (e as Error).message));
}
