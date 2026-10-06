import type { JobKind } from "@seo-autopilot/core";
import { applyJob } from "./apply";
import { auditJob } from "./audit";
import type { JobHandler } from "./context";
import { customJob } from "./custom";
import { monitorJob } from "./monitor";
import { proposeJob } from "./propose";
import { rollbackJob } from "./rollback";
import { testConnectionJob } from "./test_connection";
import { verifyJob } from "./verify";

export const HANDLERS: Record<JobKind, JobHandler> = {
  test_connection: testConnectionJob,
  audit: auditJob,
  propose: proposeJob,
  apply: (ctx) => applyJob(ctx),
  verify: (ctx) => verifyJob(ctx),
  rollback: (ctx) => rollbackJob(ctx),
  monitor: (ctx) => monitorJob(ctx),
  custom: customJob,
};

/** Jobs that need claude-seo + the runner rules (used to decide preflight checks). */
export const CLAUDE_JOBS = new Set<JobKind>(["audit", "propose", "custom"]);
