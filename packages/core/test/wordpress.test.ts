import { describe, expect, it } from "vitest";
import { createWordPressAdapter, HTACCESS_HINT } from "../src/adapters/wordpress";
import type { AdapterContext } from "../src/adapters/index";
import type { ChangeRecord, ChangeType } from "../src/schema";

const SITE = "https://blog.example.com";

interface FakeOpts {
  bridge?: boolean;
  seo?: "rankmath" | "yoast" | "seopress" | null;
  redirection?: boolean;
  stripAuth?: boolean;
  waf?: boolean;
  plainPermalinks?: boolean;
}

/** In-memory WordPress REST server. */
function fakeWp(opts: FakeOpts = {}) {
  const state = {
    posts: new Map<number, { id: number; type: string; slug: string; title: string; content: string; meta: Record<string, unknown> }>(),
    media: new Map<number, { id: number; source_url: string; alt_text: string }>(),
    seo: new Map<number, Record<string, unknown>>(),          // bridge normalized fields
    redirects: new Map<string, { from: string; to: string; code: number }>(),
    redirItems: [] as Array<{ id: number; url: string; action_code: number; action_data: { url: string }; enabled: boolean }>,
    files: { robots: "", llms: "" },
    purged: [] as unknown[],
    rankmath: new Map<number, Record<string, unknown>>(),
    log: [] as string[],
  };
  state.posts.set(12, {
    id: 12, type: "post", slug: "hello-world", title: "Hello world",
    content: '<!-- wp:heading {"level":1} --><h1 class="wp-block-heading">Hello world</h1><!-- /wp:heading -->\n<!-- wp:image {"id":45} --><figure class="wp-block-image"><img src="https://blog.example.com/wp-content/uploads/2024/01/cat-1024x683.jpg" alt="" class="wp-image-45"/></figure><!-- /wp:image -->\n<!-- wp:paragraph --><p>Our red shoes are great.</p><!-- /wp:paragraph -->',
    meta: {},
  });
  state.posts.set(7, { id: 7, type: "page", slug: "about", title: "About", content: "<p>About us</p>", meta: {} });
  state.media.set(45, { id: 45, source_url: `${SITE}/wp-content/uploads/2024/01/cat.jpg`, alt_text: "" });
  state.seo.set(12, { title: "Old SEO title", description: null });

  const ns = ["wp/v2", "oembed/1.0"];
  if (opts.bridge) ns.push("seo-agent/v1");
  if (opts.seo === "rankmath") ns.push("rankmath/v1");
  if (opts.seo === "yoast") ns.push("yoast/v1");
  if (opts.seo === "seopress") ns.push("seopress/v1");
  if (opts.redirection) ns.push("redirection/v1");

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8", ...headers } });
  const postJson = (p: { id: number; type: string; slug: string; title: string; content: string; meta: Record<string, unknown> }) => ({
    id: p.id,
    link: `${SITE}/${p.slug}/`,
    title: { raw: p.title, rendered: p.title },
    content: { raw: p.content, rendered: p.content },
    meta: p.meta,
  });
  const baseOf = (t: string) => (t === "page" ? "pages" : "posts");

  const f = (async (input: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const url = new URL(input);
    let route: string | null = null;
    if (url.pathname.startsWith("/wp-json")) route = url.pathname.slice("/wp-json".length) || "/";
    else if (url.searchParams.has("rest_route")) route = url.searchParams.get("rest_route");
    state.log.push(`${method} ${route ?? url.pathname}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    if (url.host === "api.cloudflare.com") {
      state.purged.push({ cloudflare: body });
      return json({ success: true });
    }

    if (route === null) {
      // front-end
      if (method === "HEAD" && url.pathname === "/") {
        const link = opts.plainPermalinks ? `<${SITE}/?rest_route=/>; rel="https://api.w.org/"` : `<${SITE}/wp-json/>; rel="https://api.w.org/"`;
        return new Response(null, { status: 200, headers: { link } });
      }
      const post = [...state.posts.values()].find((p) => url.pathname.replace(/\/$/, "") === `/${p.slug}`);
      if (post) {
        const t = String(state.seo.get(post.id)?.title ?? post.title);
        const d = state.seo.get(post.id)?.description;
        return new Response(`<html><head><title>${t}</title>${d ? `<meta name="description" content="${d}">` : ""}</head><body>${post.content}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html", link: `<${SITE}/wp-json/wp/v2/${baseOf(post.type)}/${post.id}>; rel="alternate"; type="application/json"` },
        });
      }
      if (url.pathname === "/") return new Response("<html><head><title>Home</title></head></html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response("nf", { status: 404 });
    }

    if (opts.plainPermalinks && url.pathname.startsWith("/wp-json")) return new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } });
    if (opts.waf) return new Response("<!DOCTYPE html><html><title>Attention Required! | Cloudflare</title></html>", { status: 403, headers: { "content-type": "text/html" } });
    const authed = !opts.stripAuth && headers.Authorization === "Basic " + Buffer.from("seo-agent:abcd efgh ijkl mnop").toString("base64");

    if (route === "/" || route === "") return json({ name: "Blog", namespaces: ns, routes: { "/": {}, ...(opts.seo === "yoast" ? { "/yoast/v1/bulk_editor/update_search": {} } : {}) } });
    if (!authed) return json({ code: "rest_not_logged_in", message: "You are not currently logged in.", data: { status: 401 } }, 401);

    let m: RegExpExecArray | null;
    if (route === "/wp/v2/users/me") return json({ id: 1, name: "SEO Agent", slug: "seo-agent", roles: ["administrator"], capabilities: { edit_others_posts: true, edit_pages: true, edit_published_posts: true, upload_files: true, manage_options: true } });
    if (route === "/wp/v2/settings") return json({ show_on_front: "posts", page_on_front: 0 });
    if (route === "/wp/v2/types") return json({ post: { slug: "post", rest_base: "posts" }, page: { slug: "page", rest_base: "pages" }, attachment: { slug: "attachment", rest_base: "media" } });
    if (route === "/wp/v2/plugins") return json([{ plugin: "wp-rocket/wp-rocket", status: "active", name: "WP Rocket" }]);
    if ((m = /^\/wp\/v2\/(posts|pages)\/(\d+)$/.exec(route))) {
      const p = state.posts.get(Number(m[2]));
      if (!p) return json({ code: "rest_post_invalid_id" }, 404);
      if (method === "POST") {
        if (body.content !== undefined) p.content = body.content;
        if (body.title !== undefined) p.title = body.title;
        if (body.meta) Object.assign(p.meta, body.meta);
      }
      return json(postJson(p));
    }
    if ((m = /^\/wp\/v2\/(posts|pages)$/.exec(route))) {
      const slug = url.searchParams.get("slug");
      return json([...state.posts.values()].filter((p) => baseOf(p.type) === m![1] && p.slug === slug).map(postJson));
    }
    if (route === "/wp/v2/media") {
      const s = url.searchParams.get("search") ?? "";
      return json([...state.media.values()].filter((x) => x.source_url.includes(s)).map((x) => ({ ...x, media_details: { sizes: { large: { source_url: x.source_url.replace(".jpg", "-1024x683.jpg") } } } })));
    }
    if ((m = /^\/wp\/v2\/media\/(\d+)$/.exec(route))) {
      const x = state.media.get(Number(m[1]));
      if (!x) return json({ code: "rest_post_invalid_id" }, 404);
      if (method === "POST" && body.alt_text !== undefined) x.alt_text = body.alt_text;
      return json(x);
    }

    // ---- bridge
    if (opts.bridge) {
      if (route === "/seo-agent/v1/status")
        return json({ version: "1.0.0", seo_plugin: opts.seo ?? "none", blog_public: true, physical_robots: false, physical_llms: false, redirection_plugin: !!opts.redirection, caching: ["WP Rocket"] });
      if (route === "/seo-agent/v1/resolve") {
        const u = new URL(url.searchParams.get("url")!);
        if (u.pathname === "/") return json({ id: 0, type: null, rest_base: null, link: `${SITE}/`, front: true });
        const p = [...state.posts.values()].find((x) => u.pathname.replace(/\/$/, "") === `/${x.slug}`);
        return json(p ? { id: p.id, type: p.type, rest_base: baseOf(p.type), link: `${SITE}/${p.slug}/`, front: false } : { id: 0, type: null, front: false });
      }
      if ((m = /^\/seo-agent\/v1\/meta\/(\d+)$/.exec(route))) {
        const id = Number(m[1]);
        const cur = { title: null, description: null, canonical: null, robots: { index: null, follow: null }, og_title: null, og_description: null, og_image: null, jsonld: null, ...(state.seo.get(id) ?? {}) };
        if (method === "GET") return json({ post_id: id, plugin: "none", fields: cur });
        const before = JSON.parse(JSON.stringify(cur));
        const next = { ...cur };
        for (const [k, v] of Object.entries(body)) (next as Record<string, unknown>)[k] = v === "" ? null : v;
        state.seo.set(id, next);
        return json({ before, after: next });
      }
      if (route === "/seo-agent/v1/redirects") {
        if (method === "GET") return json({ items: [...state.redirects.values()] });
        if (method === "POST") {
          const before = state.redirects.get(body.from) ?? null;
          state.redirects.set(body.from, { from: body.from, to: body.to, code: body.code ?? 301 });
          return json({ before, rule: state.redirects.get(body.from) });
        }
        if (method === "DELETE") {
          const from = url.searchParams.get("from")!;
          const before = state.redirects.get(from) ?? null;
          state.redirects.delete(from);
          return json({ deleted: !!before, before });
        }
      }
      if ((m = /^\/seo-agent\/v1\/(robots|llms)$/.exec(route))) {
        const k = m[1] as "robots" | "llms";
        if (method === "GET") return json({ content: state.files[k], physical: false });
        const before = state.files[k];
        state.files[k] = body.content;
        return json({ before, after: body.content });
      }
      if (route === "/seo-agent/v1/purge") {
        state.purged.push({ bridge: body });
        return json({ ok: true });
      }
    }

    // ---- Rank Math
    if (opts.seo === "rankmath" && route === "/rankmath/v1/updateMeta") {
      state.rankmath.set(body.objectID, { ...(state.rankmath.get(body.objectID) ?? {}), ...body.meta });
      const s = state.seo.get(body.objectID) ?? {};
      if ("rank_math_title" in body.meta) s.title = body.meta.rank_math_title || null;
      if ("rank_math_description" in body.meta) s.description = body.meta.rank_math_description || null;
      state.seo.set(body.objectID, s);
      return json({ slug: "hello-world", schemas: [] });
    }

    // ---- Redirection plugin
    if (opts.redirection) {
      if (route === "/redirection/v1/group") return json({ items: [{ id: 3, name: "Redirections", module_id: 1, enabled: true }] });
      if (route === "/redirection/v1/redirect" && method === "GET") {
        const fu = url.searchParams.get("filterBy[url]");
        return json({ items: state.redirItems.filter((i) => i.url === fu) });
      }
      if (route === "/redirection/v1/redirect" && method === "POST") {
        state.redirItems.push({ id: 100 + state.redirItems.length, url: body.url, action_code: body.action_code, action_data: body.action_data, enabled: true });
        return json({ items: state.redirItems });
      }
      if (route === "/redirection/v1/bulk/redirect/delete") {
        state.redirItems = state.redirItems.filter((i) => !body.items.includes(i.id));
        return json({ items: state.redirItems });
      }
    }
    return json({ code: "rest_no_route", message: "No route was found matching the URL and request method." }, 404);
  }) as unknown as typeof fetch;
  return { f, state };
}

