/**
 * Post-apply verification: re-fetch the live page (cache-busted) and check that the change is
 * actually served, and that the page is still healthy.
 *
 * `retryable` distinguishes "probably still cached" (the live value still equals `before`)
 * from hard failures (5xx, 404, unexpected noindex, a value that is neither before nor after).
 */
import * as cheerio from "cheerio";
import type { ChangeRecord, ChangeType, PageSnapshot } from "./schema";
import { assertSameHost, checkRedirect, fetchPage, fetchText, jsonLdTypes } from "./page";

export interface VerifyCheck {
  name: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
}

export interface VerifyResult {
  ok: boolean;
  retryable: boolean;
  checks: VerifyCheck[];
  checked_url: string;
  at: string;
  /** Informational notes (e.g. "manual review"). */
  notes?: string[];
}

export interface VerifyOptions {
  siteUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Which value must be live: "after" (default, post-apply) or "before" (post-rollback).
   * With "before", the roles of before/after are swapped for every check.
   */
  expect?: "after" | "before";
}

// ------------------------------------------------------------------ normalization

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", euro: "€", pound: "£",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[g.toLowerCase()] ?? m;
  });
}

/**
 * Collapse whitespace, decode entities, and fold typographic substitutions that CMSs apply on
 * output (WordPress wptexturize turns ' into ’ and -- into –).
 */
