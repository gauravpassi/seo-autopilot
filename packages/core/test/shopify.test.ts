import { describe, expect, it } from "vitest";
import { createShopifyAdapter, imageKey, parseShopifyPath, ShopifyConcurrentEditError } from "../src/adapters/shopify";
import type { AdapterContext } from "../src/adapters/index";
import type { ChangeRecord, ChangeType, SiteSecrets } from "../src/schema";

// ------------------------------------------------------------------ fake Shopify

interface Metafield {
  id: string;
  value: string;
  type: string;
  compareDigest: string;
}

class FakeShopify {
  scopes = ["write_products", "write_content", "write_online_store_navigation", "write_files", "read_themes"];
  homepageHtml = "<html><head><!-- seo-agent-jsonld --></head></html>";
  products: Record<string, { id: string; handle: string; title: string; seo: { title: string | null; description: string | null } }> = {
    "gid://shopify/Product/1": { id: "gid://shopify/Product/1", handle: "sunglasses", title: "Sunglasses", seo: { title: null, description: "Old desc" } },
  };
  collections: Record<string, { id: string; handle: string; seo: { title: string | null; description: string | null } }> = {
    "gid://shopify/Collection/2": { id: "gid://shopify/Collection/2", handle: "summer", seo: { title: null, description: null } },
  };
  pages = [
    { id: "gid://shopify/Page/3", handle: "about-us-old", body: "" },
    { id: "gid://shopify/Page/4", handle: "about", body: "<p>We sell shades since 1999.</p>" },
  ];
  blogs = [
    { id: "gid://shopify/Blog/5", handle: "news" },
    { id: "gid://shopify/Blog/6", handle: "guides" },
  ];
  articles = [
    { id: "gid://shopify/Article/7", handle: "uv-guide", blog: this.blogs[0]! },
    { id: "gid://shopify/Article/8", handle: "uv-guide", blog: this.blogs[1]! },
  ];
  media: Record<string, Array<{ id: string; alt: string | null; mediaContentType: string; image: { url: string }; fileStatus: string }>> = {
    "gid://shopify/Product/1": [
      { id: "gid://shopify/MediaImage/11", alt: "", mediaContentType: "IMAGE", image: { url: "https://cdn.shopify.com/s/files/1/0001/files/front.jpg?v=123" }, fileStatus: "READY" },
      { id: "gid://shopify/MediaImage/12", alt: "side", mediaContentType: "IMAGE", image: { url: "https://cdn.shopify.com/s/files/1/0001/files/side.jpg?v=9" }, fileStatus: "READY" },
    ],
  };
  metafields = new Map<string, Metafield>(); // `${owner}|${ns}.${key}`
  redirects: Array<{ id: string; path: string; target: string }> = [];
  shopId = "gid://shopify/Shop/99";

  calls: Array<{ op: string; variables: any }> = [];
  tokenRequests = 0;
  throttleNext = 0;
  failNext: Record<string, any[]> = {};
  private seq = 100;
  private digestSeq = 0;

  mfKey(owner: string, ns: string, key: string) {
    return `${owner}|${ns}.${key}`;
  }
  putMetafield(owner: string, ns: string, key: string, value: string, type: string) {
    const mf = { id: `gid://shopify/Metafield/${this.seq++}`, value, type, compareDigest: `d${++this.digestSeq}` };
    this.metafields.set(this.mfKey(owner, ns, key), mf);
    return mf;
  }
  /** Simulate a merchant edit in the admin. */
  merchantEdit(owner: string, ns: string, key: string, value: string) {
    const cur = this.metafields.get(this.mfKey(owner, ns, key));
    this.putMetafield(owner, ns, key, value, cur?.type ?? "single_line_text_field");
  }

