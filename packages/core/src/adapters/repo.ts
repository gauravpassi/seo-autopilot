/**
 * Repo adapter: sites whose SEO lives in a git repository (Next.js App/Pages Router, Astro,
 * static HTML) hosted on GitHub, usually deployed by Vercel/Netlify from the default branch.
 *
 * Claude edits files in a local checkout (runner spawns `claude -p ... --add-dir <checkout>`
 * with the repo-fix skill). This adapter does everything around that edit deterministically:
 *
 *   prepareCheckout → detectFramework / locate (map for Claude) → [Claude edits]
 *   → runBuild (optional) → commitAndOpenPR → waitForPreview → [verify on preview]
 *   → merge (if policy.repo_auto_merge and tier allows) → prStatus (next verify job)
 *   → revert (rollback)
 *
 * Single-change apply()/rollback() are intentionally unsupported: repo changes are batched
 * into one PR per apply job (ARCHITECTURE.md §3).
 *
 * Secrets: the GitHub token is passed to git only through GIT_CONFIG_* environment variables
 * (an `http.<origin>/.extraHeader`), never through argv, never into .git/config, and every
 * piece of git/API output that is logged or thrown is run through `sanitize()`.
 *
 * `read()` for repo sites: the source of truth for "before" is the live production page. The
 * runner should prefer its own page snapshot (core/page.ts) for "before"; `read()` here is a
 * minimal, dependency-free fallback that fetches the live page / site file from the site's own
 * host and extracts the value with regexes (title, meta description, canonical, robots meta,
 * h1, robots.txt, llms.txt). For other types it returns null.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ChangeType as ChangeTypeEnum } from "../schema";
import type {
  ApplyResult,
  ChangeRecord,
  ChangeType,
  ConnectionResult,
  ResourceRef,
  SiteAdapter,
  Tier,
} from "../schema";
import type { AdapterContext } from "./index";

// ------------------------------------------------------------------ public types

export type RepoFramework = "nextjs-app" | "nextjs-pages" | "astro" | "static" | "unknown";

export interface RepoAdapterOptions {
  /** Override the git remote (tests: file:///…/origin.git; GHE: https://ghe.example.com/o/r.git). */
  remoteUrl?: string;
  /** GitHub REST base. Default https://api.github.com. GHE: https://ghe.example.com/api/v3. */
  apiBase?: string;
  /**
   * Site policy `repo_auto_merge` (AdapterContext has no policy). When true, testConnection
   * escalates "base branch requires reviews" from an info note to a warning.
   */
  repoAutoMerge?: boolean;
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock (tests; branch names). */
  now?: () => Date;
  /** git executable. Default "git". */
  gitBin?: string;
}

export interface CheckoutInfo {
  dir: string;
  branch: string;
  baseSha: string;
}

export interface FrameworkInfo {
  framework: RepoFramework;
  seoFiles: string[];
}

export interface LocateResult {
  file?: string;
  hint: string;
}

export interface OpenPRResult {
  prNumber: number;
  prUrl: string;
  headSha: string;
  filesChanged: string[];
}

export interface PreviewResult {
  url: string | null;
  /** success | failure | error | inactive | timeout | none */
  state: string;
}

export interface PRStatus {
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
  mergeSha: string | null;
  headSha?: string;
  url?: string;
  title?: string;
}

export interface RepoAdapter extends SiteAdapter {
  prepareCheckout(opts: { jobId: string }): Promise<CheckoutInfo>;
  detectFramework(dir: string): Promise<FrameworkInfo>;
  locate(dir: string, change: Pick<ChangeRecord, "type" | "target" | "after">): Promise<LocateResult>;
  runBuild(dir: string, command?: string): Promise<{ ok: boolean; output: string }>;
  commitAndOpenPR(opts: {
    dir: string;
    branch: string;
    changes: ChangeRecord[];
    title?: string;
  }): Promise<OpenPRResult>;
  waitForPreview(opts: { headSha: string; timeoutMs?: number; pollMs?: number }): Promise<PreviewResult>;
  merge(prNumber: number, headSha: string): Promise<{ merged: boolean; sha: string }>;
  revert(opts: { prNumber: number; autoMerge?: boolean }): Promise<{ prUrl: string; prNumber: number; merged: boolean }>;
  prStatus(prNumber: number): Promise<PRStatus>;
}

// ------------------------------------------------------------------ constants

const AUTHOR_NAME = "SEO Autopilot";
const AUTHOR_EMAIL = "seo-autopilot@users.noreply.github.com";
const BRANCH_PREFIX = "seo-autopilot/";
const CLONE_DEPTH = 50;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_TAIL = 4000;

const WALK_IGNORE = new Set([
  ".git", "node_modules", ".next", ".vercel", ".astro", ".turbo", ".cache", "coverage",
  "dist", "build", "out", ".output", ".svelte-kit", "vendor", ".netlify",
]);
const WALK_MAX_FILES = 20000;
const SEO_FILES_MAX = 400;

/** Paths never committed, wherever they appear (basename or full-path regexes). */
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /(^|\/)\.env(\.[^/]*)?$/i, why: "environment file" },
  { re: /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg)$/i, why: "key/certificate file" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, why: "SSH key" },
  { re: /secret/i, why: "secrets file" },
  { re: /(^|\/)credentials?([._-][^/]*)?$/i, why: "credentials file" },
  { re: /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i, why: "credential config" },
  { re: /(^|\/)\.github\/workflows\//i, why: "CI workflow (out of scope for SEO fixes)" },
  { re: /(^|\/)\.git(\/|$)/, why: "git internals" },
];
/** Generated paths silently left unstaged if a repo doesn't gitignore them. */
const SKIP_PREFIXES = ["node_modules/", ".next/", ".vercel/", ".astro/", ".turbo/"];

const SITE_FILE_TYPES = new Set<ChangeType>(["robots_txt", "llms_txt", "redirect"]);
const METADATA_TYPES = new Set<ChangeType>([
  "title", "meta_description", "canonical", "robots_meta", "og_tags", "hreflang",
]);

const METADATA_RE =
  /export\s+(?:const\s+metadata\b|(?:async\s+)?function\s+generateMetadata\b|const\s+generateMetadata\b|\{[^}]*\b(?:metadata|generateMetadata)\b[^}]*\})/;

// ------------------------------------------------------------------ helpers (exported for tests)

export function branchName(jobId: string, now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  const id = jobId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "job";
  return `${BRANCH_PREFIX}${d}-${id}`;
}

