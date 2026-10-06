import { randomToken, sha256 } from "@seo-autopilot/core";
import { z } from "zod";
import { createAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit-log";
import { canonicalCode } from "@/lib/runner-codes";
import { errorResponse, HttpError, json, readJson } from "@/lib/runner-auth";

export const runtime = "nodejs";

const Body = z.object({
  code: z.string().min(4).max(64),
  name: z.string().min(1).max(100).optional(),
  public_key: z.string().includes("BEGIN PUBLIC KEY").max(10000),
  version: z.string().max(50).optional(),
});

export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { code, name, public_key, version } = parsed.data;
    const db = createAdmin();
    const { data: runner } = await db
      .from("runners")
      .select("id, org_id, name, registration_expires_at")
      .eq("registration_code_hash", sha256(canonicalCode(code)))
      .is("revoked_at", null)
      .maybeSingle();
    if (!runner) throw new HttpError(401, "Unknown or already used registration code");
    if (!runner.registration_expires_at || Date.parse(runner.registration_expires_at) < Date.now())
      throw new HttpError(401, "Registration code expired — create a new one in the panel");

    const token = randomToken();
    const { data: updated, error } = await db
      .from("runners")
      .update({
        public_key,
        token_hash: sha256(token),
        registration_code_hash: null,
        registration_expires_at: null,
        version: version ?? null,
        name: name?.trim() || runner.name,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", runner.id)
      .not("registration_code_hash", "is", null) // single use even under a race
      .select("id")
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!updated) throw new HttpError(409, "Registration code was just used");

    await auditLog({ orgId: runner.org_id, actor: `runner:${name?.trim() || runner.name}`, action: "runner.registered", entity: "runner", entityId: runner.id, data: { version } });
    return json({ runner_id: runner.id, token, org_id: runner.org_id });
  } catch (e) {
    return errorResponse(e);
  }
}
