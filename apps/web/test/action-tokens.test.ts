import { describe, expect, it } from "vitest";
import { mintActionToken, readActionToken, redeemActionToken, type TokenRow, type TokenStore } from "../lib/action-tokens";

const SECRET = "test-secret-please-change";

function memoryStore(): TokenStore & { rows: Map<string, TokenRow> } {
  const rows = new Map<string, TokenRow>();
  return {
    rows,
    async insert(list) {
      for (const r of list) rows.set(r.jti, { ...r });
    },
    async get(jti) {
      return rows.get(jti) ?? null;
    },
    async consume(jti, now) {
      const r = rows.get(jti);
      // emulates: update ... set used_at=now where jti=? and used_at is null and expires_at > now returning *
      if (!r || r.used_at !== null || Date.parse(r.expires_at) <= now.getTime()) return null;
      r.used_at = now.toISOString();
      return { ...r };
    },
  };
}

const ORG = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const approvers = new Set(["alice@example.com"]);
const isApprover = async (_org: string, email: string) => approvers.has(email);

function mint(over: Partial<{ act: "approve" | "reject"; recipient: string; expiresAt: Date; ids: string[] }> = {}) {
  return mintActionToken(
    {
      orgId: ORG,
      changeIds: over.ids ?? [CID],
      act: over.act ?? "approve",
      recipient: over.recipient ?? "Alice@Example.com",
      expiresAt: over.expiresAt ?? new Date(Date.now() + 3600_000),
    },
    { secret: SECRET },
  );
}

describe("email action tokens", () => {
  it("round-trips claims (recipient normalized)", () => {
    const { token, claims } = mint();
    expect(claims.rcpt).toBe("alice@example.com");
    expect(readActionToken(token, { secret: SECRET })).toEqual(claims);
  });

  it("rejects bad signatures and other secrets", () => {
    const { token } = mint();
    const [body, mac] = token.split(".");
    expect(readActionToken(`${body}x.${mac}`, { secret: SECRET })).toBeNull();
    expect(readActionToken(token, { secret: "other" })).toBeNull();
    expect(readActionToken("", { secret: SECRET })).toBeNull();
  });

  it("rejects expired tokens", () => {
    const { token } = mint({ expiresAt: new Date(Date.now() - 1000) });
    expect(readActionToken(token, { secret: SECRET })).toBeNull();
  });

  it("is single use", async () => {
    const store = memoryStore();
    const { token, row } = mint();
    await store.insert([row]);
    const first = await redeemActionToken(token, store, isApprover, { secret: SECRET });
    expect(first.ok).toBe(true);
    const second = await redeemActionToken(token, store, isApprover, { secret: SECRET });
    expect(second).toEqual({ ok: false, reason: "expired_or_used" });
  });

  it("refuses concurrent double-spend", async () => {
    const store = memoryStore();
    const { token, row } = mint();
    await store.insert([row]);
    const results = await Promise.all([1, 2, 3].map(() => redeemActionToken(token, store, isApprover, { secret: SECRET })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("requires a stored row that matches the claims", async () => {
    const store = memoryStore();
    const { token } = mint();
    expect(await redeemActionToken(token, store, isApprover, { secret: SECRET })).toEqual({ ok: false, reason: "invalid" });
    const other = mint({ act: "reject" });
    await store.insert([{ ...other.row, jti: (readActionToken(token, { secret: SECRET }) as { jti: string }).jti }]);
    expect(await redeemActionToken(token, store, isApprover, { secret: SECRET })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("re-checks the approver allow-list at redemption", async () => {
    const store = memoryStore();
    const { token, row } = mint({ recipient: "bob@example.com" });
    await store.insert([row]);
    expect(await redeemActionToken(token, store, isApprover, { secret: SECRET })).toEqual({ ok: false, reason: "not_approver" });
    expect(store.rows.get(row.jti)?.used_at).toBeNull(); // not consumed
  });

  it("fails when the DB row has expired even if the signature still verifies", async () => {
    const store = memoryStore();
    const { token, row } = mint();
    await store.insert([{ ...row, expires_at: new Date(Date.now() - 1).toISOString() }]);
    expect(await redeemActionToken(token, store, isApprover, { secret: SECRET })).toEqual({ ok: false, reason: "expired_or_used" });
  });
});
