import "server-only";
import { decryptAtRest, encryptAtRest } from "@seo-autopilot/core";
import { createAdmin } from "./supabase/server";
import {
  NOTIFY_KINDS,
  UNCHANGED,
  type ChannelsInput,
  type ChannelsView,
  type NotifyKind,
  type ResolvedChannels,
  type StoredChannels,
} from "./types";

function appKey(): string {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (!k) throw new Error("APP_ENCRYPTION_KEY is not set");
  return k;
}

export function encryptSecret(plain: string): string {
  return encryptAtRest(plain, appKey());
}

export function decryptSecret(enc: string | undefined | null): string {
  if (!enc) return "";
  try {
    return decryptAtRest(enc, appKey());
  } catch (e) {
    console.error("Could not decrypt a channel secret (APP_ENCRYPTION_KEY changed?)", (e as Error).message);
    return "";
  }
}

/** E.164 digits only, no "+" — the shape WhatsApp uses for wa_id. */
export function normalizePhone(n: string): string {
  return String(n ?? "").replace(/[^\d]/g, "");
}

export async function loadStoredChannels(orgId: string): Promise<StoredChannels> {
  const { data } = await createAdmin().from("org_settings").select("channels").eq("org_id", orgId).maybeSingle();
  return ((data?.channels as StoredChannels) ?? {}) as StoredChannels;
}

export function resolveChannels(c: StoredChannels): ResolvedChannels {
  return {
    slack: c.slack
      ? {
          enabled: !!c.slack.enabled,
          bot_token: decryptSecret(c.slack.bot_token_enc),
          signing_secret: decryptSecret(c.slack.signing_secret_enc),
          channel_id: c.slack.channel_id ?? "",
          team_id: c.slack.team_id,
          approvers: c.slack.approvers ?? [],
        }
      : null,
    whatsapp: c.whatsapp
      ? {
          enabled: !!c.whatsapp.enabled,
          phone_number_id: c.whatsapp.phone_number_id ?? "",
          access_token: decryptSecret(c.whatsapp.access_token_enc),
          app_secret: decryptSecret(c.whatsapp.app_secret_enc),
          verify_token: c.whatsapp.verify_token ?? "",
          template_name: c.whatsapp.template_name || "seo_approval_request",
          template_language: c.whatsapp.template_language || "en",
          approvers: (c.whatsapp.approvers ?? []).map(normalizePhone).filter(Boolean),
          last_inbound: c.whatsapp.last_inbound ?? {},
        }
      : null,
    email: c.email
      ? {
          enabled: !!c.email.enabled,
          provider: c.email.provider ?? "resend",
          api_key: decryptSecret(c.email.api_key_enc),
          smtp_host: c.email.smtp_host,
          smtp_port: c.email.smtp_port,
          smtp_user: c.email.smtp_user,
          smtp_pass: decryptSecret(c.email.smtp_pass_enc),
          from: c.email.from ?? "",
          approvers: (c.email.approvers ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean),
          digest: c.email.digest !== false,
        }
      : null,
    notify_on: (c.notify_on ?? NOTIFY_KINDS).filter((k): k is NotifyKind => NOTIFY_KINDS.includes(k)),
  };
}

/** org_settings.channels with secrets decrypted (server-only). */
export async function loadChannels(orgId: string): Promise<ResolvedChannels> {
  return resolveChannels(await loadStoredChannels(orgId));
}

const keep = (input: string | undefined, stored: string | undefined): string | undefined => {
  if (input === undefined || input === UNCHANGED) return stored;
  if (input === "") return undefined;
  return encryptSecret(input);
};

