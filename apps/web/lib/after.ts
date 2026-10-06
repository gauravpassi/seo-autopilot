import { after } from "next/server";

/**
 * Run work after the response is sent (Next `after`). Outside a request scope (scripts/tests)
 * it just runs the promise in the background. Errors are logged, never thrown.
 */
export function runAfter(label: string, fn: () => Promise<unknown>): void {
  const wrapped = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[after:${label}]`, e);
    }
  };
  try {
    after(wrapped);
  } catch {
    void wrapped();
  }
}
