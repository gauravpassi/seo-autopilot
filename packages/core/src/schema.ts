/**
 * Shared contract for SEO Autopilot.
 *
 * Every piece (runner, control panel, plugin skill output, adapters) speaks these types.
 * Keep this file the single source of truth; the SQL columns mirror it.
 */
import { z } from "zod";

// ------------------------------------------------------------------ platforms
export const Platform = z.enum(["wordpress", "shopify", "repo", "other"]);
export type Platform = z.infer<typeof Platform>;

// ------------------------------------------------------------------ change types
/**
 * Every kind of fix the system knows about. A platform adapter declares which of
 * these it can apply; anything else becomes advice ("manual") for a human.
 */
export const ChangeType = z.enum([
  "title",            // <title>
  "meta_description", // <meta name="description">
  "h1",               // main heading text
  "canonical",        // <link rel="canonical">
  "robots_meta",      // <meta name="robots"> index/follow
  "og_tags",          // Open Graph title/description/image
  "image_alt",        // alt text of one image on a page
  "jsonld_add",       // add a JSON-LD block
  "jsonld_fix",       // replace an invalid/incorrect JSON-LD block
  "redirect",         // 301 from a path to a URL
  "robots_txt",       // full robots.txt content
  "llms_txt",         // full llms.txt content
  "slug",             // change the URL of a page (never automated)
  "content_edit",     // edit body content of a page
  "internal_link",    // add an internal link inside body content
  "hreflang",         // hreflang alternates
  "code_change",      // repo-only free-form code change (described in prose, done by Claude on a branch)
]);
export type ChangeType = z.infer<typeof ChangeType>;

export const ResourceKind = z.enum([
  "post", "page", "product", "collection", "article", "blog", "media", "file", "site", "route", "unknown",
]);
export type ResourceKind = z.infer<typeof ResourceKind>;

export const ResourceRef = z.object({
  kind: ResourceKind,
  id: z.string().optional(),        // platform id (WP post id, Shopify GID, repo file path)
  handle: z.string().optional(),    // slug / Shopify handle
  file: z.string().optional(),      // repo: file that defines the element
});
export type ResourceRef = z.infer<typeof ResourceRef>;

export const Target = z.object({
  url: z.string().url(),            // live page the change shows up on ("/robots.txt" etc. for site files)
  resource: ResourceRef.optional(), // filled by the runner's adapter.resolve(), not by the model
});
export type Target = z.infer<typeof Target>;

// ------------------------------------------------------------------ per-type payloads ("after" values)
export const Payloads = {
  title: z.object({ value: z.string().min(1).max(120) }),
  meta_description: z.object({ value: z.string().min(1).max(320) }),
  h1: z.object({ value: z.string().min(1).max(200) }),
  canonical: z.object({ value: z.string().url() }),
  robots_meta: z.object({ index: z.boolean(), follow: z.boolean() }),
  og_tags: z.object({
    title: z.string().max(200).optional(),
    description: z.string().max(400).optional(),
    image: z.string().url().optional(),
  }),
  image_alt: z.object({ src: z.string().min(1), alt: z.string().max(250), media_id: z.string().optional() }),
  jsonld_add: z.object({ schema_type: z.string().min(1), schema: z.record(z.string(), z.unknown()) }),
  jsonld_fix: z.object({
    schema_type: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
    replaces_type: z.string().optional(),
  }),
  redirect: z.object({ from_path: z.string().startsWith("/"), to_url: z.string().url(), code: z.literal(301).default(301) }),
  robots_txt: z.object({ content: z.string().min(1).max(20000) }),
  llms_txt: z.object({ content: z.string().min(1).max(100000) }),
  slug: z.object({ value: z.string().min(1).max(200) }),
  content_edit: z.object({
    instructions: z.string().min(1),       // what to change, in plain words
    find: z.string().optional(),           // exact text to replace (when known)
    replace: z.string().optional(),
  }),
  internal_link: z.object({ anchor: z.string().min(1), to_url: z.string().url(), near_text: z.string().optional() }),
  hreflang: z.object({ alternates: z.array(z.object({ lang: z.string(), url: z.string().url() })).min(1) }),
  code_change: z.object({ instructions: z.string().min(1), files_hint: z.array(z.string()).optional() }),
} as const satisfies Record<ChangeType, z.ZodTypeAny>;

export type PayloadFor<T extends ChangeType> = z.infer<(typeof Payloads)[T]>;

export function parsePayload(type: ChangeType, value: unknown) {
  return Payloads[type].safeParse(value);
}

// ------------------------------------------------------------------ proposals (model output)
/**
 * What the propose skill emits. The model never sets the tier or the "before" value.
 */