export function normalizeText(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = decodeEntities(decodeEntities(String(v)));
  s = s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

export function normalizeUrl(u: unknown, base?: string): string {
  if (typeof u !== "string" || !u.trim()) return "";
  try {
    const x = new URL(u.trim(), base);
    x.hash = "";
    x.hostname = x.hostname.toLowerCase();
    let out = x.toString();
    if (out.endsWith("/") && x.pathname !== "/") out = out.slice(0, -1);
    if (x.pathname === "/" && !x.search) out = out.replace(/\/$/, "");
    return out;
  } catch {
    return u.trim();
  }
}

function normalizeLines(s: unknown): string {
  return String(s ?? "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** Image URL key: no query/hash, no WP size suffix (-300x200), no "-scaled", lowercase. */
function imageKey(src: string, base?: string): string {
  let p: string;
  try {
    const u = new URL(src, base);
    p = u.pathname;
  } catch {
    p = src.split(/[?#]/)[0];
  }
  return decodeURIComponent(p)
    .toLowerCase()
    .replace(/-\d+x\d+(?=\.[a-z0-9]+$)/, "")
    .replace(/-scaled(?=\.[a-z0-9]+$)/, "")
    .replace(/@2x(?=\.[a-z0-9]+$)/, "");
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// ------------------------------------------------------------------ live values

export function parseRobots(content: string | null | undefined): { index: boolean; follow: boolean } {
  const c = (content ?? "").toLowerCase();
  const tokens = c.split(/[,\s]+/).map((t) => t.replace(/^[a-z-]+:/, "")).filter(Boolean);
  const none = tokens.includes("none");
  return { index: !(none || tokens.includes("noindex")), follow: !(none || tokens.includes("nofollow")) };
}

export function isNoindex(snap: PageSnapshot): boolean {
  return !parseRobots(snap.robots).index || !parseRobots(snap.xRobotsTag).index;
}

/** All JSON-LD nodes (top-level objects, array items, @graph members) with their source block. */
function jsonLdNodes(snap: PageSnapshot): Array<{ node: Record<string, unknown>; block: PageSnapshot["jsonld"][number] }> {
  const out: Array<{ node: Record<string, unknown>; block: PageSnapshot["jsonld"][number] }> = [];
  for (const block of snap.jsonld) {
    if (!block.valid) continue;
    const visit = (v: unknown, depth: number) => {
      if (depth > 4 || v === null || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
      const o = v as Record<string, unknown>;
      out.push({ node: o, block });
      if (Array.isArray(o["@graph"])) visit(o["@graph"], depth + 1);
    };
    visit(block.parsed, 0);
  }
  return out;
}

function nodeHasType(node: Record<string, unknown>, type: string): boolean {
  const t = node["@type"];
  const want = type.toLowerCase();
  if (typeof t === "string") return t.toLowerCase() === want;
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x.toLowerCase() === want);
  return false;
}

export function findImage(snap: PageSnapshot, src: string): { src: string; alt: string | null } | null {
  if (!src) return null;
  const base = snap.finalUrl || snap.url;
  const abs = normalizeUrl(src, base);
  const exact = snap.images.find((i) => normalizeUrl(i.src, base) === abs);
  if (exact) return exact;
  const noQuery = (u: string) => {
    try {
      const x = new URL(u, base);
      return x.origin + x.pathname;
    } catch {
      return u.split(/[?#]/)[0];
    }
  };
  const nq = noQuery(src);
  const byPath = snap.images.find((i) => noQuery(i.src) === nq);
  if (byPath) return byPath;
  const key = imageKey(src, base);
  const byKey = snap.images.find((i) => imageKey(i.src, base) === key);
  if (byKey) return byKey;
  // CDNs (Jetpack Photon, imgix) may rewrite the host/path prefix: match on the file name.
  const bn = basename(key);
  const byName = snap.images.filter((i) => basename(imageKey(i.src, base)) === bn);
  return byName.length === 1 ? byName[0] : null;
}

/**
 * Current value of the element `type` refers to, in the same shape as the payload.
 * Returns null when the element is absent (robots_meta returns the effective default
 * {index:true, follow:true} when no directive is present).
 */
export function liveValue(type: ChangeType, snap: PageSnapshot, after: unknown): unknown {
  const a = (after ?? {}) as Record<string, unknown>;
  switch (type) {
    case "title":
      return snap.title ? { value: snap.title } : null;
    case "meta_description":
      return snap.metaDescription ? { value: snap.metaDescription } : null;
    case "h1": {
      if (!snap.h1.length) return null;
      const want = normalizeText(a.value);
      const match = want ? snap.h1.find((h) => normalizeText(h) === want) : undefined;
      return { value: match ?? snap.h1[0] };
    }
    case "canonical":
      return snap.canonical ? { value: snap.canonical } : null;
    case "robots_meta": {
      const m = parseRobots(snap.robots);
      const x = parseRobots(snap.xRobotsTag);
      return { index: m.index && x.index, follow: m.follow && x.follow };
    }
    case "og_tags": {
      const t = snap.og["og:title"];
      const d = snap.og["og:description"];
      const i = snap.og["og:image"] ?? snap.og["og:image:url"] ?? snap.og["og:image:secure_url"];
      if (t === undefined && d === undefined && i === undefined) return null;
      const out: Record<string, string> = {};
      if (t !== undefined) out.title = t;
      if (d !== undefined) out.description = d;
      if (i !== undefined) out.image = i;
      return out;
    }
    case "image_alt": {
      const img = findImage(snap, String(a.src ?? ""));
      return img ? { src: img.src, alt: img.alt } : null;
    }
    case "jsonld_add":
    case "jsonld_fix": {
      const t = String(a.schema_type ?? "");
      if (!t) return null;
      const nodes = jsonLdNodes(snap).filter((n) => nodeHasType(n.node, t));
      if (!nodes.length) return null;
      const expected = a.schema as Record<string, unknown> | undefined;
      if (expected) {
        const best = nodes.find((n) => isSubset(expected, n.node));
        if (best) return best.node;
      }
      return nodes[0].node;
    }
    case "hreflang":
      return snap.hreflang.length ? { alternates: snap.hreflang.map((h) => ({ lang: h.lang, url: h.href })) } : null;
    case "slug": {
      try {
        const p = new URL(snap.finalUrl || snap.url).pathname.replace(/\/$/, "");
        const seg = p.slice(p.lastIndexOf("/") + 1);
        return seg ? { value: seg } : null;
      } catch {
        return null;
      }
    }
    default:
      // redirect, robots_txt, llms_txt, content_edit, internal_link, code_change: not derivable from a snapshot.
      return null;
  }
}

// ------------------------------------------------------------------ comparison

/** Deep subset of primitive values (strings compared normalized). `@context` is ignored. */
export function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return true;
  if (typeof expected !== "object") {
    if (actual === null || actual === undefined) return false;
    if (typeof actual === "object") {
      // {"@id": x} vs "x", or a single-element array
      if (Array.isArray(actual)) return actual.some((x) => isSubset(expected, x));
      return false;
    }
    if (typeof expected === "string" && typeof actual === "string") {
      if (/^https?:\/\//i.test(expected)) return normalizeUrl(expected) === normalizeUrl(actual);
      return normalizeText(expected) === normalizeText(actual);
    }
    if (typeof expected === "number" || typeof actual === "number") return Number(expected) === Number(actual);
    return String(expected) === String(actual);
  }
  if (Array.isArray(expected)) {
    const arr = Array.isArray(actual) ? actual : [actual];
    return expected.every((e) => arr.some((x) => isSubset(e, x)));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    if (Array.isArray(actual)) return actual.some((x) => isSubset(expected, x));
    return false;
  }
  const act = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (k === "@context") continue;
    if (!isSubset(v, act[k])) return false;
  }
  return true;
}

/** Type-aware equality between a live value and an expected payload-shaped value. */
export function valuesMatch(type: ChangeType, expected: unknown, live: unknown): boolean {
  const e = (expected ?? null) as Record<string, unknown> | null;
  const l = (live ?? null) as Record<string, unknown> | null;
  const emptyE = e === null || (typeof e === "object" && Object.keys(e).length === 0) || isBlank(e);
  if (l === null) return emptyE;
  if (e === null) return isBlank(l);
  switch (type) {
    case "title":
    case "meta_description":
    case "h1":
    case "slug":
      return normalizeText(e.value) === normalizeText(l.value);
    case "canonical":
      return normalizeUrl(e.value) === normalizeUrl(l.value);
    case "robots_meta":
      return Boolean(e.index ?? true) === Boolean(l.index) && Boolean(e.follow ?? true) === Boolean(l.follow);
    case "og_tags":
      for (const k of ["title", "description"] as const)
        if (e[k] !== undefined && normalizeText(e[k]) !== normalizeText(l[k])) return false;
      if (e.image !== undefined && normalizeUrl(e.image) !== normalizeUrl(l.image)) return false;
      return true;
    case "image_alt":
      return normalizeText(e.alt) === normalizeText(l.alt) && (e.alt === null) === (l.alt === null);
    case "jsonld_add":
    case "jsonld_fix":
      return isSubset(e.schema ?? e, l);
    case "hreflang": {
      const want = (e.alternates as Array<{ lang: string; url: string }>) ?? [];
      const have = (l.alternates as Array<{ lang: string; url: string }>) ?? [];
      return want.every((w) =>
        have.some((h) => h.lang.toLowerCase() === w.lang.toLowerCase() && normalizeUrl(h.url) === normalizeUrl(w.url)),
      );
    }
    default:
      return JSON.stringify(e) === JSON.stringify(l);
  }
}

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return isBlank(o.value);
    if ("content" in o) return isBlank(o.content);
  }
  return false;
}

// ------------------------------------------------------------------ verify

const PAGE_TYPES: ChangeType[] = [
  "title", "meta_description", "h1", "canonical", "robots_meta", "og_tags", "image_alt",
  "jsonld_add", "jsonld_fix", "hreflang", "slug", "content_edit", "internal_link", "code_change",
];

function siteOrigin(siteUrl: string): string {
  return new URL(siteUrl).origin;
}

interface Ctx {
  checks: VerifyCheck[];
  notes: string[];
  hard: boolean;      // a non-retryable failure was seen
  soft: boolean;      // a mismatch that matches "before" (likely cache)
}

function add(ctx: Ctx, c: VerifyCheck, kind: "hard" | "soft" | "auto" = "auto") {
  ctx.checks.push(c);
  if (!c.ok) {
    if (kind === "hard") ctx.hard = true;
    else if (kind === "soft") ctx.soft = true;
  }
}

function healthChecks(ctx: Ctx, snap: PageSnapshot, allowNoindex: boolean) {
  const st = snap.status;
  add(ctx, { name: "status_200", ok: st === 200, expected: 200, actual: st }, st === 200 ? "auto" : st === 429 ? "soft" : "hard");
  if (!allowNoindex) {
    const ni = isNoindex(snap);
    add(
      ctx,
      { name: "not_noindex", ok: !ni, expected: "indexable", actual: ni ? snap.robots ?? snap.xRobotsTag : "indexable" },
      "hard",
    );
  }
  if (st === 200) {
    add(ctx, { name: "title_non_empty", ok: !!(snap.title && snap.title.trim()), actual: snap.title }, "hard");
  }
}

function bodyText(html: string): { text: string; html: string; $: cheerio.CheerioAPI } {
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();
  const text = normalizeText($("body").length ? $("body").text() : $.root().text());
  return { text, html: normalizeText(html), $ };
}

export async function verifyChange(change: ChangeRecord, opts: VerifyOptions): Promise<VerifyResult> {
  const at = new Date().toISOString();
  const fopts = { fetch: opts.fetch, timeoutMs: opts.timeoutMs };
  const rollbackMode = opts.expect === "before";
  const expected = (rollbackMode ? change.before : change.after) as Record<string, unknown> | null;
  const previous = (rollbackMode ? change.after : change.before) as Record<string, unknown> | null;
  // Payload hints (src, schema_type, from_path...) always come from `after`, which is the full payload.
  const payload = (change.after ?? {}) as Record<string, unknown>;
  const ctx: Ctx = { checks: [], notes: [], hard: false, soft: false };
  let checkedUrl = change.target.url;

  const finish = (): VerifyResult => {
    const ok = ctx.checks.length > 0 && ctx.checks.every((c) => c.ok);
    return {
      ok,
      retryable: !ok && !ctx.hard && ctx.soft,
      checks: ctx.checks,
      checked_url: checkedUrl,
      at,
      ...(ctx.notes.length ? { notes: ctx.notes } : {}),
    };
  };

  try {
    const type = change.type;

    // ---------------------------------------------------------- site files
    if (type === "robots_txt" || type === "llms_txt") {
      checkedUrl = `${siteOrigin(opts.siteUrl)}/${type === "robots_txt" ? "robots.txt" : "llms.txt"}`;
      assertSameHost(checkedUrl, opts.siteUrl);
      const res = await fetchText(checkedUrl, { ...fopts, cacheBust: true });
      const want = normalizeLines(expected?.content);
      const got = normalizeLines(res.text);
      const wantStatus = rollbackMode && !want ? null : 200;
      if (wantStatus) {
        add(ctx, { name: "status_200", ok: res.status === 200, expected: 200, actual: res.status }, res.status === 404 || res.status >= 500 ? "hard" : "soft");
      }
      if (res.status === 200 || !wantStatus) {
        const match = !want ? true : got === want;
        const wasBefore = normalizeLines(previous?.content) === got;
        add(ctx, { name: `${type}_content`, ok: match, expected: want, actual: got }, wasBefore ? "soft" : "hard");
      }
      // Health of the home page: a broken robots.txt write must not have broken the site.
      const home = await fetchPage(siteOrigin(opts.siteUrl) + "/", fopts);
      healthChecks(ctx, home.snapshot, false);
      return finish();
    }

    // ---------------------------------------------------------- redirect
    if (type === "redirect") {
      const fromPath = String(payload.from_path ?? "/");
      const toUrl = String(payload.to_url ?? "");
      const fromUrl = new URL(fromPath, siteOrigin(opts.siteUrl)).toString();
      checkedUrl = fromUrl;
      assertSameHost(fromUrl, opts.siteUrl);
      const r = await checkRedirect(fromUrl, fopts);
      const isRedirect = r.status === 301 || r.status === 308;
      if (rollbackMode) {
        // After rollback the redirect must be gone (or match the previous redirect if there was one).
        const prevTo = (expected as { to_url?: string } | null)?.to_url;
        const ok = prevTo ? isRedirect && normalizeUrl(r.location) === normalizeUrl(prevTo) : !(r.status >= 300 && r.status < 400 && normalizeUrl(r.location) === normalizeUrl(toUrl));
        add(ctx, { name: "redirect_removed", ok, expected: prevTo ?? "no redirect", actual: { status: r.status, location: r.location } }, "soft");
        return finish();
      }
      const liveTo = r.status >= 300 && r.status < 400 ? r.location : null;
      const beforeTo = (previous as { to_url?: string } | null)?.to_url ?? null;
      const stillBefore = normalizeUrl(liveTo ?? "") === normalizeUrl(beforeTo ?? "");
      add(ctx, { name: "redirect_status", ok: isRedirect, expected: [301, 308], actual: r.status }, stillBefore || r.status === 200 || r.status === 404 ? "soft" : "hard");
      add(ctx, { name: "redirect_location", ok: normalizeUrl(r.location) === normalizeUrl(toUrl), expected: toUrl, actual: r.location }, stillBefore ? "soft" : "hard");
      // The target must be live. Only fetch it when it is on our site (SSRF guard).
      let targetSameSite = true;
      try {
        assertSameHost(toUrl, opts.siteUrl);
      } catch {
        targetSameSite = false;
      }
      if (targetSameSite) {
        const target = await fetchPage(toUrl, fopts);
        add(ctx, { name: "target_status_200", ok: target.snapshot.status === 200, expected: 200, actual: target.snapshot.status }, "hard");
        add(ctx, { name: "target_not_redirect_chain", ok: !target.snapshot.redirected, actual: target.snapshot.finalUrl }, "hard");
        const ni = isNoindex(target.snapshot);
        add(ctx, { name: "target_not_noindex", ok: !ni, actual: target.snapshot.robots ?? target.snapshot.xRobotsTag }, "hard");
      } else {
        ctx.notes.push(`Redirect target ${toUrl} is off-site; not fetched`);
      }
      return finish();
    }

    if (!PAGE_TYPES.includes(type)) {
      ctx.notes.push(`No verifier for type ${type}`);
      add(ctx, { name: "manual_review", ok: true });
      return finish();
    }

    // ---------------------------------------------------------- page-level types
    assertSameHost(checkedUrl, opts.siteUrl);
    const { snapshot: snap, html } = await fetchPage(checkedUrl, fopts);
    const allowNoindex = type === "robots_meta" && (expected as { index?: boolean } | null)?.index === false;
    healthChecks(ctx, snap, allowNoindex);
    if (snap.status !== 200) return finish();

    switch (type) {
      case "content_edit":
      case "internal_link":
      case "code_change": {
        const { text, html: normHtml, $ } = bodyText(html);
        if (type === "content_edit") {
          const find = payload.find as string | undefined;
          const replace = payload.replace as string | undefined;
          if (find === undefined && replace === undefined) {
            ctx.notes.push("manual review");
            add(ctx, { name: "manual_review", ok: true, actual: "manual review" });
            break;
          }
          const has = (s: string) => {
            const n = normalizeText(s);
            if (!n) return false;
            const stripped = normalizeText(cheerio.load(`<div>${s}</div>`)("div").text());
            return normHtml.includes(n) || text.includes(n) || (!!stripped && text.includes(stripped));
          };
          const want = rollbackMode ? find : replace;
          const gone = rollbackMode ? replace : find;
          const wantPresent = want ? has(want) : true;
          const goneAbsent = gone && !(want && normalizeText(want).includes(normalizeText(gone))) ? !has(gone) : true;
          const kind = !wantPresent && gone && has(gone) ? "soft" : "hard";
          if (want) add(ctx, { name: "content_present", ok: wantPresent, expected: want }, kind);
          if (gone && !(want && normalizeText(want).includes(normalizeText(gone)))) add(ctx, { name: "content_replaced", ok: goneAbsent, expected: `absent: ${gone}` }, kind);
          break;
        }
        if (type === "internal_link") {
          const anchor = normalizeText(payload.anchor);
          const to = normalizeUrl(String(payload.to_url ?? ""));
          if (!anchor) {
            ctx.notes.push("manual review");
            add(ctx, { name: "manual_review", ok: true, actual: "manual review" });
            break;
          }
          let found = false;
          $("a[href]").each((_, el) => {
            const href = normalizeUrl($(el).attr("href"), snap.finalUrl || snap.url);
            const t = normalizeText($(el).text());
            if (href === to && t.toLowerCase().includes(anchor.toLowerCase())) found = true;
          });
          const ok = rollbackMode ? !found : found;
          add(ctx, { name: rollbackMode ? "link_absent" : "link_present", ok, expected: { anchor, to_url: to } }, "soft");
          break;
        }
        ctx.notes.push("manual review");
        add(ctx, { name: "manual_review", ok: true, actual: "manual review" });
        break;
      }

      case "jsonld_add":
      case "jsonld_fix": {
        const t = String(payload.schema_type ?? "");
        const blocks = snap.jsonld.filter((b) => b.valid && (b.type.some((x) => x.toLowerCase() === t.toLowerCase()) || jsonLdTypes(b.parsed).includes(t)));
        const live = liveValue(type, snap, payload);
        if (rollbackMode) {
          const prev = expected as { schema?: unknown } | null;
          if (!prev || !prev.schema) {
            const stillThere = live !== null && isSubset((payload.schema ?? {}) as object, live);
            add(ctx, { name: "jsonld_removed", ok: !stillThere, expected: null, actual: live }, "soft");
          } else {
            add(ctx, { name: "jsonld_restored", ok: valuesMatch(type, prev, live), expected: prev.schema, actual: live }, "soft");
          }
          break;
        }
        const wasBefore = valuesMatch(type, previous, live) || (live === null && isBlank(previous));
        add(ctx, { name: "jsonld_block_exists", ok: blocks.length > 0, expected: t, actual: snap.jsonld.map((b) => b.type) }, wasBefore ? "soft" : "hard");
        const invalid = snap.jsonld.filter((b) => !b.valid).length;
        if (type === "jsonld_fix") {
          add(ctx, { name: "jsonld_parses", ok: invalid === 0, expected: 0, actual: invalid }, wasBefore ? "soft" : "hard");
        }
        if (blocks.length) {
          add(ctx, { name: "jsonld_fields", ok: valuesMatch(type, payload, live), expected: payload.schema, actual: live }, wasBefore ? "soft" : "hard");
        }
        break;
      }

      default: {
        const live = liveValue(type, snap, payload);
        const ok = valuesMatch(type, expected, live);
        const wasBefore = !ok && valuesMatch(type, previous, live);
        add(ctx, { name: type, ok, expected, actual: live }, wasBefore ? "soft" : "hard");
      }
    }
    return finish();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ssrf = /Refusing|Invalid URL|Invalid site URL/.test(msg);
    add(ctx, { name: ssrf ? "ssrf_guard" : "fetch", ok: false, actual: msg }, ssrf ? "hard" : "soft");
    return finish();
  }
}

export interface RetryOptions extends VerifyOptions {
  delaysMs?: number[];
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (attempt: number, result: VerifyResult) => void;
}

export const DEFAULT_VERIFY_DELAYS_MS = [0, 15_000, 45_000, 120_000];

export async function verifyWithRetry(change: ChangeRecord, opts: RetryOptions): Promise<VerifyResult> {
  const delays = opts.delaysMs?.length ? opts.delaysMs : DEFAULT_VERIFY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: VerifyResult | null = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    last = await verifyChange(change, opts);
    opts.onAttempt?.(i + 1, last);
    if (last.ok || !last.retryable) return last;
  }
  return last!;
}
