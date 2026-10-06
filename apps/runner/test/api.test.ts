import { describe, expect, it, vi } from "vitest";
import { ApiError, RunnerApi } from "../src/api";
import { JobLogger } from "../src/logger";

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function api(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof RunnerApi>[0]> = {}) {
  return new RunnerApi({ server: "https://panel.example.com/", token: "secret-token", fetch: fetchImpl, sleep: async () => {}, ...extra });
}

describe("RunnerApi", () => {
  it("sends bearer auth and JSON to the right route", async () => {
    const f = vi.fn(async () => json(200, { job: null, site: null, secret: null }));
    const res = await api(f as unknown as typeof fetch).claim();
    expect(res.job).toBeNull();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://panel.example.com/api/runner/claim");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect(init.body).toBe("{}");
  });

  it("register does not send the bearer header", async () => {
    const f = vi.fn(async () => json(200, { runner_id: "r", token: "t", org_id: "o" }));
    await new RunnerApi({ server: "https://p.example.com", fetch: f as unknown as typeof fetch }).register({ code: "C", name: "n", public_key: "k", version: "1" });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("surfaces the server's { error } message on 4xx without retrying", async () => {
    const f = vi.fn(async () => json(409, { error: "transition applied -> approved not allowed" }));
    const err = await api(f as unknown as typeof fetch).updateChange("c1", { status: "approved" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("transition applied -> approved not allowed");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx and network errors with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return json(503, { error: "unavailable" });
      return json(200, { ok: true, server_time: "now" });
    });
    const res = await api(f as unknown as typeof fetch, { sleep: async (ms) => void sleeps.push(ms), backoffMs: 100 }).heartbeat({
      version: "0.1.0",
      status: { claude: { ok: true }, claude_seo: { ok: true }, python: { ok: true }, busy: false },
    });
    expect(res.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(200);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
  });

  it("gives up after the retry budget", async () => {
    const f = vi.fn(async () => json(500, "<html>boom</html>"));
    const err = await api(f as unknown as typeof fetch, { retries: 2 }).getSite("s1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("boom");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("rejects non-JSON success bodies and encodes path params", async () => {
    const f = vi.fn(async () => new Response("hello", { status: 200 }));
    const err = await api(f as unknown as typeof fetch).getAudit("a/b", "c d").catch((e) => e);
    expect(err.message).toMatch(/not JSON/);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://panel.example.com/api/runner/sites/a%2Fb/audits/c%20d");
  });

  it("builds the status filter for listChanges", async () => {
    const f = vi.fn(async () => json(200, { changes: [] }));
    await api(f as unknown as typeof fetch).listChanges("s1", ["approved", "applied"]);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://panel.example.com/api/runner/sites/s1/changes?status=approved,applied");
  });
});

describe("JobLogger", () => {
  it("batches lines and aborts when the server requests cancel", async () => {
    const calls: number[] = [];
    let cancel = false;
    const fake = {
      logs: vi.fn(async (_id: string, lines: unknown[]) => {
        calls.push(lines.length);
        return { ok: true as const, cancel_requested: cancel };
      }),
    };
    const l = new JobLogger(fake, "job-1", { echo: false, maxBuffer: 3, flushIntervalMs: 60_000 });
    l.info("a");
    l.info("b");
    expect(fake.logs).not.toHaveBeenCalled();
    l.info("c"); // hits maxBuffer → flush
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([3]);
    cancel = true;
    l.warn("d");
    await l.flush();
    expect(l.signal.aborted).toBe(true);
    await l.close();
  });

  it("keeps lines when an upload fails and sends them later", async () => {
    let fail = true;
    const sent: unknown[][] = [];
    const fake = {
      logs: vi.fn(async (_id: string, lines: unknown[]) => {
        if (fail) throw new Error("offline");
        sent.push(lines);
        return { ok: true as const, cancel_requested: false };
      }),
    };
    const l = new JobLogger(fake, "job-2", { echo: false, flushIntervalMs: 60_000 });
    l.info("one");
    await l.flush();
    fail = false;
    l.info("two");
    await l.close();
    expect(sent.flat().map((x) => (x as { message: string }).message)).toEqual(["one", "two"]);
  });
});
