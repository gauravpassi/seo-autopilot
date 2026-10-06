/**
 * Human-friendly labels for every enum the panel shows. Keep wording plain: the people
 * approving changes are not all SEO specialists.
 */
import type { ChangeStatus, ChangeType, JobKind, Platform, Tier, AutopilotMode } from "@seo-autopilot/core/schema";

export type Tone = "auto" | "approve" | "never" | "ok" | "bad" | "neutral" | "info";

export const CHANGE_TYPE: Record<ChangeType, { label: string; short: string; help: string }> = {
  title: { label: "Page title", short: "Title", help: "The blue link text Google shows in results." },
  meta_description: { label: "Meta description", short: "Description", help: "The snippet under the link in search results." },
  h1: { label: "Main heading (H1)", short: "H1", help: "The visible headline at the top of the page." },
  canonical: { label: "Canonical URL", short: "Canonical", help: "Tells Google which URL is the main version of this page." },
  robots_meta: { label: "Indexing rule", short: "Robots meta", help: "Whether Google may index this page and follow its links." },
  og_tags: { label: "Social preview", short: "Open Graph", help: "Title, description and image used when the page is shared." },
  image_alt: { label: "Image alt text", short: "Alt text", help: "Describes an image for screen readers and image search." },
  jsonld_add: { label: "Add structured data", short: "Schema add", help: "Machine-readable facts about the page (JSON-LD)." },
  jsonld_fix: { label: "Fix structured data", short: "Schema fix", help: "Replaces invalid JSON-LD with a corrected block." },
  redirect: { label: "Redirect", short: "Redirect", help: "Sends visitors and Google from an old path to a new URL." },
  robots_txt: { label: "robots.txt", short: "robots.txt", help: "Controls what crawlers may fetch across the whole site." },
  llms_txt: { label: "llms.txt", short: "llms.txt", help: "A guide for AI assistants describing the site." },
  slug: { label: "URL change", short: "Slug", help: "Changes the address of a page. Always done by hand." },
  content_edit: { label: "Content edit", short: "Content", help: "Edits the body text of a page." },
  internal_link: { label: "Internal link", short: "Link", help: "Adds a link from this page to another page on the site." },
  hreflang: { label: "Language versions", short: "hreflang", help: "Tells Google which page to show per language or country." },
  code_change: { label: "Code change", short: "Code", help: "A change made in the site's repository, reviewed as a pull request." },
};

export function changeTypeLabel(t: string): string {
  return CHANGE_TYPE[t as ChangeType]?.label ?? t.replace(/_/g, " ");
}

export const CHANGE_STATUS: Record<ChangeStatus, { label: string; tone: Tone; help: string }> = {
  proposed: { label: "Proposed", tone: "neutral", help: "Being classified." },
  pending_approval: { label: "Waiting for approval", tone: "approve", help: "A person needs to approve or reject it." },
  approved: { label: "Approved", tone: "info", help: "Queued to be applied by the runner." },
  rejected: { label: "Rejected", tone: "never", help: "Someone rejected it. Nothing was changed." },
  blocked: { label: "Blocked", tone: "never", help: "Too risky to automate or not supported. Do it by hand if you agree." },
  expired: { label: "Expired", tone: "never", help: "No one decided in time. Nothing was changed." },
  applying: { label: "Applying", tone: "info", help: "The runner is writing it to the site." },
  applied: { label: "Applied", tone: "info", help: "Written to the site; waiting for the live check." },
  verifying: { label: "Checking live", tone: "info", help: "Fetching the live page to confirm the change." },
  verified: { label: "Live and verified", tone: "ok", help: "Confirmed on the live page." },
  verify_failed: { label: "Check failed", tone: "bad", help: "The live page does not show the change." },
  failed: { label: "Failed", tone: "bad", help: "The runner could not apply it." },
  rolling_back: { label: "Rolling back", tone: "info", help: "Restoring the previous value." },
  rolled_back: { label: "Rolled back", tone: "never", help: "The previous value was restored." },
};