export const Proposal = z.object({
  type: ChangeType,
  url: z.string().url(),
  after: z.unknown(),
  rationale: z.string().min(1),             // the first-principle observation (claude-seo THINK)
  evidence: z.string().optional(),          // what in the audit shows the problem
  expected_impact: z.string().optional(),   // leading indicator to watch (claude-seo GROW)
  failure_check: z.string().optional(),     // how we'd know it failed (claude-seo ACCEPT)
  finding_title: z.string().optional(),     // links back to the audit finding
  severity: z.enum(["Critical", "High", "Medium", "Low", "Info"]).optional(),
});
export type Proposal = z.infer<typeof Proposal>;

export const ProposalFile = z.object({
  site_url: z.string().url(),
  proposals: z.array(Proposal),
  manual_recommendations: z
    .array(z.object({ title: z.string(), detail: z.string(), url: z.string().optional() }))
    .default([]),
});
export type ProposalFile = z.infer<typeof ProposalFile>;

// ------------------------------------------------------------------ risk tiers & policy
export const Tier = z.enum(["auto", "approve", "never"]);
export type Tier = z.infer<typeof Tier>;

export const AutopilotMode = z.enum([
  "off",      // audits only; nothing is proposed or applied
  "suggest",  // propose everything, every change needs approval (default for new sites)
  "auto",     // "auto" tier changes apply without asking; others need approval
]);
export type AutopilotMode = z.infer<typeof AutopilotMode>;

export const SitePolicy = z.object({
  mode: AutopilotMode.default("suggest"),
  /** Per-type tier overrides. "never" can only be relaxed to "approve". */
  overrides: z.partialRecord(ChangeType, Tier).default({}),
  /** A page above either threshold (last 28 days) is "important": auto -> approve, risky -> never. */
  traffic_clicks_threshold: z.number().int().min(0).default(10),
  traffic_impressions_threshold: z.number().int().min(0).default(500),
  /** Max auto-applied changes per day; extra ones wait for approval. */
  max_auto_per_day: z.number().int().min(0).default(25),
  /** Max changes in one batch before everything in it needs approval. */
  max_batch_size: z.number().int().min(1).default(50),
  /** Undo automatically when the post-apply check fails. */
  auto_rollback: z.boolean().default(true),
  /** Pending approvals expire after this many hours. */
  approval_ttl_hours: z.number().int().min(1).default(72),
  /** After an audit, propose fixes automatically. */
  auto_propose: z.boolean().default(true),
  /** Traffic-drop guard (needs Search Console): alert or revert when clicks fall this much. */
  rollback_on_click_drop_pct: z.number().min(0).max(100).default(20),
  /** Repo sites: merge the PR automatically once checks pass on the preview. */
  repo_auto_merge: z.boolean().default(false),
  /** Paths the agent must never touch (prefix match). */
  protected_paths: z.array(z.string()).default([]),
});
export type SitePolicy = z.infer<typeof SitePolicy>;

export function policyWithDefaults(raw: unknown): SitePolicy {
  return SitePolicy.parse(raw ?? {});
}

