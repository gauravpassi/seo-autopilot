import "server-only";
import { createAdmin } from "./supabase/server";

/** Insert-once marker. Returns true the first time an id is seen, false for duplicates. */
export async function firstDelivery(channel: string, id: string): Promise<boolean> {
  const { error } = await createAdmin().from("webhook_events").insert({ id: `${channel}:${id}`.slice(0, 500), channel });
  if (!error) return true;
  if (error.code === "23505") return false; // unique_violation
  console.error("webhook_events insert", error.message);
  return true; // fail open on infra errors; decide() is idempotent anyway
}