export function changeStatus(s: string) {
  return CHANGE_STATUS[s as ChangeStatus] ?? { label: s, tone: "neutral" as Tone, help: "" };
}

export const TIER: Record<Tier, { label: string; tone: Tone; help: string }> = {
  auto: { label: "Safe to automate", tone: "auto", help: "Low risk. Applies on its own when the site is in Auto mode." },
  approve: { label: "Needs approval", tone: "approve", help: "A person must approve before it is applied." },
  never: { label: "Never automated", tone: "never", help: "Too risky for the agent. Shown as advice only." },
};

export const MODE: Record<AutopilotMode, { label: string; summary: string; detail: string }> = {
  off: {
    label: "Off",
    summary: "Audits only",
    detail: "The agent audits the site and writes reports. It proposes nothing and changes nothing.",
  },
  suggest: {
    label: "Suggest",
    summary: "Every change asks first",
    detail:
      "The agent proposes fixes, but nothing is applied until someone approves it. Recommended for new sites.",
  },
  auto: {
    label: "Auto",
    summary: "Safe fixes apply on their own",
    detail:
      "Low-risk fixes (like adding a missing description or alt text) apply automatically and are checked on the live site. Anything riskier still waits for approval.",
  },
};

export const JOB_KIND: Record<JobKind, { label: string; verb: string }> = {
  test_connection: { label: "Connection test", verb: "Test connection" },
  audit: { label: "Audit", verb: "Run audit" },
  propose: { label: "Propose fixes", verb: "Propose fixes" },
  apply: { label: "Apply approved", verb: "Apply approved" },
  verify: { label: "Verify live", verb: "Verify" },
  rollback: { label: "Roll back", verb: "Roll back" },
  monitor: { label: "Traffic monitor", verb: "Check traffic" },
  custom: { label: "Custom prompt", verb: "Run prompt" },
};

export function jobKindLabel(k: string) {
  return JOB_KIND[k as JobKind]?.label ?? k;
}

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "never" },
};

export const PLATFORM: Record<Platform, { label: string; help: string }> = {
  wordpress: { label: "WordPress", help: "Self-hosted or managed WordPress with REST API access." },
  shopify: { label: "Shopify", help: "A Shopify store, through a custom app's Admin API." },
  repo: { label: "Code repository", help: "A site built from a GitHub repo (Next.js, Astro, static). Changes arrive as pull requests." },
  other: { label: "Other", help: "Audits and advice only. Nothing can be applied automatically." },
};

export const SEVERITY: Record<string, { tone: Tone; rank: number }> = {
  Critical: { tone: "bad", rank: 0 },
  High: { tone: "approve", rank: 1 },
  Medium: { tone: "info", rank: 2 },
  Low: { tone: "neutral", rank: 3 },
  Info: { tone: "neutral", rank: 4 },
};

export const NOTIFY_EVENTS: Array<{ id: string; label: string; help: string }> = [
  { id: "pending_approval", label: "Changes waiting for approval", help: "One message per batch with approve and reject buttons." },
  { id: "verify_failed", label: "Live check failed", help: "A change did not show up on the live page." },
  { id: "rolled_back", label: "Change rolled back", help: "A change was undone automatically or by someone." },
  { id: "job_failed", label: "Job failed", help: "An audit, apply or other job ended with an error." },
  { id: "traffic_alert", label: "Traffic drop after a change", help: "Clicks fell after a change went live (needs Search Console)." },
];

export const ROLE: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer (read-only)",
};

export const LOG_LEVEL: Record<string, { label: string; tone: Tone }> = {
  agent: { label: "Agent", tone: "auto" },
  tool: { label: "Tool", tone: "neutral" },
  info: { label: "Info", tone: "neutral" },
  debug: { label: "Debug", tone: "neutral" },
  warn: { label: "Warning", tone: "approve" },
  error: { label: "Error", tone: "bad" },
};
