import { mkdtempSync, statSync, writeFileSync, chmodSync, readdirSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, configPermissionsOk, loadConfig, saveConfig, type RunnerConfig } from "../src/config";
import { cleanupWorkDirs, jobWorkDir } from "../src/workspace";
import { serviceSpec } from "../src/service";

const sample: RunnerConfig = {
  server: "https://panel.example.com",
  runner_id: "r1",
  token: "tok",
  private_key_pem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  name: "laptop",
};

let home: string;
const prev = process.env.SEO_AUTOPILOT_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seo-home-"));
  process.env.SEO_AUTOPILOT_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.SEO_AUTOPILOT_HOME;
  else process.env.SEO_AUTOPILOT_HOME = prev;
});

describe("config", () => {
  it("round-trips and lives under SEO_AUTOPILOT_HOME", () => {
    saveConfig(sample);
    expect(configPath()).toBe(join(home, "runner.json"));
    expect(loadConfig()).toEqual(sample);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("writes runner.json with mode 0600", () => {
    saveConfig(sample);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(configPermissionsOk()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("tightens permissions of an existing world-readable file", () => {
    writeFileSync(configPath(), "{}", { mode: 0o644 });
    chmodSync(configPath(), 0o644);
    expect(configPermissionsOk()).toBe(false);
    saveConfig(sample);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("returns null when not registered and rejects invalid files", () => {
    expect(loadConfig()).toBeNull();
    writeFileSync(configPath(), JSON.stringify({ server: "not a url" }));
    expect(() => loadConfig()).toThrow();
  });
});

describe("workspace", () => {
  it("creates per-job dirs and removes old ones", () => {
    const dir = jobWorkDir("site-1", "job-1");
    expect(dir).toBe(join(home, "work", "site-1", "job-1"));
    expect(existsSync(dir)).toBe(true);
    const old = jobWorkDir("site-1", "job-0");
    const t = (Date.now() - 20 * 86_400_000) / 1000;
    utimesSync(old, t, t);
    expect(cleanupWorkDirs(14)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses path traversal in ids", () => {
    expect(() => jobWorkDir("../x", "job")).toThrow();
    mkdirSync(join(home, "work"), { recursive: true });
  });
});

describe("install-service", () => {
  it("renders launchd, systemd and schtasks variants", () => {
    const mac = serviceSpec({ platform: "darwin", node: "/usr/local/bin/node", script: "/opt/r/runner.js", path: "/usr/bin" });
    expect(mac.path).toMatch(/LaunchAgents\/dev\.seo-autopilot\.runner\.plist$/);
    expect(mac.content).toContain("<string>/opt/r/runner.js</string>");
    const linux = serviceSpec({ platform: "linux", node: "/usr/bin/node", script: "/opt/r/runner.js", path: "/usr/bin" });
    expect(linux.content).toContain("ExecStart=/usr/bin/node /opt/r/runner.js start");
    expect(linux.commands.join("\n")).toContain("systemctl --user enable --now");
    const win = serviceSpec({ platform: "win32", node: "C:\\node.exe", script: "C:\\r\\runner.js" });
    expect(win.path).toBeUndefined();
    expect(win.commands[0]).toContain("schtasks /Create");
    expect(win.commands[0]).toContain("ONLOGON");
  });
});
