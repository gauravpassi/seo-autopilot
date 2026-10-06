"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { JobParams } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { act, parse, UserError, Uuid } from "@/lib/action-utils";

const Input = z.object({
  id: Uuid.optional(),
  site_id: Uuid,
  kind: z.enum(["audit", "propose", "monitor", "verify"]),
  every_hours: z.number().int().min(1).max(2160),
  enabled: z.boolean(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export async function upsertSchedule(input: {
  id?: string;
  site_id: string;
  kind: "audit" | "propose" | "monitor" | "verify";
  every_hours: number;
  enabled: boolean;
  params?: Record<string, unknown>;
}) {
  return act(async () => {
    const m = await requireRole("admin");
    const i = parse(Input, input);
    const params = parse(JobParams[i.kind] as unknown as z.ZodType<Record<string, unknown>>, i.params ?? {});
    const db = createAdmin();
    const { data: site } = await db.from("sites").select("id").eq("id", i.site_id).eq("org_id", m.orgId).maybeSingle();
    if (!site) throw new UserError("Site not found");
    let id = i.id;
    if (id) {
      const { data: existing } = await db.from("schedules").select("id, every_hours, last_run_at").eq("id", id).eq("org_id", m.orgId).maybeSingle();
      if (!existing) throw new UserError("Schedule not found");
      const patch: Record<string, unknown> = { kind: i.kind, every_hours: i.every_hours, enabled: i.enabled, params, site_id: i.site_id };
      if (existing.every_hours !== i.every_hours) {
        const base = existing.last_run_at ? Date.parse(existing.last_run_at) : Date.now();
        patch.next_run_at = new Date(Math.max(Date.now(), base + i.every_hours * 3600e3)).toISOString();
      }
      const { error } = await db.from("schedules").update(patch).eq("id", id).eq("org_id", m.orgId);
      if (error) throw new Error(error.message);
    } else {
      const { data, error } = await db
        .from("schedules")
        .insert({ org_id: m.orgId, site_id: i.site_id, kind: i.kind, every_hours: i.every_hours, enabled: i.enabled, params })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      id = data.id as string;
    }
    await auditLog({ orgId: m.orgId, actor: m.email, action: i.id ? "schedule.updated" : "schedule.created", entity: "schedule", entityId: id, data: { site_id: i.site_id, kind: i.kind, every_hours: i.every_hours, enabled: i.enabled } });
    revalidatePath(`/sites/${i.site_id}`);
    return { id: id as string };
  });
}

export async function deleteSchedule(id: string) {
  return act(async () => {
    const m = await requireRole("admin");
    const sid = parse(Uuid, id);
    const { data, error } = await createAdmin().from("schedules").delete().eq("id", sid).eq("org_id", m.orgId).select("id, site_id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new UserError("Schedule not found");
    await auditLog({ orgId: m.orgId, actor: m.email, action: "schedule.deleted", entity: "schedule", entityId: sid, data: { site_id: data.site_id } });
    revalidatePath(`/sites/${data.site_id}`);
    return {};
  });
}
