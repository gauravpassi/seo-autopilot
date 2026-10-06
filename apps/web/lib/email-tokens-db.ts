import "server-only";
import { createAdmin } from "./supabase/server";
import { loadChannels } from "./settings";
import type { TokenRow, TokenStore } from "./action-tokens";

export const supabaseTokenStore: TokenStore = {
  async insert(rows) {
    if (rows.length === 0) return;
    const { error } = await createAdmin().from("action_tokens").insert(rows);
    if (error) throw new Error(`action_tokens insert: ${error.message}`);
  },
  async get(jti) {
    const { data } = await createAdmin().from("action_tokens").select("*").eq("jti", jti).maybeSingle();
    return (data as TokenRow) ?? null;
  },
  async consume(jti, now) {
    const { data } = await createAdmin()
      .from("action_tokens")
      .update({ used_at: now.toISOString() })
      .eq("jti", jti)
      .is("used_at", null)
      .gt("expires_at", now.toISOString())
      .select("*")
      .maybeSingle();
    return (data as TokenRow) ?? null;
  },
};

export async function isEmailApprover(orgId: string, email: string): Promise<boolean> {
  const ch = await loadChannels(orgId);
  return !!ch.email?.approvers.includes(email.trim().toLowerCase());
}
