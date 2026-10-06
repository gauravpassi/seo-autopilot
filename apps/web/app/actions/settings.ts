"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdmin } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { act, parse } from "@/lib/action-utils";
import { channelsView, loadStoredChannels, mergeChannels } from "@/lib/settings";
import { sendTestMessage } from "@/lib/notify";
import { NOTIFY_KINDS, type ChannelsInput, type NotifyKind } from "@/lib/types";

const Approvers = z.array(z.string().trim().min(1).max(200)).max(50);
const Input = z.object({
  slack: z
    .object({
      enabled: z.boolean(),
      bot_token: z.string().max(500),
      signing_secret: z.string().max(500),
      channel_id: z.string().max(50),
      team_id: z.string().max(50).optional(),
      approvers: Approvers,
    })
    .optional(),
  whatsapp: z
    .object({
      enabled: z.boolean(),
      phone_number_id: z.string().max(50),
      access_token: z.string().max(2000),
      app_secret: z.string().max(500),
      verify_token: z.string().max(200),
      template_name: z.string().max(100),
      template_language: z.string().max(20).optional(),
      approvers: Approvers,
    })
    .optional(),
  email: z
    .object({
      enabled: z.boolean(),
      provider: z.enum(["resend", "smtp"]),
      api_key: z.string().max(500),
      smtp_host: z.string().max(200).optional(),
      smtp_port: z.number().int().min(1).max(65535).optional(),
      smtp_user: z.string().max(200).optional(),
      smtp_pass: z.string().max(500).optional(),
      from: z.string().max(200),
      approvers: z.array(z.string().trim().toLowerCase().email()).max(50),
      digest: z.boolean(),
    })
    .optional(),
  notify_on: z.array(z.enum(NOTIFY_KINDS as [NotifyKind, ...NotifyKind[]])).optional(),
});

export async function saveChannels(channels: ChannelsInput) {
  return act(async () => {
    const m = await requireRole("admin");
    const input = parse(Input, channels) as ChannelsInput;
    const stored = await loadStoredChannels(m.orgId);
    const merged = mergeChannels(stored, input);
    const { error } = await createAdmin()
      .from("org_settings")
      .upsert({ org_id: m.orgId, channels: merged, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
    if (error) throw new Error(error.message);
    await auditLog({
      orgId: m.orgId,
      actor: m.email,
      action: "settings.channels_updated",
      entity: "org_settings",
      entityId: m.orgId,
      data: {
        slack: input.slack ? { enabled: input.slack.enabled, approvers: input.slack.approvers.length } : undefined,
        whatsapp: input.whatsapp ? { enabled: input.whatsapp.enabled, approvers: input.whatsapp.approvers.length } : undefined,
        email: input.email ? { enabled: input.email.enabled, provider: input.email.provider, approvers: input.email.approvers.length } : undefined,
        notify_on: input.notify_on,
      },
    });
    revalidatePath("/settings");
    return {};
  });
}

export async function sendTestNotification(channel: "slack" | "whatsapp" | "email") {
  return act(async () => {
    const m = await requireRole("admin");
    const c = parse(z.enum(["slack", "whatsapp", "email"]), channel);
    const detail = await sendTestMessage(m.orgId, c);
    await auditLog({ orgId: m.orgId, actor: m.email, action: "settings.test_notification", entity: "channel", entityId: c, data: { detail } });
    return { detail };
  });
}

export async function getChannelsForEdit() {
  return act(async () => {
    const m = await requireRole("viewer");
    const stored = await loadStoredChannels(m.orgId);
    return { channels: channelsView(stored) };
  });
}
