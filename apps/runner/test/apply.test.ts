import { describe, expect, it } from "vitest";
import { MSG_BEFORE_CHANGED, MSG_HASH_MISMATCH, applyJob, repoEditTools } from "../src/jobs/apply";
import { rollbackJob } from "../src/jobs/rollback";
import { verifyJob } from "../src/jobs/verify";
import { FakeAdapter, FakeApi, change, ctxFor, verifyDeps } from "./helpers";

describe("apply (non-repo)", () => {
  it("applies, records rollback data and verifies", async () => {
    const c = change();
    const api = new FakeApi([c]);
    const ad = new FakeAdapter();
    ad.live.set(ad.key(c), { value: "About" });
    const vd = verifyDeps(() => true);
    const res = await applyJob(ctxFor({ api, adapter: ad }), vd);
    expect(api.statusesFor(c.id)).toEqual(["applying", "applied", "verifying", "verified"]);
    expect(api.updates.find((u) => u.status === "applied")?.rollback_data).toEqual({ previous: { value: "About" } });
    expect(ad.applied).toEqual([c.id]);
    expect(res.counts).toEqual({ verified: 1 });
  });

  it("refuses a change whose diff hash no longer matches the approval", async () => {
    const c = change({ diff_hash: "deadbeef" });
    const api = new FakeApi([c]);
    const ad = new FakeAdapter();
    const res = await applyJob(ctxFor({ api, adapter: ad }), verifyDeps(() => true));
    expect(api.updates).toEqual([{ id: c.id, status: "failed", error: MSG_HASH_MISMATCH }]);
    expect(ad.applied).toEqual([]);
    expect(res.counts).toEqual({ failed: 1 });
  });

  it("also refuses when `after` was edited after approval (hash computed from after)", async () => {
    const c = change();
    c.after = { value: "Something else" };
    const api = new FakeApi([c]);
    await applyJob(ctxFor({ api, adapter: new FakeAdapter() }), verifyDeps(() => true));
    expect(api.last(c.id)).toMatchObject({ status: "failed", error: MSG_HASH_MISMATCH });
  });

  it("aborts when the live value changed since the proposal", async () => {
    const c = change();
    const api = new FakeApi([c]);
    const ad = new FakeAdapter();
    ad.live.set(ad.key(c), { value: "Edited by a human" });
    await applyJob(ctxFor({ api, adapter: ad }), verifyDeps(() => true));
    expect(api.statusesFor(c.id)).toEqual(["applying", "failed"]);
    expect(api.last(c.id)).toMatchObject({ error: MSG_BEFORE_CHANGED, before: { value: "Edited by a human" } });
    expect(ad.applied).toEqual([]);
  });

  it("treats a missing value consistently (null before, nothing live)", async () => {
    const c = change({ type: "meta_description", before: null, after: { value: "x".repeat(130) } });
    const api = new FakeApi([c]);
    const ad = new FakeAdapter();
    await applyJob(ctxFor({ api, adapter: ad }), verifyDeps(() => true));
    expect(api.last(c.id)?.status).toBe("verified");
  });

  it("rolls back automatically when verification fails and auto_rollback is on", async () => {
    const c = change();
    const api = new FakeApi([c]);
    const ad = new FakeAdapter();
    ad.live.set(ad.key(c), { value: "About" });
    const vd = verifyDeps((_c, expect) => expect === "before"); // after-check fails, before-check passes
    const res = await applyJob(ctxFor({ api, adapter: ad }), vd);
    expect(api.statusesFor(c.id)).toEqual(["applying", "applied", "verifying", "verify_failed", "rolling_back", "rolled_back"]);
    expect(ad.rolledBack).toEqual([c.id]);
    expect(ad.live.get(ad.key(c))).toEqual({ value: "About" });
    expect(vd.calls.map((x) => x.expect)).toEqual([undefined, "before"]);
    expect(res.counts).toEqual({ rolled_back: 1 });
  });

  it("leaves verify_failed when auto_rollback is off", async () => {
    const c = change();
    const api = new FakeApi([c]);
    const ad = new FakeAdapter();
    ad.live.set(ad.key(c), { value: "About" });
    await applyJob(ctxFor({ api, adapter: ad, policy: { auto_rollback: false } }), verifyDeps(() => false));
    expect(api.last(c.id)?.status).toBe("verify_failed");
    expect(ad.rolledBack).toEqual([]);
  });

  it("marks a change failed when the platform write errors, and continues with the next", async () => {
    const a = change({ id: "a" });
    const b = change({ id: "b", target: { url: "https://www.example.com/b" } });
    const api = new FakeApi([a, b]);
    const ad = new FakeAdapter();
    ad.live.set(ad.key(a), { value: "About" });
    ad.live.set(ad.key(b), { value: "About" });
    const orig = ad.apply.bind(ad);
    ad.apply = async (c) => {
      if (c.id === "a") throw new Error("WordPress returned 500");
      return orig(c);
    };
    const res = await applyJob(ctxFor({ api, adapter: ad }), verifyDeps(() => true));
    expect(api.last("a")).toMatchObject({ status: "failed", error: "WordPress returned 500" });
    expect(api.last("b")?.status).toBe("verified");
    expect(res.counts).toEqual({ failed: 1, verified: 1 });
  });

  it("filters by params.change_ids", async () => {
    const a = change({ id: "11111111-1111-4111-8111-111111111111" });
    const b = change({ id: "22222222-2222-4222-8222-222222222222", target: { url: "https://www.example.com/b" } });
    const api = new FakeApi([a, b]);
    const ad = new FakeAdapter();
    ad.live.set(ad.key(a), { value: "About" });
    await applyJob(ctxFor({ api, adapter: ad, params: { change_ids: [a.id] } }), verifyDeps(() => true));
    expect(api.statusesFor(b.id)).toEqual([]);
    expect(api.last(a.id)?.status).toBe("verified");
  });
});

describe("verify / rollback jobs", () => {
  it("re-verifies applied changes", async () => {
    const c = change({ status: "applied" });
    const api = new FakeApi([c]);
    await verifyJob(ctxFor({ api, adapter: new FakeAdapter(), kind: "verify" }), verifyDeps(() => true));
    expect(api.last(c.id)?.status).toBe("verified");
  });

  it("rolls back on request and checks the old value", async () => {
    const c = change({ id: "33333333-3333-4333-8333-333333333333", status: "verified", rollback_data: { previous: { value: "About" } } });
    const api = new FakeApi([c]);
    const ad = new FakeAdapter();
    ad.live.set(ad.key(c), c.after);
    const vd = verifyDeps((_c, e) => e === "before");
    await rollbackJob(ctxFor({ api, adapter: ad, kind: "rollback", params: { change_ids: [c.id] } }), vd);
    expect(api.statusesFor(c.id)).toEqual(["rolling_back", "rolled_back"]);
    expect(ad.live.get(ad.key(c))).toEqual({ value: "About" });
  });
});

describe("repoEditTools", () => {
  it.skipIf(process.platform === "win32")("scopes Edit/Write to the checkout and the report file", () => {
    const tools = repoEditTools("/home/u/.seo-autopilot/work/s/j/repo", "/home/u/.seo-autopilot/work/s/j");
    expect(tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit(//home/u/.seo-autopilot/work/s/j/repo/**)",
      "Write(//home/u/.seo-autopilot/work/s/j/repo/**)",
      "Write(//home/u/.seo-autopilot/work/s/j/repo-fix-report.json)",
    ]);
    expect(tools.some((t) => t.startsWith("Bash"))).toBe(false);
  });
});
