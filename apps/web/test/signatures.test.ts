import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../lib/notify/slack";
import { verifyWhatsAppSignature, parseWaButton, inServiceWindow } from "../lib/notify/whatsapp";

describe("Slack v0 signature", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const now = 1_760_000_000;
  const sign = (ts: number, b = body, s = secret) => "v0=" + createHmac("sha256", s).update(`v0:${ts}:${b}`).digest("hex");

  it("accepts a valid signature inside the window", () => {
    expect(verifySlackSignature(body, String(now), sign(now), secret, now)).toBe(true);
    expect(verifySlackSignature(body, String(now - 299), sign(now - 299), secret, now)).toBe(true);
  });
  it("rejects stale or future timestamps (> 300 s)", () => {
    expect(verifySlackSignature(body, String(now - 301), sign(now - 301), secret, now)).toBe(false);
    expect(verifySlackSignature(body, String(now + 301), sign(now + 301), secret, now)).toBe(false);
  });
  it("rejects a modified body, wrong secret, or missing headers", () => {
    expect(verifySlackSignature(body + "x", String(now), sign(now), secret, now)).toBe(false);
    expect(verifySlackSignature(body, String(now), sign(now, body, "other"), secret, now)).toBe(false);
    expect(verifySlackSignature(body, null, sign(now), secret, now)).toBe(false);
    expect(verifySlackSignature(body, String(now), null, secret, now)).toBe(false);
    expect(verifySlackSignature(body, "abc", sign(now), secret, now)).toBe(false);
  });
});

describe("WhatsApp X-Hub-Signature-256", () => {
  const appSecret = "app-secret-123";
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const sig = "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex");

  it("accepts the HMAC of the raw body", () => {
    expect(verifyWhatsAppSignature(raw, sig, appSecret)).toBe(true);
  });
  it("rejects re-serialized bodies, wrong secret and missing header", () => {
    expect(verifyWhatsAppSignature(JSON.stringify(JSON.parse(raw), null, 2), sig, appSecret)).toBe(false);
    expect(verifyWhatsAppSignature(raw, sig, "nope")).toBe(false);
    expect(verifyWhatsAppSignature(raw, null, appSecret)).toBe(false);
    expect(verifyWhatsAppSignature(raw, sig.replace("sha256=", ""), appSecret)).toBe(false);
  });
});

describe("WhatsApp helpers", () => {
  const id = "0b7c8a4e-1d2f-4e3a-9b8c-7d6e5f4a3b2c";
  it("parses button ids", () => {
    expect(parseWaButton(`approve:${id}`)).toEqual({ act: "approve", changeId: id });
    expect(parseWaButton(`reject:${id.toUpperCase()}`)).toEqual({ act: "reject", changeId: id });
    expect(parseWaButton(`approve:${id}x`)).toBeNull();
    expect(parseWaButton("delete:" + id)).toBeNull();
    expect(parseWaButton(undefined)).toBeNull();
  });
  it("knows the 24 h window", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    const cfg = { last_inbound: { "919800000000": "2026-10-06T00:00:00Z", "15550000000": "2026-10-05T11:00:00Z" } };
    expect(inServiceWindow(cfg, "+91 98000 00000", now)).toBe(true);
    expect(inServiceWindow(cfg, "+1 555 000 0000", now)).toBe(false);
    expect(inServiceWindow(cfg, "+44 7000", now)).toBe(false);
  });
});
