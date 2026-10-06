/**
 * WordPress adapter (REST API + Application Passwords).
 *
 * Write channels, in order of preference:
 *   1. The companion mu-plugin "seo-agent-bridge" (`seo-agent/v1`): one normalized surface for SEO
 *      meta, JSON-LD, redirects, robots.txt / llms.txt and cache purge, with exact read-back.
 *   2. SEO plugin REST surfaces: SEOPress (`/wp/v2` registered meta, exact), Rank Math
 *      (`rankmath/v1/updateMeta`), Yoast (`/wp/v2/posts` meta for posts, bulk editor for other types).
 *   3. Core `/wp/v2` content edits (h1, image alt, content edits, internal links) on `content.raw`.
 *   4. The Redirection plugin (`redirection/v1`) for redirects when the bridge is absent.
 *
 * ResourceRef encoding used by this adapter: `id` is `<rest_base>/<numeric id>`, e.g. "posts/12",
 * "pages/7", "product/99". `{ kind: "site", id: "front" }` is a homepage that shows latest posts
 * (no post object). `{ kind: "site" }` is used for site-wide changes (redirect, robots/llms.txt).
 *
 * rollback_data shape: `{ v: 1, channel, ref?, previous, ... }` (see the RB_* interfaces below).
 */
import type { ApplyResult, ChangeRecord, ChangeType, ConnectionResult, ResourceRef, SiteAdapter } from "../schema";
import type { AdapterContext } from "./index";
import { fetchSnapshot, fetchText } from "../page";
import { findImage } from "../verify";

const UA = "SEOAutopilot/0.1 (+wordpress-adapter)";

// ------------------------------------------------------------------ errors

export class WordPressError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "WordPressError";
  }
}

export const HTACCESS_HINT =
  'The server is probably stripping the Authorization header. Add this to .htaccess above the "# BEGIN WordPress" block: ' +
  '`SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1` (or `RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]`). ' +
  "On nginx/php-fpm add `fastcgi_param HTTP_AUTHORIZATION $http_authorization;`.";

// ------------------------------------------------------------------ options

export interface WordPressAdapterOptions {
  /** Minimum gap between request starts. Default 500 ms (about 2 req/s). */
  minIntervalMs?: number;
  /** Retries on 429/503 and network errors. Default 3. */
  maxRetries?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

// ------------------------------------------------------------------ internal types

type SeoPlugin = "yoast" | "rankmath" | "seopress" | "aioseo";

interface Detection {
  restRoot: string;          // e.g. https://site/wp-json/  (pretty mode)
  restMode: "pretty" | "query";
  namespaces: string[];
  routes: string[];
  seoPlugins: SeoPlugin[];
  primarySeo: SeoPlugin | null;
  bridge: BridgeStatus | null;
  redirection: boolean;
}

interface BridgeStatus {
  version: string;
  seo_plugin: string;          // yoast | rankmath | seopress | aioseo | none
  blog_public: boolean;
  physical_robots: boolean;
  physical_llms: boolean;
  redirection_plugin: boolean;
  caching: string[];
  wp_version?: string;
  [k: string]: unknown;
}

/** Normalized SEO fields (bridge vocabulary). null / "" = unset (plugin default). */
interface SeoFields {
  title?: string | null;
  description?: string | null;
  canonical?: string | null;
  robots?: { index: boolean | null; follow: boolean | null } | null;
  og_title?: string | null;
  og_description?: string | null;
  og_image?: string | null;
  jsonld?: Array<Record<string, unknown>> | null;
}

type SeoChannel = "bridge" | "seopress" | "rankmath" | "yoast-meta" | "yoast-bulk";

interface ParsedRef {
  base: string;     // rest base: posts, pages, product...
  id: number;       // 0 = front page showing posts
  front: boolean;
}

interface RB_Seo {
  v: 1;
  channel: SeoChannel;
  ref: string;
  previous: SeoFields;
  /** false when the plugin's stored value could not be read and the rendered value was saved instead. */
  exact: boolean;
}
interface RB_Core {
  v: 1;
  channel: "core";
  ref: string;
  previous: { content?: string; title?: string };
  written: { content?: string; title?: string };
  media?: { id: number; alt_text: string };
}
interface RB_Redirect {
  v: 1;
  channel: "bridge-redirect" | "redirection";
  from_path: string;
  previous: { to_url: string; code: number } | null;
  /** Redirection plugin: id of the item we created or updated. */
  item_id?: number;
}
interface RB_File {
  v: 1;
  channel: "bridge-file";
  file: "robots" | "llms";
  previous: string;
}
type RollbackData = RB_Seo | RB_Core | RB_Redirect | RB_File;

const SEO_TYPES = new Set<ChangeType>(["title", "meta_description", "canonical", "robots_meta", "og_tags"]);
const SITE_TYPES = new Set<ChangeType>(["redirect", "robots_txt", "llms_txt"]);
const NEVER_TYPES = new Set<ChangeType>(["slug", "hreflang", "code_change"]);

// ------------------------------------------------------------------ small helpers

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function decodeBasic(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}
function stripTags(s: string): string {
  return decodeBasic(s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
function normPath(u: string): string {
  try {
    const x = new URL(u);
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + x.search).toLowerCase();
  } catch {
    return u.toLowerCase().replace(/\/+$/, "");
  }
}
/** Image URL key: path without size suffix / -scaled, lowercased. */
function imageKey(src: string, base: string): string {
  let p: string;
  try {
    p = new URL(src, base).pathname;
  } catch {
    p = src.split(/[?#]/)[0];
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep */
  }
  return p
    .toLowerCase()
    .replace(/-\d+x\d+(?=\.[a-z0-9]+$)/, "")
    .replace(/-scaled(?=\.[a-z0-9]+$)/, "");
}
function fileStem(src: string): string {
  const k = imageKey(src, "http://x/");
  const name = k.slice(k.lastIndexOf("/") + 1);
  return name.replace(/\.[a-z0-9]+$/, "");
}
function getAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return decodeBasic(m[2] ?? m[3] ?? m[4] ?? "");
}
function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  const v = `${name}="${escAttr(value)}"`;
  if (re.test(tag)) return tag.replace(re, (_m, sp: string) => `${sp}${v}`);
  return tag.replace(/^<img\b/i, `<img ${v}`);
}
function parseLinkHeader(h: string | null): Array<{ url: string; rel: string; type?: string }> {
  if (!h) return [];
  const out: Array<{ url: string; rel: string; type?: string }> = [];
  for (const part of h.split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (!m) continue;
    const params = m[2];
    const rel = /rel\s*=\s*"?([^";]+)"?/i.exec(params)?.[1] ?? "";
    const type = /type\s*=\s*"?([^";]+)"?/i.exec(params)?.[1];
    out.push({ url: m[1], rel, type });
  }
  return out;
}
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim() === "" ? null : s;
}

// ------------------------------------------------------------------ factory

