import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PageSnapshot, Proposal } from "@seo-autopilot/core";
import { prepareProposals, proposalJsonSchema, readProposalFile, urlsFromFindings } from "../src/jobs/propose";
import { FakeAdapter } from "./helpers";

const snap = (url: string, over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url,
  finalUrl: url,
  status: 200,
  redirected: false,
  headers: {},
  title: "Home",
  metaDescription: null,
  canonical: null,
  robots: null,
  xRobotsTag: null,
  h1: ["Welcome"],
  og: {},
  jsonld: [],
  images: [{ src: "https://www.example.com/hero.jpg", alt: null }],
  hreflang: [],
  fetchedAt: new Date().toISOString(),
  ...over,
});

const P = (over: Partial<Proposal> & Pick<Proposal, "type" | "after">): Proposal => ({
  url: "https://www.example.com/about",
  rationale: "because",
  ...over,
});

const noop = () => {};

describe("prepareProposals", () => {
  it("drops invalid payloads, off-host URLs and duplicates; keeps valid ones with before from the platform", async () => {
    const ad = new FakeAdapter();
    ad.live.set("title@https://www.example.com/about", { value: "About" });
    const logs: string[] = [];
    const { proposals, dropped } = await prepareProposals(
      [
        P({ type: "title", after: { value: "About Example | Example" }, evidence: "Title too short", finding_title: "Short titles" }),
        P({ type: "title", after: { value: "About Example | Example" } }), // duplicate
        P({ type: "title", after: { text: "wrong shape" } }),
        P({ type: "canonical", after: { value: "not a url" } }),
        P({ type: "title", url: "https://evil.example.org/x", after: { value: "Hi" } }),
      ],
      { siteUrl: "https://www.example.com", platform: "wordpress", adapter: ad, capabilities: ["title"], snapshots: new Map(), log: (_l, m) => logs.push(m) },
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "title",
      before: { value: "About" },
      after: { value: "About Example | Example" },
      capability: true,
      evidence: "Title too short",
      finding_title: "Short titles",
      target: { url: "https://www.example.com/about", resource: { kind: "page", id: "12" } },
    });
    expect(dropped.map((d) => d.reason)).toEqual([
      "duplicate",
      expect.stringContaining("invalid payload"),
      expect.stringContaining("invalid payload"),
      expect.stringContaining("not on the site host"),
    ]);
    expect(logs.filter((l) => l.startsWith("Dropped"))).toHaveLength(4);
  });

  it("skips no-ops where the value is already live", async () => {
    const ad = new FakeAdapter();
    ad.live.set("title@https://www.example.com/about", { value: "Same" });
    const { proposals, dropped } = await prepareProposals([P({ type: "title", after: { value: "Same" } })], {
      siteUrl: "https://www.example.com",
      platform: "wordpress",
      adapter: ad,
      capabilities: ["title"],
      snapshots: new Map(),
      log: noop,
    });
    expect(proposals).toEqual([]);
    expect(dropped[0].reason).toMatch(/no-op/);
  });

  it("sends capability=false (advice) when the type is not applicable, reading before from the snapshot", async () => {
    const ad = new FakeAdapter();
    let platformReads = 0;
    ad.read = async () => {
      platformReads++;
      return null;
    };
    const url = "https://www.example.com/";
    const { proposals } = await prepareProposals(
      [
        P({ type: "h1", url, after: { value: "Example: plumbing in Leeds" } }),
        P({ type: "title", url: "https://www.example.com/unmapped", after: { value: "Unmapped page title" } }),
      ],
      {
        siteUrl: "https://www.example.com",
        platform: "wordpress",
        adapter: ad,
        capabilities: ["title"],
        snapshots: new Map([[url, snap(url)]]),
        log: noop,
        snapshot: async (u) => snap(u, { title: "Old unmapped" }),
      },
    );
    expect(proposals[0]).toMatchObject({ type: "h1", capability: false, before: { value: "Welcome" } });
    // resolve() returned null → advice, before from the live page
    expect(proposals[1]).toMatchObject({ type: "title", capability: false, before: { value: "Old unmapped" } });
    expect(proposals[1].target.resource).toBeUndefined();
    expect(platformReads).toBe(0);
  });

  it("repo sites read before from the live page, not the adapter", async () => {
    const ad = new FakeAdapter();
    ad.read = async () => {
      throw new Error("should not be called");
    };
    const url = "https://www.example.com/";
    const { proposals } = await prepareProposals([P({ type: "meta_description", url, after: { value: "d".repeat(130) } })], {
      siteUrl: "https://www.example.com",
      platform: "repo",
      adapter: ad,
      capabilities: ["meta_description"],
      snapshots: new Map([[url, snap(url, { metaDescription: "old" })]]),
      log: noop,
    });
    expect(proposals[0]).toMatchObject({ capability: true, before: { value: "old" } });
  });

  it("reads robots.txt / llms.txt from the site for before", async () => {
    const ad = new FakeAdapter();
    ad.caps = [];
    const { proposals } = await prepareProposals(
      [P({ type: "llms_txt", url: "https://www.example.com/llms.txt", after: { content: "# Example\n" } })],
      { siteUrl: "https://www.example.com", platform: "wordpress", adapter: ad, capabilities: [], snapshots: new Map(), log: noop, siteFile: async () => null },
    );
    expect(proposals[0]).toMatchObject({ type: "llms_txt", before: null, capability: false });
  });
});

describe("readProposalFile", () => {
  it("prefers structured output, falls back to proposals.json and salvages partial files", () => {
    const dir = mkdtempSync(join(tmpdir(), "prop-"));
    const good = { site_url: "https://www.example.com", proposals: [{ type: "title", url: "https://www.example.com/", after: { value: "x" }, rationale: "r" }] };
    expect(readProposalFile(good, dir, noop).proposals).toHaveLength(1);
    writeFileSync(
      join(dir, "proposals.json"),
      JSON.stringify({
        site_url: "https://www.example.com",
        proposals: [good.proposals[0], { type: "bogus", url: "x" }],
        manual_recommendations: [{ title: "t", detail: "d" }],
      }),
    );
    const f = readProposalFile(undefined, dir, noop);
    expect(f.proposals).toHaveLength(1);
    expect(f.manual_recommendations).toEqual([{ title: "t", detail: "d" }]);
  });

  it("throws when nothing usable came back", () => {
    expect(() => readProposalFile(undefined, mkdtempSync(join(tmpdir(), "prop-")), noop)).toThrow(/no usable proposals/);
  });
});

describe("helpers", () => {
  it("collects same-host URLs from findings, homepage first", () => {
    const urls = urlsFromFindings("https://www.example.com", [
      { url: "https://www.example.com/a", description: "see https://www.example.com/b. and https://other.com/c" },
      { url: "/a" },
      { recommendation: "compress https://www.example.com/img/hero.png" },
    ]);
    expect(urls).toEqual(["https://www.example.com/", "https://www.example.com/a", "https://www.example.com/b"]);
  });

  it("builds a JSON schema for --json-schema from ProposalFile", () => {
    const s = proposalJsonSchema() as { type: string; required: string[]; properties: Record<string, unknown> };
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["site_url", "proposals"]);
    expect(Object.keys(s.properties)).toContain("manual_recommendations");
  });
});
