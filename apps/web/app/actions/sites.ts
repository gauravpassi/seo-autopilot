"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Platform, SiteConfig, SitePolicy, type SealedEnvelope } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { act, parse, UserError, Uuid } from "@/lib/action-utils";
import { enqueueJobRow } from "@/lib/jobs";

/** Canonical origin: https://www.example.com (no path, no trailing slash). */
function origin(u: string): string {
  const x = new URL(u.includes("://") ? u : `https://${u}`);
  if (x.protocol !== "https:" && x.protocol !== "http:") throw new UserError("URL must be http(s)");
  return `${x.protocol}//${x.host.toLowerCase()}`;
}

const CreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(3).max(500),
  platform: Platform,
  runner_id: Uuid.nullish(),
  config: SiteConfig.partial().optional(),
  policy: z.unknown().optional(),
});

async function assertRunner(orgId: string, runnerId: string | null | undefined) {
  if (!runnerId) return;
  const { data } = await createAdmin().from("runners").select("id").eq("id", runnerId).eq("org_id", orgId).is("revoked_at", null).maybeSingle();
  if (!data) throw new UserError("Runner not found or revoked");
}

export async function createSite(input: {
  name: string;
  url: string;
  platform: "wordpress" | "shopify" | "repo" | "other";
  runner_id?: string | null;
  config?: Record<string, unknown>;
  policy?: Record<string, unknown>;
}) {
  return act(async () => {
    const m = await requireRole("admin");
    const i = parse(CreateInput, input);
    await assertRunner(m.orgId, i.runner_id);
    const policy = parse(SitePolicy, i.policy ?? {});
    const db = createAdmin();
    const { data, error } = await db
      .from("sites")
      .insert({
        org_id: m.orgId,
        name: i.name,
        url: origin(i.url),
        platform: i.platform,
        runner_id: i.runner_id ?? null,
        config: i.config ?? {},
        policy,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = data.id as string;
    const hasGsc = !!(i.config as { gsc_property?: string } | undefined)?.gsc_property;
    await db.from("schedules").insert([
      { org_id: m.orgId, site_id: id, kind: "audit", every_hours: 168, enabled: true, params: { depth: "full" }, next_run_at: new Date(Date.now() + 168 * 3600e3).toISOString() },
      { org_id: m.orgId, site_id: id, kind: "monitor", every_hours: 24, enabled: hasGsc, params: {} },
    ]);
    await auditLog({ orgId: m.orgId, actor: m.email, action: "site.created", entity: "site", entityId: id, data: { name: i.name, url: origin(i.url), platform: i.platform } });
    revalidatePath("/sites");
    revalidatePath("/");
    return { id };
  });
}

const PatchInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().min(3).max(500).optional(),
  runner_id: Uuid.nullish(),
  config: SiteConfig.partial().optional(),
  policy: z.unknown().optional(),
});

export async function updateSite(
  id: string,
  patch: { name?: string; url?: string; runner_id?: string | null; config?: Record<string, unknown>; policy?: Record<string, unknown> },
) {
  return act(async () => {
    const m = await requireRole("admin");
    const siteId = parse(Uuid, id);
    const p = parse(PatchInput, patch);
    const db = createAdmin();
    const { data: site } = await db.from("sites").select("id, config").eq("id", siteId).eq("org_id", m.orgId).maybeSingle();
    if (!site) throw new UserError("Site not found");
    const upd: Record<string, unknown> = {};
    if (p.name !== undefined) upd.name = p.name;
    if (p.url !== undefined) upd.url = origin(p.url);
    if (p.runner_id !== undefined) {
      await assertRunner(m.orgId, p.runner_id);
      upd.runner_id = p.runner_id;
    }
    if (p.config !== undefined) upd.config = { ...(site.config ?? {}), ...p.config };
    if (p.policy !== undefined) upd.policy = parse(SitePolicy, p.policy);
    if (Object.keys(upd).length === 0) return {};
    const { error } = await db.from("sites").update(upd).eq("id", siteId).eq("org_id", m.orgId);
    if (error) throw new Error(error.message);
    // Monitoring needs a Search Console property.
    if (p.config && "gsc_property" in p.config) {
      await db.from("schedules").update({ enabled: !!p.config.gsc_property }).eq("site_id", siteId).eq("kind", "monitor");
    }
    await auditLog({ orgId: m.orgId, actor: m.email, action: p.policy !== undefined ? "site.policy_updated" : "site.updated", entity: "site", entityId: siteId, data: { fields: Object.keys(upd), policy: upd.policy } });
    revalidatePath(`/sites/${siteId}`);
    revalidatePath("/sites");
    return {};
  });
}

export async function archiveSite(id: string) {
  return act(async () => {
    const m = await requireRole("admin");
    const siteId = parse(Uuid, id);
    const db = createAdmin();
    const { data, error } = await db.from("sites").update({ archived_at: new Date().toISOString() }).eq("id", siteId).eq("org_id", m.orgId).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new UserError("Site not found");
    await db.from("schedules").update({ enabled: false }).eq("site_id", siteId);
    await db.from("jobs").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("site_id", siteId).eq("status", "queued");
    await auditLog({ orgId: m.orgId, actor: m.email, action: "site.archived", entity: "site", entityId: siteId });
    revalidatePath("/sites");
    revalidatePath("/");
    return {};
  });
}

const Envelope = z.object({
  alg: z.literal("RSA-OAEP-256+A256GCM"),
  key: z.string().min(16).max(4096),
  iv: z.string().min(8).max(64),
  data: z.string().min(1).max(200_000),
});

export async function saveSiteSecret(siteId: string, runnerId: string, ciphertext: SealedEnvelope, hint?: string) {
  return act(async () => {
    const m = await requireRole("admin");
    const sid = parse(Uuid, siteId);
    const rid = parse(Uuid, runnerId);
    const env = parse(Envelope, ciphertext);
    const h = hint ? parse(z.string().max(200), hint) : null;
    const db = createAdmin();
    const { data: site } = await db.from("sites").select("id, runner_id").eq("id", sid).eq("org_id", m.orgId).maybeSingle();
    if (!site) throw new UserError("Site not found");
    await assertRunner(m.orgId, rid);
    const { error } = await db
      .from("site_secrets")
      .upsert({ site_id: sid, org_id: m.orgId, runner_id: rid, ciphertext: env, hint: h, updated_at: new Date().toISOString() }, { onConflict: "site_id" });
    if (error) throw new Error(error.message);
    // Secrets are sealed for one runner: the site must run there.
    if (site.runner_id !== rid) await db.from("sites").update({ runner_id: rid }).eq("id", sid);
    const jobId = await enqueueJobRow(db, { orgId: m.orgId, siteId: sid, kind: "test_connection", params: {}, createdBy: m.user.id });
    await auditLog([
      { orgId: m.orgId, actor: m.email, action: "site.secret_saved", entity: "site", entityId: sid, data: { runner_id: rid, hint: h } },
      { orgId: m.orgId, actor: m.email, action: "job.enqueued", entity: "job", entityId: jobId, data: { kind: "test_connection", site_id: sid } },
    ]);
    revalidatePath(`/sites/${sid}`);
    return { job_id: jobId };
  });
}
