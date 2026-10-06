import { describe, expect, it } from "vitest";
import { classify, initialStatus, type RiskContext } from "../src/risk";
import { policyWithDefaults } from "../src/schema";

const SITE = "https://example.com";
const ctx = (o: Partial<RiskContext>): RiskContext => ({
  type: "meta_description",
  url: `${SITE}/blog/post`,
  siteUrl: SITE,
  before: null,
  after: { value: "New description" },
  metrics: null,
  batchSize: 1,
  autoAppliedToday: 0,
  ...o,
});
const auto = policyWithDefaults({ mode: "auto" });

describe("classify", () => {
  it("missing meta description in auto mode -> auto", () => {
    const d = classify(ctx({}), auto);
    expect(d.tier).toBe("auto");
    expect(initialStatus(d.tier, "auto")).toBe("approved");
  });
  it("suggest mode -> approve", () => {
    const d = classify(ctx({}), policyWithDefaults({}));
    expect(d.tier).toBe("approve");
    expect(d.reasons.join(" ")).toMatch(/suggest mode/);
  });
  it("existing meta description -> approve", () => {
    expect(classify(ctx({ before: { value: "old" } }), auto).tier).toBe("approve");
  });
  it("traffic escalates auto -> approve", () => {
    const d = classify(ctx({ metrics: { clicks28d: 50 } }), auto);
    expect(d.tier).toBe("approve");
    expect(d.reasons.join(" ")).toMatch(/traffic/);
    expect(classify(ctx({ metrics: { impressions28d: 600 } }), auto).tier).toBe("approve");
  });
  it("noindex on a traffic page -> never", () => {
    const d = classify(ctx({ type: "robots_meta", after: { index: false, follow: true }, metrics: { clicks28d: 100 } }), auto);
    expect(d.tier).toBe("never");
    expect(initialStatus(d.tier, "auto")).toBe("blocked");
  });
  it("robots.txt Disallow: / -> never", () => {
    expect(classify(ctx({ type: "robots_txt", after: { content: "User-agent: *\nDisallow: /\n" } }), auto).tier).toBe("never");
    expect(classify(ctx({ type: "robots_txt", after: { content: "User-agent: *\nDisallow: /wp-admin/\n" } }), auto).tier).toBe("approve");
  });
  it("slug -> never", () => {
    expect(classify(ctx({ type: "slug", after: { value: "x" } }), auto).tier).toBe("never");
  });
  it("override approve -> auto", () => {
    const p = policyWithDefaults({ mode: "auto", overrides: { title: "auto" } });
    const d = classify(ctx({ type: "title", before: { value: "Old" }, after: { value: "New" } }), p);
    expect(d.tier).toBe("auto");
  });
  it("override cannot make never -> auto", () => {
    const p = policyWithDefaults({ mode: "auto", overrides: { slug: "auto" } });
    expect(classify(ctx({ type: "slug", after: { value: "x" } }), p).tier).toBe("approve");
  });
  it("override cannot make a traffic page auto", () => {
    const p = policyWithDefaults({ mode: "auto", overrides: { title: "auto" } });
    const d = classify(ctx({ type: "title", before: { value: "Old" }, after: { value: "New" }, metrics: { clicks28d: 99 } }), p);
    expect(d.tier).toBe("approve");
  });
  it("protected path -> never", () => {
    const p = policyWithDefaults({ mode: "auto", protected_paths: ["/blog/"] });
    expect(classify(ctx({}), p).tier).toBe("never");
  });
  it("homepage escalation", () => {
    const d = classify(ctx({ url: `${SITE}/` }), auto);
    expect(d.tier).toBe("approve");
    expect(d.reasons).toContain("Homepage");
  });
  it("daily cap", () => {
    const d = classify(ctx({ autoAppliedToday: 25 }), auto);
    expect(d.tier).toBe("approve");
    expect(d.reasons.join(" ")).toMatch(/Daily auto limit/);
    expect(classify(ctx({ autoAppliedToday: 24 }), auto).tier).toBe("auto");
  });
  it("batch size cap", () => {
    expect(classify(ctx({ batchSize: 51 }), auto).tier).toBe("approve");
  });
  it("sensitive JSON-LD needs approval, safe types are auto", () => {
    expect(classify(ctx({ type: "jsonld_add", after: { schema_type: "Product", schema: {} } }), auto).tier).toBe("approve");
    expect(classify(ctx({ type: "jsonld_add", after: { schema_type: "Organization", schema: {} } }), auto).tier).toBe("auto");
  });
});