/** Merge a settings-form submission into the stored channels (encrypting new secrets). */
export function mergeChannels(stored: StoredChannels, input: ChannelsInput): StoredChannels {
  const out: StoredChannels = { ...stored };
  if (input.slack) {
    const s = input.slack;
    out.slack = {
      enabled: s.enabled,
      bot_token_enc: keep(s.bot_token, stored.slack?.bot_token_enc),
      signing_secret_enc: keep(s.signing_secret, stored.slack?.signing_secret_enc),
      channel_id: s.channel_id.trim(),
      team_id: s.team_id?.trim() || undefined,
      approvers: s.approvers.map((a) => a.trim()).filter(Boolean),
    };
  }
  if (input.whatsapp) {
    const w = input.whatsapp;
    out.whatsapp = {
      enabled: w.enabled,
      phone_number_id: w.phone_number_id.trim(),
      access_token_enc: keep(w.access_token, stored.whatsapp?.access_token_enc),
      app_secret_enc: keep(w.app_secret, stored.whatsapp?.app_secret_enc),
      verify_token: w.verify_token.trim(),
      template_name: w.template_name.trim() || "seo_approval_request",
      template_language: w.template_language?.trim() || "en",
      approvers: w.approvers.map(normalizePhone).filter(Boolean),
      last_inbound: stored.whatsapp?.last_inbound ?? {},
    };
  }
  if (input.email) {
    const e = input.email;
    out.email = {
      enabled: e.enabled,
      provider: e.provider,
      api_key_enc: keep(e.api_key, stored.email?.api_key_enc),
      smtp_host: e.smtp_host?.trim() || undefined,
      smtp_port: e.smtp_port || undefined,
      smtp_user: e.smtp_user?.trim() || undefined,
      smtp_pass_enc: keep(e.smtp_pass, stored.email?.smtp_pass_enc),
      from: e.from.trim(),
      approvers: e.approvers.map((a) => a.trim().toLowerCase()).filter(Boolean),
      digest: e.digest,
    };
  }
  if (input.notify_on) out.notify_on = input.notify_on.filter((k) => NOTIFY_KINDS.includes(k));
  return out;
}

const mask = (enc: string | undefined) => (enc ? UNCHANGED : "");

/** Same shape as ChannelsInput with secrets replaced by "__unchanged__" (set) or "" (unset). */
export function channelsView(c: StoredChannels): ChannelsView {
  return {
    slack: {
      enabled: !!c.slack?.enabled,
      bot_token: mask(c.slack?.bot_token_enc),
      signing_secret: mask(c.slack?.signing_secret_enc),
      channel_id: c.slack?.channel_id ?? "",
      team_id: c.slack?.team_id ?? "",
      approvers: c.slack?.approvers ?? [],
    },
    whatsapp: {
      enabled: !!c.whatsapp?.enabled,
      phone_number_id: c.whatsapp?.phone_number_id ?? "",
      access_token: mask(c.whatsapp?.access_token_enc),
      app_secret: mask(c.whatsapp?.app_secret_enc),
      verify_token: c.whatsapp?.verify_token ?? "",
      template_name: c.whatsapp?.template_name ?? "seo_approval_request",
      template_language: c.whatsapp?.template_language ?? "en",
      approvers: c.whatsapp?.approvers ?? [],
    },
    email: {
      enabled: !!c.email?.enabled,
      provider: c.email?.provider ?? "resend",
      api_key: mask(c.email?.api_key_enc),
      smtp_host: c.email?.smtp_host ?? "",
      smtp_port: c.email?.smtp_port ?? 465,
      smtp_user: c.email?.smtp_user ?? "",
      smtp_pass: mask(c.email?.smtp_pass_enc),
      from: c.email?.from ?? "",
      approvers: c.email?.approvers ?? [],
      digest: c.email?.digest !== false,
    },
    notify_on: c.notify_on ?? NOTIFY_KINDS,
  };
}

/**
 * Webhook org resolution. Today there is one org, but we still match on channel identifiers so a
 * second org never receives another org's events:
 *   Slack:    channels.slack.team_id === payload.team.id (or, if team_id is unset, any org with Slack enabled
 *             whose signing secret verifies the request — the caller checks the signature per candidate).
 *   WhatsApp: channels.whatsapp.phone_number_id === value.metadata.phone_number_id
 *             (GET handshake: verify_token match).
 */
export async function listOrgChannels(): Promise<Array<{ orgId: string; stored: StoredChannels }>> {
  const { data } = await createAdmin().from("org_settings").select("org_id, channels");
  return (data ?? []).map((r) => ({ orgId: r.org_id as string, stored: (r.channels ?? {}) as StoredChannels }));
}

/** Record the last inbound WhatsApp message time for a number (opens the 24h service window). */
export async function recordWhatsAppInbound(orgId: string, from: string, at: Date = new Date()): Promise<void> {
  const db = createAdmin();
  const stored = await loadStoredChannels(orgId);
  if (!stored.whatsapp) return;
  const last = { ...(stored.whatsapp.last_inbound ?? {}), [normalizePhone(from)]: at.toISOString() };
  const channels = { ...stored, whatsapp: { ...stored.whatsapp, last_inbound: last } };
  await db.from("org_settings").update({ channels, updated_at: new Date().toISOString() }).eq("org_id", orgId);
}
