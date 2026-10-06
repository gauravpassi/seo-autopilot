#!/usr/bin/env node
/**
 * seo-autopilot-runner CLI.
 */
import { hostname } from "node:os";
import { Command } from "commander";
import { generateRunnerKeyPair } from "@seo-autopilot/core";
import { RunnerApi } from "./api";
import { configPath, loadConfig, requireConfig, saveConfig } from "./config";
import { Daemon } from "./daemon";
import { doctor, formatReport } from "./doctor";
import { serviceSpec, writeService } from "./service";
import { setup } from "./setup";
import { RUNNER_VERSION } from "./version";

const program = new Command();
program.name("seo-autopilot-runner").description("SEO Autopilot runner: runs claude-seo audits and applies approved fixes from your PC").version(RUNNER_VERSION);

program
  .command("register")
  .description("Register this computer with the control panel using a one-time code")
  .requiredOption("--server <url>", "Control panel URL, e.g. https://seo.example.com")
  .requiredOption("--code <code>", "Registration code shown in the panel (Runners → Add runner)")
  .option("--name <name>", "Name for this runner", hostname())
  .option("--force", "Overwrite an existing registration")
  .action(async (o: { server: string; code: string; name: string; force?: boolean }) => {
    const existing = loadConfig();
    if (existing && !o.force) {
      console.error(`Already registered as "${existing.name}" with ${existing.server} (${configPath()}). Use --force to replace.`);
      process.exitCode = 1;
      return;
    }
    const server = new URL(o.server).origin;
    console.log("Generating RSA-3072 key pair…");
    const { publicKeyPem, privateKeyPem } = generateRunnerKeyPair();
    const api = new RunnerApi({ server, retries: 2 });
    const res = await api.register({ code: o.code.trim(), name: o.name, public_key: publicKeyPem, version: RUNNER_VERSION });
    saveConfig({
      ...(existing ?? {}),
      server,
      runner_id: res.runner_id,
      token: res.token,
      private_key_pem: privateKeyPem,
      name: o.name,
      org_id: res.org_id,
    });
    console.log(`Registered runner "${o.name}" (${res.runner_id}). Credentials saved to ${configPath()} (mode 600).`);
    console.log("Next: seo-autopilot-runner doctor   then   seo-autopilot-runner start");
  });

program
  .command("doctor")
  .description("Check Claude Code, claude-seo, Python and git")
  .option("--json", "Print JSON")
  .action(async (o: { json?: boolean }) => {
    const r = await doctor(loadConfig());
    console.log(o.json ? JSON.stringify(r, null, 2) : formatReport(r));
    if (!r.ok) process.exitCode = 1;
  });

program
  .command("setup")
  .description("Install or update claude-seo (+ its Python runtime) and the seo-autopilot plugin")
  .option("--skip-browser", "Don't install Chromium for claude-seo")
  .action(async (o: { skipBrowser?: boolean }) => {
    const ok = await setup(loadConfig(), { skipBrowser: o.skipBrowser });
    console.log(ok ? "\nSetup complete. Run `seo-autopilot-runner doctor` to confirm." : "\nSetup finished with errors (see above).");
    if (!ok) process.exitCode = 1;
  });

program
  .command("start")
  .description("Run the daemon: heartbeat, claim and run jobs until stopped")
  .action(async () => {
    const d = new Daemon(requireConfig());
    await d.start();
  });

program
  .command("run-once")
  .description("Claim and run a single job, then exit")
  .action(async () => {
    const d = new Daemon(requireConfig());
    const stop = () => d.stop("runner stopped");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await d.heartbeat();
    const out = await d.runOnce();
    if (!out) console.log("No queued jobs.");
    else if (out.status === "failed") process.exitCode = 1;
  });

program
  .command("install-service")
  .description("Start the runner automatically at login (launchd, systemd --user, or Task Scheduler)")
  .option("--write", "Write the service file (otherwise just print it)")
  .action((o: { write?: boolean }) => {
    const spec = serviceSpec();
    if (spec.path && spec.content) {
      console.log(`# ${spec.path}\n${spec.content}`);
      if (o.write) {
        writeService(spec);
        console.log(`Wrote ${spec.path}`);
      } else console.log("(not written; re-run with --write)");
    }
    console.log(`\n# ${o.write || !spec.path ? "Run" : "Then run"}:\n${spec.commands.join("\n")}`);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