function makeAdapter(opts: FakeOpts = {}, extraSecrets: Record<string, unknown> = {}) {
  const wp = fakeWp(opts);
  const logs: string[] = [];
  const ctx: AdapterContext = {
    site: { id: "s1", url: SITE, platform: "wordpress", config: {} },
    secrets: { platform: "wordpress", username: "seo-agent", app_password: "abcd efgh ijkl mnop", ...extraSecrets } as AdapterContext["secrets"],
    log: (_l, m) => logs.push(m),
    fetch: wp.f,
  };
  const adapter = createWordPressAdapter(ctx, { minIntervalMs: 0, sleep: async () => {} });
  return { adapter, ...wp, logs };
}

let n = 0;
function change(type: ChangeType, url: string, after: unknown, extra: Partial<ChangeRecord> = {}): ChangeRecord {
  return { id: `c${++n}`, site_id: "s1", type, target: { url }, before: null, after, tier: "auto", risk_reasons: [], status: "approved", diff_hash: "h", ...extra };
}

async function roundTrip(adapter: ReturnType<typeof makeAdapter>["adapter"], c: ChangeRecord) {
  const before = await adapter.read(c);
  c.before = before;
  const res = await adapter.apply(c);
  const afterRead = await adapter.read(c);
  c.rollback_data = res.rollback;
  await adapter.rollback(c);
  const restored = await adapter.read(c);
  return { before, afterRead, restored, res };
}

