import { describe, expect, it } from "vitest";
import { assertSameHost, checkRedirect, fetchSnapshot, fetchText, parseHtml } from "../src/page";

const HTML = `<!doctype html><html><head>
<title>  Hello &amp;   World </title>
<meta name="description" content="A  page about things">
<link rel="canonical" href="/blog/post/">
<meta name="robots" content="INDEX, Follow">
<meta name="googlebot" content="max-snippet:-1">
<meta property="og:title" content="OG Title">
<meta property="og:image" content="https://cdn.example.com/a.jpg">
<link rel="alternate" hreflang="de" href="/de/blog/post/">
<link rel="alternate" hreflang="x-default" href="https://example.com/blog/post/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},{"@type":["WebPage","FAQPage"],"name":"x"}]}</script>
<script type="application/ld+json">{"@type": "Article", "headline": "broken",}</script>
<script type="application/ld+json">[{"@type":"BreadcrumbList"}]</script>
</head><body>
<h1>
  Main   heading </h1>
<h1></h1>
<img src="/wp-content/uploads/a-300x200.jpg" alt="Alt A">
<img src="b.png">
<img src="c.png" alt="">
<img src="data:image/gif;base64,R0lGOD" data-src="/lazy.jpg" alt="lazy">
</body></html>`;

describe("parseHtml", () => {
  const p = parseHtml(HTML, "https://example.com/blog/post/");
  it("extracts head fields", () => {
    expect(p.title).toBe("Hello & World");
    expect(p.metaDescription).toBe("A page about things");
    expect(p.canonical).toBe("https://example.com/blog/post/");
    expect(p.robots).toBe("index, follow, max-snippet:-1");
    expect(p.og["og:title"]).toBe("OG Title");
    expect(p.og["og:image"]).toBe("https://cdn.example.com/a.jpg");
  });
  it("h1 texts trimmed, empty dropped", () => {
    expect(p.h1).toEqual(["Main heading"]);
  });
  it("JSON-LD incl. @graph and broken blocks", () => {
    expect(p.jsonld).toHaveLength(3);
    expect(p.jsonld[0].valid).toBe(true);
    expect(p.jsonld[0].type).toEqual(["Organization", "WebPage", "FAQPage"]);
    expect(p.jsonld[1].valid).toBe(false);
    expect(p.jsonld[1].type).toEqual([]);
    expect(p.jsonld[1].raw).toContain("broken");
    expect(p.jsonld[2].type).toEqual(["BreadcrumbList"]);
  });
  it("images: absolute src, alt missing vs empty, data-src fallback", () => {
    expect(p.images).toEqual([
      { src: "https://example.com/wp-content/uploads/a-300x200.jpg", alt: "Alt A" },
      { src: "https://example.com/blog/post/b.png", alt: null },
      { src: "https://example.com/blog/post/c.png", alt: "" },
      { src: "https://example.com/lazy.jpg", alt: "lazy" },
    ]);
  });
  it("hreflang absolute", () => {
    expect(p.hreflang).toEqual([
      { lang: "de", href: "https://example.com/de/blog/post/" },
      { lang: "x-default", href: "https://example.com/blog/post/" },
    ]);
  });
  it("handles missing elements", () => {
    const q = parseHtml("<html><body><p>x</p></body></html>", "https://e.com/");
    expect(q.title).toBeNull();
    expect(q.metaDescription).toBeNull();
    expect(q.canonical).toBeNull();
    expect(q.robots).toBeNull();
    expect(q.h1).toEqual([]);
    expect(q.jsonld).toEqual([]);
  });
});

describe("fetch helpers", () => {
  it("fetchSnapshot cache-busts, lowercases headers and captures x-robots-tag", async () => {
    let seen = "";
    let ua = "";
    const f = (async (url: string, init: RequestInit) => {
      seen = url;
      ua = (init.headers as Record<string, string>)["User-Agent"];
      return new Response(HTML, { status: 200, headers: { "Content-Type": "text/html", "X-Robots-Tag": "noindex" } });
    }) as unknown as typeof fetch;
    const s = await fetchSnapshot("https://example.com/blog/post/", { fetch: f });
    expect(seen).toMatch(/_sa=\d+/);
    expect(ua).toBe("SEOAutopilot/0.1 (+verification)");
    expect(s.status).toBe(200);
    expect(s.xRobotsTag).toBe("noindex");
    expect(s.headers["content-type"]).toBe("text/html");
    expect(s.title).toBe("Hello & World");
    expect(s.finalUrl).toBe("https://example.com/blog/post/");
  });
  it("fetchSnapshot without cacheBust", async () => {
    let seen = "";
    const f = (async (url: string) => {
      seen = url;
      return new Response("<title>x</title>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    await fetchSnapshot("https://example.com/a", { fetch: f, cacheBust: false });
    expect(seen).toBe("https://example.com/a");
  });
  it("fetchText and checkRedirect", async () => {
    const f = (async (url: string, init: RequestInit) => {
      if (url.includes("robots")) return new Response("User-agent: *\nDisallow:", { status: 200 });
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 301, headers: { Location: "/new" } });
    }) as unknown as typeof fetch;
    expect(await fetchText("https://e.com/robots.txt", { fetch: f })).toEqual({ status: 200, text: "User-agent: *\nDisallow:" });
    expect(await checkRedirect("https://e.com/old", { fetch: f })).toEqual({ status: 301, location: "https://e.com/new" });
  });
  it("times out", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(fetchText("https://e.com/x", { fetch: f, timeoutMs: 20 })).rejects.toThrow(/Timed out/);
  });
});

describe("assertSameHost", () => {
  it("allows same host and www/apex", () => {
    expect(() => assertSameHost("https://example.com/a", "https://example.com")).not.toThrow();
    expect(() => assertSameHost("https://www.example.com/a", "https://example.com")).not.toThrow();
    expect(() => assertSameHost("http://example.com/a", "https://www.example.com/")).not.toThrow();
  });
  it("rejects others", () => {
    expect(() => assertSameHost("https://evil.com/", "https://example.com")).toThrow();
    expect(() => assertSameHost("https://example.com.evil.com/", "https://example.com")).toThrow();
    expect(() => assertSameHost("file:///etc/passwd", "https://example.com")).toThrow();
    expect(() => assertSameHost("https://example.com:8080/", "https://example.com")).toThrow();
    expect(() => assertSameHost("https://user:pw@example.com/", "https://example.com")).toThrow();
    expect(() => assertSameHost("not a url", "https://example.com")).toThrow();
  });
});
