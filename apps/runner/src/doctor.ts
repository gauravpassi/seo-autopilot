/**
 * Environment checks: node, claude CLI + login, claude-seo checkout + runtime, python, git.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerHealth } from "./api";
import { claudeSeoLauncher, claudeSeoPath, configPath, configPermissionsOk, loadConfig, pluginPath, type RunnerConfig } from "./config";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** Non-fatal: shown as WARN. */
  optional?: boolean;
}

export interface DoctorReport {
  checks: Check[];
  health: Omit<RunnerHealth, "busy" | "job_id">;
  ok: boolean;
}

export function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = !e ? 0 : typeof e.code === "number" ? e.code : e.code === "ENOENT" ? 127 : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (e && !stdout ? e.message : "") });
    });
  });
}

function versionAtLeast(v: string, min: [number, number]): boolean {
  const m = /(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > min[0] || (a === min[0] && b >= min[1]);
}

function claudeSeoVersion(path: string): string | null {
  try {
    return JSON.parse(readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export async function doctor(cfg: RunnerConfig | null = loadConfig()): Promise<DoctorReport> {
  const checks: Check[] = [];
  const claudeBin = cfg?.claude_bin ?? "claude";

  // Node
  const nodeOk = versionAtLeast(process.versions.node, [20, 0]);
  checks.push({ name: "Node.js", ok: nodeOk, detail: process.versions.node, fix: "Install Node.js 20 or newer" });

  // Registration
  if (cfg) {
    const permOk = configPermissionsOk();
    checks.push({
      name: "Registration",
      ok: permOk,
      detail: `${cfg.name} → ${cfg.server}${permOk ? "" : " (runner.json is readable by others)"}`,
      fix: `chmod 600 ${configPath()}`,
    });
  } else {
    checks.push({ name: "Registration", ok: false, optional: true, detail: "not registered", fix: "seo-autopilot-runner register --server <url> --code <CODE>" });
  }

  // Claude Code
  const cv = await run(claudeBin, ["-v"]);
  const claudeVersion = cv.code === 0 ? cv.stdout.trim().split(/\s+/)[0] : null;
  checks.push({
    name: "Claude Code",
    ok: !!claudeVersion,
    detail: claudeVersion ?? (cv.code === 127 ? "not found on PATH" : cv.stderr.trim().slice(0, 120)),
    fix: "Install Claude Code: npm install -g @anthropic-ai/claude-code (or see https://claude.com/claude-code)",
  });
  let auth: string | null = null;
  if (claudeVersion) {
    const as = await run(claudeBin, ["auth", "status", "--json"]);
    try {
      const j = JSON.parse(as.stdout);
      auth = j.loggedIn === false ? "none" : String(j.authMethod ?? "none");
    } catch {
      auth = null;
    }
    checks.push({
      name: "Claude login",
      ok: !!auth && auth !== "none",
      detail: auth ?? "unknown",
      fix: "Run `claude` once and sign in (or `claude auth login`)",
    });
  }

  // claude-seo
  const seoPath = claudeSeoPath(cfg);
  const seoPresent = existsSync(join(seoPath, ".claude-plugin", "plugin.json"));
  const seoVersion = seoPresent ? claudeSeoVersion(seoPath) : null;
  checks.push({
    name: "claude-seo",
    ok: seoPresent,
    detail: seoPresent ? `${seoVersion ?? "?"} at ${seoPath}` : `missing at ${seoPath}`,
    fix: "seo-autopilot-runner setup",
  });

  // Python
  const py = process.platform === "win32" ? await run("py", ["-3", "--version"]) : await run("python3", ["--version"]);
  const pyVersion = py.code === 0 ? (py.stdout || py.stderr).trim().replace(/^Python\s+/i, "") : null;
  const pyOk = !!pyVersion && versionAtLeast(pyVersion, [3, 10]);
  checks.push({ name: "Python", ok: pyOk, detail: pyVersion ?? "not found", fix: "Install Python 3.10 or newer (python3 on PATH)" });

  // claude-seo runtime
  let runtimeReady = false;
  if (seoPresent) {
    const launcher = claudeSeoLauncher(cfg);
    const r = process.platform === "win32" ? await run("bash", [launcher, "doctor", "--json"], 60_000) : await run(launcher, ["doctor", "--json"], 60_000);
    try {
      const j = JSON.parse(r.stdout);
      runtimeReady = !!j.ready;
      checks.push({
        name: "claude-seo runtime",
        ok: runtimeReady,
        detail: runtimeReady ? `ready (python ${j.python_version}, chromium ${j.browser_ready ? "ready" : "missing"})` : `not ready: ${(j.reasons ?? []).join(", ")}`,
        fix: `"${launcher}" setup   (or: seo-autopilot-runner setup)`,
      });
    } catch {
      checks.push({ name: "claude-seo runtime", ok: false, detail: (r.stderr || r.stdout).trim().slice(0, 160) || `exit ${r.code}`, fix: "seo-autopilot-runner setup" });
    }
  }

  // seo-autopilot plugin
  const plug = pluginPath(cfg);
  checks.push({ name: "seo-autopilot plugin", ok: !!plug, detail: plug ?? "not found", fix: "seo-autopilot-runner setup" });

  // git
  const g = await run("git", ["--version"]);
  checks.push({ name: "git", ok: g.code === 0, optional: true, detail: g.code === 0 ? g.stdout.trim() : "not found", fix: "Install git (needed for setup and repo sites)" });

  const health: DoctorReport["health"] = {
    claude: { ok: !!claudeVersion && !!auth && auth !== "none", version: claudeVersion, auth },
    claude_seo: { ok: seoPresent && runtimeReady && !!plug, version: seoVersion, path: seoPresent ? seoPath : null },
    python: { ok: pyOk, version: pyVersion },
  };
  return { checks, health, ok: checks.every((c) => c.ok || c.optional) };
}

export function formatReport(r: DoctorReport): string {
  const w = Math.max(...r.checks.map((c) => c.name.length));
  const lines = r.checks.map((c) => {
    const tag = c.ok ? " OK " : c.optional ? "WARN" : "FAIL";
    return `[${tag}] ${c.name.padEnd(w)}  ${c.detail}`;
  });
  const fixes = r.checks.filter((c) => !c.ok && c.fix).map((c) => `  - ${c.name}: ${c.fix}`);
  return [...lines, ...(fixes.length ? ["", "How to fix:", ...fixes] : []), "", r.ok ? "All required checks passed." : "Some required checks failed."].join("\n");
}
