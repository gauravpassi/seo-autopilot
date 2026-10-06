/** Static fixture data for the dev-only preview routes. Not used by real pages. */
import type { Change } from "@/lib/types";

const base = {
  org_id: "org",
  audit_id: null,
  finding_id: null,
  batch_id: "b1",
  status: "pending_approval" as const,
  diff_hash: "x",
  evidence: null as string | null,
  expected_impact: null as string | null,
  approved_by: null,
  approved_via: null,
  approver_label: null,
  decided_at: null,
  decision_note: null,
  applied_at: null,
  verified_at: null,
  verify_result: null,
  rollback_data: null,
  pr_url: null,
  error: null,
  created_at: "2026-10-06T06:00:00.000Z",
  updated_at: "2026-10-06T06:00:00.000Z",
};

export const PREVIEW_NOW = Date.parse("2026-10-06T09:00:00.000Z");
const inHours = (h: number) => new Date(PREVIEW_NOW + h * 3600_000).toISOString();

export const previewSites = [
  { id: "s1", name: "Kiran Ceramics" },
  { id: "s2", name: "Northwind Clinics" },
  { id: "s3", name: "Upcore.ai" },
];

export const previewChanges: Change[] = [
  {
    ...base,
    id: "c1",
    site_id: "s1",
    type: "title",
    target: { url: "https://www.kiranceramics.in/collections/stoneware-dinner-sets" },
    before: { value: "Stoneware Dinner Sets – Kiran Ceramics – Buy Online – Best Price in India" },
    after: { value: "Handmade Stoneware Dinner Sets | Kiran Ceramics" },
    rationale:
      "The current title is 72 characters, so Google truncates it after “Buy Online”. The new one leads with the term the page ranks for and fits in 49.",
    evidence: "Search Console: position 8.4 for “stoneware dinner set”, CTR 1.1% vs 3.2% site average.",
    expected_impact: "CTR on this collection rises toward the site average within 3–4 weeks.",
    tier: "approve",
    risk_reasons: [
      "Rewrites a title link Google shows in results",
      "Page has traffic (184 clicks / 16,920 impressions in 28 days)",
    ],
    page_metrics: { clicks28d: 184, impressions28d: 16920 },
    expires_at: inHours(4.2),
  },
  {
    ...base,
    id: "c2",
    site_id: "s2",
    type: "meta_description",
    target: { url: "https://northwindclinics.com/services/physiotherapy" },
    before: { value: "Physiotherapy services." },
    after: {
      value:
        "Book physiotherapy in Pune with licensed therapists. Same-week appointments for back, neck and sports injuries, with home visits across the city.",
    },
    rationale: "The existing description is 23 characters and says nothing a searcher can act on.",
    expected_impact: "Better snippet; watch CTR for “physiotherapy pune”.",
    tier: "approve",
    risk_reasons: ["Rewrites an existing meta description"],
    page_metrics: { clicks28d: 41, impressions28d: 2310 },
    expires_at: inHours(52),
  },
  {
    ...base,
    id: "c3",
    site_id: "s3",
    type: "jsonld_add",
    target: { url: "https://upcore.ai/" },
    before: null,
    after: {
      schema_type: "Organization",
      schema: {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Upcore Technologies",
        url: "https://upcore.ai",
        logo: "https://upcore.ai/logo.png",
        sameAs: ["https://www.linkedin.com/company/upcore-technologies"],
      },
    },
    rationale: "The homepage has no Organization markup, so Google can't connect the brand to its logo and profiles.",
    tier: "approve",
    risk_reasons: ["Adds Organization markup describing the site", "Homepage", "Site is in suggest mode: every change needs approval"],
    page_metrics: null,
    expires_at: inHours(70),
  },
  {
    ...base,
    id: "c4",
    site_id: "s1",
    type: "image_alt",
    target: { url: "https://www.kiranceramics.in/products/indigo-glaze-mug" },
    before: { src: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=400", alt: "IMG_2041" },
    after: {
      src: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=400",
      alt: "Indigo-glazed stoneware mug on a wooden table",
    },
    rationale: "The alt text is a camera filename, which tells screen readers and image search nothing.",
    tier: "approve",
    risk_reasons: ["Replaces existing alt text"],
    page_metrics: { clicks28d: 3, impressions28d: 220 },
    expires_at: inHours(30),
  },
  {
    ...base,
    id: "c5",
    site_id: "s2",
    type: "robots_txt",
    target: { url: "https://northwindclinics.com/robots.txt" },
    before: {
      content: "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /?s=\n\nSitemap: https://northwindclinics.com/sitemap.xml",
    },
    after: {
      content:
        "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /?s=\nDisallow: /*?replytocom=\n\nSitemap: https://northwindclinics.com/sitemap_index.xml",
    },
    rationale:
      "Comment-reply URLs are crawled as thousands of duplicates, and the sitemap line points to an old file that returns 404.",
    evidence: "Crawl found 2,140 URLs with ?replytocom=; /sitemap.xml returns 404.",
    tier: "approve",
    risk_reasons: ["robots.txt controls crawling for the whole site"],
    page_metrics: null,
    expires_at: inHours(60),
  },
  {
    ...base,
    id: "c6",
    site_id: "s3",
    type: "redirect",
    target: { url: "https://upcore.ai/ai-agents-old" },
    before: null,
    after: { from_path: "/ai-agents-old", to_url: "https://upcore.ai/ai-agents", code: 301 },
    rationale: "The old URL still has 6 backlinks and returns 404.",
    tier: "approve",
    risk_reasons: ["Redirects move ranking signals and should stay at least a year", "Page has backlinks"],
    page_metrics: { backlinks: 6 },
    expires_at: inHours(1.4),
  },
];