// ------------------------------------------------------------------ change lifecycle
export const ChangeStatus = z.enum([
  "proposed", "pending_approval", "approved", "rejected", "blocked", "expired",
  "applying", "applied", "verifying", "verified", "verify_failed", "failed",
  "rolling_back", "rolled_back",
]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

export interface PageMetrics {
  clicks28d?: number;
  impressions28d?: number;
  ctr28d?: number;
  position28d?: number;
  backlinks?: number;
}

export interface ChangeRecord {
  id: string;
  site_id: string;
  type: ChangeType;
  target: Target;
  before: unknown;
  after: unknown;
  tier: Tier;
  risk_reasons: string[];
  status: ChangeStatus;
  diff_hash: string;
  rollback_data?: unknown;
  page_metrics?: PageMetrics | null;
  rationale?: string | null;
  pr_url?: string | null;
}

// ------------------------------------------------------------------ page snapshot (verification)
export interface PageSnapshot {
  url: string;
  finalUrl: string;
  status: number;
  redirected: boolean;
  headers: Record<string, string>;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robots: string | null;             // meta robots content, lowercased
  xRobotsTag: string | null;
  h1: string[];
  og: Record<string, string>;        // og:title -> value
  jsonld: Array<{ type: string[]; raw: string; parsed: unknown; valid: boolean }>;
  images: Array<{ src: string; alt: string | null }>;
  hreflang: Array<{ lang: string; href: string }>;
  fetchedAt: string;
}

// ------------------------------------------------------------------ adapters
export interface ApplyResult {
  /** Whatever the adapter needs to undo this exact change later. Stored as changes.rollback_data. */
  rollback: unknown;
  /** Value actually written (may be normalized by the platform). */
  written?: unknown;
  note?: string;
}

export interface ConnectionResult {
  ok: boolean;
  details: Record<string, unknown>;
  warnings: string[];
}

export interface SiteAdapter {
  readonly platform: Platform;
  /** Types this adapter can apply on this site (may depend on detected plugins). */
  capabilities(): Promise<ChangeType[]>;
  testConnection(): Promise<ConnectionResult>;
  /** Map a public URL to the platform resource that controls it. */
  resolve(url: string, type: ChangeType): Promise<ResourceRef | null>;
  /** Current value on the platform for this change (shape mirrors the payload where possible). */
  read(change: Pick<ChangeRecord, "type" | "target" | "after">): Promise<unknown>;
  apply(change: ChangeRecord): Promise<ApplyResult>;
  rollback(change: ChangeRecord): Promise<void>;
  /** Purge caches for these URLs after a write, best effort. */
  purge?(urls: string[]): Promise<void>;
}

/** Site secrets, decrypted on the runner only. */
export const SiteSecrets = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("wordpress"),
    username: z.string().min(1),
    app_password: z.string().min(1),
    cloudflare: z.object({ zone_id: z.string(), api_token: z.string() }).optional(),
  }),
  z.object({
    platform: z.literal("shopify"),
    shop: z.string().min(1),                 // my-store.myshopify.com
    access_token: z.string().optional(),     // static Admin API token (custom app)
    client_id: z.string().optional(),        // or client-credentials (Dev Dashboard app in your own org)
    client_secret: z.string().optional(),
  }),
  z.object({
    platform: z.literal("repo"),
    github_token: z.string().min(1),         // fine-grained PAT: contents + pull requests (rw), deployments/statuses (r)
    vercel_bypass_secret: z.string().optional(),
  }),
  z.object({ platform: z.literal("other") }),
]);
export type SiteSecrets = z.infer<typeof SiteSecrets>;

/** Non-secret per-site config stored in sites.config. */
export const SiteConfig = z.object({
  gsc_property: z.string().optional(),       // e.g. sc-domain:example.com
  // repo
  repo: z.string().optional(),               // owner/name
  branch: z.string().optional(),             // base branch, default "main"
  build_command: z.string().optional(),      // e.g. "npm run build", run before opening the PR
  framework: z.string().optional(),          // nextjs-app | nextjs-pages | astro | static
  // wordpress
  wp_bridge: z.boolean().optional(),         // seo-agent-bridge mu-plugin detected
  // shopify
  shopify_api_version: z.string().optional(),
});
export type SiteConfig = z.infer<typeof SiteConfig>;

// ------------------------------------------------------------------ jobs
export const JobKind = z.enum(["test_connection", "audit", "propose", "apply", "verify", "rollback", "monitor", "custom"]);
export type JobKind = z.infer<typeof JobKind>;

export const JobParams = {
  test_connection: z.object({}),
  audit: z.object({
    depth: z.enum(["full", "page"]).default("full"),
    urls: z.array(z.string().url()).optional(),   // for depth=page
  }),
  propose: z.object({ audit_id: z.string().uuid().optional() }),
  apply: z.object({ change_ids: z.array(z.string().uuid()).optional() }), // default: all approved
  verify: z.object({ change_ids: z.array(z.string().uuid()).optional() }),
  rollback: z.object({ change_ids: z.array(z.string().uuid()).min(1), reason: z.string().optional() }),
  monitor: z.object({}),
  custom: z.object({ prompt: z.string().min(1) }),
} as const satisfies Record<JobKind, z.ZodTypeAny>;

// ------------------------------------------------------------------ claude-seo audit envelope (subset we rely on)
export const AuditFinding = z.object({
  title: z.string(),
  severity: z.string(),
  description: z.string().optional().default(""),
  recommendation: z.string().optional().default(""),
  url: z.string().optional(),
});
export const AuditData = z.object({
  summary: z.object({
    health_score: z.coerce.number().optional(),
    business_type: z.string().optional(),
    top_findings: z.array(z.unknown()).optional(),
    quick_wins: z.array(z.unknown()).optional(),
  }).passthrough(),
  categories: z.array(z.object({
    name: z.string(),
    score: z.coerce.number().optional(),
    what_works: z.array(z.unknown()).optional(),
    findings: z.array(AuditFinding).default([]),
  }).passthrough()).default([]),
  action_plan: z.unknown().optional(),
}).passthrough();
export type AuditData = z.infer<typeof AuditData>;