  fetch: typeof fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/admin/oauth/access_token")) {
      this.tokenRequests++;
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("cid");
      expect(body.get("client_secret")).toBe("csecret");
      return json({ access_token: `tok${this.tokenRequests}`, scope: this.scopes.join(","), expires_in: 86399 });
    }
    if (url.includes("/admin/api/")) {
      expect(url).toBe("https://demo.myshopify.com/admin/api/2026-10/graphql.json");
      const body = JSON.parse(String(init?.body));
      this.lastToken = init?.headers?.["X-Shopify-Access-Token"];
      this.calls.push({ op: body.operationName, variables: body.variables });
      if (this.throttleNext > 0) {
        this.throttleNext--;
        return json({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: { cost: { requestedQueryCost: 52, actualQueryCost: null, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 2, restoreRate: 100 } } },
        });
      }
      const data = this.handle(body.operationName, body.variables ?? {});
      return json(
        { data, extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } } },
        { "x-shopify-api-version": "2026-10" },
      );
    }
    if (url === "https://shades.example/") return new Response(this.homepageHtml, { status: 200, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected fetch ${url}`);
  };
  lastToken: string | undefined;

  private ue(op: string): any[] {
    const e = this.failNext[op];
    if (e) {
      delete this.failNext[op];
      return e;
    }
    return [];
  }

  handle(op: string, v: any): any {
    switch (op) {
      case "ShopInfo":
        return {
          shop: { id: this.shopId, name: "Shades", myshopifyDomain: "demo.myshopify.com", primaryDomain: { url: "https://shades.example", host: "shades.example" }, plan: { publicDisplayName: "Basic", shopifyPlus: false, partnerDevelopment: false } },
          currentAppInstallation: { accessScopes: this.scopes.map((handle) => ({ handle })) },
        };
      case "AccessScopes":
        return { currentAppInstallation: { accessScopes: this.scopes.map((handle) => ({ handle })) } };
      case "ShopBasics":
        return { shop: { id: this.shopId, primaryDomain: { url: "https://shades.example" } } };
      case "ProductByHandle": {
        const p = Object.values(this.products).find((x) => x.handle === v.handle);
        return { productByIdentifier: p ? { id: p.id, handle: p.handle } : null };
      }
      case "CollectionByHandle": {
        const c = Object.values(this.collections).find((x) => x.handle === v.handle);
        return { collectionByIdentifier: c ? { id: c.id, handle: c.handle } : null };
      }
      case "PagesByHandle": {
        // Shopify search is fuzzy: return near matches too.
        const h = String(v.q).replace(/^handle:"?|"?$/g, "");
        return { pages: { nodes: this.pages.filter((p) => p.handle.includes(h)).map(({ id, handle }) => ({ id, handle })) } };
      }
      case "ArticlesByHandle": {
        const h = String(v.q).replace(/^handle:"?|"?$/g, "");
        return { articles: { nodes: this.articles.filter((a) => a.handle === h) } };
      }
      case "BlogsByHandle": {
        const h = String(v.q).replace(/^handle:"?|"?$/g, "");
        return { blogs: { nodes: this.blogs.filter((b) => b.handle === h) } };
      }
      case "ProductSeo": {
        const p = this.products[v.id];
        return { product: p ? { id: p.id, title: p.title, seo: { ...p.seo } } : null };
      }
      case "CollectionSeo": {
        const c = this.collections[v.id];
        return { collection: c ? { id: c.id, title: c.handle, seo: { ...c.seo } } : null };
      }
      case "ProductUpdateSeo": {
        const errs = this.ue(op);
        if (errs.length) return { productUpdate: { product: null, userErrors: errs } };
        const p = this.products[v.product.id]!;
        // Shopify semantics: fields omitted in SEOInput are cleared.
        p.seo = { title: v.product.seo.title ?? null, description: v.product.seo.description ?? null };
        return { productUpdate: { product: { id: p.id, seo: { ...p.seo } }, userErrors: [] } };
      }
      case "CollectionUpdateSeo": {
        const c = this.collections[v.collection.id]!;
        c.seo = { title: v.collection.seo.title ?? null, description: v.collection.seo.description ?? null };
        return { collectionUpdate: { collection: { id: c.id, seo: { ...c.seo } }, userErrors: [] } };
      }
      case "MetafieldRead":
        return { node: { id: v.id, metafield: this.metafields.get(this.mfKey(v.id, v.namespace, v.key)) ?? null } };
      case "ShopMetafieldRead":
        return { shop: { id: this.shopId, metafield: this.metafields.get(this.mfKey(this.shopId, v.namespace, v.key)) ?? null } };
      case "MetafieldsSet": {
        const errs = this.ue(op);
        if (errs.length) return { metafieldsSet: { metafields: null, userErrors: errs } };
        const out = [];
        for (const m of v.metafields) {
          const cur = this.metafields.get(this.mfKey(m.ownerId, m.namespace, m.key));
          if (m.compareDigest !== undefined) {
            const ok = m.compareDigest === null ? !cur : cur?.compareDigest === m.compareDigest;
            if (!ok)
              return {
                metafieldsSet: {
                  metafields: null,
                  userErrors: [{ field: ["metafields", "0", "compareDigest"], message: "The resource has been updated since it was loaded. Try again with an updated `compareDigest` value.", code: "STALE_OBJECT" }],
                },
              };
          }
          const mf = this.putMetafield(m.ownerId, m.namespace, m.key, m.value, m.type);
          out.push({ ...mf, namespace: m.namespace, key: m.key });
        }
        return { metafieldsSet: { metafields: out, userErrors: [] } };
      }
      case "MetafieldsDelete": {
        for (const m of v.metafields) {
          this.metafields.delete(this.mfKey(m.ownerId, m.namespace, m.key));
          // product/collection seo fields mirror global.* metafields
          const p = this.products[m.ownerId];
          if (p && m.namespace === "global") {
            if (m.key === "title_tag") p.seo.title = null;
            if (m.key === "description_tag") p.seo.description = null;
          }
        }
        return { metafieldsDelete: { deletedMetafields: v.metafields, userErrors: [] } };
      }
      case "ProductMedia":
        return { product: { id: v.id, media: { nodes: this.media[v.id] ?? [] } } };
      case "FileAlt": {
        const m = Object.values(this.media).flat().find((x) => x.id === v.id);
        return { node: m ? { id: m.id, alt: m.alt, image: m.image, fileStatus: m.fileStatus } : null };
      }
      case "FileUpdateAlt": {
        for (const f of v.files) {
          expect(Object.keys(f).sort()).toEqual(["alt", "id"]); // never referencesToRemove
          const m = Object.values(this.media).flat().find((x) => x.id === f.id)!;
          m.alt = f.alt;
        }
        return { fileUpdate: { files: v.files.map((f: any) => ({ id: f.id, alt: f.alt })), userErrors: [] } };
      }
      case "RedirectsByPath": {
        const p = String(v.q).replace(/^path:"?|"?$/g, "");
        return { urlRedirects: { nodes: this.redirects.filter((r) => r.path.startsWith(p)) } };
      }
      case "RedirectCreate": {
        const errs = this.ue(op);
        if (errs.length) return { urlRedirectCreate: { urlRedirect: null, userErrors: errs } };
        const r = { id: `gid://shopify/UrlRedirect/${this.seq++}`, path: v.urlRedirect.path, target: v.urlRedirect.target };
        this.redirects.push(r);
        return { urlRedirectCreate: { urlRedirect: r, userErrors: [] } };
      }
      case "RedirectUpdate": {
        const r = this.redirects.find((x) => x.id === v.id)!;
        Object.assign(r, v.urlRedirect);
        return { urlRedirectUpdate: { urlRedirect: r, userErrors: [] } };
      }
      case "RedirectDelete":
        this.redirects = this.redirects.filter((x) => x.id !== v.id);
        return { urlRedirectDelete: { deletedUrlRedirectId: v.id, userErrors: [] } };
      case "BodyRead": {
        const p = this.pages.find((x) => x.id === v.id);
        return { node: p ? { id: p.id, body: p.body } : null };
      }
      case "PageUpdateBody": {
        const p = this.pages.find((x) => x.id === v.id)!;
        p.body = v.page.body;
        return { pageUpdate: { page: { id: p.id, body: p.body }, userErrors: [] } };
      }
      default:
        throw new Error(`fake shopify: unhandled op ${op}`);
    }
  }
}

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

