import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { branchName, createRepoAdapter, forbiddenReason, splitCommand } from "../src/adapters/repo";
import type { AdapterContext } from "../src/adapters/index";
import type { ChangeRecord } from "../src/schema";

const TOKEN = "test-token-not-a-real-github-token-0001";
const API = "https://api.test";
const NOW = new Date("2026-10-06T10:00:00Z");

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...process.env, ...ID },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, rel: string, content: string) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fx", dependencies: { next: "16.0.0", react: "19.0.0" } }),
  "next.config.ts": "export default { async redirects() { return []; } };\n",
  "app/layout.tsx":
    "export const metadata = { title: { template: '%s | Acme', default: 'Acme' }, metadataBase: new URL('https://acme.test') };\nexport default function L({children}){return <html><body>{children}</body></html>}\n",
  "app/page.tsx": "export default function P(){return <h1>Home</h1>}\n",
  "app/robots.ts": "export default function robots(){return {rules:{userAgent:'*',allow:'/'}}}\n",
  "app/(marketing)/about/page.tsx": "export const metadata = { title: 'About' };\nexport default function A(){return <h1>About</h1>}\n",
  "app/blog/layout.tsx": "export default function BL({children}){return children}\n",
  "app/blog/[slug]/page.tsx":
    "export async function generateMetadata({ params }){ return { title: 'Post' } }\nexport default function B(){return <article/>}\n",
  "app/blog/featured/page.tsx": "'use client';\nexport default function F(){return <div/>}\n",
  "app/_components/Nav.tsx": "export const metadata = 1;\n",
  "public/llms.txt": "# Acme\n",
  ".gitignore": "node_modules\n.next\n",
};

// ------------------------------------------------------------------ GitHub API mock

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
type Route = (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function mockFetch(routes: Route[], calls: Call[]): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const call: Call = {
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname + url.search,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) {
        return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
          status: res.status ?? 200,
          headers: { "content-type": "application/json", ...(res.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ message: `unmocked ${call.method} ${call.path}` }), { status: 404 });
  }) as typeof fetch;
}

const on = (method: string, p: string | RegExp, res: ReturnType<Route> | ((c: Call) => ReturnType<Route>)): Route => (c) => {
  if (c.method !== method) return undefined;
  const pathOnly = c.path.split("?")[0];
  if (typeof p === "string" ? pathOnly !== p : !p.test(c.path)) return undefined;
  return typeof res === "function" ? res(c) : res;
};

// ------------------------------------------------------------------ fixture repos

let tmp: string;
let originDir: string;
let originUrl: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "repo-adapter-"));
  const seed = path.join(tmp, "seed");
  mkdirSync(seed);
  for (const [f, c] of Object.entries(FIXTURE)) write(seed, f, c);
  g(seed, "init", "-q", "-b", "main");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "init");
  originDir = path.join(tmp, "origin.git");
  g(tmp, "clone", "-q", "--bare", seed, originDir);
  originUrl = "file://" + originDir;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(fetchImpl: typeof fetch, logs: string[], workDir: string): AdapterContext {
  return {
    site: { id: "site-1", url: "https://acme.test", platform: "repo", config: { repo: "acme/web", branch: "main" } },
    secrets: { platform: "repo", github_token: TOKEN },
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    fetch: fetchImpl,
    workDir,
  };
}

function change(partial: Partial<ChangeRecord> & Pick<ChangeRecord, "type">): ChangeRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    site_id: "site-1",
    target: { url: "https://acme.test/about" },
    before: { value: "About | Acme" },
    after: { value: "About Acme — Industrial Widgets" },
    tier: "approve",
    risk_reasons: ["Rewrites a title link Google shows in results"],
    status: "approved",
    diff_hash: "x",
    rationale: "Title is generic",
    ...partial,
  };
}