/**
 * Split a build command into argv without a shell. Supports single/double quotes and
 * backslash escapes; refuses shell operators so `config.build_command` can't chain commands.
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ""; has = false; }
      continue;
    }
    if (/[;&|<>`$(){}*?!#\n]/.test(c)) {
      throw new Error(`Build command contains shell syntax "${c}"; use a package.json script instead`);
    }
    cur += c;
    has = true;
  }
  if (quote) throw new Error("Build command has an unterminated quote");
  if (has) out.push(cur);
  if (!out.length) throw new Error("Build command is empty");
  return out;
}

export function forbiddenReason(relPath: string): string | null {
  for (const { re, why } of FORBIDDEN_PATTERNS) if (re.test(relPath)) return why;
  return null;
}

function tail(s: string, n = OUTPUT_TAIL): string {
  return s.length > n ? "…" + s.slice(s.length - n) : s;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname) || "/";
  } catch {
    return url.startsWith("/") ? url : "/" + url;
  }
}

function pathSegments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string, max = 512 * 1024): Promise<string> {
  try {
    const fh = await fs.open(p, "r");
    try {
      const buf = Buffer.alloc(max);
      const { bytesRead } = await fh.read(buf, 0, max, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

/** Repo-relative POSIX file list, skipping build output and dependencies. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < WALK_MAX_FILES) {
    const rel = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!WALK_IGNORE.has(e.name)) stack.push(r);
      } else if (e.isFile()) {
        out.push(r);
        if (out.length >= WALK_MAX_FILES) break;
      }
    }
  }
  return out.sort();
}

function fence(s: string, lang = ""): string {
  const runs = s.match(/`+/g) ?? [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const f = "`".repeat(n);
  return `${f}${lang}\n${s}\n${f}`;
}

function show(v: unknown, max = 600): string {
  if (v === null || v === undefined || v === "") return "(none)";
  let s: string;
  if (typeof v === "string") s = v;
  else {
    const obj = v as Record<string, unknown>;
    // common payload shape { value }
    if (obj && typeof obj === "object" && Object.keys(obj).length === 1 && typeof obj.value === "string") s = obj.value;
    else s = JSON.stringify(v, null, 2);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const TIER_ORDER: Record<Tier, number> = { auto: 0, approve: 1, never: 2 };

/** Verification checklist lines per change type (docs/research B4). */
const CHECKLIST: Partial<Record<ChangeType, string>> = {
  title: "Exactly one `<title>` in raw HTML on the preview; value matches; length sane",
  meta_description: 'Exactly one `<meta name="description">` on the preview; value matches',
  h1: "Exactly one `<h1>` with the intended text",
  canonical: "One absolute `<link rel=canonical>`; target returns 200 and is indexable",
  robots_meta: "Robots meta only on the intended URLs (ignore Vercel's preview `X-Robots-Tag: noindex`)",
  og_tags: "`og:*` tags present with intended values; og:image URL returns 200",
  image_alt: "Target `<img>` has the intended `alt`",
  jsonld_add: "JSON-LD parses; Rich Results Test / schema validator report 0 errors; values match visible text",
  jsonld_fix: "JSON-LD parses; no duplicate conflicting entities; validator reports 0 errors",
  redirect: "Old path returns 308/301 in one hop to a 200, indexable target; no loops (also with trailing slash and query)",
  robots_txt: "`/robots.txt` returns 200 text/plain; sitemap and top URLs still allowed",
  llms_txt: "`/llms.txt` returns 200 with the intended content",
  hreflang: "Alternates are reciprocal, absolute, and return 200",
  content_edit: "Edited text renders as intended; no layout breakage",
  internal_link: "Link renders with intended anchor and target (200)",
  code_change: "Build passes; sample pages from affected routes show only the intended SEO diffs",
};

// ------------------------------------------------------------------ errors

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "GitHubError";
  }
}

// ------------------------------------------------------------------ factory

