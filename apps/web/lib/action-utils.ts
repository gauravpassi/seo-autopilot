import "server-only";
import { z } from "zod";
import { AuthzError } from "./auth";

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

export class UserError extends Error {}

/** Run an action body; map auth/validation/user errors to { ok:false, error } and log the rest. */
export async function act<T extends object>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const out = await fn();
    return { ok: true, ...out };
  } catch (e) {
    // redirect()/notFound() throw control-flow errors that must propagate.
    if (e && typeof e === "object" && "digest" in e && typeof (e as { digest?: unknown }).digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_")) throw e;
    if (e instanceof AuthzError || e instanceof UserError) return { ok: false, error: e.message };
    if (e instanceof z.ZodError) return { ok: false, error: zodMessage(e) };
    console.error("server action failed", e);
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new UserError(zodMessage(r.error));
  return r.data;
}

export const Uuid = z.string().uuid();
