import "server-only";
import { sha256 } from "@seo-autopilot/core";
import { createAdmin } from "./supabase/server";

export interface RunnerContext {
  id: string;
  orgId: string;
  name: string;
  publicKey: string | null;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
}

/**
 * Authenticate a runner request: `Authorization: Bearer <token>` → sha256 → runners.token_hash
 * (not revoked). Bumps last_seen_at. Throws HttpError(401).
 */
export async function authenticateRunner(req: Request): Promise<RunnerContext> {
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new HttpError(401, "Missing runner token");
  const hash = sha256(m[1]);
  const db = createAdmin();
  const { data, error } = await db
    .from("runners")
    .select("id, org_id, name, public_key")
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(401, "Invalid or revoked runner token");
  await db.from("runners").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return { id: data.id, orgId: data.org_id, name: data.name, publicKey: data.public_key };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

/** Load a site that belongs to the runner's org (404 otherwise). */
export async function loadSiteForRunner(runner: RunnerContext, siteId: string) {
  const { data, error } = await createAdmin()
    .from("sites")
    .select("*")
    .eq("id", siteId)
    .eq("org_id", runner.orgId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Site not found");
  return data as import("./types").Site;
}

export const runnerActor = (r: RunnerContext) => `runner:${r.name}`;