export function createRepoAdapter(ctx: AdapterContext, opts: RepoAdapterOptions = {}): RepoAdapter {
  const doFetch: typeof fetch = ctx.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const gitBin = opts.gitBin ?? "git";
  const apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const config = ctx.site.config ?? {};
  const baseBranch = config.branch ?? "main";

  const secrets = ctx.secrets;
  const token = secrets.platform === "repo" ? secrets.github_token : "";

  const repoFull = config.repo ?? "";
  const repoValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFull);

  function requireRepo(): string {
    if (!repoValid) throw new Error(`Site config "repo" must be "owner/name" (got "${repoFull}")`);
    if (!token) throw new Error("Repo site secrets are missing github_token");
    return repoFull;
  }

  const remoteUrl =
    opts.remoteUrl ??
    (() => {
      const host = apiBase === "https://api.github.com" ? "https://github.com" : new URL(apiBase).origin;
      return `${host}/${repoFull}.git`;
    })();

  const b64Basic = token ? Buffer.from(`x-access-token:${token}`).toString("base64") : "";

  function sanitize(s: string): string {
    if (!s) return s;
    let out = s;
    for (const secret of [token, b64Basic]) {
      if (secret && secret.length >= 4) out = out.split(secret).join("***");
    }
    return out
      .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, "***")
      .replace(/(AUTHORIZATION:\s*(?:basic|bearer|token)\s+)\S+/gi, "$1***")
      .replace(/(https?:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/g, "$1***@");
  }

  const log = (level: "debug" | "info" | "warn" | "error", msg: string) => ctx.log(level, sanitize(msg));

  // -------------------------------------------------------------- git

  /** Env for git: no prompts, no global hooks surprises, and (for network ops) the auth header. */
  function gitEnv(withAuth: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
      LC_ALL: "C",
    };
    const keys: Array<[string, string]> = [
      ["commit.gpgsign", "false"],
      ["core.hooksPath", "/dev/null"],
      ["advice.detachedHead", "false"],
    ];
    if (withAuth && token && /^https?:/i.test(remoteUrl)) {
      const origin = new URL(remoteUrl).origin;
      keys.push([`http.${origin}/.extraHeader`, `AUTHORIZATION: basic ${b64Basic}`]);
      keys.push(["credential.helper", ""]);
    }
    // Append to any GIT_CONFIG_COUNT the parent already set.
    const start = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
    keys.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${start + i}`] = k;
      env[`GIT_CONFIG_VALUE_${start + i}`] = v;
    });
    env.GIT_CONFIG_COUNT = String(start + keys.length);
    return env;
  }

  function git(
    cwd: string,
    args: string[],
    o: { auth?: boolean; allowFail?: boolean; timeout?: number } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        gitBin,
        args,
        { cwd, env: gitEnv(!!o.auth), timeout: o.timeout ?? GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
          const res = { code, stdout: String(stdout), stderr: String(stderr) };
          if (err && !o.allowFail) {
            reject(
              new Error(
                sanitize(`git ${args[0]} failed (exit ${code}): ${tail((res.stderr || res.stdout || err.message).trim(), 2000)}`),
              ),
            );
          } else resolve(res);
        },
      );
    });
  }

  const checkoutDir = () => {
    if (!ctx.workDir) throw new Error("Repo adapter needs ctx.workDir for the git checkout");
    return path.join(ctx.workDir, "repo");
  };

  /** Clone or refresh `<workDir>/repo` to origin/<base>; returns dir and base sha. Leaves HEAD detached at base. */
  async function syncBase(): Promise<{ dir: string; baseSha: string }> {
    requireRepo();
    const dir = checkoutDir();
    const refspec = `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`;
    if (await exists(path.join(dir, ".git"))) {
      log("info", `Refreshing checkout ${dir} (${baseBranch})`);
      await git(dir, ["remote", "set-url", "origin", remoteUrl]);
      await git(dir, ["merge", "--abort"], { allowFail: true });
      await git(dir, ["revert", "--abort"], { allowFail: true });
      await git(dir, ["cherry-pick", "--abort"], { allowFail: true });
      await git(dir, ["fetch", "--no-tags", "--prune", `--depth=${CLONE_DEPTH}`, "origin", refspec], { auth: true });
      await git(dir, ["checkout", "--force", "--detach", `origin/${baseBranch}`]);
      await git(dir, ["reset", "--hard", `origin/${baseBranch}`]);
      // Remove untracked files from earlier runs but keep ignored ones (node_modules) for speed.
      await git(dir, ["clean", "-fd"]);
    } else {
      log("info", `Cloning ${repoFull} (${baseBranch}, depth ${CLONE_DEPTH})`);
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.rm(dir, { recursive: true, force: true });
      await git(path.dirname(dir), [
        "clone", "--no-tags", `--depth=${CLONE_DEPTH}`, "--single-branch", "--branch", baseBranch, remoteUrl, dir,
      ], { auth: true });
      await git(dir, ["checkout", "--detach", `origin/${baseBranch}`]);
    }
    const baseSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    return { dir, baseSha };
  }

  async function pushBranch(dir: string, branch: string): Promise<void> {
    if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`Refusing to push non-${BRANCH_PREFIX} branch ${branch}`);
    // Our own branches only: force is safe (re-runs of the same job reuse the name).
    await git(dir, ["push", "--force", "--no-verify", "origin", `HEAD:refs/heads/${branch}`], { auth: true });
  }

  // -------------------------------------------------------------- GitHub REST

  async function gh<T = any>(
    method: string,
    p: string,
    body?: unknown,
    o: { allow?: number[] } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    requireRepo();
    const url = `${apiBase}${p}`;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "seo-autopilot",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      // Primary/secondary rate limits: honour retry-after / reset, up to 3 retries, ≤ 60 s each.
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = res.headers.get("retry-after");
      const limited =
        (res.status === 429 || res.status === 403) &&
        (retryAfter !== null || remaining === "0" || /rate limit/i.test(String(data?.message ?? "")));
      if (limited && attempt < 3) {
        let waitMs = retryAfter ? Number(retryAfter) * 1000 : 0;
        const reset = res.headers.get("x-ratelimit-reset");
        if (!waitMs && reset) waitMs = Number(reset) * 1000 - Date.now();
        waitMs = Math.min(Math.max(waitMs || 5000, 1000), 60000);
        log("warn", `GitHub rate limit on ${method} ${p}; waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok && !(o.allow ?? []).includes(res.status)) {
        const msg = typeof data === "object" && data?.message ? data.message : String(text).slice(0, 300);
        throw new GitHubError(sanitize(`GitHub ${method} ${p} → ${res.status}: ${msg}`), res.status, data);
      }
      return { status: res.status, data: data as T, headers: res.headers };
    }
  }

  const repoPath = () => `/repos/${requireRepo()}`;
  const owner = () => requireRepo().split("/")[0];

  async function findOpenPR(branch: string): Promise<{ number: number; html_url: string } | null> {
    const { data } = await gh<any[]>(
      "GET",
      `${repoPath()}/pulls?state=open&head=${encodeURIComponent(`${owner()}:${branch}`)}&per_page=5`,
    );
    return Array.isArray(data) && data.length ? data[0] : null;
  }

  async function openOrUpdatePR(branch: string, title: string, body: string): Promise<{ number: number; html_url: string }> {
    const existing = await findOpenPR(branch);
    if (existing) {
      await gh("PATCH", `${repoPath()}/pulls/${existing.number}`, { title, body });
      log("info", `Updated existing PR #${existing.number}`);
      return existing;
    }
    const { data } = await gh<any>("POST", `${repoPath()}/pulls`, {
      title, head: branch, base: baseBranch, body, draft: false,
    });
    log("info", `Opened PR #${data.number} ${data.html_url}`);
    return data;
  }

  async function addLabels(prNumber: number, labels: string[]): Promise<void> {
    try {
      await gh("POST", `${repoPath()}/issues/${prNumber}/labels`, { labels });
    } catch (e) {
      log("warn", `Could not add labels to PR #${prNumber}: ${(e as Error).message}`);
    }
  }

  // -------------------------------------------------------------- framework detection

  async function detectFramework(dir: string): Promise<FrameworkInfo> {
    const files = await walk(dir);
    const set = new Set(files);
    let pkg: any = {};
    try {
      pkg = JSON.parse(await readText(path.join(dir, "package.json")));
    } catch {
      pkg = {};
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const appRoot = ["app", "src/app"].find((r) => files.some((f) => f.startsWith(r + "/") && /\/(page|layout)\.[jt]sx?$/.test(f)));
    const pagesRoot = ["pages", "src/pages"].find((r) => files.some((f) => f.startsWith(r + "/") && /\.[jt]sx?$/.test(f)));
    const hasNextConfig = files.some((f) => /^next\.config\.(js|cjs|mjs|ts)$/.test(f));
    const isNext = !!deps.next || hasNextConfig;
    const isAstro = !!deps.astro || files.some((f) => /^astro\.config\.(js|cjs|mjs|ts)$/.test(f));

    let framework: RepoFramework = "unknown";
    if (isNext && appRoot) framework = "nextjs-app";
    else if (isNext && pagesRoot) framework = "nextjs-pages";
    else if (isNext) framework = "nextjs-app";
    else if (isAstro) framework = "astro";
    else if (files.some((f) => f.endsWith(".html"))) framework = "static";

    const seo: string[] = [];
    const add = (f: string) => {
      if (!seo.includes(f) && seo.length < SEO_FILES_MAX) seo.push(f);
    };

    // Site-level files, any framework.
    for (const f of files) {
      if (
        /^(src\/)?app\/(robots|sitemap|manifest)\.(ts|js|tsx|jsx|txt|xml)$/.test(f) ||
        /^(src\/)?app\/(opengraph-image|twitter-image|icon)\.[a-z]+$/.test(f) ||
        /^(public\/)?(robots\.txt|llms\.txt|llms-full\.txt|sitemap[^/]*\.xml)$/.test(f) ||
        /^next\.config\.(js|cjs|mjs|ts)$/.test(f) ||
        /^astro\.config\.(js|cjs|mjs|ts)$/.test(f) ||
        /^(vercel\.json|netlify\.toml|_redirects|public\/_redirects|\.htaccess|next-sitemap\.config\.[cm]?js)$/.test(f) ||
        /^(src\/)?(proxy|middleware)\.[jt]s$/.test(f) ||
        /^src\/pages\/(robots\.txt|sitemap[^/]*|llms\.txt)\.[jt]s$/.test(f)
      ) add(f);
    }

    if (framework === "nextjs-app" && appRoot) {
      for (const f of files) {
        if (!f.startsWith(appRoot + "/") || !/\/(layout|page|template)\.[jt]sx?$/.test(f)) continue;
        const text = await readText(path.join(dir, f));
        if (METADATA_RE.test(text) || text.includes("application/ld+json")) add(f);
      }
      // Root layout always matters (metadataBase, title template).
      for (const ext of ["tsx", "jsx", "ts", "js"]) if (set.has(`${appRoot}/layout.${ext}`)) add(`${appRoot}/layout.${ext}`);
    }
    if (framework === "nextjs-pages" || (isNext && pagesRoot)) {
      const pr = pagesRoot ?? "pages";
      for (const f of files) {
        if (new RegExp(`^${pr}/_(app|document)\\.[jt]sx?$`).test(f)) add(f);
      }
      for (const f of files) {
        if (!f.startsWith(pr + "/") || !/\.[jt]sx?$/.test(f) || f.startsWith(pr + "/api/")) continue;
        const text = await readText(path.join(dir, f));
        if (/next\/head|next-seo|application\/ld\+json/.test(text)) add(f);
      }
    }
    if (framework === "astro") {
      for (const f of files) {
        if (/^src\/(layouts|components)\/.*\.astro$/.test(f)) {
          const text = await readText(path.join(dir, f));
          if (/<head|<title|<meta\s|application\/ld\+json|<SEO\b/i.test(text)) add(f);
        }
      }
    }
    // Components shared by all frameworks (SEO.tsx, Seo.astro, head partials).
    for (const f of files) {
      if (/(^|\/)(seo|SEO|Seo|head|Head|meta|Meta)\.(tsx|jsx|astro|html|njk|liquid)$/.test(f)) add(f);
      if (/(^|\/)(_includes|partials|_layouts)\/[^/]*head[^/]*\.(html|njk|liquid|hbs)$/.test(f)) add(f);
    }
    if (framework === "static") {
      for (const f of files) if (f.endsWith(".html")) add(f);
    }
    return { framework, seoFiles: seo };
  }

  // -------------------------------------------------------------- route location

  type Seg = { kind: "static"; v: string } | { kind: "dyn" } | { kind: "catch" } | { kind: "optcatch" };

  function parseSeg(name: string): Seg {
    if (/^\[\[\.\.\..+\]\]$/.test(name)) return { kind: "optcatch" };
    if (/^\[\.\.\..+\]$/.test(name)) return { kind: "catch" };
    if (/^\[.+\]$/.test(name)) return { kind: "dyn" };
    return { kind: "static", v: name };
  }

  /** Score how well route segments match URL segments; -1 = no match. Static > dynamic > catch-all. */
  function matchScore(route: Seg[], url: string[]): number {
    let score = 0;
    for (let i = 0; i < route.length; i++) {
      const s = route[i];
      if (s.kind === "catch" || s.kind === "optcatch") {
        const rest = url.length - i;
        if (s.kind === "catch" && rest < 1) return -1;
        return score + 1;
      }
      if (i >= url.length) return -1;
      if (s.kind === "static") {
        if (s.v.toLowerCase() !== url[i].toLowerCase()) return -1;
        score += 100;
      } else score += 10;
    }
    return route.length === url.length ? score + 1000 : -1;
  }

  function bestMatch<T extends { segs: Seg[] }>(cands: T[], url: string[]): T | undefined {
    let best: T | undefined;
    let bestScore = -1;
    for (const c of cands) {
      const s = matchScore(c.segs, url);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  async function locateAppRoute(dir: string, files: string[], appRoot: string, segs: string[]) {
    const pages: Array<{ file: string; segs: Seg[]; dirs: string[] }> = [];
    for (const f of files) {
      if (!f.startsWith(appRoot + "/")) continue;
      const m = /^(.*)\/page\.(tsx|jsx|ts|js|mdx|md)$/.exec(f);
      if (!m) continue;
      const rel = m[1].slice(appRoot.length).split("/").filter(Boolean);
      if (rel.some((d) => d.startsWith("_") || d.startsWith("@") || d.startsWith("(."))) continue;
      const routeSegs = rel.filter((d) => !/^\(.*\)$/.test(d)).map(parseSeg);
      pages.push({ file: f, segs: routeSegs, dirs: rel });
    }
    const page = bestMatch(pages, segs);
    if (!page) return null;
    // Layouts from the page's segment up to app root.
    const layouts: string[] = [];
    for (let i = page.dirs.length; i >= 0; i--) {
      const d = [appRoot, ...page.dirs.slice(0, i)].join("/");
      for (const ext of ["tsx", "jsx", "ts", "js"]) {
        if (files.includes(`${d}/layout.${ext}`)) layouts.push(`${d}/layout.${ext}`);
      }
    }
    return { page: page.file, layouts };
  }

  async function locate(dir: string, change: Pick<ChangeRecord, "type" | "target" | "after">): Promise<LocateResult> {
    const { framework } = await detectFrameworkCached(dir);
    const files = await walk(dir);
    const has = (f: string) => files.includes(f);
    const first = (...cands: string[]) => cands.find(has);
    const type = change.type;
    const p = urlPath(change.target.url);
    const segs = pathSegments(p);
    const after = (change.after ?? {}) as Record<string, any>;

    // ---- site-level files
    if (type === "robots_txt") {
      const file = first(
        "app/robots.ts", "app/robots.js", "app/robots.txt", "src/app/robots.ts", "src/app/robots.js", "src/app/robots.txt",
        "src/pages/robots.txt.ts", "src/pages/robots.txt.js", "public/robots.txt", "static/robots.txt", "robots.txt",
      );
      if (file) {
        const dyn = /\.(ts|js)$/.test(file);
        return {
          file,
          hint: dyn
            ? `robots.txt is generated by ${file}; edit the returned rules so the output equals the requested content.`
            : `Replace the content of ${file} with the requested robots.txt.`,
        };
      }
      const target = framework === "static" ? "robots.txt" : "public/robots.txt";
      return { file: target, hint: `No robots source found; create ${target}.` };
    }
    if (type === "llms_txt") {
      const file = first("public/llms.txt", "static/llms.txt", "llms.txt", "src/pages/llms.txt.ts");
      if (file) return { file, hint: `Replace the content of ${file} with the requested llms.txt.` };
      const target = framework === "static" ? "llms.txt" : "public/llms.txt";
      return { file: target, hint: `No llms.txt found; create ${target} (served at /llms.txt).` };
    }
    if (type === "redirect") {
      const from = typeof after.from_path === "string" ? after.from_path : p;
      const nextCfg = first("next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs");
      if (nextCfg)
        return {
          file: nextCfg,
          hint: `Add { source: '${from}', destination: <to_url path>, permanent: true } to async redirects() in ${nextCfg} (permanent → 308). Keep existing entries; avoid chains.`,
        };
      const astroCfg = first("astro.config.mjs", "astro.config.ts", "astro.config.js");
      if (astroCfg) return { file: astroCfg, hint: `Add '${from}' to the redirects map in ${astroCfg} (status 301).` };
      const other = first("vercel.json", "_redirects", "public/_redirects", "netlify.toml", ".htaccess");
      if (other) return { file: other, hint: `Add a 301/308 redirect for ${from} in ${other}.` };
      return { hint: `No redirect config found; for Vercel add a "redirects" entry to vercel.json, for Netlify/Cloudflare use public/_redirects.` };
    }
    if (type === "code_change") {
      const hints: string[] = Array.isArray(after.files_hint) ? after.files_hint : [];
      const file = hints.map((h) => h.replace(/^\.?\//, "")).find(has);
      return { file, hint: file ? `Start with ${file}.` : `No hinted file exists; search the repo for the code described.` };
    }

    // ---- page-level elements
    if (framework === "nextjs-app") {
      const appRoot = ["app", "src/app"].find((r) => files.some((f) => f.startsWith(r + "/"))) ?? "app";
      const found = await locateAppRoute(dir, files, appRoot, segs);
      if (!found) return { hint: `No App Router page matches ${p} under ${appRoot}/ (check rewrites, proxy.ts or a catch-all).` };
      const chain = [found.page, ...found.layouts];
      const pageText = await readText(path.join(dir, found.page));
      const isClient = /^\s*(['"])use client\1/m.test(pageText.slice(0, 500));
      const defining: string[] = [];
      for (const f of chain) if (METADATA_RE.test(await readText(path.join(dir, f)))) defining.push(f);
      const notes: string[] = [`Route ${p} → ${found.page}; layouts (nearest first): ${found.layouts.join(", ") || "none"}.`];
      if (METADATA_TYPES.has(type)) {
        notes.push(
          defining.length
            ? `Metadata currently comes from: ${defining.join(", ")} (child overrides parent per top-level key; openGraph replaces wholesale).`
            : "No metadata export in the chain yet.",
        );
        if (type === "title") notes.push("Check the nearest layout's title.template; set the page's title so the rendered <title> equals the target (use title.absolute to bypass the template).");
        if (type === "canonical" || type === "hreflang") notes.push("Use alternates.{canonical,languages}; relative URLs need metadataBase in the root layout.");
        notes.push("A segment cannot export both metadata and generateMetadata; edit the existing one if present.");
        if (isClient) {
          notes.push(`${found.page} is a Client Component ('use client'): metadata must go in a server wrapper page or this segment's layout.`);
          return { file: found.layouts[0] ?? found.page, hint: notes.join(" ") };
        }
        return { file: found.page, hint: notes.join(" ") };
      }
      if (type === "jsonld_add" || type === "jsonld_fix") {
        let file = found.page;
        if (type === "jsonld_fix") {
          for (const f of chain) if ((await readText(path.join(dir, f))).includes("application/ld+json")) { file = f; break; }
        }
        notes.push("Render <script type=\"application/ld+json\" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\\\u003c') }} />.");
        return { file, hint: notes.join(" ") };
      }
      notes.push("The element may be rendered by an imported component; follow imports from the page.");
      return { file: found.page, hint: notes.join(" ") };
    }

    if (framework === "nextjs-pages") {
      const root = ["pages", "src/pages"].find((r) => files.some((f) => f.startsWith(r + "/"))) ?? "pages";
      const cands: Array<{ file: string; segs: Seg[] }> = [];
      for (const f of files) {
        if (!f.startsWith(root + "/") || f.startsWith(root + "/api/")) continue;
        const m = /^(.*)\.(tsx|jsx|ts|js|mdx|md)$/.exec(f.slice(root.length + 1));
        if (!m || /^_(app|document|error)$/.test(m[1]) || /^(404|500)$/.test(m[1])) continue;
        const parts = m[1].split("/");
        if (parts[parts.length - 1] === "index") parts.pop();
        cands.push({ file: f, segs: parts.map(parseSeg) });
      }
      const best = bestMatch(cands, segs);
      const app = first(`${root}/_app.tsx`, `${root}/_app.jsx`, `${root}/_app.js`, `${root}/_app.ts`);
      if (!best) return { file: undefined, hint: `No Pages Router file matches ${p}.` };
      const text = await readText(path.join(dir, best.file));
      const usesHead = /next\/head|next-seo|<SEO\b|<Seo\b/.test(text);
      return {
        file: best.file,
        hint:
          `Route ${p} → ${best.file}. ` +
          (usesHead ? "Edit its <Head>/<NextSeo>/<SEO> props. " : "Page has no <Head>; add one via next/head (use key props to dedupe). ") +
          (app ? `Site-wide defaults (DefaultSeo) live in ${app}.` : ""),
      };
    }

    if (framework === "astro") {
      const root = "src/pages";
      const cands: Array<{ file: string; segs: Seg[] }> = [];
      for (const f of files) {
        if (!f.startsWith(root + "/")) continue;
        const m = /^(.*)\.(astro|md|mdx|html)$/.exec(f.slice(root.length + 1));
        if (!m) continue;
        const parts = m[1].split("/");
        if (parts[parts.length - 1] === "index") parts.pop();
        if (parts.some((s) => s.startsWith("_"))) continue;
        cands.push({ file: f, segs: parts.map(parseSeg) });
      }
      const best = bestMatch(cands, segs);
      if (!best) return { hint: `No Astro page matches ${p}; it may come from a content collection (src/content/**).` };
      const text = await readText(path.join(dir, best.file));
      const layout = /import\s+\w+\s+from\s+['"]([^'"]*layouts?\/[^'"]+)['"]/.exec(text)?.[1];
      const dyn = best.segs.some((s) => s.kind !== "static");
      return {
        file: best.file,
        hint:
          `Route ${p} → ${best.file}.` +
          (layout ? ` Head tags are rendered by layout ${layout}; pass page-specific values as props/frontmatter rather than editing the layout.` : "") +
          (dyn ? " Dynamic route: per-entry values usually live in src/content/** frontmatter." : ""),
      };
    }

    // static / unknown: HTML files
    const rel = segs.join("/");
    const roots = ["", "public/", "docs/", "site/", "src/"];
    const cands: string[] = [];
    for (const r of roots) {
      if (!rel) cands.push(`${r}index.html`);
      else cands.push(`${r}${rel}`, `${r}${rel}.html`, `${r}${rel}/index.html`);
    }
    const file = first(...cands.filter((c) => c.endsWith(".html")));
    if (file) return { file, hint: `Edit the <head>/body of ${file} directly (check for a shared head partial first).` };
    return { hint: `No HTML file found for ${p}; look for a static-site generator template/front matter.` };
  }

  const fwCache = new Map<string, Promise<FrameworkInfo>>();
  function detectFrameworkCached(dir: string) {
    let p = fwCache.get(dir);
    if (!p) {
      p = detectFramework(dir);
      fwCache.set(dir, p);
      // Re-detect next time if files changed a lot; cache only for one tick of locate calls.
      setTimeout(() => fwCache.delete(dir), 30_000).unref?.();
    }
    return p;
  }

  // -------------------------------------------------------------- build

  function run(
    cwd: string,
    argv: string[],
    timeout: number,
  ): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      const [cmd, ...args] = argv;
      // Never hand the GitHub token to repo code; strip anything token-like from env.
      const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
      for (const k of Object.keys(env)) if (/GITHUB_TOKEN|GH_TOKEN|GIT_CONFIG_/.test(k)) delete env[k];
      execFile(cmd, args, { cwd, env, timeout, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        const output = sanitize(`${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`);
        if (err) {
          const reason = (err as { killed?: boolean }).killed ? `timed out after ${Math.round(timeout / 1000)}s` : err.message;
          resolve({ ok: false, output: `${output}\n[${argv.join(" ")}] ${sanitize(reason)}` });
        } else resolve({ ok: true, output });
      });
    });
  }

  async function runBuild(dir: string, command?: string): Promise<{ ok: boolean; output: string }> {
    const cmd = command ?? config.build_command;
    if (!cmd) return { ok: true, output: "No build command configured; skipped." };
    let argv: string[];
    try {
      argv = splitCommand(cmd);
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
    const deadline = Date.now() + BUILD_TIMEOUT_MS;
    let out = "";
    if ((await exists(path.join(dir, "package.json"))) && !(await exists(path.join(dir, "node_modules")))) {
      let install: string[];
      if (await exists(path.join(dir, "pnpm-lock.yaml"))) install = ["pnpm", "install", "--frozen-lockfile"];
      else if (await exists(path.join(dir, "yarn.lock"))) install = ["yarn", "install", "--frozen-lockfile"];
      else if (await exists(path.join(dir, "package-lock.json"))) install = ["npm", "ci", "--no-audit", "--no-fund"];
      else install = ["npm", "install", "--no-audit", "--no-fund"];
      log("info", `Installing dependencies: ${install.join(" ")}`);
      const r = await run(dir, install, Math.max(1000, deadline - Date.now()));
      out += `$ ${install.join(" ")}\n${r.output}\n`;
      if (!r.ok) return { ok: false, output: tail(out) };
    }
    log("info", `Running build: ${argv.join(" ")}`);
    const r = await run(dir, argv, Math.max(1000, deadline - Date.now()));
    out += `$ ${argv.join(" ")}\n${r.output}`;
    return { ok: r.ok, output: tail(out) };
  }

  // -------------------------------------------------------------- commit + PR

  async function changedPaths(dir: string): Promise<string[]> {
    const { stdout } = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const parts = stdout.split("\0").filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      const xy = entry.slice(0, 2);
      out.push(entry.slice(3));
      if (xy[0] === "R" || xy[0] === "C") out.push(parts[++i]); // rename source follows
    }
    return [...new Set(out)];
  }

  async function assertInsideRepo(dir: string, rel: string): Promise<string | null> {
    if (path.isAbsolute(rel) || rel.split("/").includes("..")) return "path escapes the repository";
    const abs = path.resolve(dir, rel);
    const root = await fs.realpath(dir);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) return "path escapes the repository";
    try {
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) {
        const target = path.resolve(path.dirname(abs), await fs.readlink(abs));
        let real = target;
        try { real = await fs.realpath(target); } catch { /* dangling */ }
        if (!real.startsWith(root + path.sep)) return "symlink points outside the repository";
      }
      const realParent = await fs.realpath(path.dirname(abs));
      if (realParent !== root && !realParent.startsWith(root + path.sep)) return "parent directory resolves outside the repository";
    } catch {
      /* deleted file: fine */
    }
    return null;
  }

  function buildPRBody(changes: ChangeRecord[], filesChanged: string[]): string {
    const lines: string[] = [];
    lines.push(`Automated SEO fixes by **SEO Autopilot** for ${ctx.site.url}.`);
    lines.push("");
    lines.push(`Approved changes: **${changes.length}** · Files: ${filesChanged.map((f) => `\`${f}\``).join(", ")}`);
    lines.push("");
    changes.forEach((c, i) => {
      lines.push(`### ${i + 1}. \`${c.type}\` — ${c.target.url}`);
      lines.push("");
      lines.push(`- **Change id:** \`${c.id}\``);
      lines.push(`- **Risk tier:** \`${c.tier}\`${c.risk_reasons?.length ? ` — ${c.risk_reasons.join("; ")}` : ""}`);
      if (c.rationale) lines.push(`- **Rationale:** ${c.rationale.replace(/\s+/g, " ").trim()}`);
      if (c.target.resource?.file) lines.push(`- **File:** \`${c.target.resource.file}\``);
      lines.push("");
      lines.push("**Before**");
      lines.push(fence(show(c.before)));
      lines.push("**After**");
      lines.push(fence(show(c.after)));
      lines.push("");
    });
    lines.push("## Verification checklist");
    lines.push("");
    lines.push("- [ ] Build / CI checks pass on this PR");
    lines.push("- [ ] Preview deployment is ready (preview `X-Robots-Tag: noindex` is expected and not a regression)");
    const seen = new Set<ChangeType>();
    for (const c of changes) {
      if (seen.has(c.type)) continue;
      seen.add(c.type);
      const item = CHECKLIST[c.type];
      if (item) lines.push(`- [ ] \`${c.type}\`: ${item}`);
    }
    lines.push("- [ ] Unrelated pages from the same templates show no SEO diffs");
    lines.push("- [ ] After merge: re-verified on production");
    lines.push("");
    lines.push("Rollback: SEO Autopilot opens a revert PR for this merge commit.");
    lines.push("");
    lines.push(`<!-- seo-autopilot change-ids: ${changes.map((c) => c.id).join(",")} -->`);
    return lines.join("\n");
  }

  async function commitAndOpenPR(o: {
    dir: string;
    branch: string;
    changes: ChangeRecord[];
    title?: string;
  }): Promise<OpenPRResult> {
    const { dir, branch, changes } = o;
    requireRepo();
    if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`Branch must start with ${BRANCH_PREFIX}`);
    if (!changes.length) throw new Error("commitAndOpenPR needs at least one change");

    const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (current !== branch) throw new Error(`Checkout is on "${current}", expected "${branch}"`);

    const all = await changedPaths(dir);
    const paths = all.filter((p) => !SKIP_PREFIXES.some((s) => p.startsWith(s)));
    const skipped = all.filter((p) => !paths.includes(p));
    if (skipped.length) log("warn", `Not committing generated paths: ${skipped.slice(0, 10).join(", ")}`);
    if (!paths.length) throw new Error("No changes to commit: the checkout has no modifications (Claude did not edit any file)");

    const refused: string[] = [];
    for (const p of paths) {
      const why = forbiddenReason(p) ?? (await assertInsideRepo(dir, p));
      if (why) refused.push(`${p} (${why})`);
    }
    if (refused.length) {
      throw new Error(`Refusing to commit: ${refused.join(", ")}. Revert those edits and retry.`);
    }

    await git(dir, ["add", "-A", "--", ...paths]);
    const staged = (await git(dir, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
    if (!staged.length) throw new Error("No changes to commit: staged diff is empty");

    const types = [...new Set(changes.map((c) => c.type))];
    const title =
      o.title ??
      `SEO Autopilot: ${changes.length} fix${changes.length === 1 ? "" : "es"} (${types.slice(0, 4).join(", ")}${types.length > 4 ? ", …" : ""})`;
    const commitBody = changes.map((c) => `- ${c.type} ${c.target.url} [${c.id}]`).join("\n");
    await git(dir, ["commit", "--no-verify", "-m", title, "-m", commitBody]);
    const headSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

    log("info", `Pushing ${branch} (${headSha.slice(0, 7)})`);
    await pushBranch(dir, branch);

    const pr = await openOrUpdatePR(branch, title, buildPRBody(changes, staged));
    const maxTier = changes.reduce<Tier>((t, c) => (TIER_ORDER[c.tier] > TIER_ORDER[t] ? c.tier : t), "auto");
    await addLabels(pr.number, ["seo-autopilot", `risk:${maxTier}`]);
    return { prNumber: pr.number, prUrl: pr.html_url, headSha, filesChanged: staged };
  }

  // -------------------------------------------------------------- preview

  async function waitForPreview(o: { headSha: string; timeoutMs?: number; pollMs?: number }): Promise<PreviewResult> {
    const timeoutMs = o.timeoutMs ?? 10 * 60 * 1000;
    const pollMs = o.pollMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    let sawAny = false;
    for (;;) {
      const { data: deployments } = await gh<any[]>(
        "GET",
        `${repoPath()}/deployments?sha=${encodeURIComponent(o.headSha)}&per_page=20`,
      );
      const list = (Array.isArray(deployments) ? deployments : [])
        // Prefer preview environments over production ones for the same sha.
        .sort((a, b) => Number(!!a.production_environment) - Number(!!b.production_environment));
      let allTerminalFailed = list.length > 0;
      let failState = "failure";
      for (const d of list) {
        sawAny = true;
        const { data: statuses } = await gh<any[]>("GET", `${repoPath()}/deployments/${d.id}/statuses?per_page=10`);
        const latest = Array.isArray(statuses) && statuses.length ? statuses[0] : null;
        const state: string = latest?.state ?? "pending";
        if (state === "success") {
          const url = latest.environment_url || latest.target_url || null;
          log("info", `Preview ready: ${url ?? "(no environment_url)"}`);
          return { url, state: "success" };
        }
        if (state === "failure" || state === "error") failState = state;
        else allTerminalFailed = false;
      }
      if (allTerminalFailed) return { url: null, state: failState };
      if (Date.now() + pollMs > deadline) return { url: null, state: sawAny ? "timeout" : "none" };
      await sleep(pollMs);
    }
  }

  // -------------------------------------------------------------- merge / status / revert

  async function prStatus(prNumber: number): Promise<PRStatus> {
    const { data } = await gh<any>("GET", `${repoPath()}/pulls/${prNumber}`);
    const merged = !!data.merged_at || data.merged === true;
    return {
      state: merged ? "merged" : data.state === "open" ? "open" : "closed",
      mergedAt: data.merged_at ?? null,
      mergeSha: merged ? data.merge_commit_sha ?? null : null,
      headSha: data.head?.sha,
      url: data.html_url,
      title: data.title,
    };
  }

  async function merge(prNumber: number, headSha: string): Promise<{ merged: boolean; sha: string }> {
    let pr: any;
    for (let i = 0; i < 6; i++) {
      pr = (await gh<any>("GET", `${repoPath()}/pulls/${prNumber}`)).data;
      if (pr.merged) return { merged: true, sha: pr.merge_commit_sha };
      if (pr.state !== "open") throw new Error(`PR #${prNumber} is ${pr.state}; cannot merge`);
      if (pr.head?.sha && pr.head.sha !== headSha)
        throw new Error(`PR #${prNumber} head moved (${String(pr.head.sha).slice(0, 7)} ≠ verified ${headSha.slice(0, 7)}); refusing to merge`);
      if (pr.mergeable === true) break;
      if (pr.mergeable === false) throw new Error(`PR #${prNumber} is not mergeable (conflicts or blocked: ${pr.mergeable_state})`);
      await sleep(2000);
    }
    try {
      const { data } = await gh<any>("PUT", `${repoPath()}/pulls/${prNumber}/merge`, {
        merge_method: "squash",
        sha: headSha,
        commit_title: `${pr?.title ?? "SEO Autopilot"} (#${prNumber})`,
      });
      log("info", `Merged PR #${prNumber} → ${data.sha}`);
      const branch: string | undefined = pr?.head?.ref;
      if (branch?.startsWith(BRANCH_PREFIX)) {
        await gh("DELETE", `${repoPath()}/git/refs/heads/${branch}`, undefined, { allow: [404, 422] }).catch(() => undefined);
      }
      return { merged: !!data.merged, sha: data.sha };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 405)
        throw new Error(`PR #${prNumber} cannot be merged by the agent (branch protection or required checks): ${e.message}`);
      if (e instanceof GitHubError && e.status === 409)
        throw new Error(`PR #${prNumber} head changed since verification; refusing to merge: ${e.message}`);
      throw e;
    }
  }

  async function revert(o: { prNumber: number; autoMerge?: boolean }): Promise<{ prUrl: string; prNumber: number; merged: boolean }> {
    const st = await prStatus(o.prNumber);
    if (st.state !== "merged" || !st.mergeSha) {
      throw new Error(`PR #${o.prNumber} is ${st.state}; only merged PRs can be reverted (close an open PR instead)`);
    }
    const sha = st.mergeSha;
    const { dir } = await syncBase();
    const has = async (ref: string) => (await git(dir, ["cat-file", "-e", `${ref}^{commit}`], { allowFail: true })).code === 0;
    if (!(await has(sha))) {
      await git(dir, ["fetch", "--no-tags", `--deepen=${CLONE_DEPTH * 4}`, "origin", baseBranch], { auth: true, allowFail: true });
      if (!(await has(sha))) await git(dir, ["fetch", "--no-tags", "--depth=2", "origin", sha], { auth: true });
    }
    const parents = (await git(dir, ["rev-list", "--parents", "-n", "1", sha])).stdout.trim().split(/\s+/).slice(1);
    if (parents.length && !(await has(parents[0]))) {
      await git(dir, ["fetch", "--no-tags", "--depth=2", "origin", sha], { auth: true });
    }
    const d = now().toISOString().slice(0, 10).replace(/-/g, "");
    const branch = `${BRANCH_PREFIX}revert-pr${o.prNumber}-${d}`;
    await git(dir, ["checkout", "-B", branch, `origin/${baseBranch}`]);
    const args = ["revert", "--no-edit", ...(parents.length > 1 ? ["-m", "1"] : []), sha];
    const r = await git(dir, args, { allowFail: true });
    if (r.code !== 0) {
      await git(dir, ["revert", "--abort"], { allowFail: true });
      throw new Error(
        sanitize(`Revert of ${sha.slice(0, 7)} (PR #${o.prNumber}) conflicts with later commits on ${baseBranch}; revert manually. ${tail(r.stderr || r.stdout, 800)}`),
      );
    }
    const headSha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    await pushBranch(dir, branch);
    const title = `Revert "${st.title ?? `PR #${o.prNumber}`}"`;
    const body = [
      `Reverts #${o.prNumber} (merge commit ${sha}) — opened by **SEO Autopilot** rollback.`,
      "",
      "- [ ] Preview shows the previous SEO values",
      "- [ ] After merge: production re-verified",
      "",
      `<!-- seo-autopilot revert-of: ${o.prNumber} -->`,
    ].join("\n");
    const pr = await openOrUpdatePR(branch, title, body);
    await addLabels(pr.number, ["seo-autopilot", "revert"]);
    let merged = false;
    if (o.autoMerge) merged = (await merge(pr.number, headSha)).merged;
    return { prUrl: pr.html_url, prNumber: pr.number, merged };
  }

  // -------------------------------------------------------------- SiteAdapter

  async function testConnection(): Promise<ConnectionResult> {
    const warnings: string[] = [];
    const details: Record<string, unknown> = { repo: repoFull, branch: baseBranch };
    if (!repoValid) return { ok: false, details, warnings: [`Site config "repo" must be "owner/name"`] };
    if (!token) return { ok: false, details, warnings: ["Missing github_token in site secrets"] };

    let repo: any;
    try {
      const r = await gh<any>("GET", repoPath());
      repo = r.data;
      const scopes = r.headers.get("x-oauth-scopes");
      if (scopes !== null && scopes !== "") {
        details.token_scopes = scopes;
        const s = scopes.split(",").map((x) => x.trim());
        if (!s.includes("repo") && !(s.includes("public_repo") && !repo.private))
          warnings.push(`Classic token scopes "${scopes}" lack "repo"; pushes will fail`);
        if (s.includes("workflow") || s.includes("admin:org") || s.includes("delete_repo"))
          warnings.push("Token has broader scopes than needed (workflow/admin); prefer a fine-grained PAT");
      }
    } catch (e) {
      const status = e instanceof GitHubError ? e.status : 0;
      return {
        ok: false,
        details: { ...details, status },
        warnings: [
          status === 404 ? `Repository ${repoFull} not found, or the token has no access to it`
            : status === 401 ? "GitHub rejected the token (expired or revoked)"
            : sanitize((e as Error).message),
        ],
      };
    }
    details.default_branch = repo.default_branch;
    details.private = repo.private;
    details.permissions = repo.permissions ?? null;
    details.html_url = repo.html_url;
    details.allow_squash_merge = repo.allow_squash_merge;
    let ok = true;
    if (repo.archived) { ok = false; warnings.push("Repository is archived (read-only)"); }
    if (!repo.permissions?.push) {
      ok = false;
      warnings.push("Token cannot push to this repository (needs Contents: read & write)");
    }
    if (repo.allow_squash_merge === false) warnings.push("Squash merging is disabled on this repo; the agent's merge step will fail");

    try {
      const { data: br } = await gh<any>("GET", `${repoPath()}/branches/${encodeURIComponent(baseBranch)}`);
      details.base_sha = br.commit?.sha;
      details.branch_protected = !!br.protected;
      let reviews: number | null = null;
      if (br.protected) {
        const prot = await gh<any>("GET", `${repoPath()}/branches/${encodeURIComponent(baseBranch)}/protection`, undefined, { allow: [403, 404] });
        if (prot.status === 200) reviews = prot.data?.required_pull_request_reviews?.required_approving_review_count ?? (prot.data?.required_pull_request_reviews ? 1 : 0);
      }
      const rules = await gh<any[]>("GET", `${repoPath()}/rules/branches/${encodeURIComponent(baseBranch)}`, undefined, { allow: [403, 404] });
      if (rules.status === 200 && Array.isArray(rules.data)) {
        for (const r of rules.data) {
          if (r.type === "pull_request") reviews = Math.max(reviews ?? 0, r.parameters?.required_approving_review_count ?? 0);
        }
      }
      details.required_reviews = reviews;
      if (reviews && reviews > 0) {
        const msg = `Branch ${baseBranch} requires ${reviews} approving review(s); the agent cannot self-merge PRs`;
        warnings.push(opts.repoAutoMerge ? `${msg} — repo_auto_merge will not work` : `${msg} (fine: PRs wait for a human merge)`);
      }
    } catch (e) {
      ok = false;
      warnings.push(
        e instanceof GitHubError && e.status === 404
          ? `Base branch "${baseBranch}" not found (default branch is "${repo.default_branch}")`
          : sanitize((e as Error).message),
      );
    }

    const pulls = await gh("GET", `${repoPath()}/pulls?state=open&per_page=1`, undefined, { allow: [403, 404] }).catch((e) => ({ status: (e as GitHubError).status ?? 0 }));
    if (pulls.status !== 200) {
      ok = false;
      warnings.push("Token cannot read pull requests (needs Pull requests: read & write)");
    }
    const deps = await gh("GET", `${repoPath()}/deployments?per_page=1`, undefined, { allow: [403, 404] }).catch((e) => ({ status: (e as GitHubError).status ?? 0 }));
    if (deps.status !== 200) warnings.push("Token cannot read deployments; preview URLs will be unavailable (grant Deployments: read)");

    return { ok, details, warnings };
  }

  async function capabilities(): Promise<ChangeType[]> {
    return ChangeTypeEnum.options.filter((t) => t !== "slug");
  }

  async function resolve(url: string, _type: ChangeType): Promise<ResourceRef | null> {
    return { kind: "route", id: urlPath(url) };
  }

  async function read(change: Pick<ChangeRecord, "type" | "target" | "after">): Promise<unknown> {
    let site: URL;
    let target: URL;
    try {
      site = new URL(ctx.site.url);
      target = new URL(change.target.url, site);
    } catch {
      return null;
    }
    if (target.host !== site.host) return null; // SSRF guard: only the site's own host
    const get = async (u: URL) => {
      const res = await doFetch(u.toString(), { headers: { "User-Agent": "SEO-Autopilot/1.0 (+repo read)" }, redirect: "follow" });
      return { status: res.status, text: await res.text() };
    };
    try {
      if (change.type === "robots_txt" || change.type === "llms_txt") {
        const r = await get(new URL(change.type === "robots_txt" ? "/robots.txt" : "/llms.txt", site));
        return r.status === 200 ? { content: r.text } : null;
      }
      const supported: ChangeType[] = ["title", "meta_description", "canonical", "h1", "robots_meta"];
      if (!supported.includes(change.type)) return null;
      const { status, text } = await get(target);
      if (status >= 400) return null;
      const head = text.slice(0, 500_000);
      const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "is").exec(tag)?.[2] ?? null;
      const metaBy = (key: string, val: string) => {
        for (const m of head.matchAll(/<meta\b[^>]*>/gi)) if ((attr(m[0], key) ?? "").toLowerCase() === val) return attr(m[0], "content");
        return null;
      };
      const decode = (s: string) =>
        s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ").trim();
      switch (change.type) {
        case "title": {
          const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
          return m ? { value: decode(m[1]) } : null;
        }
        case "meta_description": {
          const v = metaBy("name", "description");
          return v !== null ? { value: decode(v) } : null;
        }
        case "canonical": {
          for (const m of head.matchAll(/<link\b[^>]*>/gi)) if ((attr(m[0], "rel") ?? "").toLowerCase() === "canonical") {
            const href = attr(m[0], "href");
            return href ? { value: new URL(decode(href), target).toString() } : null;
          }
          return null;
        }
        case "h1": {
          const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(head);
          return m ? { value: decode(m[1].replace(/<[^>]+>/g, "")) } : null;
        }
        case "robots_meta": {
          const v = (metaBy("name", "robots") ?? "").toLowerCase();
          if (!v) return null;
          return { index: !/\bnoindex\b|\bnone\b/.test(v), follow: !/\bnofollow\b|\bnone\b/.test(v) };
        }
      }
    } catch (e) {
      log("warn", `read(${change.type}) failed: ${(e as Error).message}`);
    }
    return null;
  }

  const batchOnly = () => {
    throw new Error("Repo changes are applied in batches; use prepareCheckout + commitAndOpenPR");
  };

  return {
    platform: "repo",
    capabilities,
    testConnection,
    resolve,
    read,
    async apply(_c: ChangeRecord): Promise<ApplyResult> {
      return batchOnly();
    },
    async rollback(_c: ChangeRecord): Promise<void> {
      return batchOnly();
    },

    async prepareCheckout({ jobId }) {
      const { dir, baseSha } = await syncBase();
      const branch = branchName(jobId, now());
      await git(dir, ["checkout", "-B", branch]);
      log("info", `Checkout ready on ${branch} at ${baseSha.slice(0, 7)}`);
      fwCache.delete(dir);
      return { dir, branch, baseSha };
    },
    detectFramework: (dir) => {
      fwCache.delete(dir);
      return detectFrameworkCached(dir);
    },
    locate,
    runBuild,
    commitAndOpenPR,
    waitForPreview,
    merge,
    revert,
    prStatus,
  };
}
