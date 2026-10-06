/**
 * Browser-side sealing of site credentials for a runner (client-safe: WebCrypto only).
 *
 * Produces exactly the core `SealedEnvelope` (packages/core/src/crypto.ts):
 *   key  = base64( RSA-OAEP(SHA-256)( 32-byte AES key ) )
 *   iv   = base64( 12 random bytes )
 *   data = base64( AES-256-GCM ciphertext ‖ 16-byte tag )   (WebCrypto already appends the tag)
 *
 * Only the runner holding the private key can open it (`unseal`).
 */

export interface SealedEnvelope {
  alg: "RSA-OAEP-256+A256GCM";
  key: string;
  iv: string;
  data: string;
}

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available (needs a secure context: https or localhost)");
  return c.subtle;
}

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64decode(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Parse an SPKI PEM ("-----BEGIN PUBLIC KEY-----") into DER bytes. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const m = pem.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/);
  if (!m) throw new Error("Runner public key must be an SPKI PEM (BEGIN PUBLIC KEY)");
  return b64decode(m[1].replace(/\s+/g, ""));
}

export async function importRunnerPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  return getSubtle().importKey("spki", pemToDer(publicKeyPem), { name: "RSA-OAEP", hash: "SHA-256" }, false, [
    "encrypt",
  ]);
}

export async function sealForRunner(plaintextJson: string, publicKeyPem: string): Promise<SealedEnvelope> {
  const subtle = getSubtle();
  const rsa = await importRunnerPublicKey(publicKeyPem);
  const aesRaw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aes = await subtle.importKey("raw", aesRaw, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, aes, new TextEncoder().encode(plaintextJson));
  const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, rsa, aesRaw);
  aesRaw.fill(0);
  return { alg: "RSA-OAEP-256+A256GCM", key: b64encode(wrapped), iv: b64encode(iv), data: b64encode(ct) };
}
