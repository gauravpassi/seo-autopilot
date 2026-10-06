import { describe, expect, it } from "vitest";
import type { ChangeRecord } from "../src/schema";
import { liveValue, verifyChange, verifyWithRetry } from "../src/verify";
import { parseHtml } from "../src/page";

const SITE = "https://example.com";

type Route = { status?: number; body?: string; headers?: Record<string, string> };
function mockFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: string[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    u.searchParams.delete("_sa");
    const key = u.toString();
    calls.push(key);
    let r = routes[key] ?? routes[u.pathname];
    if (typeof r === "function") r = r();
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const status = r.status ?? 200;
    if (init?.redirect !== "manual" && (status === 301 || status === 308) && r.headers?.location) {
      return f(new URL(r.headers.location, input).toString(), init);
    }
    return new Response(status === 301 || status === 308 || status === 204 ? null : r.body ?? "", {
      status,
      headers: { "content-type": "text/html", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const page = (o: { title?: string; desc?: string; robots?: string; jsonld?: string; img?: string; body?: string }) =>
  `<html><head><title>${o.title ?? "Page"}</title>${o.desc ? `<meta name="description" content="${o.desc}">` : ""}${o.robots ? `<meta name="robots" content="${o.robots}">` : ""}${o.jsonld ? `<script type="application/ld+json">${o.jsonld}</script>` : ""}</head><body><h1>Heading</h1>${o.img ?? ""}${o.body ?? ""}</body></html>`;

const change = (o: Partial<ChangeRecord>): ChangeRecord => ({
  id: "c1",
  site_id: "s1",
  type: "meta_description",
  target: { url: `${SITE}/post` },
  before: { value: "Old description" },
  after: { value: "New   description &amp; more" },
  tier: "auto",
  risk_reasons: [],
  status: "applied",
  diff_hash: "x",
  ...o,
});

describe("verifyChange", () => {
  it("passes when the new value is live", async () => {
    const { f } = mockFetch({ "/post": { body: page({ desc: "New description &amp; more" }) } });
    const r = await verifyChange(change({}), { siteUrl: SITE, fetch: f });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(["status_200", "not_noindex", "title_non_empty", "meta_description"]);
    expect(r.checked_url).toBe(`${SITE}/post`);
  });

  it("is retryable when the old value is still served (cache)", async () => {
    const { f } = mockFetch({ "/post": { body: page({ desc: "Old description" }) } });
    const r = await verifyChange(change({}), { siteUrl: SITE, fetch: f });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it("hard fails on 500 and on surprise noindex", async () => {
    const a = mockFetch({ "/post": { status: 500, body: "err" } });
    const r = await verifyChange(change({}), { siteUrl: SITE, fetch: a.f });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    const b = mockFetch({ "/post": { body: page({ desc: "Old description", robots: "noindex" }) } });
    const r2 = await verifyChange(change({}), { siteUrl: SITE, fetch: b.f });
    expect(r2.retryable).toBe(false);
    expect(r2.checks.find((c) => c.name === "not_noindex")?.ok).toBe(false);
  });

  it("hard fails on a value that is neither before nor after", async () => {
    const { f } = mockFetch({ "/post": { body: page({ desc: "Something else" }) } });
    const r = await verifyChange(change({}), { siteUrl: SITE, fetch: f });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it("allows noindex for robots_meta index=false", async () => {
    const { f } = mockFetch({ "/post": { body: page({ robots: "noindex, follow" }) } });
    const r = await verifyChange(change({ type: "robots_meta", before: { index: true, follow: true }, after: { index: false, follow: true } }), { siteUrl: SITE, fetch: f });
    expect(r.ok).toBe(true);
  });

  it("verifies a 301 redirect and its target", async () => {
    const { f } = mockFetch({
      "/old": { status: 301, headers: { location: "/new" } },
      "/new": { body: page({}) },
    });
    const r = await verifyChange(
      change({ type: "redirect", before: null, after: { from_path: "/old", to_url: `${SITE}/new`, code: 301 } }),
      { siteUrl: SITE, fetch: f },
    );
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toContain("target_status_200");
  });

  it("redirect not live yet is retryable; wrong location is hard", async () => {
    const a = mockFetch({ "/old": { status: 404, body: "nf" }, "/new": { body: page({}) } });
    const ch = change({ type: "redirect", before: null, after: { from_path: "/old", to_url: `${SITE}/new`, code: 301 } });
    const r = await verifyChange(ch, { siteUrl: SITE, fetch: a.f, timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    const b = mockFetch({ "/old": { status: 302, headers: { location: "/elsewhere" } }, "/new": { body: page({}) } });
    const r2 = await verifyChange(ch, { siteUrl: SITE, fetch: b.f });
    expect(r2.retryable).toBe(false);
  });

  it("robots.txt content compare with normalized line endings", async () => {
    const { f } = mockFetch({
      "/robots.txt": { body: "User-agent: *\r\nDisallow: /wp-admin/  \r\n\r\n", headers: { "content-type": "text/plain" } },
      "/": { body: page({}) },
    });
    const r = await verifyChange(
      change({ type: "robots_txt", target: { url: `${SITE}/robots.txt` }, before: { content: "User-agent: *" }, after: { content: "User-agent: *\nDisallow: /wp-admin/\n" } }),
      { siteUrl: SITE, fetch: f },
    );
    expect(r.ok).toBe(true);
    expect(r.checked_url).toBe(`${SITE}/robots.txt`);
  });

  it("robots.txt still old -> retryable", async () => {
    const { f } = mockFetch({ "/robots.txt": { body: "User-agent: *\n" }, "/": { body: page({}) } });
    const r = await verifyChange(
      change({ type: "robots_txt", target: { url: `${SITE}/robots.txt` }, before: { content: "User-agent: *" }, after: { content: "User-agent: *\nDisallow: /x/" } }),
      { siteUrl: SITE, fetch: f },
    );
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it("JSON-LD subset compare", async () => {
    const jsonld = JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "Acme Inc", url: "https://example.com/", logo: { "@type": "ImageObject", url: "https://example.com/logo.png" }, extra: 1 }] });
    const { f } = mockFetch({ "/post": { body: page({ jsonld }) } });
    const r = await verifyChange(
      change({ type: "jsonld_add", before: null, after: { schema_type: "Organization", schema: { "@context": "https://schema.org", "@type": "Organization", name: "Acme  Inc", url: "https://example.com", logo: { url: "https://example.com/logo.png" } } } }),
      { siteUrl: SITE, fetch: f },
    );
    expect(r.ok).toBe(true);
  });

  it("JSON-LD missing is retryable when it was missing before", async () => {
    const { f } = mockFetch({ "/post": { body: page({}) } });
    const r = await verifyChange(change({ type: "jsonld_add", before: null, after: { schema_type: "Organization", schema: { name: "Acme" } } }), { siteUrl: SITE, fetch: f });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it("image_alt matches resized image", async () => {
    const { f } = mockFetch({ "/post": { body: page({ img: `<img src="/wp-content/uploads/cat-300x200.jpg?ver=2" alt="A cat">` }) } });
    const r = await verifyChange(
      change({ type: "image_alt", before: { src: `${SITE}/wp-content/uploads/cat.jpg`, alt: null }, after: { src: `${SITE}/wp-content/uploads/cat.jpg`, alt: "A cat" } }),
      { siteUrl: SITE, fetch: f },
    );
    expect(r.ok).toBe(true);
  });

  it("content_edit and internal_link checks; manual review otherwise", async () => {
    const { f } = mockFetch({ "/post": { body: page({ body: `<p>We sell <a href="/shoes/">red shoes</a> today.</p>` }) } });
    const ce = await verifyChange(change({ type: "content_edit", before: null, after: { instructions: "x", find: "blue shoes", replace: "red shoes" } }), { siteUrl: SITE, fetch: f });
    expect(ce.ok).toBe(true);
    const il = await verifyChange(change({ type: "internal_link", before: null, after: { anchor: "red shoes", to_url: `${SITE}/shoes` } }), { siteUrl: SITE, fetch: f });
    expect(il.ok).toBe(true);
    const man = await verifyChange(change({ type: "content_edit", before: null, after: { instructions: "rewrite intro" } }), { siteUrl: SITE, fetch: f });
    expect(man.ok).toBe(true);
    expect(man.notes).toContain("manual review");
  });

  it("refuses off-site URLs (SSRF guard)", async () => {
    const { f, calls } = mockFetch({});
    const r = await verifyChange(change({ target: { url: "https://evil.com/x" } }), { siteUrl: SITE, fetch: f });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rollback mode expects the before value", async () => {
    const { f } = mockFetch({ "/post": { body: page({ desc: "Old description" }) } });
    const r = await verifyChange(change({}), { siteUrl: SITE, fetch: f, expect: "before" });
    expect(r.ok).toBe(true);
  });
});

describe("verifyWithRetry", () => {
  it("retries until the cache clears", async () => {
    let n = 0;
    const { f } = mockFetch({ "/post": () => ({ body: page({ desc: ++n < 3 ? "Old description" : "New description & more" }) }) });
    const slept: number[] = [];
    const r = await verifyWithRetry(change({}), { siteUrl: SITE, fetch: f, delaysMs: [0, 10, 20, 30], sleep: async (ms) => void slept.push(ms) });
    expect(r.ok).toBe(true);
    expect(slept).toEqual([10, 20]);
  });
  it("stops early on a hard failure", async () => {
    const { f, calls } = mockFetch({ "/post": { status: 500 } });
    const r = await verifyWithRetry(change({}), { siteUrl: SITE, fetch: f, delaysMs: [0, 10, 20], sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("liveValue", () => {
  const snap = {
    ...parseHtml(page({ title: "T", desc: "D", robots: "noindex" }) + "", `${SITE}/x`),
    status: 200, finalUrl: `${SITE}/x`, redirected: false, headers: {}, xRobotsTag: null, fetchedAt: "",
  };
  it("shapes", () => {
    expect(liveValue("title", snap, {})).toEqual({ value: "T" });
    expect(liveValue("meta_description", snap, {})).toEqual({ value: "D" });
    expect(liveValue("robots_meta", snap, {})).toEqual({ index: false, follow: true });
    expect(liveValue("canonical", snap, {})).toBeNull();
    expect(liveValue("og_tags", snap, {})).toBeNull();
    expect(liveValue("jsonld_add", snap, { schema_type: "Organization" })).toBeNull();
    expect(liveValue("image_alt", snap, { src: "/nope.jpg" })).toBeNull();
  });
});
