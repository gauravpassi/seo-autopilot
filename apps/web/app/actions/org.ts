"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdmin } from "@/lib/supabase/server";
import { getMembership, getUser, requireRole, AuthzError } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { act, parse, UserError, Uuid } from "@/lib/action-utils";
import { NOTIFY_KINDS } from "@/lib/types";
import { appUrl } from "@/lib/notify";

const RoleIn = z.enum(["admin", "member", "viewer"]);

export async function bootstrapOrg(name: string) {
  return act(async () => {
    const user = await getUser();
    if (!user) throw new AuthzError("You are not signed in");
    if (await getMembership()) throw new UserError("You already belong to an organization");
    const n = parse(z.string().trim().min(2).max(100), name);
    const db = createAdmin();
    const { data: org, error } = await db.from("orgs").insert({ name: n }).select("id").single();
    if (error) throw new Error(error.message);
    const { error: me } = await db.from("org_members").insert({ org_id: org.id, user_id: user.id, role: "owner", email: user.email ?? null });
    if (me) throw new Error(me.message);
    await db.from("org_settings").insert({
      org_id: org.id,
      channels: { notify_on: NOTIFY_KINDS, email: { enabled: false, provider: "resend", approvers: user.email ? [user.email.toLowerCase()] : [], digest: true } },
      defaults: {},
    });
    await auditLog({ orgId: org.id, actor: user.email ?? user.id, action: "org.created", entity: "org", entityId: org.id, data: { name: n } });
    revalidatePath("/", "layout");
    return { id: org.id as string };
  });
}

export async function inviteMember(email: string, role: "admin" | "member" | "viewer") {
  return act(async () => {
    const m = await requireRole("admin");
    const e = parse(z.string().trim().toLowerCase().email(), email);
    const r = parse(RoleIn, role);
    const db = createAdmin();
    let userId: string | null = null;
    const { data: inv, error } = await db.auth.admin.inviteUserByEmail(e, { redirectTo: `${appUrl()}/login` });
    if (inv?.user) userId = inv.user.id;
    if (error) {
      // Already registered: find the user by email.
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      userId = list?.users.find((u) => u.email?.toLowerCase() === e)?.id ?? null;
      if (!userId) throw new UserError(`Could not invite ${e}: ${error.message}`);
    }
    const { error: me } = await db.from("org_members").upsert({ org_id: m.orgId, user_id: userId, role: r, email: e }, { onConflict: "org_id,user_id" });
    if (me) throw new Error(me.message);
    await auditLog({ orgId: m.orgId, actor: m.email, action: "member.invited", entity: "user", entityId: userId, data: { email: e, role: r } });
    revalidatePath("/settings");
    return { user_id: userId as string };
  });
}

async function ownersLeft(orgId: string, excludingUser: string): Promise<number> {
  const { count } = await createAdmin()
    .from("org_members")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("role", "owner")
    .neq("user_id", excludingUser);
  return count ?? 0;
}

export async function updateMemberRole(userId: string, role: "owner" | "admin" | "member" | "viewer") {
  return act(async () => {
    const m = await requireRole("admin");
    const uid = parse(Uuid, userId);
    const r = parse(z.enum(["owner", "admin", "member", "viewer"]), role);
    const db = createAdmin();
    const { data: target } = await db.from("org_members").select("role").eq("org_id", m.orgId).eq("user_id", uid).maybeSingle();
    if (!target) throw new UserError("Member not found");
    if ((r === "owner" || target.role === "owner") && m.role !== "owner") throw new AuthzError("Only an owner can grant or remove the owner role");
    if (target.role === "owner" && r !== "owner" && (await ownersLeft(m.orgId, uid)) === 0) throw new UserError("The organization needs at least one owner");
    await db.from("org_members").update({ role: r }).eq("org_id", m.orgId).eq("user_id", uid);
    await auditLog({ orgId: m.orgId, actor: m.email, action: "member.role_changed", entity: "user", entityId: uid, data: { from: target.role, to: r } });
    revalidatePath("/settings");
    return {};
  });
}

export async function removeMember(userId: string) {
  return act(async () => {
    const m = await requireRole("admin");
    const uid = parse(Uuid, userId);
    const db = createAdmin();
    const { data: target } = await db.from("org_members").select("role, email").eq("org_id", m.orgId).eq("user_id", uid).maybeSingle();
    if (!target) throw new UserError("Member not found");
    if (target.role === "owner" && m.role !== "owner") throw new AuthzError("Only an owner can remove an owner");
    if (target.role === "owner" && (await ownersLeft(m.orgId, uid)) === 0) throw new UserError("The organization needs at least one owner");
    await db.from("org_members").delete().eq("org_id", m.orgId).eq("user_id", uid);
    await auditLog({ orgId: m.orgId, actor: m.email, action: "member.removed", entity: "user", entityId: uid, data: { email: target.email } });
    revalidatePath("/settings");
    return {};
  });
}
