/**
 * Signed, single-use email action tokens.
 * Token = core signToken({ jti, cids, act, rcpt, exp }, ACTION_TOKEN_SECRET); a row in action_tokens
 * makes it single-use (atomic `update ... where used_at is null returning`).
 *
 * Pure logic takes a minimal DB interface so it can be unit-tested with a fake.
 */
import { randomUUID } from "node:crypto";
import { signToken, verifyToken } from "@seo-autopilot/core";

export interface ActionClaims {
  jti: string;
  cids: string[];
  act: "approve" | "reject";
  rcpt: string;
  exp: number; // unix seconds
  org: string;
}

export interface TokenRow {
  jti: string;
  org_id: string;
  change_ids: string[];
  action: "approve" | "reject";
  recipient: string;
  expires_at: string;
  used_at: string | null;
}

/** Minimal persistence the token logic needs (implemented with Supabase in lib/email-tokens-db.ts). */
export interface TokenStore {
  insert(rows: TokenRow[]): Promise<void>;
  get(jti: string): Promise<TokenRow | null>;
  /** Atomically set used_at if still null and unexpired; return the row or null. */
  consume(jti: string, now: Date): Promise<TokenRow | null>;
}

function secret(s?: string): string {
  const v = s ?? process.env.ACTION_TOKEN_SECRET;
  if (!v) throw new Error("ACTION_TOKEN_SECRET is not set");
  return v;
}

export function mintActionToken(
  input: { orgId: string; changeIds: string[]; act: "approve" | "reject"; recipient: string; expiresAt: Date },
  opts: { secret?: string; jti?: string } = {},
): { token: string; claims: ActionClaims; row: TokenRow } {
  const claims: ActionClaims = {
    jti: opts.jti ?? randomUUID(),
    cids: input.changeIds,
    act: input.act,
    rcpt: input.recipient.trim().toLowerCase(),
    exp: Math.floor(input.expiresAt.getTime() / 1000),
    org: input.orgId,
  };
  const token = signToken(claims as unknown as Record<string, unknown>, secret(opts.secret));
  const row: TokenRow = {
    jti: claims.jti,
    org_id: input.orgId,
    change_ids: input.changeIds,
    action: input.act,
    recipient: claims.rcpt,
    expires_at: input.expiresAt.toISOString(),
    used_at: null,
  };
  return { token, claims, row };
}

/** Signature + expiry + shape. Returns claims or null. Does not touch the DB. */
export function readActionToken(token: string | null | undefined, opts: { secret?: string } = {}): ActionClaims | null {
  if (!token || token.length > 8192) return null;
  const c = verifyToken<ActionClaims>(token, secret(opts.secret));
  if (!c) return null;
  if (
    typeof c.jti !== "string" ||
    !Array.isArray(c.cids) ||
    c.cids.length === 0 ||
    !c.cids.every((x) => typeof x === "string") ||
    (c.act !== "approve" && c.act !== "reject") ||
    typeof c.rcpt !== "string" ||
    typeof c.exp !== "number" ||
    typeof c.org !== "string"
  )
    return null;
  return c;
}

export type RedeemResult =
  | { ok: true; claims: ActionClaims }
  | { ok: false; reason: "invalid" | "expired_or_used" | "not_approver" | "mismatch" };

/**
 * Verify + consume a token. `isApprover` re-checks the recipient against the CURRENT allow-list.
 * Order: verify signature/expiry → check the row matches the claims → allow-list → consume atomically.
 */
export async function redeemActionToken(
  token: string,
  store: TokenStore,
  isApprover: (orgId: string, email: string) => Promise<boolean>,
  opts: { secret?: string; now?: Date } = {},
): Promise<RedeemResult> {
  const claims = readActionToken(token, opts);
  if (!claims) return { ok: false, reason: "invalid" };
  const row = await store.get(claims.jti);
  if (!row) return { ok: false, reason: "invalid" };
  if (
    row.org_id !== claims.org ||
    row.action !== claims.act ||
    row.recipient !== claims.rcpt ||
    [...row.change_ids].sort().join(",") !== [...claims.cids].sort().join(",")
  )
    return { ok: false, reason: "mismatch" };
  if (!(await isApprover(claims.org, claims.rcpt))) return { ok: false, reason: "not_approver" };
  const used = await store.consume(claims.jti, opts.now ?? new Date());
  if (!used) return { ok: false, reason: "expired_or_used" };
  return { ok: true, claims };
}
