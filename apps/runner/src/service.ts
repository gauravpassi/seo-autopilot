/**
 * `install-service`: start the runner at login (launchd / systemd --user / Task Scheduler).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { baseDir } from "./config";

export interface ServiceSpec {
  platform: NodeJS.Platform;
  /** File to write (absent for Windows, which uses a command). */
  path?: string;
  content?: string;
  /** Commands to run after writing. */
  commands: string[];
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function serviceSpec(opts: { node?: string; script?: string; platform?: NodeJS.Platform; path?: string } = {}): ServiceSpec {
  const node = opts.node ?? process.execPath;
  const script = resolve(opts.script ?? process.argv[1] ?? "runner.js");
  const platform = opts.platform ?? process.platform;
  const logDir = join(baseDir(), "logs");
  const envPath = opts.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  if (platform === "darwin") {
    const label = "dev.seo-autopilot.runner";
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(node)}</string>
    <string>${xmlEsc(script)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEsc(envPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xmlEsc(join(logDir, "runner.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(join(logDir, "runner.err.log"))}</string>
</dict>
</plist>
`;
    return { platform, path, content, commands: [`launchctl unload ${shq(path)} 2>/dev/null; launchctl load -w ${shq(path)}`] };
  }

  if (platform === "win32") {
    const tr = `"${node}" "${script}" start`;
    return {
      platform,
      commands: [`schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "SEO Autopilot Runner" /TR "${tr.replace(/"/g, '\\"')}"`, `schtasks /Run /TN "SEO Autopilot Runner"`],
    };
  }

  // Linux & others: systemd user unit
  const path = join(homedir(), ".config", "systemd", "user", "seo-autopilot-runner.service");
  const q = (s: string) => (/\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const content = `[Unit]
Description=SEO Autopilot runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${q(node)} ${q(script)} start
Restart=on-failure
RestartSec=30
Environment=PATH=${envPath}
KillSignal=SIGINT
TimeoutStopSec=60

[Install]
WantedBy=default.target
`;
  return {
    platform,
    path,
    content,
    commands: ["systemctl --user daemon-reload", "systemctl --user enable --now seo-autopilot-runner.service", "loginctl enable-linger $USER   # optional: keep running after logout"],
  };
}

export function writeService(spec: ServiceSpec): void {
  if (!spec.path || !spec.content) return;
  mkdirSync(dirname(spec.path), { recursive: true });
  mkdirSync(join(baseDir(), "logs"), { recursive: true });
  writeFileSync(spec.path, spec.content, "utf8");
}
