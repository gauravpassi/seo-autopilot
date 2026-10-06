"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sha256 } from "@seo-autopilot/core";
import { createAdmin } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { act, parse, UserError, Uuid } from "@/lib/action-utils";
import { generateRunnerCode, RUNNER_CODE_TTL_MS } from "@/lib/runner-codes";

/** Creates a runner row with a one-time registration code (shown once, 15 min). */
export async function createRunnerCode(name: string) {
  return act(async () => {
    const m = await requireRole("admin");
    const n = parse(z.string().trim().min(1).max(100), name);
    const code = generateRunnerCode();
    const expires = new Date(Date.now() + RUNNER_CODE_TTL_MS).toISOString();
    const { data, error } = await createAdmin()
      .from("runners")
      .insert({ org_id: m.orgId, name: n, registration_code_hash: sha256(code), registration_expires_at: expires })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await auditLog({ orgId: m.orgId, actor: m.email, action: "runner.code_created", entity: "runner", entityId: data.id, data: { name: n, expires_at: expires } });
    revalidatePath("/runners");
    return { runner_id: data.id as string, code, expires_at: expires };
  });
}

export async function renameRunner(id: string, name: string) {
  return act(async () => {
    const m = await requireRole("admin");
    const rid = parse(Uuid, id);
    const n = parse(z.string().trim().min(1).max(100), name);
    const { data, error } = await createAdmin().from("runners").update({ name: n }).eq("id", rid).eq("org_id", m.orgId).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new UserError("Runner not found");
    await auditLog({ orgId: m.orgId, actor: m.email, action: "runner.renamed", entity: "runner", entityId: rid, data: { name: n } });
    revalidatePath("/runners");
    return {};
  });
}

export async function revokeRunner(id: string) {
  return act(async () => {
    const m = await requireRole("admin");
    const rid = parse(Uuid, id);
    const db = createAdmin();
    const { data, error } = await db
      .from("runners")
      .update({ revoked_at: new Date().toISOString(), token_hash: null, registration_code_hash: null })
      .eq("id", rid)
      .eq("org_id", m.orgId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new UserError("Runner not found");
    // Release work the revoked runner held.
    await db.from("jobs").update({ status: "queued", runner_id: null, started_at: null }).eq("runner_id", rid).eq("status", "running");
    await auditLog({ orgId: m.orgId, actor: m.email, action: "runner.revoked", entity: "runner", entityId: rid });
    revalidatePath("/runners");
    revalidatePath("/");
    return {};
  });
}
