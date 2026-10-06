import { describe, expect, it } from "vitest";
import { canTransition, notifyKindFor, timestampsFor, RUNNER_TRANSITIONS } from "../lib/transitions";

describe("runner change transitions", () => {
  it("allows the happy path", () => {
    const path = ["approved", "applying", "applied", "verifying", "verified"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });
  it("allows failure and rollback paths", () => {
    expect(canTransition("verifying", "verify_failed")).toBe(true);
    expect(canTransition("verify_failed", "rolling_back")).toBe(true);
    expect(canTransition("rolling_back", "rolled_back")).toBe(true);
    expect(canTransition("applying", "failed")).toBe(true);
    expect(canTransition("applied", "rolling_back")).toBe(true);
    expect(canTransition("verified", "rolling_back")).toBe(true);
    expect(canTransition("verify_failed", "verifying")).toBe(true);
  });
  it("blocks decisions and skips", () => {
    expect(canTransition("pending_approval", "approved")).toBe(false);
    expect(canTransition("pending_approval", "applying")).toBe(false);
    expect(canTransition("rejected", "applying")).toBe(false);
    expect(canTransition("blocked", "applying")).toBe(false);
    expect(canTransition("approved", "applied")).toBe(false);
    expect(canTransition("rolled_back", "applying")).toBe(false);
    expect(canTransition("verified", "applied")).toBe(false);
  });
  it("is idempotent for repeated reports", () => {
    expect(canTransition("applied", "applied")).toBe(true);
  });
  it("never lets a runner move a change out of terminal states except via rollback", () => {
    for (const from of ["rejected", "expired", "blocked", "rolled_back", "proposed", "pending_approval"] as const) {
      expect(RUNNER_TRANSITIONS[from]).toBeUndefined();
    }
  });
  it("stamps timestamps and picks notifications", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    expect(timestampsFor("applied", now)).toEqual({ applied_at: now.toISOString() });
    expect(timestampsFor("verified", now)).toEqual({ verified_at: now.toISOString() });
    expect(timestampsFor("applying", now)).toEqual({});
    expect(notifyKindFor("verify_failed")).toBe("verify_failed");
    expect(notifyKindFor("rolled_back")).toBe("rolled_back");
    expect(notifyKindFor("failed")).toBe("job_failed");
    expect(notifyKindFor("verified")).toBeNull();
  });
});