let calls: Call[];
let logs: string[];
let workDir: string;
beforeEach(() => {
  calls = [];
  logs = [];
  workDir = mkdtempSync(path.join(tmp, "work-"));
});

const optsFor = () => ({ remoteUrl: originUrl, apiBase: API, sleep: async () => {}, now: () => NOW });

// ------------------------------------------------------------------ tests

describe("helpers", () => {
  it("branchName", () => {
    expect(branchName("abcdef12-3456-7890", NOW)).toBe("seo-autopilot/20261006-abcdef12");
  });
  it("splitCommand splits safely and refuses shell syntax", () => {
    expect(splitCommand(`npm run "build site" --x='a b'`)).toEqual(["npm", "run", "build site", "--x=a b"]);
    expect(() => splitCommand("npm run build && rm -rf /")).toThrow(/shell syntax/);
    expect(() => splitCommand("echo $(id)")).toThrow(/shell syntax/);
  });
  it("forbiddenReason", () => {
    expect(forbiddenReason(".env")).toBeTruthy();
    expect(forbiddenReason("apps/web/.env.local")).toBeTruthy();
    expect(forbiddenReason("certs/server.pem")).toBeTruthy();
    expect(forbiddenReason("config/secrets.json")).toBeTruthy();
    expect(forbiddenReason(".github/workflows/ci.yml")).toBeTruthy();
    expect(forbiddenReason("app/page.tsx")).toBeNull();
    expect(forbiddenReason("environment.ts")).toBeNull();
  });
});

describe("SiteAdapter surface", () => {
  it("capabilities excludes slug; apply/rollback throw; resolve returns route", async () => {
    const a = createRepoAdapter(makeCtx(mockFetch([], calls), logs, workDir), optsFor());
    const caps = await a.capabilities();
    expect(caps).not.toContain("slug");
    expect(caps).toContain("code_change");
    expect(caps).toContain("title");
    await expect(a.apply(change({ type: "title" }))).rejects.toThrow(/batches/);
    await expect(a.rollback(change({ type: "title" }))).rejects.toThrow(/batches/);
    expect(await a.resolve("https://acme.test/blog/hello?x=1", "title")).toEqual({ kind: "route", id: "/blog/hello" });
  });

  it("read extracts title from the live page and refuses other hosts", async () => {
    const f = (async (u: any) => {
      calls.push({ method: "GET", path: String(u), body: undefined, headers: {} });
      return new Response(`<html><head><title>About &amp; Us | Acme</title><meta content="Desc" name="description"></head><body><h1>Hi <b>there</b></h1></body></html>`);
    }) as typeof fetch;
    const a = createRepoAdapter(makeCtx(f, logs, workDir), optsFor());
    expect(await a.read({ type: "title", target: { url: "https://acme.test/about" }, after: {} })).toEqual({ value: "About & Us | Acme" });
    expect(await a.read({ type: "meta_description", target: { url: "https://acme.test/about" }, after: {} })).toEqual({ value: "Desc" });
    expect(await a.read({ type: "h1", target: { url: "https://acme.test/about" }, after: {} })).toEqual({ value: "Hi there" });
    expect(await a.read({ type: "title", target: { url: "https://evil.test/" }, after: {} })).toBeNull();
    expect(await a.read({ type: "jsonld_add", target: { url: "https://acme.test/" }, after: {} })).toBeNull();
  });
});

