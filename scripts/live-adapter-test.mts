/**
 * Live round-trip test of a platform adapter against a REAL site.
 *
 * For every change type the adapter supports on the given page it does:
 *   read before → apply → verify on the live page → rollback → verify the old value is back.
 * Everything it changes is rolled back. Use a staging site.
 *
 * Usage (WordPress):
 *   LIVE_TEST=1 npx tsx scripts/live-adapter-test.mts wordpress <site-url> <page-url> <user> <app-password>
 */
import { createAdapter, verifyChange, fetchSnapshot, liveValue, diffHash, type ChangeRecord, type ChangeType } from "@seo-autopilot/core";

if (process.env.LIVE_TEST !== "1") {
  console.error("Refusing to run: set LIVE_TEST=1 (this writes to the site, then rolls everything back).");
  process.exit(2);
}
const [platform, siteUrl, pageUrl, user, pass] = process.argv.slice(2);
if (platform !== "wordpress" || !siteUrl || !pageUrl || !user || !pass) {
  console.error("usage: wordpress <site-url> <page-url> <user> <app-password>");
  process.exit(2);
}

const adapter = createAdapter({
  site: { id: "live-test", url: siteUrl, platform: "wordpress", config: {} },
  secrets: { platform: "wordpress", username: user, app_password: pass },
  log: (lvl, msg) => { if (lvl !== "debug") console.log(`    [${lvl}] ${msg}`); },
})!;

const stamp = new Date().toISOString().slice(11, 19);
const snap0 = await fetchSnapshot(pageUrl);
const img = snap0.images[0]?.src;
const origin = new URL(siteUrl).origin;

const cases: Array<{ type: ChangeType; url: string; after: unknown }> = [
  { type: "title", url: pageUrl, after: { value: `Handmade Stoneware Dinner Sets ${stamp} | Kiran Ceramics` } },
  { type: "meta_description", url: pageUrl, after: { value: `Handmade stoneware dinner sets thrown in our Pune studio, oven and dishwasher safe, shipped across India. Test ${stamp}.` } },
  { type: "canonical", url: pageUrl, after: { value: pageUrl } },
  { type: "og_tags", url: pageUrl, after: { title: `OG title ${stamp}`, description: "OG description for the live adapter test" } },
  ...(img ? [{ type: "image_alt" as const, url: pageUrl, after: { src: img, alt: `Glazed stoneware mug ${stamp}` } }] : []),
  { type: "jsonld_add", url: pageUrl, after: { schema_type: "BreadcrumbList", schema: { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: origin + "/" }, { "@type": "ListItem", position: 2, name: `Dinner sets ${stamp}`, item: pageUrl }] } } },
  { type: "redirect", url: pageUrl, after: { from_path: `/old-dinner-sets-${stamp.replace(/:/g, "")}`, to_url: pageUrl, code: 301 } },
  { type: "llms_txt", url: origin + "/llms.txt", after: { content: `# Kiran Ceramics\n\n> Handmade stoneware from Pune. Test ${stamp}.\n\n## Pages\n- [Dinner sets](${pageUrl})\n` } },
  { type: "robots_txt", url: origin + "/robots.txt", after: { content: `User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n# test ${stamp}\n` } },
];

const conn = await adapter.testConnection();
console.log(`connection ok=${conn.ok}`, JSON.stringify(conn.details).slice(0, 300));
for (const w of conn.warnings) console.log(`  warning: ${w}`);
const caps = await adapter.capabilities();
console.log(`capabilities: ${caps.join(", ")}\n`);

let pass_ = 0, fail = 0, skipped = 0;
for (const tc of cases) {
  const label = tc.type.padEnd(17);
  if (!caps.includes(tc.type)) { console.log(`- ${label} skipped (not supported on this site)`); skipped++; continue; }
  try {
    const resource = await adapter.resolve(tc.url, tc.type);
    if (!resource) { console.log(`- ${label} skipped (resolve returned null → manual)`); skipped++; continue; }
    const before = await adapter.read({ type: tc.type, target: { url: tc.url, resource }, after: tc.after });
    const snapBefore = await fetchSnapshot(tc.url.endsWith(".txt") ? pageUrl : tc.url);
    const change: ChangeRecord = {
      id: crypto.randomUUID(), site_id: "live-test", type: tc.type, target: { url: tc.url, resource },
      before: before ?? liveValue(tc.type, snapBefore, tc.after), after: tc.after,
      tier: "approve", risk_reasons: [], status: "approved", diff_hash: diffHash(tc.type, tc.url, tc.after),
    };
    const res = await adapter.apply(change);
    change.rollback_data = res.rollback;
    await adapter.purge?.([tc.url]);
    const v1 = await verifyChange(change, { siteUrl });
    await adapter.rollback(change);
    await adapter.purge?.([tc.url]);
    const v2 = await verifyChange(change, { siteUrl, expect: "before" } as never);
    const ok = v1.ok && v2.ok;
    ok ? pass_++ : fail++;
    console.log(`${ok ? "✔" : "✘"} ${label} apply+verify=${v1.ok} rollback+verify=${v2.ok}`);
    if (!ok) for (const c of [...v1.checks, ...v2.checks].filter((c) => !c.ok)) console.log(`    failed check ${c.name}: expected ${JSON.stringify(c.expected)?.slice(0, 120)} got ${JSON.stringify(c.actual)?.slice(0, 120)}`);
  } catch (e) {
    fail++;
    console.log(`✘ ${label} error: ${(e as Error).message}`);
  }
}
console.log(`\n${pass_} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
