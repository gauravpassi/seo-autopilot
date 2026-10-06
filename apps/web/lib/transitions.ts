import type { ChangeStatus } from "@seo-autopilot/core";

/**
 * Status transitions a runner may report for a change (POST /api/runner/changes/:id).
 * Decisions (pending_approval → approved/rejected/expired) are NOT here: they go through decide().
 *
 *   approved      → applying (apply started / repo PR open), failed (pre-check aborted), blocked (platform says a person must do it)
 *   applying      → applied, failed, blocked
 *   applied       → verifying, verified, verify_failed, rolling_back
 *   verifying     → verified, verify_failed
 *   verify_failed → verifying (re-verify, slow caches), verified, rolling_back
 *   verified      → verifying (re-check), rolling_back
 *   failed        → rolling_back (undo a partial write)
 *   rolling_back  → rolled_back, failed
 */
export const RUNNER_TRANSITIONS: Partial<Record<ChangeStatus, readonly ChangeStatus[]>> = {
  approved: ["applying", "failed", "blocked"],
  applying: ["applied", "failed", "blocked"],
  applied: ["verifying", "verified", "verify_failed", "rolling_back"],
  verifying: ["verified", "verify_failed"],
  verify_failed: ["verifying", "verified", "rolling_back"],
  verified: ["verifying", "rolling_back"],
  failed: ["rolling_back"],
  rolling_back: ["rolled_back", "failed"],
};

export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  if (from === to) return true; // idempotent re-report (e.g. a retried request)
  return RUNNER_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Timestamp columns set automatically when a change enters a status. */
export function timestampsFor(to: ChangeStatus, now: Date = new Date()): Record<string, string> {
  const iso = now.toISOString();
  switch (to) {
    case "applied":
      return { applied_at: iso };
    case "verified":
      return { verified_at: iso };
    default:
      return {};
  }
}

/** Which notify kind (if any) a runner-reported status triggers. */
export function notifyKindFor(to: ChangeStatus): "verify_failed" | "rolled_back" | "job_failed" | null {
  if (to === "verify_failed") return "verify_failed";
  if (to === "rolled_back") return "rolled_back";
  if (to === "failed") return "job_failed";
  return null;
}
