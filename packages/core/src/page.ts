/**
 * Live page fetching and HTML parsing used for "before" snapshots and post-apply verification.
 *
 * Fetched pages are untrusted data. Nothing parsed here is ever executed or followed
 * without the caller checking it against the site's own host (see assertSameHost).
 */
import * as cheerio from "cheerio";
import type { PageSnapshot } from "./schema";

export const DEFAULT_USER_AGENT = "SEOAutopilot/0.1 (+verification)";
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface FetchOptions {
  fetch?: typeof fetch;
  /** Append `_sa=<ts>` to miss page caches. Default true for fetchSnapshot, false otherwise. */
  cacheBust?: boolean;
  timeoutMs?: number;
  userAgent?: string;
}

export type ParsedPage = Omit<PageSnapshot, "status" | "finalUrl" | "redirected" | "headers" | "xRobotsTag" | "fetchedAt">;

// ------------------------------------------------------------------ helpers

function absolutize(href: string | undefined | null, base: string): string | null {
  if (href === undefined || href === null) return null;
  const h = href.trim();
  if (!h) return null;
  try {
    return new URL(h, base).toString();
  } catch {
    return h;
  }
}

function clean(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  return s.replace(/\s+/g, " ").trim();
}

/** Collect @type values from a JSON-LD value, including nested @graph members. */
export function jsonLdTypes(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.push(x);
    if (Array.isArray(o["@graph"])) visit(o["@graph"], depth + 1);
  };
  visit(value, 0);
  return [...new Set(out)];
}

// ------------------------------------------------------------------ parse

