/**
 * Risk classifier: decides whether a proposed change can be applied automatically,
 * needs a human to approve it, or must never be automated.
 *
 * The model never chooses the tier. This runs on the server when proposals are stored.
 *
 * Base tiers follow Google Search Central guidance and practitioner consensus
 * (see docs/research/research-repos-and-risk.md). Escalators can only make a change
 * stricter, except explicit site-policy overrides, which can relax approve -> auto
 * and never -> approve, but never relax never -> auto.
 */
import type { ChangeType, PageMetrics, SitePolicy, Tier } from "./schema";

export interface RiskContext {
  type: ChangeType;
  url: string;
  siteUrl: string;
  before: unknown;           // live value read by the runner (null/empty = missing)
  after: unknown;
  metrics?: PageMetrics | null;
  batchSize: number;         // proposals in this batch
  autoAppliedToday: number;  // auto changes already applied today on this site
  resourceFile?: string;     // repo: file that holds the element (layout files affect many pages)
}

export interface RiskDecision {
  tier: Tier;
  reasons: string[];
}

const ORDER: Record<Tier, number> = { auto: 0, approve: 1, never: 2 };
const stricter = (a: Tier, b: Tier): Tier => (ORDER[a] >= ORDER[b] ? a : b);

/** JSON-LD types that describe the site itself and are safe to add when missing. */
const SAFE_SCHEMA_TYPES = new Set([
  "Organization", "WebSite", "BreadcrumbList", "Article", "BlogPosting", "NewsArticle",
  "Person", "ProfilePage", "WebPage", "CollectionPage", "AboutPage", "ContactPage", "ImageObject",
]);
/** Types where Google's spam policies bite if markup isn't visible on the page. */
const SENSITIVE_SCHEMA_TYPES = new Set([
  "Review", "AggregateRating", "Product", "Offer", "Event", "JobPosting", "Recipe",
  "Course", "FAQPage", "QAPage", "Dataset", "SoftwareApplication", "LocalBusiness", "VideoObject",
]);

export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return isEmpty(o.value);
    if ("alt" in o) return isEmpty(o.alt);
    if ("content" in o) return isEmpty(o.content);
    return Object.keys(o).length === 0;
  }
  return false;
}

function isHome(url: string, siteUrl: string): boolean {
  try {
    const u = new URL(url);
    const s = new URL(siteUrl);
    return u.host === s.host && (u.pathname === "/" || u.pathname === "");
  } catch {
    return false;
  }
}

function baseTier(ctx: RiskContext): RiskDecision {
  const missing = isEmpty(ctx.before);
  const a = (ctx.after ?? {}) as Record<string, unknown>;
  switch (ctx.type) {
    case "image_alt":
      return missing
        ? { tier: "auto", reasons: ["Adds alt text where there was none"] }
        : { tier: "approve", reasons: ["Replaces existing alt text"] };
    case "meta_description":
      return missing
        ? { tier: "auto", reasons: ["Adds a missing meta description (Google allows generated descriptions)"] }
        : { tier: "approve", reasons: ["Rewrites an existing meta description"] };
    case "og_tags":
      return missing
        ? { tier: "auto", reasons: ["Adds missing Open Graph tags"] }
        : { tier: "approve", reasons: ["Changes existing Open Graph tags"] };
    case "jsonld_fix":
      return { tier: "auto", reasons: ["Repairs structured data that is invalid today"] };
    case "jsonld_add": {
      const t = String(a.schema_type ?? "");
      if (SAFE_SCHEMA_TYPES.has(t)) return { tier: "auto", reasons: [`Adds ${t} markup describing the site`] };
      if (SENSITIVE_SCHEMA_TYPES.has(t))
        return { tier: "approve", reasons: [`${t} markup must match visible content (Google structured-data policy)`] };
      return { tier: "approve", reasons: [`Adds ${t || "unknown"} markup`] };
    }
    case "llms_txt":
      return missing
        ? { tier: "auto", reasons: ["Creates a missing llms.txt"] }
        : { tier: "approve", reasons: ["Replaces the existing llms.txt"] };
    case "title":
      return missing
        ? { tier: "auto", reasons: ["Adds a missing title"] }
        : { tier: "approve", reasons: ["Rewrites a title link Google shows in results"] };
    case "h1":
      return { tier: "approve", reasons: ["Changes visible page content"] };
    case "canonical":
      return missing
        ? { tier: "approve", reasons: ["Adds a canonical; wrong canonicals move ranking signals"] }
        : { tier: "approve", reasons: ["Changes an existing canonical"] };
    case "robots_meta": {
      const noindex = a.index === false;
      if (noindex) return { tier: "approve", reasons: ["Removes the page from Google's index"] };
      return { tier: "approve", reasons: ["Changes indexing directives"] };
    }
    case "robots_txt": {
      const content = String(a.content ?? "");
      if (/^\s*disallow:\s*\/\s*$/im.test(content))
        return { tier: "never", reasons: ["Would block the whole site from crawling"] };
      return { tier: "approve", reasons: ["robots.txt controls crawling for the whole site"] };
    }
    case "redirect":
      return { tier: "approve", reasons: ["Redirects move ranking signals and should stay at least a year"] };
    case "hreflang":
      return { tier: "approve", reasons: ["International targeting affects which version ranks per country"] };
    case "internal_link":
      return { tier: "approve", reasons: ["Edits body content"] };
    case "content_edit":
      return { tier: "approve", reasons: ["Edits body content"] };
    case "code_change":
      return { tier: "approve", reasons: ["Free-form code change"] };
    case "slug":
      return { tier: "never", reasons: ["URL changes cause ranking swings for weeks; do it by hand with redirects"] };
  }
}

