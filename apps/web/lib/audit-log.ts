import "server-only";
import { createAdmin } from "./supabase/server";

export interface AuditEntry {
  orgId: string;
  /** user email, "runner:<name>", "slack:<user>", "whatsapp:<number>", "email:<address>", "system" */
  actor: string;
  action: string;
  entity?: string;
  entityId?: string | null;
  data?: Record<string, unknown> | null;
}

/** Append to audit_log. Never throws: an audit write failure is logged, not fatal. */
export async function auditLog(e: AuditEntry | AuditEntry[]): Promise<void> {
  const rows = (Array.isArray(e) ? e : [e]).map((x) => ({
    org_id: x.orgId,
    actor: x.actor,
    action: x.action,
    entity: x.entity ?? null,
    entity_id: x.entityId ?? null,
    data: x.data ?? null,
  }));
  if (rows.length === 0) return;
  const { error } = await createAdmin().from("audit_log").insert(rows);
  if (error) console.error("audit_log insert failed", error.message);
}
