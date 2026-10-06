/**
 * Per-job work directories: ~/.seo-autopilot/work/<site-id>/<job-id>/
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { baseDir } from "./config";

const SAFE = /^[A-Za-z0-9._-]+$/;

export function workRoot(): string {
  return join(baseDir(), "work");
}

export function jobWorkDir(siteId: string | null | undefined, jobId: string): string {
  const site = siteId ?? "_global";
  if (!SAFE.test(site) || !SAFE.test(jobId)) throw new Error("Unsafe site or job id for a directory name");
  const dir = join(workRoot(), site, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Delete job directories older than `days` (by mtime). Returns how many were removed. */
export function cleanupWorkDirs(days = 14, now = Date.now(), root = workRoot()): number {
  let removed = 0;
  const cutoff = now - days * 86_400_000;
  let sites: string[] = [];
  try {
    sites = readdirSync(root);
  } catch {
    return 0;
  }
  for (const site of sites) {
    const siteDir = join(root, site);
    let jobs: string[] = [];
    try {
      if (!statSync(siteDir).isDirectory()) continue;
      jobs = readdirSync(siteDir);
    } catch {
      continue;
    }
    for (const job of jobs) {
      const dir = join(siteDir, job);
      try {
        const st = statSync(dir);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    try {
      if (readdirSync(siteDir).length === 0) rmSync(siteDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return removed;
}
