"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-fetches the server component every `ms` while enabled and the tab is visible. */
export function AutoRefresh({ enabled, ms = 5000 }: { enabled: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    return () => clearInterval(t);
  }, [enabled, ms, router]);
  return null;
}
