import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobKind } from "@seo-autopilot/core";

export interface EnqueueInput {
  orgId: string;
  siteId: string | null;
  kind: JobKind;
  params?: Record<string, unknown>;
  createdBy?: string | null;
  parentJobId?: string | null;
}

export async function enqueueJobRow(db: SupabaseClient, j: EnqueueInput): Promise<string> {
  const { data, error } = await db
    .from("jobs")
    .insert({
      org_id: j.orgId,
      site_id: j.siteId,
      kind: j.kind,
      params: j.params ?? {},
      created_by: j.createdBy ?? null,
      parent_job_id: j.parentJobId ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`enqueue ${j.kind}: ${error.message}`);
  return data.id as string;
}

/**
 * Enqueue an `apply` job (default params = all approved changes on the site) unless one is
 * already queued for that site — the queued one will pick up the new approvals too.
 * Returns the new job id, or null when skipped.
 */
export async function enqueueApplyIfNone(
  db: SupabaseClient,
  orgId: string,
  siteId: string,
  createdBy?: string | null,
): Promise<string | null> {
  const { data: existing } = await db
    .from("jobs")
    .select("id")
    .eq("org_id", orgId)
    .eq("site_id", siteId)
    .eq("kind", "apply")
    .eq("status", "queued")
    .limit(1);
  if (existing && existing.length > 0) return null;
  return enqueueJobRow(db, { orgId, siteId, kind: "apply", params: {}, createdBy });
}
