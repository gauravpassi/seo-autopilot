import { listOrgChannels, resolveChannels } from "@/lib/settings";
import { verifySlackSignature, buildSlackMessageFor } from "@/lib/notify/slack";
import { firstDelivery } from "@/lib/webhook-dedupe";
import { decide } from "@/lib/approvals";
import { auditLog } from "@/lib/audit-log";
import { runAfter } from "@/lib/after";
import { appUrl } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface BlockActionsPayload {
  type: string;
  team?: { id: string; domain?: string };
  user: { id: string; username?: string; name?: string };
  api_app_id?: string;
  container?: { message_ts?: string; channel_id?: string };
  channel?: { id: string };
  message?: { ts: string };
  response_url?: string;
  actions?: Array<{ action_id: string; value?: string; action_ts?: string }>;
}

async function respond(url: string | undefined, body: Record<string, unknown>) {
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch((e) =>
    console.error("slack response_url", (e as Error).message),
  );
}

/**
 * Slack interactivity endpoint. Verifies the v0 signature on the raw body against each org whose
 * Slack channel is enabled (matching team_id first), acks immediately and does the work in after().
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");

  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "null");
  } catch {
    payload = null as unknown as BlockActionsPayload;
  }
  // Payload is parsed only to pick the org; nothing is trusted until a signature verifies.
  const teamId = payload?.team?.id;
  const orgs = (await listOrgChannels())
    .map((o) => ({ orgId: o.orgId, ch: resolveChannels(o.stored) }))
    .filter((o) => o.ch.slack?.enabled && o.ch.slack.signing_secret)
    .sort((a, b) => Number(b.ch.slack?.team_id === teamId) - Number(a.ch.slack?.team_id === teamId));
  const org = orgs.find(
    (o) => (!o.ch.slack!.team_id || o.ch.slack!.team_id === teamId) && verifySlackSignature(raw, ts, sig, o.ch.slack!.signing_secret),
  );
  if (!org) return new Response("invalid signature", { status: 401 });
  if (!payload || payload.type !== "block_actions" || !payload.actions?.length) return new Response("", { status: 200 });

  const action = payload.actions[0];
  const messageTs = payload.container?.message_ts ?? payload.message?.ts ?? "";
  const channelId = payload.container?.channel_id ?? payload.channel?.id ?? "";
  const dedupeId = `${messageTs}:${action.action_ts ?? ""}:${action.action_id}:${action.value ?? ""}`;
  const slack = org.ch.slack!;
  const userId = payload.user.id;
  const label = payload.user.name || payload.user.username || userId;

  runAfter("slack interaction", async () => {
    if (!(await firstDelivery("slack", dedupeId))) return;
    if (!slack.approvers.includes(userId)) {
      await auditLog({ orgId: org.orgId, actor: `slack:${userId}`, action: "approval.denied", entity: "change", entityId: action.value ?? null, data: { reason: "not in Slack approver allow-list" } });
      await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: "You are not on the approver list for SEO Autopilot." });
      return;
    }
    const ids = action.action_id === "approve_all" ? String(action.value ?? "").split(",").filter(Boolean) : action.value ? [action.value] : [];
    const act = action.action_id === "reject" ? "reject" : action.action_id === "approve" || action.action_id === "approve_all" ? "approve" : null;
    if (!act || ids.length === 0) return;

    const externalId = channelId && messageTs ? `${channelId}:${messageTs}` : "";
    const r = await decide(ids, act, { orgId: org.orgId, via: "slack", label: `Slack @${label}`, auditActor: `slack:${userId}` }, null, {
      skipSlackExternalIds: externalId ? [externalId] : [],
    });
    // Update the clicked message through response_url (no token needed), re-rendered from DB state.
    const msg = externalId ? await buildSlackMessageFor(org.orgId, externalId, appUrl()) : null;
    if (msg) await respond(payload.response_url, { replace_original: true, text: msg.text, blocks: msg.blocks });
    if (r.skipped.length > 0 && r.decided.length === 0) {
      await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: "Already decided or expired — nothing changed." });
    }
  });
  return new Response("", { status: 200 });
}
