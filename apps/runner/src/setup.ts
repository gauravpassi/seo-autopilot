/**
 * `setup`: clone or update claude-seo, run its runtime setup, and install the seo-autopilot
 * plugin under ~/.seo-autopilot/plugin.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { baseDir, bundledPluginPath, claudeSeoLauncher, claudeSeoPath, type RunnerConfig } from "./config";

export const CLAUDE_SEO_REPO = "https://github.com/AgriciDaniel/claude-seo";

function runInherit(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    process.stdout.write(`$ ${cmd} ${args.join(" ")}\n`);
    const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: false, windowsHide: true });
    p.on("error", (e) => {
      process.stderr.write(`${cmd}: ${e.message}\n`);
      resolve(127);
    });
    p.on("close", (code) => resolve(code ?? 1));
  });
}

export async function setup(cfg: Partial<RunnerConfig> | null, opts: { skipBrowser?: boolean; skipRuntime?: boolean } = {}): Promise<boolean> {
  let ok = true;
  const seo = claudeSeoPath(cfg);
  mkdirSync(dirname(seo), { recursive: true });

  // 1. claude-seo checkout
  if (existsSync(join(seo, ".git"))) {
    console.log(`Updating claude-seo in ${seo}`);
    const code = await runInherit("git", ["-C", seo, "pull", "--ff-only"]);
    if (code !== 0) console.warn("git pull failed; keeping the current version");
  } else if (existsSync(join(seo, ".claude-plugin", "plugin.json"))) {
    console.log(`claude-seo found at ${seo} (not a git checkout; leaving it as is)`);
  } else {
    console.log(`Cloning claude-seo into ${seo}`);
    const code = await runInherit("git", ["clone", "--depth", "1", CLAUDE_SEO_REPO, seo]);
    if (code !== 0) {
      console.error("Could not clone claude-seo. Is git installed and is github.com reachable?");
      return false;
    }
  }

  // 2. claude-seo managed Python runtime
  if (!opts.skipRuntime) {
    const launcher = claudeSeoLauncher(cfg);
    const args = ["setup", ...(opts.skipBrowser ? ["--skip-browser"] : [])];
    const code = process.platform === "win32" ? await runInherit("bash", [launcher, ...args]) : await runInherit(launcher, args);
    if (code !== 0) {
      console.error(`claude-seo runtime setup failed (exit ${code}). Python 3.10+ is required.`);
      ok = false;
    }
  }

  // 3. seo-autopilot plugin
  const target = join(baseDir(), "plugin");
  const src = cfg?.plugin_path ?? bundledPluginPath();
  if (src && existsSync(join(src, ".claude-plugin", "plugin.json"))) {
    if (src !== target) {
      rmSync(target, { recursive: true, force: true });
      cpSync(src, target, { recursive: true });
      console.log(`Installed seo-autopilot plugin into ${target}`);
    }
  } else if (existsSync(join(target, ".claude-plugin", "plugin.json"))) {
    console.log(`seo-autopilot plugin already at ${target}`);
  } else {
    console.error("Could not find the seo-autopilot plugin directory. Set plugin_path in runner.json or copy plugin/ to " + target);
    ok = false;
  }
  return ok;
}