describe("WordPress adapter with seo-agent-bridge", () => {
  it("testConnection reports bridge, plugins and capabilities", async () => {
    const { adapter } = makeAdapter({ bridge: true, seo: "rankmath" });
    const r = await adapter.testConnection();
    expect(r.ok).toBe(true);
    expect(r.details.bridge_version).toBe("1.0.0");
    expect(r.details.primary_seo_plugin).toBe("rankmath");
    expect(r.details.caching_plugins).toEqual(["WP Rocket"]);
    expect(r.details.user).toMatchObject({ slug: "seo-agent" });
    const caps = await adapter.capabilities();
    for (const t of ["title", "meta_description", "jsonld_add", "redirect", "robots_txt", "llms_txt", "image_alt", "h1"]) expect(caps).toContain(t);
    for (const t of ["slug", "hreflang", "code_change"]) expect(caps).not.toContain(t);
  });

  it("resolves URLs to resources", async () => {
    const { adapter } = makeAdapter({ bridge: true });
    expect(await adapter.resolve(`${SITE}/hello-world/`, "title")).toEqual({ kind: "post", id: "posts/12" });
    expect(await adapter.resolve(`${SITE}/about/`, "title")).toEqual({ kind: "page", id: "pages/7" });
    expect(await adapter.resolve(`${SITE}/`, "title")).toEqual({ kind: "site", id: "front" });
    expect(await adapter.resolve(`${SITE}/robots.txt`, "robots_txt")).toEqual({ kind: "site" });
  });

  it("title round trip", async () => {
    const { adapter, state } = makeAdapter({ bridge: true });
    const c = change("title", `${SITE}/hello-world/`, { value: "Better Title" });
    const { before, afterRead, restored } = await roundTrip(adapter, c);
    expect(before).toEqual({ value: "Old SEO title" });
    expect(afterRead).toEqual({ value: "Better Title" });
    expect(restored).toEqual({ value: "Old SEO title" });
    expect(state.seo.get(12)?.title).toBe("Old SEO title");
  });

  it("meta_description round trip (empty previous = delete)", async () => {
    const { adapter, state } = makeAdapter({ bridge: true });
    const c = change("meta_description", `${SITE}/hello-world/`, { value: "A fine description" });
    const { before, afterRead, restored, res } = await roundTrip(adapter, c);
    expect(before).toBeNull();
    expect(afterRead).toEqual({ value: "A fine description" });
    expect(restored).toBeNull();
    expect(state.seo.get(12)?.description).toBeNull();
    expect((res.rollback as { previous: unknown }).previous).toEqual({ description: null });
  });

  it("image_alt updates content.raw (preserving blocks) and media alt_text, then rolls back", async () => {
    const { adapter, state } = makeAdapter({ bridge: true });
    const original = state.posts.get(12)!.content;
    const c = change("image_alt", `${SITE}/hello-world/`, { src: `${SITE}/wp-content/uploads/2024/01/cat.jpg`, alt: 'A "ginger" cat' });
    const before = await adapter.read(c);
    expect(before).toMatchObject({ alt: "" });
    const res = await adapter.apply({ ...c, before });
    const content = state.posts.get(12)!.content;
    expect(content).toContain('alt="A &quot;ginger&quot; cat"');
    expect(content).toContain('<!-- wp:image {"id":45} -->');
    expect(content).toContain('class="wp-image-45"');
    expect(state.media.get(45)!.alt_text).toBe('A "ginger" cat');
    expect(await adapter.read(c)).toMatchObject({ alt: 'A "ginger" cat' });
    await adapter.rollback({ ...c, rollback_data: res.rollback });
    expect(state.posts.get(12)!.content).toBe(original);
    expect(state.media.get(45)!.alt_text).toBe("");
  });

  it("redirect round trip", async () => {
    const { adapter, state } = makeAdapter({ bridge: true });
    const c = change("redirect", `${SITE}/old-post`, { from_path: "/old-post", to_url: `${SITE}/hello-world/`, code: 301 });
    const { before, afterRead, restored } = await roundTrip(adapter, c);
    expect(before).toBeNull();
    expect(afterRead).toMatchObject({ from_path: "/old-post", to_url: `${SITE}/hello-world/` });
    expect(restored).toBeNull();
    expect(state.redirects.size).toBe(0);
  });

  it("jsonld_add round trip", async () => {
    const { adapter, state } = makeAdapter({ bridge: true });
    const c = change("jsonld_add", `${SITE}/hello-world/`, { schema_type: "BlogPosting", schema: { headline: "Hello world" } });
    const { before, afterRead, restored } = await roundTrip(adapter, c);
    expect(before).toBeNull();
    expect(afterRead).toMatchObject({ schema_type: "BlogPosting", schema: { "@type": "BlogPosting", "@context": "https://schema.org", headline: "Hello world" } });
    expect(restored).toBeNull();
    expect(state.seo.get(12)?.jsonld).toEqual([]);
  });

  it("robots_txt and llms_txt round trip", async () => {
    const { adapter, state } = makeAdapter({ bridge: true });
    state.files.robots = "User-agent: *\nDisallow: /wp-admin/\n";
    const c = change("robots_txt", `${SITE}/robots.txt`, { content: "User-agent: *\nDisallow: /wp-admin/\nSitemap: https://blog.example.com/sitemap.xml\n" });
    const { afterRead } = await roundTrip(adapter, c);
    expect(afterRead).toMatchObject({ content: expect.stringContaining("Sitemap:") });
    expect(state.files.robots).toBe("User-agent: *\nDisallow: /wp-admin/\n");
    const l = change("llms_txt", `${SITE}/llms.txt`, { content: "# Blog\n" });
    await adapter.apply(l);
    expect(state.files.llms).toBe("# Blog\n");
  });

  it("h1 edit in content and internal link insertion", async () => {
    const { adapter, state } = makeAdapter({ bridge: true });
    const h = change("h1", `${SITE}/hello-world/`, { value: "Hello, wide world" });
    const r1 = await adapter.apply({ ...h, before: { value: "Hello world" } });
    expect(state.posts.get(12)!.content).toContain(">Hello, wide world</h1><!-- /wp:heading -->");
    const il = change("internal_link", `${SITE}/hello-world/`, { anchor: "red shoes", to_url: `${SITE}/shoes/` });
    const r2 = await adapter.apply(il);
    expect(state.posts.get(12)!.content).toContain(`<a href="${SITE}/shoes/">red shoes</a>`);
    // roll back in reverse order
    await adapter.rollback({ ...il, rollback_data: r2.rollback });
    await adapter.rollback({ ...h, rollback_data: r1.rollback });
    expect(state.posts.get(12)!.content).toContain(">Hello world</h1>");
    expect(state.posts.get(12)!.content).not.toContain("<a href");
  });

  it("purge calls the bridge and Cloudflare with both slash variants", async () => {
    const { adapter, state } = makeAdapter({ bridge: true }, { cloudflare: { zone_id: "z1", api_token: "t" } });
    await adapter.purge!([`${SITE}/hello-world/`]);
    expect(state.purged[0]).toEqual({ bridge: { urls: [`${SITE}/hello-world/`] } });
    expect((state.purged[1] as { cloudflare: { files: string[] } }).cloudflare.files.sort()).toEqual([`${SITE}/hello-world`, `${SITE}/hello-world/`]);
  });

  it("refuses never-automated types", async () => {
    const { adapter } = makeAdapter({ bridge: true });
    await expect(adapter.apply(change("slug", `${SITE}/hello-world/`, { value: "x" }))).rejects.toThrow(/never/);
  });
});