describe("checkout, framework, locate", () => {
  it("prepareCheckout clones and creates the branch; re-run refreshes", async () => {
    const a = createRepoAdapter(makeCtx(mockFetch([], calls), logs, workDir), optsFor());
    const co = await a.prepareCheckout({ jobId: "abcdef12-0000-0000-0000-000000000000" });
    expect(co.dir).toBe(path.join(workDir, "repo"));
    expect(co.branch).toBe("seo-autopilot/20261006-abcdef12");
    expect(g(co.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(co.branch);
    expect(co.baseSha).toBe(g(originDir, "rev-parse", "main"));
    // token never written to .git/config
    expect(readFileSync(path.join(co.dir, ".git", "config"), "utf8")).not.toContain(TOKEN);

    // dirty the tree, re-run: should reset cleanly
    write(co.dir, "app/page.tsx", "dirty");
    write(co.dir, "untracked.txt", "x");
    const co2 = await a.prepareCheckout({ jobId: "bbbbbbbb-0000" });
    expect(co2.branch).toBe("seo-autopilot/20261006-bbbbbbbb");
    expect(readFileSync(path.join(co2.dir, "app/page.tsx"), "utf8")).toBe(FIXTURE["app/page.tsx"]);
    expect(existsSync(path.join(co2.dir, "untracked.txt"))).toBe(false);
  });

  it("detectFramework maps a Next App Router tree", async () => {
    const a = createRepoAdapter(makeCtx(mockFetch([], calls), logs, workDir), optsFor());
    const { dir } = await a.prepareCheckout({ jobId: "fw" });
    const fw = await a.detectFramework(dir);
    expect(fw.framework).toBe("nextjs-app");
    expect(fw.seoFiles).toEqual(
      expect.arrayContaining([
        "app/layout.tsx", "app/(marketing)/about/page.tsx", "app/blog/[slug]/page.tsx",
        "app/robots.ts", "public/llms.txt", "next.config.ts",
      ]),
    );
    expect(fw.seoFiles).not.toContain("app/page.tsx");
    expect(fw.seoFiles).not.toContain("app/_components/Nav.tsx");
  });

  it("locate resolves routes, route groups, dynamic segments and site files", async () => {
    const a = createRepoAdapter(makeCtx(mockFetch([], calls), logs, workDir), optsFor());
    const { dir } = await a.prepareCheckout({ jobId: "loc" });
    const L = (type: ChangeRecord["type"], url: string, after: unknown = {}) => a.locate(dir, { type, target: { url }, after });

    const about = await L("title", "https://acme.test/about");
    expect(about.file).toBe("app/(marketing)/about/page.tsx");
    expect(about.hint).toMatch(/template/);

    const post = await L("meta_description", "https://acme.test/blog/hello-world");
    expect(post.file).toBe("app/blog/[slug]/page.tsx");
    expect(post.hint).toContain("app/blog/layout.tsx");

    // static segment beats dynamic; client page → metadata goes to the layout
    const featured = await L("title", "https://acme.test/blog/featured");
    expect(featured.file).toBe("app/blog/layout.tsx");
    expect(featured.hint).toMatch(/Client Component/);

    expect((await L("h1", "https://acme.test/")).file).toBe("app/page.tsx");
    expect((await L("robots_txt", "https://acme.test/robots.txt")).file).toBe("app/robots.ts");
    expect((await L("llms_txt", "https://acme.test/llms.txt")).file).toBe("public/llms.txt");
    const red = await L("redirect", "https://acme.test/old", { from_path: "/old", to_url: "https://acme.test/new", code: 301 });
    expect(red.file).toBe("next.config.ts");
    expect(red.hint).toContain("/old");
    expect((await L("title", "https://acme.test/nope/deep")).file).toBeUndefined();
  });
});

describe("commitAndOpenPR", () => {
  it("refuses an empty diff and .env files", async () => {
    const a = createRepoAdapter(makeCtx(mockFetch([], calls), logs, workDir), optsFor());
    const co = await a.prepareCheckout({ jobId: "empty000" });
    await expect(a.commitAndOpenPR({ ...co, changes: [change({ type: "title" })] })).rejects.toThrow(/No changes to commit/);

    write(co.dir, "app/(marketing)/about/page.tsx", "export const metadata = { title: 'New' };\n");
    write(co.dir, ".env.local", "SECRET=1\n");
    await expect(a.commitAndOpenPR({ ...co, changes: [change({ type: "title" })] })).rejects.toThrow(/Refusing to commit: \.env\.local/);
    expect(calls).toHaveLength(0);
    // nothing pushed
    expect(() => g(originDir, "rev-parse", "--verify", co.branch)).toThrow();
  });

  it("commits, pushes, opens a PR with a descriptive body, and labels it", async () => {
    let prBody: any;
    const routes: Route[] = [
      on("GET", "/repos/acme/web/pulls", { body: [] }),
      on("POST", "/repos/acme/web/pulls", (c) => {
        prBody = c.body;
        return { status: 201, body: { number: 7, html_url: "https://github.com/acme/web/pull/7" } };
      }),
      on("POST", "/repos/acme/web/issues/7/labels", { body: [] }),
    ];
    const a = createRepoAdapter(makeCtx(mockFetch(routes, calls), logs, workDir), optsFor());
    const co = await a.prepareCheckout({ jobId: "pr000001" });
    write(co.dir, "app/(marketing)/about/page.tsx",
      "export const metadata = { title: 'About Acme — Industrial Widgets' };\nexport default function A(){return <h1>About</h1>}\n");
    const ch = [
      change({ type: "title", target: { url: "https://acme.test/about", resource: { kind: "route", id: "/about", file: "app/(marketing)/about/page.tsx" } } }),
      change({ id: "99999999-2222-3333-4444-555555555555", type: "jsonld_add", tier: "auto", risk_reasons: [], before: null,
        after: { schema_type: "Organization", schema: { "@type": "Organization", name: "Acme" } }, target: { url: "https://acme.test/" } }),
    ];
    const res = await a.commitAndOpenPR({ ...co, changes: ch });

    expect(res.prNumber).toBe(7);
    expect(res.prUrl).toBe("https://github.com/acme/web/pull/7");
    expect(res.filesChanged).toEqual(["app/(marketing)/about/page.tsx"]);
    expect(g(originDir, "rev-parse", co.branch)).toBe(res.headSha);
    expect(g(originDir, "log", "-1", "--format=%an <%ae>", co.branch)).toBe("SEO Autopilot <seo-autopilot@users.noreply.github.com>");

    // GitHub calls: auth header + body content
    const post = calls.find((c) => c.method === "POST" && c.path === "/repos/acme/web/pulls")!;
    expect(post.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(prBody.head).toBe(co.branch);
    expect(prBody.base).toBe("main");
    expect(prBody.title).toMatch(/SEO Autopilot: 2 fixes \(title, jsonld_add\)/);
    expect(prBody.body).toContain("`title` — https://acme.test/about");
    expect(prBody.body).toContain("About | Acme");
    expect(prBody.body).toContain("About Acme — Industrial Widgets");
    expect(prBody.body).toContain("Title is generic");
    expect(prBody.body).toContain("Rewrites a title link Google shows in results");
    expect(prBody.body).toContain("11111111-2222-3333-4444-555555555555");
    expect(prBody.body).toContain("99999999-2222-3333-4444-555555555555");
    expect(prBody.body).toContain("## Verification checklist");
    expect(prBody.body).toMatch(/JSON-LD parses/);
    const labels = calls.find((c) => c.path.endsWith("/issues/7/labels"))!;
    expect(labels.body.labels).toEqual(["seo-autopilot", "risk:approve"]);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("waitForPreview", () => {
  it("polls deployments until a status succeeds", async () => {
    let n = 0;
    const routes: Route[] = [
      on("GET", "/repos/acme/web/deployments", (c) => {
        expect(c.path).toContain("sha=abc123");
        n++;
        return { body: n < 2 ? [] : [{ id: 55, environment: "Preview", production_environment: false }] };
      }),
      on("GET", "/repos/acme/web/deployments/55/statuses", () => ({
        body: n < 3 ? [{ state: "in_progress" }] : [{ state: "success", environment_url: "https://acme-git-x.vercel.app", target_url: "https://vercel.com/i" }],
      })),
    ];
    const a = createRepoAdapter(makeCtx(mockFetch(routes, calls), logs, workDir), optsFor());
    const r = await a.waitForPreview({ headSha: "abc123", pollMs: 1, timeoutMs: 60_000 });
    expect(r).toEqual({ url: "https://acme-git-x.vercel.app", state: "success" });
    expect(n).toBe(3);
  });

  it("reports failure and timeout", async () => {
    const failing = createRepoAdapter(
      makeCtx(mockFetch([
        on("GET", "/repos/acme/web/deployments", { body: [{ id: 1 }] }),
        on("GET", "/repos/acme/web/deployments/1/statuses", { body: [{ state: "failure" }] }),
      ], calls), logs, workDir),
      optsFor(),
    );
    expect(await failing.waitForPreview({ headSha: "s", pollMs: 1, timeoutMs: 1000 })).toEqual({ url: null, state: "failure" });

    const none = createRepoAdapter(makeCtx(mockFetch([on("GET", "/repos/acme/web/deployments", { body: [] })], calls), logs, workDir), optsFor());
    expect(await none.waitForPreview({ headSha: "s", pollMs: 10, timeoutMs: 5 })).toEqual({ url: null, state: "none" });
  });
});

describe("merge, prStatus, revert", () => {
  it("merge sends squash with the sha guard and refuses a moved head", async () => {
    const routes: Route[] = [
      on("GET", "/repos/acme/web/pulls/7", { body: { number: 7, state: "open", mergeable: true, title: "T", head: { sha: "aaa", ref: "seo-autopilot/x" } } }),
      on("PUT", "/repos/acme/web/pulls/7/merge", { body: { merged: true, sha: "mmm" } }),
      on("DELETE", "/repos/acme/web/git/refs/heads/seo-autopilot/x", { status: 204 }),
    ];
    const a = createRepoAdapter(makeCtx(mockFetch(routes, calls), logs, workDir), optsFor());
    expect(await a.merge(7, "aaa")).toEqual({ merged: true, sha: "mmm" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ merge_method: "squash", sha: "aaa" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);

    calls.length = 0;
    await expect(a.merge(7, "bbb")).rejects.toThrow(/head moved/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("prStatus maps merged/open/closed", async () => {
    const routes: Route[] = [
      on("GET", "/repos/acme/web/pulls/1", { body: { state: "closed", merged_at: "2026-10-06T00:00:00Z", merge_commit_sha: "m1" } }),
      on("GET", "/repos/acme/web/pulls/2", { body: { state: "open", merged_at: null, merge_commit_sha: "tmp" } }),
      on("GET", "/repos/acme/web/pulls/3", { body: { state: "closed", merged_at: null } }),
    ];
    const a = createRepoAdapter(makeCtx(mockFetch(routes, calls), logs, workDir), optsFor());
    expect(await a.prStatus(1)).toMatchObject({ state: "merged", mergedAt: "2026-10-06T00:00:00Z", mergeSha: "m1" });
    expect(await a.prStatus(2)).toMatchObject({ state: "open", mergeSha: null });
    expect(await a.prStatus(3)).toMatchObject({ state: "closed" });
  });

  it("revert creates a revert branch of the squash commit and opens a PR", async () => {
    // Simulate a squash merge on origin/main that changes the robots file.
    const other = path.join(tmp, "merger-" + Date.now());
    g(tmp, "clone", "-q", originUrl, other);
    write(other, "public/llms.txt", "# Acme\n\nNew llms content\n");
    g(other, "commit", "-q", "-am", "SEO Autopilot: llms (#9)");
    g(other, "push", "-q", "origin", "main");
    const mergeSha = g(other, "rev-parse", "HEAD");

    let revertPR: any;
    const routes: Route[] = [
      on("GET", "/repos/acme/web/pulls/9", { body: { state: "closed", merged_at: "2026-10-06T00:00:00Z", merge_commit_sha: mergeSha, title: "SEO Autopilot: llms" } }),
      on("GET", "/repos/acme/web/pulls", { body: [] }),
      on("POST", "/repos/acme/web/pulls", (c) => {
        revertPR = c.body;
        return { status: 201, body: { number: 10, html_url: "https://github.com/acme/web/pull/10" } };
      }),
      on("POST", "/repos/acme/web/issues/10/labels", { body: [] }),
    ];
    const a = createRepoAdapter(makeCtx(mockFetch(routes, calls), logs, workDir), optsFor());
    const r = await a.revert({ prNumber: 9 });
    expect(r).toEqual({ prUrl: "https://github.com/acme/web/pull/10", prNumber: 10, merged: false });
    expect(revertPR.head).toBe("seo-autopilot/revert-pr9-20261006");
    expect(revertPR.title).toBe('Revert "SEO Autopilot: llms"');
    expect(revertPR.body).toContain(mergeSha);
    expect(g(originDir, "show", `${revertPR.head}:public/llms.txt`)).toBe("# Acme");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("revert refuses an unmerged PR", async () => {
    const a = createRepoAdapter(
      makeCtx(mockFetch([on("GET", "/repos/acme/web/pulls/4", { body: { state: "open", merged_at: null } })], calls), logs, workDir),
      optsFor(),
    );
    await expect(a.revert({ prNumber: 4 })).rejects.toThrow(/only merged PRs/);
  });
});

describe("testConnection", () => {
  const base = (perms: { push: boolean }, extra: Route[] = []): Route[] => [
    ...extra,
    on("GET", "/repos/acme/web", { body: { default_branch: "main", private: true, permissions: { ...perms, pull: true }, allow_squash_merge: true } }),
    on("GET", "/repos/acme/web/branches/main", { body: { protected: true, commit: { sha: "abc" } } }),
    on("GET", "/repos/acme/web/branches/main/protection", { body: { required_pull_request_reviews: { required_approving_review_count: 1 } } }),
    on("GET", "/repos/acme/web/rules/branches/main", { body: [] }),
    on("GET", "/repos/acme/web/pulls", { body: [] }),
    on("GET", "/repos/acme/web/deployments", { body: [] }),
  ];

  it("ok with push; warns about required reviews when auto-merge is on", async () => {
    const a = createRepoAdapter(makeCtx(mockFetch(base({ push: true }), calls), logs, workDir), { ...optsFor(), repoAutoMerge: true });
    const r = await a.testConnection();
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ base_sha: "abc", required_reviews: 1, branch_protected: true });
    expect(r.warnings.join("\n")).toMatch(/repo_auto_merge will not work/);
  });

  it("fails without push permission", async () => {
    const a = createRepoAdapter(makeCtx(mockFetch(base({ push: false }), calls), logs, workDir), optsFor());
    const r = await a.testConnection();
    expect(r.ok).toBe(false);
    expect(r.warnings.join("\n")).toMatch(/cannot push/);
    expect(r.warnings.join("\n")).toMatch(/PRs wait for a human merge/);
  });

  it("fails clearly on 404 and missing PR access", async () => {
    const nf = createRepoAdapter(makeCtx(mockFetch([], calls), logs, workDir), optsFor());
    const r = await nf.testConnection();
    expect(r.ok).toBe(false);
    expect(r.warnings[0]).toMatch(/not found/);

    const noPR = createRepoAdapter(
      makeCtx(mockFetch(base({ push: true }, [on("GET", "/repos/acme/web/pulls", { status: 403, body: { message: "Resource not accessible by personal access token" } })]), calls), logs, workDir),
      optsFor(),
    );
    const r2 = await noPR.testConnection();
    expect(r2.ok).toBe(false);
    expect(r2.warnings.join("\n")).toMatch(/Pull requests/);
  });
});
