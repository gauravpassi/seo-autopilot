import "server-only";
import { createHmac } from "node:crypto";
import { safeEqual } from "@seo-autopilot/core";
import { createAdmin } from "../supabase/server";
import type { Change, ResolvedChannels } from "../types";
import { slackBatchMessage, type MiniChange, type SlackMessage } from "./format";

type SlackCfg = NonNullable<ResolvedChannels["slack"]>;

export async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string }> {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({ ok: false, error: `http_${r.status}` }))) as T & { ok: boolean; error?: string };
  if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? r.status}`);
  return j;
}

/** Verify a Slack request: v0 HMAC-SHA256 over "v0:<ts>:<raw body>", 300 s replay window. */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature || !signingSecret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex");
  return safeEqual(expected, signature);
}

export function slackReady(s: ResolvedChannels["slack"]): s is SlackCfg {
  return !!s && s.enabled && !!s.bot_token && !!s.channel_id;
}

/** Post one batch message and remember which changes it announced (approval_messages). */
export async function postSlackBatch(
  orgId: string,
  cfg: SlackCfg,
  changes: MiniChange[],
  opts: { appUrl: string; batchId?: string | null; siteNames?: Record<string, string> },
): Promise<string> {
  const msg = slackBatchMessage(changes, opts);
  const res = await slackApi<{ channel: string; ts: string }>(cfg.bot_token, "chat.postMessage", {
    channel: cfg.channel_id,
    text: msg.text,
    blocks: msg.blocks,
    unfurl_links: false,
  });
  const externalId = `${res.channel}:${res.ts}`;
  await createAdmin()
    .from("approval_messages")
    .insert(
      changes.map((c) => ({
        org_id: orgId,
        change_id: c.id,
        batch_id: opts.batchId ?? null,
        channel: "slack",
        external_id: externalId,
        recipient: cfg.channel_id,
      })),
    );
  return externalId;
}

export async function postSlackMessage(cfg: SlackCfg, msg: SlackMessage): Promise<void> {
  await slackApi(cfg.bot_token, "chat.postMessage", { channel: cfg.channel_id, text: msg.text, blocks: msg.blocks, unfurl_links: false });
}

const CHANGE_COLS = "id, site_id, type, target, before, after, risk_reasons, status, approver_label, rationale";

/** Rebuild a batch message from current change statuses (all changes it announced). */
export async function buildSlackMessageFor(orgId: string, externalId: string, appUrl: string): Promise<SlackMessage | null> {
  const db = createAdmin();
  const { data: rows } = await db
    .from("approval_messages")
    .select("change_id, created_at")
    .eq("org_id", orgId)
    .eq("channel", "slack")
    .eq("external_id", externalId)
    .order("created_at");
  const ids = [...new Set((rows ?? []).map((r) => r.change_id as string).filter(Boolean))];
  if (ids.length === 0) return null;
  const { data: changes } = await db.from("changes").select(CHANGE_COLS).eq("org_id", orgId).in("id", ids);
  const byId = new Map((changes ?? []).map((c) => [c.id as string, c as unknown as MiniChange]));
  const ordered = ids.map((id) => byId.get(id)).filter((c): c is MiniChange => !!c);
  const { data: sites } = await db.from("sites").select("id, name").eq("org_id", orgId).in("id", [...new Set(ordered.map((c) => c.site_id))]);
  const siteNames = Object.fromEntries((sites ?? []).map((s) => [s.id as string, s.name as string]));
  const pending = ordered.filter((c) => c.status === "pending_approval").length;
  const title =
    pending === 0
      ? `${ordered.length} SEO change${ordered.length === 1 ? "" : "s"} — all decided`
      : `${pending} of ${ordered.length} SEO change${ordered.length === 1 ? "" : "s"} still need approval`;
  return slackBatchMessage(ordered, { appUrl, siteNames, title });
}

/** chat.update every Slack message that announced one of these changes. */
export async function refreshSlackMessages(
  orgId: string,
  cfg: SlackCfg,
  changeIds: string[],
  appUrl: string,
  skipExternalIds: string[] = [],
): Promise<void> {
  if (changeIds.length === 0) return;
  const { data } = await createAdmin()
    .from("approval_messages")
    .select("external_id")
    .eq("org_id", orgId)
    .eq("channel", "slack")
    .in("change_id", changeIds);
  const ext = [...new Set((data ?? []).map((r) => r.external_id as string).filter(Boolean))].filter(
    (e) => !skipExternalIds.includes(e),
  );
  for (const e of ext) {
    const msg = await buildSlackMessageFor(orgId, e, appUrl);
    if (!msg) continue;
    const i = e.indexOf(":");
    try {
      await slackApi(cfg.bot_token, "chat.update", { channel: e.slice(0, i), ts: e.slice(i + 1), text: msg.text, blocks: msg.blocks });
    } catch (err) {
      console.error("slack chat.update failed", (err as Error).message);
    }
  }
}

export type { Change };