describe("WordPress adapter without the bridge", () => {
  it("Rank Math title via updateMeta, rollback from rendered value", async () => {
    const { adapter, state } = makeAdapter({ seo: "rankmath" });
    const caps = await adapter.capabilities();
    expect(caps).toContain("title");
    expect(caps).not.toContain("robots_txt");
    expect(caps).not.toContain("jsonld_add");
    expect(caps).not.toContain("redirect");
    const c = change("title", `${SITE}/hello-world/`, { value: "RM Title" });
    c.target.resource = (await adapter.resolve(c.target.url, "title"))!;
    expect(c.target.resource).toEqual({ kind: "post", id: "posts/12" });
    const res = await adapter.apply(c);
    expect(state.rankmath.get(12)).toEqual({ rank_math_title: "RM Title" });
    await adapter.rollback({ ...c, rollback_data: res.rollback });
    expect(state.rankmath.get(12)).toEqual({ rank_math_title: "Old SEO title" });
  });

  it("Redirection plugin create + rollback delete", async () => {
    const { adapter, state } = makeAdapter({ redirection: true });
    expect(await adapter.capabilities()).toContain("redirect");
    const c = change("redirect", `${SITE}/old`, { from_path: "/old", to_url: `${SITE}/hello-world/`, code: 301 });
    const res = await adapter.apply(c);
    expect(state.redirItems).toHaveLength(1);
    expect(state.redirItems[0]).toMatchObject({ url: "/old", action_code: 301 });
    await adapter.rollback({ ...c, rollback_data: res.rollback });
    expect(state.redirItems).toHaveLength(0);
  });

  it("falls back to ?rest_route= with plain permalinks", async () => {
    const { adapter, state } = makeAdapter({ seo: "seopress", plainPermalinks: true });
    const r = await adapter.testConnection();
    expect(r.ok).toBe(true);
    expect(r.details.rest_mode).toBe("query");
    expect(state.log.some((l) => l === "GET /wp/v2/users/me")).toBe(true);
  });

  it("no SEO plugin and no bridge: title is not a capability", async () => {
    const { adapter } = makeAdapter({});
    const caps = await adapter.capabilities();
    expect(caps).not.toContain("title");
    expect(caps).toEqual(expect.arrayContaining(["h1", "image_alt", "content_edit", "internal_link"]));
    await expect(adapter.apply(change("title", `${SITE}/hello-world/`, { value: "x" }))).rejects.toThrow(/seo-agent-bridge/);
  });
});

describe("WordPress adapter errors", () => {
  it("401 includes the .htaccess hint", async () => {
    const { adapter } = makeAdapter({ bridge: true, stripAuth: true });
    const r = await adapter.testConnection();
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toContain("SetEnvIf Authorization");
    expect(HTACCESS_HINT).toContain("HTTP_AUTHORIZATION");
  });
  it("403 HTML is reported as a firewall block", async () => {
    const { adapter } = makeAdapter({ waf: true });
    const r = await adapter.testConnection();
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/firewall|WAF/i);
  });
  it("retries on 429", async () => {
    const wp = fakeWp({ bridge: true });
    let hits = 0;
    const f = (async (u: string, i: RequestInit) => {
      if (String(u).includes("users/me") && hits++ === 0) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      return wp.f(u, i);
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const adapter = createWordPressAdapter(
      { site: { id: "s", url: SITE, platform: "wordpress", config: {} }, secrets: { platform: "wordpress", username: "seo-agent", app_password: "abcd efgh ijkl mnop" }, log: () => {}, fetch: f },
      { minIntervalMs: 0, sleep: async (ms) => void slept.push(ms) },
    );
    const r = await adapter.testConnection();
    expect(r.ok).toBe(true);
    expect(slept).toContain(1000);
  });
});
