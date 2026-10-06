import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createAdmin, createClient } from "./supabase/server";
import type { Role } from "./types";

export interface Membership {
  user: User;
  orgId: string;
  role: Role;
  email: string;
}

/** Current user (validated with the Auth server), or null. Deduplicated per request. */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

/**
 * The user's org membership, or null when logged out / no org.
 * Single-org today: picks the oldest membership.
 */
export const getMembership = cache(async (): Promise<Membership | null> => {
  const user = await getUser();
  if (!user) return null;
  const { data } = await createAdmin()
    .from("org_members")
    .select("org_id, role, email, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { user, orgId: data.org_id as string, role: data.role as Role, email: (data.email as string) ?? user.email ?? "" };
});

/** For pages and actions: redirects to /login (no session) or /onboarding (no org). */
export async function requireMember(): Promise<Membership> {
  const user = await getUser();
  if (!user) redirect("/login");
  const m = await getMembership();
  if (!m) redirect("/onboarding");
  return m;
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export class AuthzError extends Error {}

/** For server actions: returns the membership or throws AuthzError (caught and returned as {ok:false}). */
export async function requireRole(min: Role): Promise<Membership> {
  const user = await getUser();
  if (!user) throw new AuthzError("You are not signed in");
  const m = await getMembership();
  if (!m) throw new AuthzError("You are not a member of an organization");
  if (!hasRole(m.role, min)) throw new AuthzError(`This needs the ${min} role or higher`);
  return m;
}
