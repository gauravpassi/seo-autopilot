import { describe, expect, it } from "vitest";
import type { AuditData } from "@seo-autopilot/core";
import { assertAuditRan } from "../src/jobs/audit";
import { localTargetFor } from "../src/local-targets";

const env = (over: Partial<AuditData> = {}): AuditData =>
  ({ summary: { health_score: 72 }, categories: [{ name: "Technical SEO", score: 70, findings: [] }], ...over }) as AuditData;

const denial = { tool_name: "Bash", tool_input: { command: "curl -sS http://127.0.0.1:8088/" } };

describe("assertAuditRan", () => {
  it("accepts a scored audit with no denials", () => {
    expect(() => assertAuditRan(env(), [], false)).not.toThrow();
  });
  it("accepts a scored audit even if an incidental call was denied", () => {
    expect(() => assertAuditRan(env(), [denial], false)).not.toThrow();
  });
  it("rejects the empty envelope written after tools were blocked (the e2e failure)", () => {
    const empty = env({ summary: { health_score: 0 }, categories: [{ name: "Audit status", findings: [{ title: "Audit could not run", severity: "Info", description: "", recommendation: "" }] }] as AuditData["categories"] });
    expect(() => assertAuditRan(empty, [denial], true)).toThrow(/blocked by the runner's permissions.*curl/);
  });
  it("rejects an envelope that was only written by the follow-up after denials", () => {
    expect(() => assertAuditRan(env(), [denial], true)).toThrow(/couldn't run/);
  });
  it("rejects an unscored audit with no denials", () => {
    expect(() => assertAuditRan(env({ summary: {}, categories: [] }), [], false)).toThrow(/no scores/);
  });
});

describe("localTargetFor", () => {
  it.each([
    ["http://127.0.0.1:8088", "127.0.0.1:8088"],
    ["http://localhost:3000/", "localhost:3000"],
    ["https://staging.local", "staging.local"],
    ["http://192.168.1.20", "192.168.1.20"],
    ["http://10.0.0.5:8080", "10.0.0.5:8080"],
    ["http://172.20.1.1", "172.20.1.1"],
    ["http://100.101.102.103", "100.101.102.103"],
    ["http://[::1]:8080", "[::1]:8080"],
  ])("allows local site %s", (url, want) => {
    expect(localTargetFor(url)).toBe(want);
  });
  it.each(["https://www.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://169.254.169.254", "not a url"])(
    "never allows %s",
    (url) => expect(localTargetFor(url)).toBeNull(),
  );
});