function setup(secretsOver: Partial<Extract<SiteSecrets, { platform: "shopify" }>> = {}, clock = { t: 0 }) {
  const fake = new FakeShopify();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const ctx: AdapterContext = {
    site: { id: "s1", url: "https://shades.example", platform: "shopify", config: {} },
    secrets: { platform: "shopify", shop: "demo.myshopify.com", access_token: "shpat_static", ...secretsOver },
    log: (level, message) => logs.push(`${level}: ${message}`),
    fetch: fake.fetch,
  };
  const adapter = createShopifyAdapter(ctx, { sleep: async (ms) => void sleeps.push(ms), now: () => clock.t });
  return { fake, adapter, logs, sleeps };
}

let n = 0;
function change(type: ChangeType, url: string, after: unknown, extra: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    id: `c${++n}`,
    site_id: "s1",
    type,
    target: { url },
    before: null,
    after,
    tier: "approve",
    risk_reasons: [],
    status: "approved",
    diff_hash: "x",
    ...extra,
  };
}

/** apply then attach rollback_data, the way the runner does. */
async function applyAndStore(adapter: ReturnType<typeof setup>["adapter"], c: ChangeRecord) {
  const res = await adapter.apply(c);
  return { res, stored: { ...c, rollback_data: JSON.parse(JSON.stringify(res.rollback)) } as ChangeRecord };
}

