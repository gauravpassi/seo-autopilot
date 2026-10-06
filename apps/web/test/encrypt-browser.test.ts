import { describe, expect, it } from "vitest";
import { generateRunnerKeyPair, unseal } from "@seo-autopilot/core";
import { sealForRunner } from "../lib/encrypt-browser";

describe("sealForRunner (WebCrypto) ↔ core unseal (node:crypto)", () => {
  const { publicKeyPem, privateKeyPem } = generateRunnerKeyPair();

  it("produces a SealedEnvelope the runner can open", async () => {
    const secret = JSON.stringify({ platform: "wordpress", username: "seo-agent", app_password: "abcd efgh ijkl mnop", note: "ünïcødé ✓" });
    const env = await sealForRunner(secret, publicKeyPem);
    expect(env.alg).toBe("RSA-OAEP-256+A256GCM");
    expect(Buffer.from(env.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(env.key, "base64")).toHaveLength(384); // RSA-3072
    expect(Buffer.from(env.data, "base64").length).toBe(Buffer.byteLength(secret) + 16); // ciphertext ‖ tag
    expect(unseal(env, privateKeyPem)).toBe(secret);
  });

  it("uses a fresh key and IV every time", async () => {
    const a = await sealForRunner("x", publicKeyPem);
    const b = await sealForRunner("x", publicKeyPem);
    expect(a.iv).not.toBe(b.iv);
    expect(a.key).not.toBe(b.key);
  });

  it("detects tampering", async () => {
    const env = await sealForRunner("hello", publicKeyPem);
    const buf = Buffer.from(env.data, "base64");
    buf[0] ^= 1;
    expect(() => unseal({ ...env, data: buf.toString("base64") }, privateKeyPem)).toThrow();
  });

  it("rejects a non-SPKI key", async () => {
    await expect(sealForRunner("x", "-----BEGIN RSA PUBLIC KEY-----\nAAAA\n-----END RSA PUBLIC KEY-----")).rejects.toThrow(/SPKI/);
  });
});
