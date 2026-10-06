import { describe, expect, it } from "vitest";
import { approvalEmail, slackBatchMessage, SLACK_MAX_BLOCKS, valueText, whatsappChangeBody, waTemplateParam, WA_BODY_MAX, type MiniChange } from "../lib/notify/format";

const mk = (i: number, status: MiniChange["status"] = "pending_approval"): MiniChange => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  site_id: "s1",
  type: "meta_description",
  target: { url: `https://www.example.com/p/${i}` },
  before: { value: "" },
  after: { value: "x".repeat(2000) },
  risk_reasons: ["Rewrites an existing meta description", "Site is in suggest mode: every change needs approval"],
  status,
  approver_label: status === "pending_approval" ? null : "alice@example.com",
  rationale: "r",
});

describe("Slack batch message", () => {
  it("stays within 45 blocks and summarizes overflow", () => {
    const m = slackBatchMessage(Array.from({ length: 60 }, (_, i) => mk(i)), { appUrl: "https://app.test" });
    expect(m.blocks.length).toBeLessThanOrEqual(SLACK_MAX_BLOCKS);
    expect(JSON.stringify(m.blocks.at(-1))).toContain("more");
    const allBtn = m.blocks.find((b) => b.block_id === "batch") as { elements: Array<{ value: string }> };
    expect(allBtn.elements[0].value.split(",").length).toBeGreaterThan(1);
    expect(allBtn.elements[0].value.length).toBeLessThanOrEqual(2000);
  });
  it("shows decisions instead of buttons for decided changes", () => {
    const m = slackBatchMessage([mk(1, "approved"), mk(2)], { appUrl: "https://app.test" });
    const s = JSON.stringify(m.blocks);
    expect(s).toContain("✅ Approved by alice@example.com");
    expect(m.blocks.filter((b) => b.type === "actions")).toHaveLength(1);
  });
});

describe("WhatsApp formatting", () => {
  it("keeps the body ≤ 1024 chars and template params single-line", () => {
    expect(whatsappChangeBody(mk(1)).length).toBeLessThanOrEqual(WA_BODY_MAX);
    expect(waTemplateParam("a\nb\tc     d")).toBe("a b c   d");
  });
});

describe("email + value text", () => {
  it("renders per-change links and escapes HTML", () => {
    const c = { ...mk(1), after: { value: "<script>alert(1)</script>" } };
    const e = approvalEmail([{ change: c, approveUrl: "https://app.test/approve?t=a", rejectUrl: "https://app.test/approve?t=r" }], { appUrl: "https://app.test" });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("https://app.test/approve?t=a");
    expect(e.text).toContain("Reject:  https://app.test/approve?t=r");
  });
  it("describes typed values", () => {
    expect(valueText("robots_meta", { index: false, follow: true })).toBe("noindex, follow");
    expect(valueText("redirect", { from_path: "/a", to_url: "https://x.com/b", code: 301 })).toBe("/a → https://x.com/b (301)");
    expect(valueText("title", null)).toBe("(none)");
  });
});