// ------------------------------------------------------------------ tests

describe("parseShopifyPath", () => {
  it("parses storefront paths", () => {
    expect(parseShopifyPath("https://x.com/products/a")).toEqual({ kind: "product", handle: "a" });
    expect(parseShopifyPath("/collections/summer/products/a")).toEqual({ kind: "product", handle: "a" });
    expect(parseShopifyPath("/collections/summer")).toEqual({ kind: "collection", handle: "summer" });
    expect(parseShopifyPath("/pages/about?x=1")).toEqual({ kind: "page", handle: "about" });
    expect(parseShopifyPath("/blogs/news/uv-guide")).toEqual({ kind: "article", blogHandle: "news", handle: "uv-guide" });
    expect(parseShopifyPath("/blogs/news")).toEqual({ kind: "blog", handle: "news" });
    expect(parseShopifyPath("/en-us/products/a")).toEqual({ kind: "product", handle: "a" });
    expect(parseShopifyPath("/fr/pages/about")).toEqual({ kind: "page", handle: "about" });
    expect(parseShopifyPath("/en-us")).toEqual({ kind: "site" });
    expect(parseShopifyPath("https://x.com/")).toEqual({ kind: "site" });
    expect(parseShopifyPath("/cart")).toBeNull();
    expect(parseShopifyPath("/collections/all")).toBeNull();
  });

  it("normalizes Shopify CDN image URLs", () => {
    expect(imageKey("//cdn.shopify.com/s/files/1/files/front_800x.jpg?v=1")).toBe("front.jpg");
    expect(imageKey("https://cdn.shopify.com/s/files/1/files/front.jpg?v=123")).toBe("front.jpg");
    expect(imageKey("/files/front_400x300_crop_center@2x.jpg")).toBe("front.jpg");
  });
});

