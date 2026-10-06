/**
 * Runner configuration: ~/.seo-autopilot/runner.json (mode 0600).
 *
 * Holds the bearer token and the RSA private key that unseals site secrets, so it must be
 * readable by the current user only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const RunnerConfig = z.object({
  server: z.string().url(),
  runner_id: z.string().min(1),
  token: z.string().min(1),
  private_key_pem: z.string().min(1),
  name: z.string().min(1),
  org_id: z.string().optional(),
  /** Where claude-seo lives. Default ~/.seo-autopilot/claude-seo */
  claude_seo_path: z.string().optional(),
  /** Where the seo-autopilot plugin lives. Default: auto-detected. */
  plugin_path: z.string().optional(),
  /** Path to the `claude` binary. Default: "claude" on PATH. */
  claude_bin: z.string().optional(),
  /** Optional model alias passed as --model. */
  model: z.string().optional(),
  /** Default --max-budget-usd per claude run. */
  max_budget_usd: z.number().positive().optional(),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

export function baseDir(): string {
  return process.env.SEO_AUTOPILOT_HOME ? resolve(process.env.SEO_AUTOPILOT_HOME) : join(homedir(), ".seo-autopilot");
}

export function configPath(): string {
  return join(baseDir(), "runner.json");
}

export function defaultClaudeSeoPath(): string {
  return join(baseDir(), "claude-seo");
}

export function claudeSeoPath(cfg?: Partial<RunnerConfig> | null): string {
  return cfg?.claude_seo_path ? resolve(cfg.claude_seo_path) : defaultClaudeSeoPath();
}

/** Path of claude-seo's launcher script (`scripts/claude-seo`). */
export function claudeSeoLauncher(cfg?: Partial<RunnerConfig> | null): string {
  return join(claudeSeoPath(cfg), "scripts", "claude-seo");
}

/**
 * Locate the seo-autopilot Claude Code plugin directory:
 *  1. config.plugin_path
 *  2. ~/.seo-autopilot/plugin (copied there by `setup`)
 *  3. <repo>/plugin relative to this file (dev: src/ or dist/ inside apps/runner)
 */
export function pluginPath(cfg?: Partial<RunnerConfig> | null): string | null {
  const candidates: string[] = [];
  if (cfg?.plugin_path) candidates.push(resolve(cfg.plugin_path));
  candidates.push(join(baseDir(), "plugin"));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, "../../../plugin"), resolve(here, "../../plugin"), resolve(here, "../plugin"));
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    if (existsSync(join(c, ".claude-plugin", "plugin.json"))) return c;
  }
  return null;
}

/** Repo plugin dir (source for `setup` to copy from). */
export function bundledPluginPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const c of [resolve(here, "../../../plugin"), resolve(here, "../../plugin"), resolve(here, "../plugin")]) {
      if (existsSync(join(c, ".claude-plugin", "plugin.json"))) return c;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function loadConfig(path = configPath()): RunnerConfig | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return RunnerConfig.parse(raw);
}

export function requireConfig(path = configPath()): RunnerConfig {
  const cfg = loadConfig(path);
  if (!cfg) {
    throw new Error(`Runner is not registered (no ${path}). Run: seo-autopilot-runner register --server <url> --code <CODE>`);
  }
  return cfg;
}

/** Write config atomically with mode 0600 (best effort on Windows, where POSIX modes are ignored). */
export function saveConfig(cfg: RunnerConfig, path = configPath()): void {
  const data = RunnerConfig.parse(cfg);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

/** True when the file is not readable by group/others (always true on Windows). */
export function configPermissionsOk(path = configPath()): boolean {
  if (process.platform === "win32") return true;
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}
