/**
 * Crypto helpers shared by the runner and the server. Node runtime only.
 *
 * Site credentials: hybrid encryption. The browser generates a random AES-256-GCM key,
 * encrypts the secrets JSON with it, then wraps the AES key with the runner's RSA-OAEP
 * (SHA-256) public key. Only the runner holds the private key, so the hosted panel and
 * database never see plaintext credentials. The browser side lives in
 * apps/web/lib/encrypt-browser.ts and must produce exactly this envelope.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  constants,
  timingSafeEqual,
} from "node:crypto";

export interface SealedEnvelope {
  alg: "RSA-OAEP-256+A256GCM";
  key: string;   // base64 RSA-OAEP(SHA-256) wrapped AES key
  iv: string;    // base64 12-byte IV
  data: string;  // base64 ciphertext with the 16-byte GCM tag appended (WebCrypto layout)
}

export function generateRunnerKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** Node-side equivalent of the browser seal, used in tests and for server-originated secrets. */
export function seal(plaintext: string, publicKeyPem: string): SealedEnvelope {
  const aes = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aes, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]);
  const key = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    aes,
  );
  return { alg: "RSA-OAEP-256+A256GCM", key: key.toString("base64"), iv: iv.toString("base64"), data: ct.toString("base64") };
}

export function unseal(env: SealedEnvelope, privateKeyPem: string): string {
  if (env.alg !== "RSA-OAEP-256+A256GCM") throw new Error(`Unsupported envelope ${env.alg}`);
  const aes = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(env.key, "base64"),
  );
  const buf = Buffer.from(env.data, "base64");
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(0, buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", aes, Buffer.from(env.iv, "base64"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// ------------------------------------------------------------------ symmetric (server-side secrets at rest)
/** Encrypt a string with a 32-byte key given as base64 (APP_ENCRYPTION_KEY). Output: "v1:iv:data" base64. */
export function encryptAtRest(plaintext: string, keyB64: string): string {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]);
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptAtRest(value: string, keyB64: string): string {
  const [v, ivB64, dataB64] = value.split(":");
  if (v !== "v1" || !ivB64 || !dataB64) throw new Error("Bad encrypted value");
  const key = Buffer.from(keyB64, "base64");
  const buf = Buffer.from(dataB64, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8");
}

// ------------------------------------------------------------------ hashing & tokens
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Deterministic JSON (sorted keys) so hashes are stable. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** The hash an approval binds to: the runner refuses to apply if it no longer matches. */
export function diffHash(type: string, url: string, after: unknown): string {
  return sha256(stableStringify({ type, url, after }));
}

/** Compact signed token: base64url(payload).base64url(hmac). */
export function signToken(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Constant-time comparison of two hex/base64 strings. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
