"use server";

import { revalidatePath } from "next/cache";
import { JobKind, JobParams } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { act, parse, UserError, Uuid } from "@/lib/action-utils";
import { enqueueJobRow } from "@/lib/jobs";

export async function enqueueJob(siteId: string, kind: JobKind, params?: object) {
  return act(async () => {
    const m = await requireRole("member");
    const sid = parse(Uuid, siteId);
    const k = parse(JobKind, kind);
    const p = parse(JobParams[k] as unknown as import("zod").ZodType<Record<string, unknown>>, params ?? {});
    const db = createAdmin();
    const { data: site } = await db.from("sites").select("id, archived_at").eq("id", sid).eq("org_id", m.orgId).maybeSingle();
    if (!site) throw new UserError("Site not found");
    if (site.archived_at) throw new UserError("Site is archived");
    const id = await enqueueJobRow(db, { orgId: m.orgId, siteId: sid, kind: k, params: p, createdBy: m.user.id });
    await auditLog({ orgId: m.orgId, actor: m.email, action: "job.enqueued", entity: "job", entityId: id, data: { kind: k, site_id: sid, params: p } });
    revalidatePath("/jobs");
    revalidatePath(`/sites/${sid}`);
    return { id };
  });
}

export async function cancelJob(jobId: string) {
  return act(async () => {
    const m = await requireRole("member");
    const id = parse(Uuid, jobId);
    const db = createAdmin();
    const { data: job } = await db.from("jobs").select("id, status, site_id").eq("id", id).eq("org_id", m.orgId).maybeSingle();
    if (!job) throw new UserError("Job not found");
    let outcome: "cancelled" | "cancel_requested";
    if (job.status === "queued") {
      const { data } = await db
        .from("jobs")
        .update({ status: "cancelled", cancel_requested: true, finished_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "queued")
        .select("id")
        .maybeSingle();
      outcome = data ? "cancelled" : "cancel_requested";
      if (!data) await db.from("jobs").update({ cancel_requested: true }).eq("id", id);
    } else if (job.status === "running") {
      await db.from("jobs").update({ cancel_requested: true }).eq("id", id);
      outcome = "cancel_requested";
    } else {
      throw new UserError(`Job already ${job.status}`);
    }
    await auditLog({ orgId: m.orgId, actor: m.email, action: `job.${outcome}`, entity: "job", entityId: id });
    revalidatePath(`/jobs/${id}`);
    revalidatePath("/jobs");
    return { status: outcome };
  });
}
