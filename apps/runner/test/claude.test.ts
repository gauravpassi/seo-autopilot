import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeError, StreamParser, buildClaudeArgs, runClaude, summarizeToolUse } from "../src/claude";

type Line = { level: string; message: string };
const collect = () => {
  const lines: Line[] = [];
  return { lines, log: (level: string, message: string) => lines.push({ level, message }) };
};

const fixture = readFileSync(join(__dirname, "fixtures", "stream-ok.jsonl"), "utf8");

describe("StreamParser", () => {
  it("parses a real stream-json transcript", () => {
    const { lines, log } = collect();
    const p = new StreamParser(log, ["claude-seo", "seo-autopilot"]);
    // feed in odd-sized chunks to exercise line buffering
    for (let i = 0; i < fixture.length; i += 37) p.push(fixture.slice(i, i + 37));
    p.end();
    expect(p.fatal).toBeNull();
    expect(p.init?.plugins).toEqual(["claude-seo", "seo-autopilot"]);
    expect(p.result).toMatchObject({ is_error: false, subtype: "success", structured_output: { answer: "done" } });
    expect(p.result!.total_cost_usd).toBeGreaterThan(0);
    expect(p.result!.session_id).toBeTruthy();
    expect(lines.filter((l) => l.level === "tool").map((l) => l.message)).toEqual([
      "Glob: *.txt",
      "StructuredOutput: returning structured result",
    ]);
    expect(lines.some((l) => l.level === "agent" && l.message === "done")).toBe(true);
  });

  it("fails fast when a required plugin did not load", () => {
    const { lines, log } = collect();
    let fatal = "";
    const p = new StreamParser(log, ["claude-seo", "seo-autopilot"], (r) => (fatal = r));
    p.line(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        plugins: [{ name: "seo-autopilot" }],
        plugin_errors: [{ plugin: "inline[0]", type: "path-not-found", message: "Path not found: /nope" }],
      }),
    );
    expect(fatal).toMatch(/claude-seo/);
    expect(fatal).toMatch(/Path not found/);
    expect(lines.some((l) => l.level === "warn" && l.message.includes("Path not found"))).toBe(true);
  });

  it("truncates long assistant text to 2000 chars and summarises tools", () => {
    const { lines, log } = collect();
    const p = new StreamParser(log);
    p.line(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "x".repeat(5000) },
            { type: "tool_use", name: "Bash", input: { command: "  ls   -la\n /tmp " } },
            { type: "tool_use", name: "WebFetch", input: { url: "https://example.com/a" } },
          ],
        },
      }),
    );
    const agent = lines.find((l) => l.level === "agent")!;
    expect(agent.message.startsWith("x".repeat(2000))).toBe(true);
    expect(agent.message.length).toBeLessThan(2100);
    expect(lines.filter((l) => l.level === "tool").map((l) => l.message)).toEqual(["Bash: ls -la /tmp", "WebFetch: https://example.com/a"]);
  });

  it("marks error results and logs permission denials; ignores non-JSON lines", () => {
    const { lines, log } = collect();
    const p = new StreamParser(log);
    p.line("not json at all");
    p.line(
      JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: false,
        result: "",
        total_cost_usd: 1.5,
        session_id: "abc",
        permission_denials: [{ tool_name: "Write", tool_input: { file_path: "/etc/passwd" } }],
      }),
    );
    expect(p.result?.is_error).toBe(true);
    expect(p.result?.permission_denials).toHaveLength(1);
    expect(lines.some((l) => l.level === "warn" && l.message.includes("Write: /etc/passwd"))).toBe(true);
    expect(lines.some((l) => l.level === "debug" && l.message.includes("not json"))).toBe(true);
  });
});

describe("summarizeToolUse", () => {
  it("handles skills, agents and unknown tools", () => {
    expect(summarizeToolUse("Skill", { skill: "claude-seo:seo-audit", args: "https://x.com" })).toBe("Skill: claude-seo:seo-audit https://x.com");
    expect(summarizeToolUse("Agent", { subagent_type: "seo-technical", description: "Technical audit" })).toBe("Agent: seo-technical — Technical audit");
    expect(summarizeToolUse("Mystery", { a: 1 })).toBe('Mystery: {"a":1}');
  });
});

