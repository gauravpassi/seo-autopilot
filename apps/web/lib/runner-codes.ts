import { randomBytes } from "node:crypto";

// No 0/O/1/I/L to avoid misreads.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** "ABCD-EFGH-JKLM" */
export function generateRunnerCode(): string {
  const bytes = randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Normalize a typed code ("abcd efgh-jklm") to canonical form before hashing. */
export function canonicalCode(code: string): string {
  const s = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.match(/.{1,4}/g)?.join("-") ?? s;
}

export const RUNNER_CODE_TTL_MS = 15 * 60 * 1000;