export function classify(ctx: RiskContext, policy: SitePolicy): RiskDecision {
  let { tier, reasons } = baseTier(ctx);
  reasons = [...reasons];

  // 1. Protected paths
  const path = safePath(ctx.url);
  if (policy.protected_paths.some((p) => path.startsWith(p))) {
    return { tier: "never", reasons: [...reasons, `Path ${path} is protected in site policy`] };
  }

  // 2. Traffic: important pages need a human; risky changes on them are never automated.
  const m = ctx.metrics;
  const important =
    !!m &&
    ((m.clicks28d ?? 0) >= policy.traffic_clicks_threshold ||
      (m.impressions28d ?? 0) >= policy.traffic_impressions_threshold);
  if (important) {
    const note = `Page has traffic (${m?.clicks28d ?? 0} clicks / ${m?.impressions28d ?? 0} impressions in 28 days)`;
    if (ctx.type === "robots_meta" && (ctx.after as { index?: boolean })?.index === false) {
      tier = "never";
      reasons.push(`${note}; noindex would drop it from search`);
    } else if (tier === "auto") {
      tier = "approve";
      reasons.push(note);
    }
  }
  if ((m?.backlinks ?? 0) > 0 && (ctx.type === "slug" || ctx.type === "redirect")) {
    tier = stricter(tier, "approve");
    reasons.push("Page has backlinks");
  }

  // 3. Homepage and shared templates touch many visitors / pages.
  if (tier === "auto" && isHome(ctx.url, ctx.siteUrl)) {
    tier = "approve";
    reasons.push("Homepage");
  }
  if (tier === "auto" && ctx.resourceFile && /(^|\/)(layout|_app|_document|template|head)\.[jt]sx?$/.test(ctx.resourceFile)) {
    tier = "approve";
    reasons.push(`Shared template ${ctx.resourceFile} affects many pages`);
  }

  // 4. Volume limits
  if (tier === "auto" && ctx.batchSize > policy.max_batch_size) {
    tier = "approve";
    reasons.push(`Batch of ${ctx.batchSize} exceeds the auto limit of ${policy.max_batch_size}`);
  }
  if (tier === "auto" && ctx.autoAppliedToday >= policy.max_auto_per_day) {
    tier = "approve";
    reasons.push(`Daily auto limit of ${policy.max_auto_per_day} reached`);
  }

  // 5. Explicit policy override (can relax, but never -> auto is not allowed)
  const ov = policy.overrides?.[ctx.type];
  if (ov && ov !== tier) {
    if (tier === "never" && ov === "auto") {
      tier = "approve";
      reasons.push("Policy asks for auto, but this kind of change can at most be approved by a person");
    } else if (!(important && ov === "auto")) {
      reasons.push(`Site policy sets ${ctx.type} to ${ov}`);
      tier = ov;
    }
  }

  // 6. Mode: in "suggest" every automatic change waits for a person.
  if (policy.mode !== "auto" && tier === "auto") {
    tier = "approve";
    reasons.push("Site is in suggest mode: every change needs approval");
  }
  return { tier, reasons };
}

/** Status a freshly stored change gets. */
export function initialStatus(tier: Tier, mode: SitePolicy["mode"]): "approved" | "pending_approval" | "blocked" {
  if (tier === "never") return "blocked";
  if (tier === "auto" && mode === "auto") return "approved";
  return "pending_approval";
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