describe("buildClaudeArgs", () => {
  it("follows ARCHITECTURE section 8", () => {
    const { args, stdin } = buildClaudeArgs(
      {
        prompt: "/seo audit https://example.com",
        pluginDirs: ["/a/claude-seo", "/a/plugin"],
        allowedTools: ["Read", "Bash(/a/claude-seo/scripts/claude-seo *)"],
        maxBudgetUsd: 5,
        model: "sonnet",
        jsonSchema: { type: "object" },
        addDirs: ["/repo"],
        resume: "sess",
      },
      "/rules.md",
    );
    expect(stdin).toBeNull();
    expect(args.slice(0, 2)).toEqual(["-p", "/seo audit https://example.com"]);
    expect(args).toEqual(
      expect.arrayContaining(["--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--permission-prompts", "none"]),
    );
    const s = args.join(" ");
    expect(s).toContain("--plugin-dir /a/claude-seo --plugin-dir /a/plugin");
    expect(s).toContain("--allowedTools Read Bash(/a/claude-seo/scripts/claude-seo *)");
    expect(s).toContain("--max-budget-usd 5");
    expect(s).toContain("--append-system-prompt-file /rules.md");
    expect(s).toContain('--json-schema {"type":"object"}');
    expect(s).toContain("--add-dir /repo");
    expect(s).toContain("--resume sess");
    expect(args).not.toContain("--bare");
  });

  it("sends very long prompts via stdin", () => {
    const { args, stdin } = buildClaudeArgs({ prompt: "y".repeat(20000), pluginDirs: [], allowedTools: [] }, null);
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("--output-format");
    expect(stdin).toHaveLength(20000);
  });
});

describe("runClaude (fake binary)", () => {
  const fakeBin = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/usr/bin/env node\n${script}`);
    chmodSync(bin, 0o755);
    return { dir, bin };
  };

  it.skipIf(process.platform === "win32")("runs, streams and returns the result", async () => {
    const { dir, bin } = fakeBin(`process.stdout.write(${JSON.stringify(fixture)});`);
    const { lines, log } = collect();
    const r = await runClaude({ prompt: "hi", cwd: dir, pluginDirs: [], allowedTools: ["Read"], timeoutMs: 10000, log, claudeBin: bin, rulesFile: null, requirePlugins: ["claude-seo"] });
    expect(r.is_error).toBe(false);
    expect(r.exit_code).toBe(0);
    expect(r.structured_output).toEqual({ answer: "done" });
    expect(lines.some((l) => l.message.startsWith("Running:"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("aborts with SIGINT on cancel", async () => {
    const { dir, bin } = fakeBin(
      `process.on("SIGINT", () => { process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,result:"",total_cost_usd:0.1,session_id:"s"})+"\\n"); process.exit(130); });\nsetInterval(() => {}, 1000);`,
    );
    const ctrl = new AbortController();
    const p = runClaude({ prompt: "hi", cwd: dir, pluginDirs: [], allowedTools: [], timeoutMs: 10000, log: () => {}, claudeBin: bin, rulesFile: null, signal: ctrl.signal, killGraceMs: 500 });
    setTimeout(() => ctrl.abort(new Error("Job cancelled from the control panel")), 300);
    await expect(p).rejects.toThrow(/cancelled from the control panel/);
    await p.catch((e: ClaudeError) => expect(e.run?.total_cost_usd).toBe(0.1));
  });

  it.skipIf(process.platform === "win32")("times out and escalates to SIGTERM", async () => {
    const { dir, bin } = fakeBin(`process.on("SIGINT", () => {});\nsetInterval(() => {}, 1000);`);
    const p = runClaude({ prompt: "hi", cwd: dir, pluginDirs: [], allowedTools: [], timeoutMs: 300, log: () => {}, claudeBin: bin, rulesFile: null, killGraceMs: 300 });
    await expect(p).rejects.toThrow(/timed out/);
  });

  it("reports a missing binary clearly", async () => {
    await expect(
      runClaude({ prompt: "hi", cwd: tmpdir(), pluginDirs: [], allowedTools: [], timeoutMs: 1000, log: () => {}, claudeBin: "/definitely/not/claude", rulesFile: null }),
    ).rejects.toThrow(/Is Claude Code installed/);
  });
});