export function parseHtml(html: string, url: string): ParsedPage {
  const $ = cheerio.load(html);
  // <base href> changes how relative URLs resolve.
  const baseHref = $("base[href]").first().attr("href");
  const base = (baseHref && absolutize(baseHref, url)) || url;

  const titleText = $("head title").first().text() || $("title").first().text();
  const title = $("title").length ? clean(titleText) : null;

  const metaByName = (name: string): string | null => {
    const el = $("meta").filter((_, e) => ($(e).attr("name") ?? "").trim().toLowerCase() === name).first();
    if (!el.length) return null;
    const c = el.attr("content");
    return c === undefined ? null : clean(c);
  };

  const metaDescription = metaByName("description");

  const canonEl = $("link")
    .filter((_, e) => ($(e).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"))
    .first();
  const canonical = canonEl.length ? absolutize(canonEl.attr("href"), base) : null;

  const robotsParts: string[] = [];
  $("meta").each((_, e) => {
    const n = ($(e).attr("name") ?? "").trim().toLowerCase();
    if (n === "robots" || n === "googlebot") {
      const c = ($(e).attr("content") ?? "").trim().toLowerCase();
      if (c) robotsParts.push(c);
    }
  });
  const robots = robotsParts.length
    ? [...new Set(robotsParts.join(",").split(",").map((s) => s.trim()).filter(Boolean))].join(", ")
    : null;

  const h1: string[] = [];
  $("h1").each((_, e) => {
    const t = clean($(e).text());
    if (t) h1.push(t);
  });

  const og: Record<string, string> = {};
  $("meta").each((_, e) => {
    const p = ($(e).attr("property") ?? $(e).attr("name") ?? "").trim().toLowerCase();
    if (p.startsWith("og:") && !(p in og)) {
      const c = $(e).attr("content");
      if (c !== undefined) og[p] = clean(c) ?? "";
    }
  });

  const jsonld: ParsedPage["jsonld"] = [];
  $("script").each((_, e) => {
    const type = ($(e).attr("type") ?? "").trim().toLowerCase();
    if (type !== "application/ld+json") return;
    const raw = ($(e).html() ?? "").trim();
    // Strip HTML comment / CDATA wrappers some themes add.
    const body = raw.replace(/^<!--/, "").replace(/-->$/, "").replace(/^\/\/\s*<!\[CDATA\[/, "").replace(/\/\/\s*\]\]>$/, "").trim();
    try {
      const parsed: unknown = JSON.parse(body);
      jsonld.push({ type: jsonLdTypes(parsed), raw, parsed, valid: true });
    } catch {
      jsonld.push({ type: [], raw, parsed: null, valid: false });
    }
  });

  const images: ParsedPage["images"] = [];
  $("img").each((_, e) => {
    const el = $(e);
    let src = el.attr("src");
    const dataSrc = el.attr("data-src") ?? el.attr("data-lazy-src") ?? el.attr("data-original");
    if (!src || src.startsWith("data:")) src = dataSrc ?? src;
    if (!src || src.startsWith("data:")) return;
    const abs = absolutize(src, base);
    if (!abs) return;
    const alt = el.attr("alt");
    images.push({ src: abs, alt: alt === undefined ? null : alt });
  });

  const hreflang: ParsedPage["hreflang"] = [];
  $("link[hreflang]").each((_, e) => {
    const el = $(e);
    const rel = (el.attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate")) return;
    const href = absolutize(el.attr("href"), base);
    const lang = (el.attr("hreflang") ?? "").trim();
    if (href && lang) hreflang.push({ lang, href });
  });

  return {
    url,
    title,
    metaDescription,
    canonical,
    robots,
    h1,
    og,
    jsonld,
    images,
    hreflang,
  };
}

// ------------------------------------------------------------------ fetch

function withCacheBust(url: string): string {
  const u = new URL(url);
  u.searchParams.set("_sa", String(Date.now()));
  return u.toString();
}

function stripCacheBust(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("_sa");
    return u.toString();
  } catch {
    return url;
  }
}

async function timedFetch(url: string, init: RequestInit, opts: FetchOptions = {}): Promise<Response> {
  const f = opts.fetch ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await f(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "User-Agent": opts.userAgent ?? DEFAULT_USER_AGENT,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`Timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms fetching ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export async function fetchSnapshot(url: string, opts: FetchOptions = {}): Promise<PageSnapshot> {
  return (await fetchPage(url, opts)).snapshot;
}

/** Like fetchSnapshot, but also returns the raw HTML (used for body-content checks). */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<{ snapshot: PageSnapshot; html: string }> {
  const reqUrl = opts.cacheBust === false ? url : withCacheBust(url);
  const res = await timedFetch(reqUrl, { method: "GET", redirect: "follow", headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } }, opts);
  const headers = headersToRecord(res.headers);
  const ct = headers["content-type"] ?? "";
  const text = await res.text();
  const parsed = /html|xml/i.test(ct) || ct === "" || /<html|<head/i.test(text.slice(0, 2000))
    ? parseHtml(text, url)
    : parseHtml("", url);
  const finalUrl = stripCacheBust(res.url || reqUrl);
  const snapshot: PageSnapshot = {
    ...parsed,
    url,
    finalUrl,
    status: res.status,
    redirected: res.redirected || normalizeForCompare(finalUrl) !== normalizeForCompare(url),
    headers,
    xRobotsTag: headers["x-robots-tag"] ?? null,
    fetchedAt: new Date().toISOString(),
  };
  return { snapshot, html: text };
}

function normalizeForCompare(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<{ status: number; text: string }> {
  const reqUrl = opts.cacheBust ? withCacheBust(url) : url;
  const res = await timedFetch(reqUrl, { method: "GET", redirect: "follow", headers: { Accept: "text/plain,*/*;q=0.5" } }, opts);
  return { status: res.status, text: await res.text() };
}

export async function checkRedirect(url: string, opts: FetchOptions = {}): Promise<{ status: number; location: string | null }> {
  const reqUrl = opts.cacheBust ? withCacheBust(url) : url;
  const res = await timedFetch(reqUrl, { method: "GET", redirect: "manual" }, opts);
  // Release the body; we only care about status + Location.
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
  const loc = res.headers.get("location");
  return { status: res.status, location: loc ? absolutize(loc, url) : null };
}

// ------------------------------------------------------------------ SSRF guard

function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

/**
 * Throws unless `url` is http(s) and on the same site as `siteUrl` (www and apex count as the same).
 * Port must match too (default ports normalized by URL).
 */
export function assertSameHost(url: string, siteUrl: string): void {
  let u: URL;
  let s: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  try {
    s = new URL(siteUrl);
  } catch {
    throw new Error(`Invalid site URL: ${siteUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Refusing non-http(s) URL: ${url}`);
  if (u.username || u.password) throw new Error(`Refusing URL with credentials: ${url}`);
  if (siteKey(u.hostname) !== siteKey(s.hostname) || u.port !== s.port) {
    throw new Error(`Refusing to fetch ${u.host}: not on the site host ${s.host}`);
  }
}

export function isSameHost(url: string, siteUrl: string): boolean {
  try {
    assertSameHost(url, siteUrl);
    return true;
  } catch {
    return false;
  }
}