export function createWordPressAdapter(ctx: AdapterContext, options: WordPressAdapterOptions = {}): SiteAdapter {
  if (ctx.secrets.platform !== "wordpress") throw new Error("createWordPressAdapter needs WordPress secrets");
  const secrets = ctx.secrets;
  const doFetch = ctx.fetch ?? globalThis.fetch;
  const siteUrl = ctx.site.url.replace(/\/+$/, "");
  const origin = new URL(siteUrl).origin;
  const auth = "Basic " + Buffer.from(`${secrets.username}:${secrets.app_password}`).toString("base64");
  const minInterval = options.minIntervalMs ?? 500;
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = ctx.log ?? (() => {});

  // ---------------------------------------------------------------- rate-limited HTTP
  let nextSlot = 0;
  async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minInterval;
    if (wait > 0) await sleep(wait);
  }

  async function rawFetch(url: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
    let attempt = 0;
    for (;;) {
      await throttle();
      let res: Response;
      try {
        res = await doFetch(url, {
          ...init,
          redirect: init.redirect ?? "follow",
          headers: {
            "User-Agent": UA,
            Accept: "application/json, */*;q=0.5",
            ...(withAuth ? { Authorization: auth } : {}),
            ...((init.headers as Record<string, string>) ?? {}),
          },
        });
      } catch (e) {
        if (attempt >= maxRetries) throw new WordPressError(`Network error calling ${url}: ${(e as Error).message}`, 0, "network");
        await sleep(1000 * 2 ** attempt++);
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : 1000 * 2 ** attempt;
        log("warn", `WordPress returned ${res.status} for ${url}; retrying in ${delay} ms`);
        attempt++;
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        await sleep(delay);
        continue;
      }
      return res;
    }
  }

  // ---------------------------------------------------------------- REST URL building + discovery
  let det: Detection | null = null;
  let detPromise: Promise<Detection> | null = null;
  let restRoot = `${origin}/wp-json/`;
  let restMode: "pretty" | "query" = "pretty";

  function restUrl(route: string, query?: Record<string, string | number | boolean | undefined>): string {
    const r = route.startsWith("/") ? route : `/${route}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const q = qs.toString();
    if (restMode === "query") return `${origin}/?rest_route=${encodeURIComponent(r).replace(/%2F/g, "/")}${q ? `&${q}` : ""}`;
    return `${restRoot.replace(/\/+$/, "")}${r}${q ? `?${q}` : ""}`;
  }

  async function errorFrom(res: Response, url: string): Promise<WordPressError> {
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    let code: string | undefined;
    let message: string | undefined;
    if (ct.includes("json") || /^\s*[{[]/.test(text)) {
      try {
        body = JSON.parse(text);
        code = (body as { code?: string }).code;
        message = (body as { message?: string }).message;
      } catch {
        /* not JSON */
      }
    }
    const route = url.replace(origin, "");
    if (res.status === 401) {
      if (code === "incorrect_password" || code === "invalid_username" || code === "invalid_email")
        return new WordPressError(
          `WordPress rejected the Application Password for "${secrets.username}" (${code}). Check the username and password, and that Application Passwords are not disabled by a security plugin.`,
          401, code, body,
        );
      return new WordPressError(
        `WordPress returned 401 ${code ?? ""} for ${route}: the request arrived unauthenticated. ${HTACCESS_HINT}`.replace(/\s+/g, " "),
        401, code, body,
      );
    }
    if (res.status === 403 && !ct.includes("json") && /<html|<!doctype/i.test(text)) {
      return new WordPressError(
        `Blocked by a firewall/WAF: ${route} returned 403 with an HTML page instead of JSON (Cloudflare, Wordfence, Sucuri, host WAF...). Allowlist the runner's IP or the "${UA}" user agent for /wp-json/*.`,
        403, "waf_block", text.slice(0, 500),
      );
    }
    if (code === "rest_disabled" || code === "rest_cannot_access" || code === "rest_login_required") {
      return new WordPressError(`The WordPress REST API is disabled or restricted (${code}): ${message ?? ""}. Allow REST access for authenticated users.`, res.status, code, body);
    }
    if (res.status === 403) {
      return new WordPressError(`Permission denied for ${route} (${code ?? 403}): ${message ?? "the user lacks the needed capability"}.`, 403, code, body);
    }
    return new WordPressError(`WordPress ${res.status} for ${route}: ${message ?? String(text).slice(0, 300)}`, res.status, code, body);
  }

  async function api<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    route: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; allow404?: boolean } = {},
  ): Promise<T> {
    if (!det) await detect();
    const url = restUrl(route, opts.query);
    const res = await rawFetch(url, {
      method,
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (opts.allow404 && res.status === 404) return null as T;
    if (!res.ok) throw await errorFrom(res, url);
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new WordPressError(
        `Expected JSON from ${route} but got ${text.slice(0, 80).replace(/\s+/g, " ")}... (a cache, firewall or PHP notice may be interfering).`,
        res.status, "invalid_json",
      );
    }
  }

  async function getRootIndex(url: string): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; res?: Response; err?: WordPressError }> {
    const res = await rawFetch(url, { method: "GET" });
    if (!res.ok) return { ok: false, res };
    const text = await res.text();
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (data && Array.isArray(data.namespaces)) return { ok: true, data };
    } catch {
      /* fallthrough */
    }
    return { ok: false };
  }

  async function detect(force = false): Promise<Detection> {
    if (det && !force) return det;
    if (detPromise && !force) return detPromise;
    detPromise = (async () => {
      // 1. Link header discovery on the home page.
      let discovered: string | null = null;
      try {
        const res = await rawFetch(`${siteUrl}/`, { method: "HEAD" }, false);
        const link = parseLinkHeader(res.headers.get("link")).find((l) => l.rel === "https://api.w.org/");
        if (link) discovered = link.url;
      } catch {
        /* ignore, fall back */
      }
      const candidates: Array<{ root: string; mode: "pretty" | "query" }> = [];
      if (discovered) {
        if (/[?&]rest_route=/.test(discovered)) candidates.push({ root: discovered, mode: "query" });
        else candidates.push({ root: discovered.endsWith("/") ? discovered : discovered + "/", mode: "pretty" });
      }
      candidates.push({ root: `${origin}/wp-json/`, mode: "pretty" });
      candidates.push({ root: `${origin}/?rest_route=/`, mode: "query" });

      let index: Record<string, unknown> | null = null;
      let lastErr: WordPressError | null = null;
      const seen = new Set<string>();
      for (const c of candidates) {
        if (seen.has(c.root)) continue;
        seen.add(c.root);
        const url = c.mode === "query" ? `${origin}/?rest_route=/` : c.root;
        const r = await getRootIndex(url);
        if (r.ok) {
          index = r.data;
          restRoot = c.root;
          restMode = c.mode;
          break;
        }
        if (r.res) {
          const e = await errorFrom(r.res, url);
          if (e.code === "waf_block" || e.status === 401) lastErr = e;
          else lastErr = lastErr ?? e;
          if (e.code === "waf_block") break;
        }
      }
      if (!index) {
        if (lastErr && (lastErr.code === "waf_block" || lastErr.status === 401 || lastErr.code?.startsWith("rest_"))) throw lastErr;
        throw new WordPressError(
          `Could not reach the WordPress REST API at ${origin}/wp-json/ or ${origin}/?rest_route=/. The REST API may be disabled by a plugin or the site is not WordPress.`,
          lastErr?.status ?? 404, "rest_unavailable",
        );
      }
      const namespaces = (index.namespaces as string[]) ?? [];
      const routes = Object.keys((index.routes as Record<string, unknown>) ?? {});
      const seoPlugins: SeoPlugin[] = [];
      if (namespaces.includes("yoast/v1")) seoPlugins.push("yoast");
      if (namespaces.includes("rankmath/v1")) seoPlugins.push("rankmath");
      if (namespaces.includes("seopress/v1")) seoPlugins.push("seopress");
      if (namespaces.includes("aioseo/v1")) seoPlugins.push("aioseo");
      const d: Detection = {
        restRoot, restMode, namespaces, routes, seoPlugins,
        primarySeo: seoPlugins[0] ?? null,
        bridge: null,
        redirection: namespaces.includes("redirection/v1"),
      };
      det = d;
      if (namespaces.includes("seo-agent/v1")) {
        try {
          d.bridge = await api<BridgeStatus>("GET", "/seo-agent/v1/status");
          const bp = d.bridge?.seo_plugin as SeoPlugin | "none" | undefined;
          if (bp && bp !== "none") d.primarySeo = bp;
          if (d.bridge?.redirection_plugin) d.redirection = true;
        } catch (e) {
          log("warn", `seo-agent-bridge is installed but /status failed: ${(e as Error).message}`);
          d.bridge = null;
        }
      }
      return d;
    })();
    try {
      return await detPromise;
    } catch (e) {
      detPromise = null;
      det = null;
      throw e;
    }
  }

  // ---------------------------------------------------------------- capabilities
  function seoChannelFor(type: ChangeType, ref: ParsedRef | null, d: Detection): SeoChannel | null {
    if (d.bridge) return "bridge";
    if (ref?.front) return null;
    const p = d.primarySeo;
    if (p === "seopress") return "seopress";
    if (p === "rankmath") return "rankmath";
    if (p === "yoast") {
      if (type !== "title" && type !== "meta_description") return null;
      if (!ref || ref.base === "posts") return "yoast-meta";
      const hasBulk = d.routes.some((r) => r.includes("bulk_editor/update_search"));
      return hasBulk ? "yoast-bulk" : null;
    }
    return null;
  }

  async function capabilities(): Promise<ChangeType[]> {
    const d = await detect();
    const caps = new Set<ChangeType>(["h1", "image_alt", "content_edit", "internal_link"]);
    const p = d.primarySeo;
    if (d.bridge) {
      for (const t of ["title", "meta_description", "canonical", "robots_meta", "og_tags", "jsonld_add", "jsonld_fix", "redirect", "robots_txt", "llms_txt"] as ChangeType[]) caps.add(t);
    } else {
      if (p === "seopress" || p === "rankmath") for (const t of ["title", "meta_description", "canonical", "robots_meta", "og_tags"] as ChangeType[]) caps.add(t);
      if (p === "yoast") {
        caps.add("title");
        caps.add("meta_description");
      }
      if (d.redirection) caps.add("redirect");
    }
    return [...caps];
  }

  // ---------------------------------------------------------------- refs
  function encodeRef(base: string, id: number): ResourceRef {
    return { kind: base === "pages" ? "page" : base === "media" ? "media" : "post", id: `${base}/${id}` };
  }
  function parseRef(ref: ResourceRef | undefined | null): ParsedRef | null {
    if (!ref) return null;
    if (ref.kind === "site" && ref.id === "front") return { base: "front", id: 0, front: true };
    if (!ref.id) return null;
    const m = /^([a-z0-9_-]+)\/(\d+)$/i.exec(ref.id);
    if (m) return { base: m[1], id: Number(m[2]), front: false };
    if (/^\d+$/.test(ref.id)) return { base: ref.kind === "page" ? "pages" : ref.kind === "media" ? "media" : "posts", id: Number(ref.id), front: false };
    return null;
  }
  function refString(p: ParsedRef): string {
    return p.front ? "front" : `${p.base}/${p.id}`;
  }
  function refFromString(s: string): ParsedRef {
    if (s === "front") return { base: "front", id: 0, front: true };
    const [base, id] = s.split("/");
    return { base, id: Number(id), front: false };
  }

  let typesCache: Array<{ slug: string; rest_base: string }> | null = null;
  async function postTypes(): Promise<Array<{ slug: string; rest_base: string }>> {
    if (typesCache) return typesCache;
    const types = await api<Record<string, { slug: string; rest_base?: string; viewable?: boolean; rest_namespace?: string }>>("GET", "/wp/v2/types", {
      query: { context: "edit" },
    }).catch(() => null);
    const out: Array<{ slug: string; rest_base: string }> = [
      { slug: "post", rest_base: "posts" },
      { slug: "page", rest_base: "pages" },
    ];
    for (const t of Object.values(types ?? {})) {
      if (!t?.rest_base || ["attachment", "post", "page", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "nav_menu_item", "wp_global_styles", "wp_font_family", "wp_font_face"].includes(t.slug)) continue;
      if (t.viewable === false) continue;
      if (t.rest_namespace && t.rest_namespace !== "wp/v2") continue;
      out.push({ slug: t.slug, rest_base: t.rest_base });
    }
    typesCache = out;
    return out;
  }
  async function baseForType(type: string): Promise<string> {
    const ts = await postTypes();
    return ts.find((t) => t.slug === type)?.rest_base ?? (type === "page" ? "pages" : type === "post" ? "posts" : type);
  }

  async function resolveUrl(url: string): Promise<ParsedRef | null> {
    const d = await detect();
    let path = "/";
    try {
      path = new URL(url).pathname;
    } catch {
      /* keep */
    }
    // 1. Bridge (url_to_postid, knows the front page)
    if (d.bridge) {
      const r = await api<{ id: number; type: string | null; rest_base?: string | null; front?: boolean }>("GET", "/seo-agent/v1/resolve", { query: { url } }).catch(() => null);
      if (r?.front) return { base: "front", id: 0, front: true };
      if (r && r.id > 0) return { base: r.rest_base || (await baseForType(r.type ?? "post")), id: r.id, front: false };
    }
    // 2. Homepage via settings
    if (path === "/" || path === "") {
      const s = await api<{ show_on_front?: string; page_on_front?: number }>("GET", "/wp/v2/settings").catch(() => null);
      if (s?.show_on_front === "page" && s.page_on_front) return { base: "pages", id: s.page_on_front, front: false };
      if (s?.show_on_front === "posts") return d.bridge ? { base: "front", id: 0, front: true } : null;
    }
    // 3. rel=alternate Link header on the page itself
    try {
      const res = await rawFetch(url, { method: "HEAD" }, false);
      const alt = parseLinkHeader(res.headers.get("link")).find((l) => l.rel === "alternate" && (l.type ?? "").includes("json"));
      const m = alt && /\/wp\/v2\/([a-z0-9_-]+)\/(\d+)/i.exec(decodeURIComponent(alt.url));
      if (m && m[1] !== "users" && m[1] !== "categories" && m[1] !== "tags") return { base: m[1], id: Number(m[2]), front: false };
    } catch {
      /* fall through */
    }
    // 4. slug search over posts, pages and public CPTs, matching `link`
    const seg = path.replace(/\/+$/, "").split("/").pop();
    if (!seg) return null;
    const want = normPath(url);
    for (const t of await postTypes()) {
      const items = await api<Array<{ id: number; link: string }>>("GET", `/wp/v2/${t.rest_base}`, {
        query: { slug: decodeURIComponent(seg), status: "any", _fields: "id,link", per_page: 20 },
      }).catch(() => null);
      const hit = (items ?? []).find((i) => normPath(i.link) === want);
      if (hit) return { base: t.rest_base, id: hit.id, front: false };
    }
    return null;
  }

  async function resolve(url: string, type: ChangeType): Promise<ResourceRef | null> {
    if (SITE_TYPES.has(type)) return { kind: "site" };
    const p = await resolveUrl(url);
    if (!p) return null;
    if (p.front) return { kind: "site", id: "front" };
    return encodeRef(p.base, p.id);
  }

  async function refFor(change: Pick<ChangeRecord, "type" | "target">): Promise<ParsedRef> {
    const p = parseRef(change.target.resource) ?? (await resolveUrl(change.target.url));
    if (!p) throw new WordPressError(`Could not map ${change.target.url} to a WordPress post, page or custom post type`, 404, "unresolved");
    return p;
  }

  // ---------------------------------------------------------------- SEO meta channels
  interface WpPost {
    id: number;
    link?: string;
    title?: { raw?: string; rendered?: string };
    content?: { raw?: string; rendered?: string };
    meta?: Record<string, unknown>;
  }
  async function getPost(ref: ParsedRef, fields = "id,link,title,content,meta"): Promise<WpPost> {
    return api<WpPost>("GET", `/wp/v2/${ref.base}/${ref.id}`, { query: { context: "edit", _fields: fields } });
  }

  async function readRendered(url: string): Promise<SeoFields> {
    const snap = await fetchSnapshot(url, { fetch: doFetch, cacheBust: true });
    const r = snap.robots ?? "";
    return {
      title: snap.title,
      description: snap.metaDescription,
      canonical: snap.canonical,
      robots: { index: !/noindex|none/.test(r), follow: !/nofollow|none/.test(r) },
      og_title: snap.og["og:title"] ?? null,
      og_description: snap.og["og:description"] ?? null,
      og_image: snap.og["og:image"] ?? null,
    };
  }

  async function readSeo(channel: SeoChannel, ref: ParsedRef, url: string): Promise<{ fields: SeoFields; exact: boolean }> {
    switch (channel) {
      case "bridge": {
        const r = await api<{ fields: SeoFields }>("GET", `/seo-agent/v1/meta/${ref.id}`);
        return { fields: r.fields, exact: true };
      }
      case "seopress": {
        const p = await getPost(ref, "id,meta");
        const m = p.meta ?? {};
        const idx = str(m._seopress_robots_index);
        const fol = str(m._seopress_robots_follow);
        return {
          exact: true,
          fields: {
            title: str(m._seopress_titles_title),
            description: str(m._seopress_titles_desc),
            canonical: str(m._seopress_robots_canonical),
            robots: { index: idx === "yes" ? false : null, follow: fol === "yes" ? false : null },
            og_title: str(m._seopress_social_fb_title),
            og_description: str(m._seopress_social_fb_desc),
            og_image: str(m._seopress_social_fb_img),
          },
        };
      }
      case "yoast-meta": {
        const p = await getPost(ref, "id,meta");
        const m = p.meta ?? {};
        if (!("_yoast_wpseo_title" in m) && !("_yoast_wpseo_metadesc" in m)) {
          return { fields: await readRendered(url), exact: false };
        }
        return { exact: true, fields: { title: str(m._yoast_wpseo_title), description: str(m._yoast_wpseo_metadesc) } };
      }
      case "yoast-bulk":
      case "rankmath":
        // Stored values aren't readable over REST without the bridge; use what the page renders.
        return { fields: await readRendered(url), exact: false };
    }
  }

  async function writeSeo(channel: SeoChannel, ref: ParsedRef, f: SeoFields): Promise<void> {
    const S = (v: string | null | undefined) => (v === null || v === undefined ? "" : v);
    switch (channel) {
      case "bridge": {
        await api("POST", `/seo-agent/v1/meta/${ref.id}`, { body: f });
        return;
      }
      case "seopress": {
        const meta: Record<string, unknown> = {};
        if ("title" in f) meta._seopress_titles_title = S(f.title);
        if ("description" in f) meta._seopress_titles_desc = S(f.description);
        if ("canonical" in f) meta._seopress_robots_canonical = S(f.canonical);
        if ("robots" in f) {
          meta._seopress_robots_index = f.robots?.index === false ? "yes" : "";
          meta._seopress_robots_follow = f.robots?.follow === false ? "yes" : "";
        }
        if ("og_title" in f) meta._seopress_social_fb_title = S(f.og_title);
        if ("og_description" in f) meta._seopress_social_fb_desc = S(f.og_description);
        if ("og_image" in f) meta._seopress_social_fb_img = S(f.og_image);
        await api("POST", `/wp/v2/${ref.base}/${ref.id}`, { body: { meta } });
        return;
      }
      case "rankmath": {
        const meta: Record<string, unknown> = {};
        if ("title" in f) meta.rank_math_title = S(f.title);
        if ("description" in f) meta.rank_math_description = S(f.description);
        if ("canonical" in f) meta.rank_math_canonical_url = S(f.canonical);
        if ("robots" in f) {
          const r = f.robots;
          meta.rank_math_robots =
            !r || (r.index === null && r.follow === null)
              ? ""
              : [r.index === false ? "noindex" : "index", r.follow === false ? "nofollow" : "follow"];
        }
        if ("og_title" in f) meta.rank_math_facebook_title = S(f.og_title);
        if ("og_description" in f) meta.rank_math_facebook_description = S(f.og_description);
        if ("og_image" in f) meta.rank_math_facebook_image = S(f.og_image);
        await api("POST", "/rankmath/v1/updateMeta", { body: { objectType: "post", objectID: ref.id, meta } });
        return;
      }
      case "yoast-meta": {
        const meta: Record<string, unknown> = {};
        if ("title" in f) meta._yoast_wpseo_title = S(f.title);
        if ("description" in f) meta._yoast_wpseo_metadesc = S(f.description);
        const res = await api<WpPost>("POST", `/wp/v2/${ref.base}/${ref.id}`, { body: { meta } });
        const back = res?.meta ?? {};
        for (const [k, v] of Object.entries(meta)) {
          if (k in back && String(back[k] ?? "") !== String(v)) throw new WordPressError(`Yoast did not store ${k} (got "${back[k]}")`, 500, "write_mismatch");
          if (!(k in back)) throw new WordPressError(`Yoast meta ${k} is not exposed over REST on this site; install seo-agent-bridge`, 501, "not_exposed");
        }
        return;
      }
      case "yoast-bulk": {
        const item: Record<string, unknown> = { id: ref.id };
        if ("title" in f) item.seo_title = S(f.title);
        if ("description" in f) item.meta_description = S(f.description);
        await api("POST", "/yoast/v1/bulk_editor/update_search", { body: { items: [item] } });
        return;
      }
    }
  }

  function fieldsForType(type: ChangeType, after: Record<string, unknown>): SeoFields {
    switch (type) {
      case "title":
        return { title: String(after.value ?? "") };
      case "meta_description":
        return { description: String(after.value ?? "") };
      case "canonical":
        return { canonical: String(after.value ?? "") };
      case "robots_meta":
        return { robots: { index: after.index !== false, follow: after.follow !== false } };
      case "og_tags": {
        const f: SeoFields = {};
        if (after.title !== undefined) f.og_title = String(after.title);
        if (after.description !== undefined) f.og_description = String(after.description);
        if (after.image !== undefined) f.og_image = String(after.image);
        return f;
      }
      default:
        return {};
    }
  }

  function pick(fields: SeoFields, keys: Array<keyof SeoFields>): SeoFields {
    const out: SeoFields = {};
    for (const k of keys) (out as Record<string, unknown>)[k] = (fields as Record<string, unknown>)[k] ?? null;
    return out;
  }

  function seoToPayload(type: ChangeType, f: SeoFields): unknown {
    switch (type) {
      case "title":
        return isBlank(f.title) ? null : { value: f.title };
      case "meta_description":
        return isBlank(f.description) ? null : { value: f.description };
      case "canonical":
        return isBlank(f.canonical) ? null : { value: f.canonical };
      case "robots_meta":
        return { index: f.robots?.index !== false, follow: f.robots?.follow !== false };
      case "og_tags": {
        const o: Record<string, string> = {};
        if (!isBlank(f.og_title)) o.title = f.og_title!;
        if (!isBlank(f.og_description)) o.description = f.og_description!;
        if (!isBlank(f.og_image)) o.image = f.og_image!;
        return Object.keys(o).length ? o : null;
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- JSON-LD (bridge)
  function nodeType(n: Record<string, unknown>): string[] {
    const t = n["@type"];
    return typeof t === "string" ? [t] : Array.isArray(t) ? (t.filter((x) => typeof x === "string") as string[]) : [];
  }
  function hasType(n: Record<string, unknown>, t: string): boolean {
    return nodeType(n).some((x) => x.toLowerCase() === t.toLowerCase());
  }
  async function readJsonLd(ref: ParsedRef): Promise<Array<Record<string, unknown>>> {
    const r = await api<{ fields: SeoFields }>("GET", `/seo-agent/v1/meta/${ref.id}`);
    return Array.isArray(r.fields.jsonld) ? r.fields.jsonld : [];
  }

  // ---------------------------------------------------------------- content helpers
  function findImgTags(raw: string, src: string, mediaId?: number): Array<{ start: number; end: number; tag: string }> {
    const out: Array<{ start: number; end: number; tag: string }> = [];
    const key = imageKey(src, siteUrl);
    const re = /<img\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const tag = m[0];
      const s = getAttr(tag, "src") ?? getAttr(tag, "data-src") ?? "";
      const cls = getAttr(tag, "class") ?? "";
      const byId = mediaId !== undefined && new RegExp(`\\bwp-image-${mediaId}\\b`).test(cls);
      if ((s && imageKey(s, siteUrl) === key) || byId) out.push({ start: m.index, end: m.index + tag.length, tag });
    }
    return out;
  }

  function replaceH1(raw: string, value: string, before: string | null): string | null {
    const re = /(<h1\b[^>]*>)([\s\S]*?)(<\/h1>)/gi;
    const all = [...raw.matchAll(re)];
    if (!all.length) return null;
    let target = all[0];
    if (before) {
      const want = before.replace(/\s+/g, " ").trim().toLowerCase();
      target = all.find((m) => stripTags(m[2]).toLowerCase() === want) ?? all[0];
    }
    const i = target.index!;
    return raw.slice(0, i) + target[1] + escText(value) + target[3] + raw.slice(i + target[0].length);
  }

  /** Wrap the first plain-text occurrence of `anchor` (outside tags, comments and existing links). */
  function insertLink(raw: string, anchor: string, href: string, nearText?: string): string | null {
    const tokens = raw.split(/(<!--[\s\S]*?-->|<[^>]+>)/);
    const tryPass = (ci: boolean, requireNear: boolean): string | null => {
      let inA = 0;
      let inSkip = 0;
      let nearSeen = !requireNear;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith("<")) {
          if (/^<a\b/i.test(t)) inA++;
          else if (/^<\/a>/i.test(t)) inA = Math.max(0, inA - 1);
          else if (/^<(h[1-6]|script|style|code|pre|button)\b/i.test(t)) inSkip++;
          else if (/^<\/(h[1-6]|script|style|code|pre|button)>/i.test(t)) inSkip = Math.max(0, inSkip - 1);
          continue;
        }
        if (requireNear && !nearSeen && nearText) {
          if (decodeBasic(t).toLowerCase().includes(nearText.toLowerCase())) nearSeen = true;
          else continue;
        }
        if (inA || inSkip) continue;
        const hay = ci ? t.toLowerCase() : t;
        const needleRaw = escText(anchor);
        const needle = ci ? needleRaw.toLowerCase() : needleRaw;
        let idx = hay.indexOf(needle);
        // Prefer whole-word matches.
        while (idx >= 0) {
          const before = hay[idx - 1];
          const after = hay[idx + needle.length];
          const wordB = before && /[\p{L}\p{N}]/u.test(before);
          const wordA = after && /[\p{L}\p{N}]/u.test(after);
          if (!wordB && !wordA) break;
          idx = hay.indexOf(needle, idx + 1);
        }
        if (idx >= 0) {
          const original = t.slice(idx, idx + needle.length);
          tokens[i] = t.slice(0, idx) + `<a href="${escAttr(href)}">${original}</a>` + t.slice(idx + needle.length);
          return tokens.join("");
        }
      }
      return null;
    };
    return (nearText ? tryPass(false, true) ?? tryPass(true, true) : null) ?? tryPass(false, false) ?? tryPass(true, false);
  }

  function assertNotBuilder(p: WpPost) {
    const m = p.meta ?? {};
    if (m._elementor_edit_mode === "builder" || (typeof p.content?.raw === "string" && p.content.raw.trim() === "" && (p.content.rendered ?? "").length > 200)) {
      throw new WordPressError(
        "This page is built with a page builder (content is not in post_content); edit it in the builder by hand.",
        409, "page_builder",
      );
    }
  }

  async function resolveMedia(src: string, mediaId?: string): Promise<{ id: number; alt_text: string } | null> {
    if (mediaId && /^\d+$/.test(mediaId)) {
      const m = await api<{ id: number; alt_text: string }>("GET", `/wp/v2/media/${mediaId}`, { query: { context: "edit", _fields: "id,alt_text" }, allow404: true });
      if (m) return { id: m.id, alt_text: m.alt_text ?? "" };
    }
    const key = imageKey(src, siteUrl);
    const stem = fileStem(src);
    if (!stem) return null;
    const items = await api<Array<{ id: number; source_url: string; alt_text: string; media_details?: { sizes?: Record<string, { source_url: string }> } }>>(
      "GET", "/wp/v2/media",
      { query: { search: stem, media_type: "image", per_page: 50, context: "edit", _fields: "id,source_url,alt_text,media_details" } },
    ).catch(() => []);
    for (const it of items ?? []) {
      const urls = [it.source_url, ...Object.values(it.media_details?.sizes ?? {}).map((s) => s.source_url)];
      if (urls.some((u) => u && imageKey(u, siteUrl) === key)) return { id: it.id, alt_text: it.alt_text ?? "" };
    }
    return null;
  }

  // ---------------------------------------------------------------- redirects
  interface RedirItem { id: number; url: string; action_code: number; action_data?: { url?: string } | string; enabled?: boolean }
  function redirTarget(i: RedirItem): string {
    return typeof i.action_data === "string" ? i.action_data : i.action_data?.url ?? "";
  }
  function samePath(a: string, b: string) {
    return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
  }
  async function redirectionFind(from: string): Promise<RedirItem | null> {
    const r = await api<{ items?: RedirItem[] }>("GET", "/redirection/v1/redirect", {
      query: { "filterBy[url]": from, per_page: 50 },
    });
    return (r?.items ?? []).find((i) => samePath(i.url, from)) ?? null;
  }
  async function redirectionGroup(): Promise<number> {
    const r = await api<{ items?: Array<{ id: number; name: string; module_id?: number; enabled?: boolean }> }>("GET", "/redirection/v1/group", { query: { per_page: 50 } });
    const items = (r?.items ?? []).filter((g) => g.enabled !== false && (g.module_id === undefined || g.module_id === 1));
    const g = items.find((x) => /^redirections$/i.test(x.name)) ?? items[0];
    if (!g) throw new WordPressError("The Redirection plugin has no enabled group to add redirects to", 409, "no_group");
    return g.id;
  }
  async function readRedirect(from: string): Promise<{ from_path: string; to_url: string; code: number } | null> {
    const d = await detect();
    if (d.bridge) {
      const r = await api<{ items: Array<{ from: string; to: string; code: number }> }>("GET", "/seo-agent/v1/redirects");
      const hit = (r?.items ?? []).find((i) => samePath(i.from, from));
      if (hit) return { from_path: hit.from, to_url: hit.to, code: hit.code };
      if (!d.redirection) return null;
    }
    if (d.redirection) {
      const hit = await redirectionFind(from).catch(() => null);
      if (hit && hit.enabled !== false) return { from_path: hit.url, to_url: absolute(redirTarget(hit)), code: hit.action_code };
    }
    return null;
  }
  function absolute(u: string): string {
    try {
      return new URL(u, origin).toString();
    } catch {
      return u;
    }
  }

  // ---------------------------------------------------------------- site files (bridge)
  async function readFileOverride(file: "robots" | "llms"): Promise<{ content: string; physical: boolean }> {
    const r = await api<{ content: string; physical?: boolean }>("GET", `/seo-agent/v1/${file}`);
    return { content: r?.content ?? "", physical: !!r?.physical };
  }

  // ---------------------------------------------------------------- read
  async function read(change: Pick<ChangeRecord, "type" | "target" | "after">): Promise<unknown> {
    const d = await detect();
    const type = change.type;
    const after = (change.after ?? {}) as Record<string, unknown>;
    if (NEVER_TYPES.has(type)) return null;

    if (type === "robots_txt" || type === "llms_txt") {
      const file = type === "robots_txt" ? "robots" : "llms";
      if (d.bridge) {
        const o = await readFileOverride(file);
        if (o.content.trim()) return { content: o.content };
      }
      const live = await fetchText(`${origin}/${file}.txt`, { fetch: doFetch, cacheBust: true });
      return live.status === 200 && live.text.trim() && !/<html/i.test(live.text.slice(0, 500)) ? { content: live.text } : null;
    }
    if (type === "redirect") return readRedirect(String(after.from_path ?? ""));

    const ref = await refFor(change);
    if (SEO_TYPES.has(type)) {
      const ch = seoChannelFor(type, ref, d);
      if (!ch) return null;
      const { fields } = await readSeo(ch, ref, change.target.url);
      return seoToPayload(type, fields);
    }
    if (type === "jsonld_add" || type === "jsonld_fix") {
      if (!d.bridge) return null;
      const t = String((type === "jsonld_fix" ? after.replaces_type : undefined) ?? after.schema_type ?? "");
      const blocks = await readJsonLd(ref);
      const hit = blocks.find((b) => hasType(b, t));
      return hit ? { schema_type: t, schema: hit } : null;
    }
    if (ref.front) return null;
    const post = await getPost(ref);
    const raw = post.content?.raw ?? "";
    switch (type) {
      case "h1": {
        const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(raw);
        const v = m ? stripTags(m[1]) : post.title?.raw ?? "";
        return v ? { value: v } : null;
      }
      case "image_alt": {
        const src = String(after.src ?? "");
        const tags = findImgTags(raw, src, after.media_id ? Number(after.media_id) : undefined);
        if (tags.length) {
          return { src: getAttr(tags[0].tag, "src") ?? src, alt: getAttr(tags[0].tag, "alt") };
        }
        // Image rendered by the theme (featured image etc.): the attachment's alt is what shows.
        const media = await resolveMedia(src, after.media_id as string | undefined);
        if (media) return { src, alt: media.alt_text || null, media_id: String(media.id) };
        // Last resort: the live page.
        const snap = await fetchSnapshot(change.target.url, { fetch: doFetch, cacheBust: true }).catch(() => null);
        const img = snap ? findImage(snap, src) : null;
        return img ? { src: img.src, alt: img.alt } : null;
      }
      case "content_edit": {
        const find = after.find as string | undefined;
        const replace = after.replace as string | undefined;
        return {
          find_present: find ? raw.includes(find) : null,
          replace_present: replace ? raw.includes(replace) : null,
          content_length: raw.length,
        };
      }
      case "internal_link": {
        const to = String(after.to_url ?? "");
        const linked = [...raw.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)].some((m) => normPath(absolute(decodeBasic(m[1]))) === normPath(to));
        return { linked, anchor_present: stripTags(raw).toLowerCase().includes(String(after.anchor ?? "").toLowerCase()) };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- apply
  async function apply(change: ChangeRecord): Promise<ApplyResult> {
    const d = await detect();
    const type = change.type;
    const after = (change.after ?? {}) as Record<string, unknown>;
    if (NEVER_TYPES.has(type)) throw new WordPressError(`${type} changes are never applied automatically on WordPress`, 400, "manual");
    const caps = await capabilities();
    if (!caps.includes(type)) throw new WordPressError(`${type} cannot be applied on this site (${d.bridge ? "bridge present" : "install seo-agent-bridge"})`, 501, "manual");

    // ---- site files
    if (type === "robots_txt" || type === "llms_txt") {
      const file = type === "robots_txt" ? "robots" : "llms";
      const cur = await readFileOverride(file);
      if (cur.physical) {
        throw new WordPressError(
          `A physical ${file}.txt file exists in the web root, so WordPress can't serve an override. Edit or delete the file by hand.`,
          409, "physical_file",
        );
      }
      if (file === "robots" && d.bridge && d.bridge.blog_public === false) {
        throw new WordPressError(`"Discourage search engines" is on (blog_public=0); WordPress serves Disallow: / regardless. Fix that setting first.`, 409, "blog_not_public");
      }
      const res = await api<{ before: string; after: string }>("POST", `/seo-agent/v1/${file}`, { body: { content: String(after.content ?? "") } });
      const rb: RB_File = { v: 1, channel: "bridge-file", file, previous: res?.before ?? cur.content };
      return { rollback: rb, written: { content: res?.after ?? after.content } };
    }

    // ---- redirects
    if (type === "redirect") {
      const from = String(after.from_path);
      const to = String(after.to_url);
      if (samePath(from, new URL(to, origin).pathname) && new URL(to, origin).host === new URL(origin).host) {
        throw new WordPressError("Redirect would loop to itself", 400, "loop");
      }
      if (d.bridge) {
        const res = await api<{ before: { from: string; to: string; code: number } | null; rule: { to: string; code: number } }>("POST", "/seo-agent/v1/redirects", {
          body: { from, to, code: 301 },
        });
        const rb: RB_Redirect = { v: 1, channel: "bridge-redirect", from_path: from, previous: res?.before ? { to_url: res.before.to, code: res.before.code } : null };
        return { rollback: rb, written: { from_path: from, to_url: res?.rule?.to ?? to, code: 301 } };
      }
      // Redirection plugin
      const existing = await redirectionFind(from);
      if (existing) {
        const prev = { to_url: redirTarget(existing), code: existing.action_code };
        await api("POST", `/redirection/v1/redirect/${existing.id}`, {
          body: { ...existing, action_type: "url", action_code: 301, action_data: { url: to }, enabled: true },
        });
        const rb: RB_Redirect = { v: 1, channel: "redirection", from_path: from, previous: existing.enabled === false ? null : prev, item_id: existing.id };
        return { rollback: rb, written: { from_path: from, to_url: to, code: 301 }, note: "Updated an existing Redirection rule" };
      }
      const group = await redirectionGroup();
      await api("POST", "/redirection/v1/redirect", {
        body: {
          url: from, match_type: "url", action_type: "url", action_code: 301, action_data: { url: to },
          group_id: group, regex: false, title: `seo-autopilot ${change.id}`,
          match_data: { source: { flag_query: "exact", flag_case: false, flag_trailing: true, flag_regex: false } },
        },
      });
      const created = await redirectionFind(from);
      if (!created) throw new WordPressError("Redirect was created but could not be found again in the Redirection plugin", 500, "write_mismatch");
      const rb: RB_Redirect = { v: 1, channel: "redirection", from_path: from, previous: null, item_id: created.id };
      return { rollback: rb, written: { from_path: from, to_url: to, code: 301 } };
    }

    const ref = await refFor(change);
    const refStr = refString(ref);

    // ---- SEO meta
    if (SEO_TYPES.has(type)) {
      const ch = seoChannelFor(type, ref, d);
      if (!ch) throw new WordPressError(`No write channel for ${type} on ${refStr}; install seo-agent-bridge`, 501, "manual");
      const fields = fieldsForType(type, after);
      const keys = Object.keys(fields) as Array<keyof SeoFields>;
      const before = await readSeo(ch, ref, change.target.url);
      let previous = pick(before.fields, keys);
      if (!before.exact && type === "robots_meta") {
        // Rendered robots: default index,follow means "nothing stored".
        const r = previous.robots;
        if (r && r.index !== false && r.follow !== false) previous = { robots: { index: null, follow: null } };
      }
      if (!before.exact) {
        log("warn", `Stored ${type} is not readable via ${ch}; rollback will restore the rendered value. Install seo-agent-bridge for exact rollback.`);
      }
      await writeSeo(ch, ref, fields);
      const rb: RB_Seo = { v: 1, channel: ch, ref: refStr, previous, exact: before.exact };
      return { rollback: rb, written: after, note: before.exact ? undefined : "Previous value read from the rendered page (inexact rollback)" };
    }

    // ---- JSON-LD (bridge)
    if (type === "jsonld_add" || type === "jsonld_fix") {
      const blocks = await readJsonLd(ref);
      const schemaType = String(after.schema_type);
      const schema = { ...(after.schema as Record<string, unknown>) };
      if (!schema["@context"]) schema["@context"] = "https://schema.org";
      if (!schema["@type"]) schema["@type"] = schemaType;
      const replaceType = type === "jsonld_fix" ? String(after.replaces_type ?? schemaType) : schemaType;
      const next = blocks.filter((b) => !hasType(b, replaceType) && !hasType(b, schemaType));
      next.push(schema);
      await writeSeo("bridge", ref, { jsonld: next });
      const rb: RB_Seo = { v: 1, channel: "bridge", ref: refStr, previous: { jsonld: blocks }, exact: true };
      const replacedOwn = blocks.length !== next.length - 1;
      return {
        rollback: rb,
        written: { schema_type: schemaType, schema },
        note: type === "jsonld_fix" && !replacedOwn ? "The invalid block is printed by the theme or another plugin; added a correct block alongside it" : undefined,
      };
    }

    // ---- core content edits
    if (ref.front) throw new WordPressError(`${type} on a latest-posts homepage must be done in the theme`, 501, "manual");
    const post = await getPost(ref);
    assertNotBuilder(post);
    const raw = post.content?.raw ?? "";
    const rb: RB_Core = { v: 1, channel: "core", ref: refStr, previous: {}, written: {} };

    if (type === "h1") {
      const value = String(after.value ?? "");
      const beforeVal = (change.before as { value?: string } | null)?.value ?? null;
      const replaced = replaceH1(raw, value, beforeVal);
      if (replaced !== null) {
        await api("POST", `/wp/v2/${ref.base}/${ref.id}`, { body: { content: replaced } });
        rb.previous.content = raw;
        rb.written.content = replaced;
      } else {
        await api("POST", `/wp/v2/${ref.base}/${ref.id}`, { body: { title: value } });
        rb.previous.title = post.title?.raw ?? "";
        rb.written.title = value;
      }
      return { rollback: rb, written: { value }, note: replaced === null ? "Updated the post title (rendered as the H1 by the theme)" : undefined };
    }

    if (type === "image_alt") {
      const src = String(after.src ?? "");
      const alt = String(after.alt ?? "");
      const media = await resolveMedia(src, after.media_id as string | undefined);
      const tags = findImgTags(raw, src, media?.id);
      if (!tags.length && !media) {
        throw new WordPressError(`Image ${src} is neither in the post content nor in the media library`, 404, "image_not_found");
      }
      if (tags.length) {
        let next = "";
        let last = 0;
        for (const t of tags) {
          next += raw.slice(last, t.start) + setAttr(t.tag, "alt", alt);
          last = t.end;
        }
        next += raw.slice(last);
        if (next !== raw) {
          await api("POST", `/wp/v2/${ref.base}/${ref.id}`, { body: { content: next } });
          rb.previous.content = raw;
          rb.written.content = next;
        }
      }
      if (media) {
        await api("POST", `/wp/v2/media/${media.id}`, { body: { alt_text: alt } });
        rb.media = { id: media.id, alt_text: media.alt_text };
      }
      return { rollback: rb, written: { src, alt, ...(media ? { media_id: String(media.id) } : {}) } };
    }

    if (type === "content_edit") {
      const find = after.find as string | undefined;
      const replace = after.replace as string | undefined;
      if (find === undefined || replace === undefined) {
        throw new WordPressError("content_edit without exact find/replace text needs a human", 400, "manual");
      }
      const count = raw.split(find).length - 1;
      if (count === 0) throw new WordPressError("The text to replace was not found in the post's raw content", 409, "find_not_found");
      if (count > 1) throw new WordPressError(`The text to replace occurs ${count} times; refusing an ambiguous edit`, 409, "find_ambiguous");
      const next = raw.replace(find, () => replace);
      await api("POST", `/wp/v2/${ref.base}/${ref.id}`, { body: { content: next } });
      rb.previous.content = raw;
      rb.written.content = next;
      return { rollback: rb, written: { find, replace } };
    }

    if (type === "internal_link") {
      const anchor = String(after.anchor ?? "");
      const to = String(after.to_url ?? "");
      const next = insertLink(raw, anchor, to, after.near_text as string | undefined);
      if (!next) throw new WordPressError(`Anchor text "${anchor}" was not found as plain text in the post content`, 409, "anchor_not_found");
      await api("POST", `/wp/v2/${ref.base}/${ref.id}`, { body: { content: next } });
      rb.previous.content = raw;
      rb.written.content = next;
      return { rollback: rb, written: { anchor, to_url: to } };
    }

    throw new WordPressError(`Unsupported change type ${type}`, 400, "manual");
  }

  // ---------------------------------------------------------------- rollback
  async function rollback(change: ChangeRecord): Promise<void> {
    const rb = change.rollback_data as RollbackData | undefined;
    if (!rb || typeof rb !== "object" || (rb as { v?: number }).v !== 1) {
      throw new WordPressError(`No usable rollback data for change ${change.id}`, 400, "no_rollback");
    }
    await detect();
    switch (rb.channel) {
      case "bridge":
      case "seopress":
      case "rankmath":
      case "yoast-meta":
      case "yoast-bulk": {
        await writeSeo(rb.channel, refFromString(rb.ref), rb.previous);
        return;
      }
      case "bridge-file": {
        await api("POST", `/seo-agent/v1/${rb.file}`, { body: { content: rb.previous } });
        return;
      }
      case "bridge-redirect": {
        if (rb.previous) await api("POST", "/seo-agent/v1/redirects", { body: { from: rb.from_path, to: rb.previous.to_url, code: rb.previous.code } });
        else await api("DELETE", "/seo-agent/v1/redirects", { query: { from: rb.from_path } });
        return;
      }
      case "redirection": {
        if (rb.item_id === undefined) throw new WordPressError("Redirection rollback is missing the item id", 400, "no_rollback");
        if (rb.previous) {
          const cur = await redirectionFind(rb.from_path);
          await api("POST", `/redirection/v1/redirect/${rb.item_id}`, {
            body: { ...(cur ?? {}), url: rb.from_path, action_type: "url", action_code: rb.previous.code, action_data: { url: rb.previous.to_url } },
          });
        } else {
          await api("POST", "/redirection/v1/bulk/redirect/delete", { body: { items: [rb.item_id] } });
        }
        return;
      }
      case "core": {
        const ref = refFromString(rb.ref);
        if (rb.previous.content !== undefined || rb.previous.title !== undefined) {
          const post = await getPost(ref);
          const body: Record<string, string> = {};
          if (rb.previous.content !== undefined) {
            const cur = post.content?.raw ?? "";
            if (cur === rb.written.content) body.content = rb.previous.content;
            else if (rb.written.content !== undefined) {
              // Someone edited the post since. Undo only our fragment when it is unambiguous.
              const undone = reverseEdit(cur, rb.previous.content, rb.written.content);
              if (undone === null) {
                throw new WordPressError("The post content changed after this edit; rollback needs a human (see post revisions)", 409, "conflict");
              }
              body.content = undone;
            }
          }
          if (rb.previous.title !== undefined) body.title = rb.previous.title;
          if (Object.keys(body).length) await api("POST", `/wp/v2/${ref.base}/${ref.id}`, { body });
        }
        if (rb.media) await api("POST", `/wp/v2/media/${rb.media.id}`, { body: { alt_text: rb.media.alt_text } });
        return;
      }
    }
  }

  /** Given prev -> written (a single contiguous edit), re-apply the inverse on `current`. */
  function reverseEdit(current: string, prev: string, written: string): string | null {
    let s = 0;
    while (s < prev.length && s < written.length && prev[s] === written[s]) s++;
    let e = 0;
    while (e < prev.length - s && e < written.length - s && prev[prev.length - 1 - e] === written[written.length - 1 - e]) e++;
    // Widen the fragment a little so it is unique in the current content.
    for (let pad = 0; pad <= 200; pad += 20) {
      const a = Math.max(0, s - pad);
      const wFrag = written.slice(a, written.length - Math.max(0, e - pad));
      const pFrag = prev.slice(a, prev.length - Math.max(0, e - pad));
      if (!wFrag) return null;
      const n = current.split(wFrag).length - 1;
      if (n === 1) return current.replace(wFrag, () => pFrag);
      if (n === 0) return null;
    }
    return null;
  }

  // ---------------------------------------------------------------- purge
  async function purge(urls: string[]): Promise<void> {
    const d = await detect().catch(() => null);
    const list = [...new Set(urls.filter(Boolean))];
    if (d?.bridge) {
      try {
        await api("POST", "/seo-agent/v1/purge", { body: { urls: list } });
      } catch (e) {
        log("warn", `Bridge purge failed: ${(e as Error).message}`);
      }
    }
    if (secrets.cloudflare && list.length) {
      const files = new Set<string>();
      for (const u of list) {
        try {
          const x = new URL(u, origin);
          x.hash = "";
          const s = x.toString();
          files.add(s);
          if (x.pathname !== "/" && !/\.[a-z0-9]{2,5}$/i.test(x.pathname)) files.add(s.endsWith("/") ? s.replace(/\/(\?|$)/, "$1") : x.search ? s.replace(x.pathname, x.pathname + "/") : s + "/");
        } catch {
          /* skip */
        }
      }
      const all = [...files];
      for (let i = 0; i < all.length; i += 100) {
        const chunk = all.slice(i, i + 100);
        try {
          const res = await doFetch(`https://api.cloudflare.com/client/v4/zones/${secrets.cloudflare.zone_id}/purge_cache`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secrets.cloudflare.api_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ files: chunk }),
          });
          const j = (await res.json().catch(() => null)) as { success?: boolean; errors?: Array<{ message: string }> } | null;
          if (!res.ok || j?.success === false) log("warn", `Cloudflare purge failed: ${res.status} ${j?.errors?.map((e) => e.message).join("; ") ?? ""}`);
        } catch (e) {
          log("warn", `Cloudflare purge error: ${(e as Error).message}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- testConnection
  async function testConnection(): Promise<ConnectionResult> {
    const warnings: string[] = [];
    const details: Record<string, unknown> = {};
    let d: Detection;
    try {
      d = await detect(true);
    } catch (e) {
      return { ok: false, details: { error: (e as Error).message, code: (e as WordPressError).code }, warnings: [(e as Error).message] };
    }
    details.rest_root = d.restMode === "query" ? `${origin}/?rest_route=/` : d.restRoot;
    details.rest_mode = d.restMode;
    if (d.restMode === "query") warnings.push("Pretty permalinks are off; using ?rest_route= URLs.");
    details.namespaces = d.namespaces;

    let me: { id: number; name: string; slug?: string; roles?: string[]; capabilities?: Record<string, boolean> };
    try {
      me = await api("GET", "/wp/v2/users/me", { query: { context: "edit", _fields: "id,name,slug,roles,capabilities" } });
    } catch (e) {
      const err = e as WordPressError;
      return { ok: false, details: { ...details, error: err.message, code: err.code, status: err.status }, warnings: [...warnings, err.message] };
    }
    details.user = { id: me.id, name: me.name, slug: me.slug, roles: me.roles ?? [] };
    const cap = me.capabilities ?? {};
    const missing = ["edit_others_posts", "edit_pages", "edit_published_posts", "upload_files", "manage_options"].filter((c) => !cap[c]);
    if (missing.length) warnings.push(`User "${me.slug ?? me.name}" lacks: ${missing.join(", ")}. An Administrator account is recommended.`);

    details.seo_plugins = d.seoPlugins;
    details.primary_seo_plugin = d.primarySeo;
    if (d.seoPlugins.length > 1) warnings.push(`Several SEO plugins are active (${d.seoPlugins.join(", ")}); they may print duplicate tags.`);
    details.redirection_plugin = d.redirection;
    if (d.redirection && d.seoPlugins.includes("rankmath")) warnings.push("Redirection and Rank Math are both active; make sure only one manages redirects.");

    let caching: string[] = [];
    let blogPublic: boolean | null = null;
    if (d.bridge) {
      details.bridge_version = d.bridge.version;
      caching = d.bridge.caching ?? [];
      blogPublic = d.bridge.blog_public;
      if (d.bridge.physical_robots) warnings.push("A physical robots.txt exists in the web root; robots.txt changes must be made by hand.");
      if (d.bridge.physical_llms) warnings.push("A physical llms.txt exists in the web root; llms.txt changes must be made by hand.");
    } else {
      details.bridge_version = null;
      warnings.push(
        "seo-agent-bridge is not installed: JSON-LD, robots.txt, llms.txt and cache purge are unavailable" +
          (d.primarySeo ? "" : ", and so are title/meta description (no SEO plugin found)") +
          ". Upload integrations/wordpress/seo-agent-bridge.php to wp-content/mu-plugins/.",
      );
      if (d.primarySeo === "rankmath" || d.primarySeo === "yoast") warnings.push(`Without the bridge, ${d.primarySeo} values can't be read exactly, so rollbacks restore the rendered value.`);
      if (d.primarySeo === "aioseo") warnings.push("AIOSEO needs seo-agent-bridge for SEO meta writes.");
      // Plugin list (needs activate_plugins).
      const plugins = await api<Array<{ plugin: string; status: string; name: string }>>("GET", "/wp/v2/plugins", { query: { _fields: "plugin,status,name" } }).catch(() => null);
      if (plugins) {
        const active = plugins.filter((p) => p.status === "active").map((p) => p.plugin);
        const known: Record<string, string> = {
          "wp-rocket": "WP Rocket", "litespeed-cache": "LiteSpeed Cache", "w3-total-cache": "W3 Total Cache",
          "wp-super-cache": "WP Super Cache", "sg-cachepress": "SiteGround Optimizer", "wp-fastest-cache": "WP Fastest Cache",
          "cache-enabler": "Cache Enabler", "breeze": "Breeze", "wp-optimize": "WP-Optimize", "nitropack": "NitroPack", "cloudflare": "Cloudflare",
        };
        for (const a of active) {
          const slug = a.split("/")[0];
          if (known[slug]) caching.push(known[slug]);
        }
      }
      // blog_public isn't in /wp/v2/settings; infer from the home page.
      const home = await fetchSnapshot(`${siteUrl}/`, { fetch: doFetch, cacheBust: true }).catch(() => null);
      if (home && /noindex/.test(home.robots ?? "")) {
        details.home_noindex = true;
        warnings.push("The home page is noindex. If \"Discourage search engines\" is on (Settings → Reading), the whole site is hidden from search.");
      }
    }
    details.caching_plugins = caching;
    if (caching.length && !d.bridge && !secrets.cloudflare) warnings.push(`Caching detected (${caching.join(", ")}) but no purge channel; changes may take a while to show.`);
    details.blog_public = blogPublic;
    if (blogPublic === false) warnings.push('"Discourage search engines from indexing this site" is ON (Settings → Reading). The whole site is noindex.');
    details.cloudflare_purge = !!secrets.cloudflare;
    if (!siteUrl.startsWith("https://")) warnings.push("Site is not on HTTPS; Application Passwords are sent in clear text.");
    details.capabilities = await capabilities();
    return { ok: true, details, warnings };
  }

  return {
    platform: "wordpress",
    capabilities,
    testConnection,
    resolve,
    read,
    apply,
    rollback,
    purge,
  };
}