describe("shopify adapter", () => {
  it("testConnection reports missing scopes and a missing theme snippet", async () => {
    const { fake, adapter } = setup();
    fake.scopes = ["write_products", "write_content", "read_themes"];
    fake.homepageHtml = "<html><head></head></html>";
    const r = await adapter.testConnection();
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ shop: "demo.myshopify.com", primary_domain: "https://shades.example", api_version: "2026-10" });
    expect(r.warnings.join("\n")).toMatch(/write_online_store_navigation/);
    expect(r.warnings.join("\n")).toMatch(/write_files/);
    expect(r.warnings.join("\n")).toMatch(/seo-agent-jsonld/);
    expect(r.warnings.some((w) => w.includes("write_products"))).toBe(false);
    const caps = await adapter.capabilities();
    expect(caps).not.toContain("redirect");
    expect(caps).not.toContain("image_alt");
    expect(caps).toContain("title");
  });

  it("testConnection is clean when everything is in place", async () => {
    const { adapter } = setup();
    const r = await adapter.testConnection();
    expect(r.warnings).toEqual([]);
    expect(await adapter.capabilities()).toEqual(
      expect.arrayContaining(["title", "meta_description", "robots_meta", "image_alt", "redirect", "jsonld_add", "jsonld_fix", "content_edit"]),
    );
  });

  it("resolves products, collections, pages, articles and locale prefixes", async () => {
    const { adapter } = setup();
    expect(await adapter.resolve("https://shades.example/products/sunglasses", "title")).toEqual({ kind: "product", id: "gid://shopify/Product/1", handle: "sunglasses" });
    expect(await adapter.resolve("https://shades.example/en-us/collections/summer/products/sunglasses", "title")).toMatchObject({ kind: "product", id: "gid://shopify/Product/1" });
    expect(await adapter.resolve("https://shades.example/collections/summer", "meta_description")).toMatchObject({ kind: "collection", id: "gid://shopify/Collection/2" });
    // fuzzy search returns "about-us-old" first; exact match wins
    expect(await adapter.resolve("https://shades.example/pages/about", "meta_description")).toMatchObject({ kind: "page", id: "gid://shopify/Page/4" });
    // same article handle in two blogs: blog handle decides
    expect(await adapter.resolve("https://shades.example/blogs/guides/uv-guide", "title")).toMatchObject({ kind: "article", id: "gid://shopify/Article/8" });
    expect(await adapter.resolve("https://shades.example/products/nope", "title")).toBeNull();
    // manual cases
    expect(await adapter.resolve("https://shades.example/", "title")).toBeNull();
    expect(await adapter.resolve("https://shades.example/products/sunglasses", "h1")).toBeNull();
    expect(await adapter.resolve("https://shades.example/products/sunglasses", "canonical")).toBeNull();
    // shop-level JSON-LD on the homepage
    expect(await adapter.resolve("https://shades.example/", "jsonld_add")).toEqual({ kind: "site", id: "gid://shopify/Shop/99" });
  });

  it("round-trips a product title (null = falls back to product name)", async () => {
    const { fake, adapter } = setup();
    const c = change("title", "https://shades.example/products/sunglasses", { value: "Matte Sunglasses | Shades" });
    expect(await adapter.read(c)).toEqual({ value: null });
    const { res, stored } = await applyAndStore(adapter, c);
    expect(res.written).toEqual({ value: "Matte Sunglasses | Shades" });
    expect(fake.products["gid://shopify/Product/1"]!.seo).toEqual({ title: "Matte Sunglasses | Shades", description: "Old desc" }); // description kept
    expect(await adapter.read(c)).toEqual({ value: "Matte Sunglasses | Shades" });
    const upd = fake.calls.find((x) => x.op === "ProductUpdateSeo")!;
    expect(upd.variables.product).toEqual({ id: "gid://shopify/Product/1", seo: { title: "Matte Sunglasses | Shades", description: "Old desc" } });
    await adapter.rollback(stored);
    expect(await adapter.read(c)).toEqual({ value: null });
    expect(fake.products["gid://shopify/Product/1"]!.seo.description).toBe("Old desc");
  });

  it("round-trips a product meta description", async () => {
    const { fake, adapter } = setup();
    const c = change("meta_description", "https://shades.example/products/sunglasses", { value: "New desc" });
    expect(await adapter.read(c)).toEqual({ value: "Old desc" });
    const { stored } = await applyAndStore(adapter, c);
    expect(fake.products["gid://shopify/Product/1"]!.seo.description).toBe("New desc");
    expect(stored.rollback_data).toMatchObject({ op: "seo_field", previous: "Old desc", written: "New desc" });
    await adapter.rollback(stored);
    expect(await adapter.read(c)).toEqual({ value: "Old desc" });
  });

  it("refuses product SEO rollback when a merchant edited it after apply", async () => {
    const { fake, adapter } = setup();
    const c = change("meta_description", "https://shades.example/products/sunglasses", { value: "New desc" });
    const { stored } = await applyAndStore(adapter, c);
    fake.products["gid://shopify/Product/1"]!.seo.description = "Merchant wrote this";
    await expect(adapter.rollback(stored)).rejects.toBeInstanceOf(ShopifyConcurrentEditError);
  });

  it("page meta description via metafields: create, then delete on rollback", async () => {
    const { fake, adapter } = setup();
    const c = change("meta_description", "https://shades.example/pages/about", { value: "About Shades" });
    expect(await adapter.read(c)).toEqual({ value: null });
    const { stored } = await applyAndStore(adapter, c);
    expect(stored.rollback_data).toMatchObject({ op: "metafield", existed: false, namespace: "global", key: "description_tag" });
    const set = fake.calls.find((x) => x.op === "MetafieldsSet")!;
    expect(set.variables.metafields[0]).toMatchObject({ ownerId: "gid://shopify/Page/4", namespace: "global", key: "description_tag", type: "single_line_text_field", compareDigest: null });
    expect(await adapter.read(c)).toEqual({ value: "About Shades" });
    await adapter.rollback(stored);
    expect(fake.metafields.has("gid://shopify/Page/4|global.description_tag")).toBe(false);
    expect(fake.calls.some((x) => x.op === "MetafieldsDelete")).toBe(true);
  });

  it("page title via metafields: restore previous value when it existed", async () => {
    const { fake, adapter } = setup();
    fake.putMetafield("gid://shopify/Page/4", "global", "title_tag", "Old title", "single_line_text_field");
    const c = change("title", "https://shades.example/pages/about", { value: "New title" });
    const { stored } = await applyAndStore(adapter, c);
    expect(stored.rollback_data).toMatchObject({ existed: true, previous: "Old title" });
    await adapter.rollback(stored);
    expect(fake.metafields.get("gid://shopify/Page/4|global.title_tag")!.value).toBe("Old title");
  });

  it("detects a concurrent merchant edit via compareDigest", async () => {
    const { fake, adapter } = setup();
    fake.putMetafield("gid://shopify/Page/4", "global", "title_tag", "Old title", "single_line_text_field");
    // Merchant edits between the adapter's read and its write.
    const orig = fake.handle.bind(fake);
    let once = true;
    fake.handle = (op, v) => {
      if (op === "MetafieldsSet" && once) {
        once = false;
        fake.merchantEdit("gid://shopify/Page/4", "global", "title_tag", "Merchant title");
      }
      return orig(op, v);
    };
    const c = change("title", "https://shades.example/pages/about", { value: "New title" });
    await expect(adapter.apply(c)).rejects.toThrow(/edited in Shopify after the agent read it/);
    expect(fake.metafields.get("gid://shopify/Page/4|global.title_tag")!.value).toBe("Merchant title");
  });

  it("robots_meta noindex via seo.hidden and back", async () => {
    const { fake, adapter } = setup();
    const c = change("robots_meta", "https://shades.example/collections/summer", { index: false, follow: false });
    expect(await adapter.read(c)).toEqual({ index: true, follow: true });
    const { stored } = await applyAndStore(adapter, c);
    expect(fake.metafields.get("gid://shopify/Collection/2|seo.hidden")).toMatchObject({ value: "1", type: "number_integer" });
    expect(await adapter.read(c)).toEqual({ index: false, follow: false });
    await adapter.rollback(stored);
    expect(fake.metafields.has("gid://shopify/Collection/2|seo.hidden")).toBe(false);

    // index again = delete; rollback recreates
    fake.putMetafield("gid://shopify/Collection/2", "seo", "hidden", "1", "number_integer");
    const c2 = change("robots_meta", "https://shades.example/collections/summer", { index: true, follow: true });
    const r2 = await applyAndStore(adapter, c2);
    expect(fake.metafields.has("gid://shopify/Collection/2|seo.hidden")).toBe(false);
    await adapter.rollback(r2.stored);
    expect(fake.metafields.get("gid://shopify/Collection/2|seo.hidden")!.value).toBe("1");
  });

  it("image_alt round trip via fileUpdate (id + alt only)", async () => {
    const { fake, adapter } = setup();
    const c = change("image_alt", "https://shades.example/products/sunglasses", {
      src: "//shades.example/cdn/shop/files/front_800x.jpg?v=123",
      alt: "Matte black aviator sunglasses, front view",
    });
    expect(await adapter.read(c)).toMatchObject({ alt: null, media_id: "gid://shopify/MediaImage/11" });
    const { stored } = await applyAndStore(adapter, c);
    expect(fake.media["gid://shopify/Product/1"]![0]!.alt).toBe("Matte black aviator sunglasses, front view");
    await adapter.rollback(stored);
    expect(fake.media["gid://shopify/Product/1"]![0]!.alt).toBe("");
    // image not in product media → manual
    const bad = change("image_alt", "https://shades.example/products/sunglasses", { src: "/files/banner.jpg", alt: "x" });
    await expect(adapter.apply(bad)).rejects.toThrow(/manual/);
  });

  it("redirect create + rollback deletes it; existing redirect is updated and restored", async () => {
    const { fake, adapter } = setup();
    const c = change("redirect", "https://shades.example/products/old", { from_path: "/products/old", to_url: "https://shades.example/products/sunglasses", code: 301 });
    expect(await adapter.read(c)).toBeNull();
    const { res, stored } = await applyAndStore(adapter, c);
    expect(fake.redirects).toEqual([{ id: expect.any(String), path: "/products/old", target: "/products/sunglasses" }]);
    expect(res.rollback).toMatchObject({ action: "created" });
    expect(await adapter.read(c)).toEqual({ from_path: "/products/old", to_url: "/products/sunglasses", code: 301 });
    await adapter.rollback(stored);
    expect(fake.redirects).toEqual([]);

    fake.redirects.push({ id: "gid://shopify/UrlRedirect/1", path: "/pages/x", target: "/pages/y" });
    const c2 = change("redirect", "https://shades.example/pages/x", { from_path: "/pages/x", to_url: "https://shades.example/pages/about", code: 301 });
    const r2 = await applyAndStore(adapter, c2);
    expect(r2.res.rollback).toMatchObject({ action: "updated", previous_target: "/pages/y" });
    expect(fake.calls.some((x) => x.op === "RedirectCreate" && x.variables.urlRedirect.path === "/pages/x")).toBe(false);
    await adapter.rollback(r2.stored);
    expect(fake.redirects[0]!.target).toBe("/pages/y");
  });

  it("jsonld_add replaces a block of the same @type and keeps others; rollback restores", async () => {
    const { fake, adapter } = setup();
    const owner = "gid://shopify/Product/1";
    const original = JSON.stringify([
      { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] },
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ old: true }] },
    ]);
    fake.putMetafield(owner, "seo_agent", "jsonld", original, "json");
    const c = change("jsonld_add", "https://shades.example/products/sunglasses", {
      schema_type: "FAQPage",
      schema: { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Polarized?" }] },
    });
    expect(await adapter.read(c)).toMatchObject({ schema_type: "FAQPage", schema: { mainEntity: [{ old: true }] } });
    const { stored } = await applyAndStore(adapter, c);
    const after = JSON.parse(fake.metafields.get(`${owner}|seo_agent.jsonld`)!.value);
    expect(after).toHaveLength(2);
    expect(after.map((b: any) => b["@type"])).toEqual(["BreadcrumbList", "FAQPage"]);
    expect(after[1]).toEqual({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Polarized?" }] });
    await adapter.rollback(stored);
    expect(fake.metafields.get(`${owner}|seo_agent.jsonld`)!.value).toBe(original);
  });

  it("jsonld_add on the homepage uses the shop metafield and deletes on rollback", async () => {
    const { fake, adapter } = setup();
    const c = change("jsonld_add", "https://shades.example/", { schema_type: "Organization", schema: { name: "Shades" } });
    const { stored } = await applyAndStore(adapter, c);
    expect(JSON.parse(fake.metafields.get(`${fake.shopId}|seo_agent.jsonld`)!.value)).toEqual([
      { name: "Shades", "@context": "https://schema.org", "@type": "Organization" },
    ]);
    await adapter.rollback(stored);
    expect(fake.metafields.has(`${fake.shopId}|seo_agent.jsonld`)).toBe(false);
  });

  it("refuses JSON-LD that could break out of the script tag", async () => {
    const { adapter } = setup();
    const c = change("jsonld_add", "https://shades.example/pages/about", { schema_type: "WebPage", schema: { name: "</script><script>alert(1)</script>" } });
    await expect(adapter.apply(c)).rejects.toThrow(/script/);
  });

  it("content_edit on a page requires an exact single match", async () => {
    const { fake, adapter } = setup();
    const c = change("content_edit", "https://shades.example/pages/about", { instructions: "fix year", find: "since 1999", replace: "since 1998" });
    const { stored } = await applyAndStore(adapter, c);
    expect(fake.pages[1]!.body).toBe("<p>We sell shades since 1998.</p>");
    await adapter.rollback(stored);
    expect(fake.pages[1]!.body).toBe("<p>We sell shades since 1999.</p>");
    await expect(adapter.apply(change("content_edit", "https://shades.example/pages/about", { instructions: "x", find: "nope", replace: "y" }))).rejects.toThrow(/0 times/);
    await expect(adapter.apply(change("content_edit", "https://shades.example/pages/about", { instructions: "rewrite intro" }))).rejects.toThrow(/manual/);
  });

  it("unsupported types are manual", async () => {
    const { adapter } = setup();
    await expect(adapter.apply(change("h1", "https://shades.example/products/sunglasses", { value: "x" }))).rejects.toThrow(/manual/);
    await expect(adapter.apply(change("robots_txt", "https://shades.example/robots.txt", { content: "x" }))).rejects.toThrow(/manual/);
    await expect(adapter.apply(change("title", "https://shades.example/", { value: "Home" }))).rejects.toThrow(/manual/);
  });

  it("retries THROTTLED responses with backoff", async () => {
    const { fake, adapter, sleeps } = setup();
    fake.throttleNext = 2;
    const c = change("title", "https://shades.example/products/sunglasses", { value: "x" });
    expect(await adapter.read(c)).toEqual({ value: null });
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]! - 1); // non-decreasing (exponential)
    expect(fake.calls.filter((x) => x.op === "ProductByHandle")).toHaveLength(3);
  });

  it("gives up after max attempts when always throttled", async () => {
    const { fake, adapter } = setup();
    fake.throttleNext = 100;
    await expect(adapter.resolve("https://shades.example/products/sunglasses", "title")).rejects.toThrow(/THROTTLED/);
  });

  it("surfaces userErrors with field and message", async () => {
    const { fake, adapter } = setup();
    fake.failNext.RedirectCreate = [{ field: ["urlRedirect", "path"], message: "Path has already been taken", code: "TAKEN" }];
    const c = change("redirect", "https://shades.example/a", { from_path: "/a", to_url: "https://shades.example/pages/about", code: 301 });
    await expect(adapter.apply(c)).rejects.toThrow("urlRedirect.path: Path has already been taken");
    fake.failNext.ProductUpdateSeo = [{ field: ["seo", "title"], message: "is too long" }];
    await expect(adapter.apply(change("title", "https://shades.example/products/sunglasses", { value: "x" }))).rejects.toThrow("seo.title: is too long");
  });

  it("client credentials: fetches a token once and caches it until 5 min before expiry", async () => {
    const clock = { t: 0 };
    const { fake, adapter } = setup({ access_token: undefined, client_id: "cid", client_secret: "csecret" }, clock);
    await adapter.resolve("https://shades.example/products/sunglasses", "title");
    await adapter.resolve("https://shades.example/collections/summer", "title");
    expect(fake.tokenRequests).toBe(1);
    expect(fake.lastToken).toBe("tok1");
    clock.t = (86399 - 301) * 1000; // still valid
    await adapter.resolve("https://shades.example/pages/about", "title");
    expect(fake.tokenRequests).toBe(1);
    clock.t = (86399 - 299) * 1000; // inside the 5-minute window → refresh
    await adapter.resolve("https://shades.example/pages/about", "title");
    expect(fake.tokenRequests).toBe(2);
    expect(fake.lastToken).toBe("tok2");
  });

  it("uses the configured API version and the static token", async () => {
    const fake = new FakeShopify();
    const urls: string[] = [];
    const adapter = createShopifyAdapter({
      site: { id: "s", url: "https://shades.example", platform: "shopify", config: { shopify_api_version: "2026-07" } },
      secrets: { platform: "shopify", shop: "demo", access_token: "shpat_x" },
      log: () => {},
      fetch: (async (u: any, init: any) => {
        urls.push(String(u));
        expect(init.headers["X-Shopify-Access-Token"]).toBe("shpat_x");
        return json({ data: fake.handle(JSON.parse(init.body).operationName, JSON.parse(init.body).variables) });
      }) as typeof fetch,
    });
    await adapter.resolve("https://shades.example/products/sunglasses", "title");
    expect(urls[0]).toBe("https://demo.myshopify.com/admin/api/2026-07/graphql.json");
  });

  it("purge is a no-op", async () => {
    const { adapter, logs } = setup();
    await adapter.purge!(["https://shades.example/products/sunglasses"]);
    expect(logs.some((l) => l.startsWith("debug:"))).toBe(true);
  });
});
