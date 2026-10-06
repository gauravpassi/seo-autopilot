import { createBrowserClient as createSsrBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browser: SupabaseClient | null = null;

/** Supabase client for Client Components (anon key, user session in cookies, RLS applies). */
export function createBrowserClient(): SupabaseClient {
  if (!browser) {
    browser = createSsrBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return browser;
}
