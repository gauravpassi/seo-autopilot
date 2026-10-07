/**
 * audit: run claude-seo (`/seo audit <url>` or `/seo page <url>` per URL), find the
 * `<domain>-audit/audit-data.json` envelope, validate it with core AuditData and upload it with
 * FULL-AUDIT-REPORT.md and ACTION-PLAN.md.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { AuditData, JobParams } from "@seo-autopilot/core";
import { assertSameHost } from "@seo-autopilot/core/page";
import { JOB_TIMEOUTS_MS } from "../claude";
import { requireSite, throwIfAborted, type JobContext, type JobResult } from "./context";

const MAX_PAGES = 10;
const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;

export function domainOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

function envelopeInstructions(domain: string, pageUrl?: string): string {
  return `

---
Runner instructions (SEO Autopilot, unattended run):
- Work only inside the current working directory. Write every output file under \`./${domain}-audit/\`.
- You MUST write \`./${domain}-audit/FULL-AUDIT-REPORT.md\` (the complete report), \`./${domain}-audit/ACTION-PLAN.md\` (prioritised Critical > High > Medium > Low) and \`./${domain}-audit/audit-data.json\`.
- \`audit-data.json\` must follow the seo-audit "Structured Audit Data Envelope" exactly:
  {"summary":{"health_score":<0-100 number>,"business_type":"...","top_findings":[],"quick_wins":[]},
   "categories":[{"name":"Technical SEO","score":<0-100>,"what_works":[],"findings":[{"title":"...","severity":"Critical|High|Medium|Low|Info","description":"evidence","recommendation":"specific fix","url":"https://affected/page"}]}],
   "action_plan":{"phases":[...]}}
  Write this envelope${pageUrl ? " for this single-page analysis too (one category per analysed area)" : ""}. Every finding needs a "url" field with the affected page URL whenever it concerns a specific page${pageUrl ? ` (use ${pageUrl} for findings about this page)` : ""}.
- Severity must be exactly one of Critical, High, Medium, Low, Info.
- Skip optional extras that need a person (PDF generation offers, questions, community footer).`;
}

function findEnvelope(dir: string, domain: string): string | null {
  const preferred = join(dir, `${domain}-audit`, "audit-data.json");
  if (existsSync(preferred)) return preferred;
  // Any *-audit/audit-data.json up to 3 levels deep (Claude may name the folder with www. etc.)
  const hits: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e === "audit-data.json") hits.push(p);
    }
  };
  walk(dir, 0);
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0] ?? null;
}

function readIfExists(p: string): string | undefined {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Normalise severities so the server's findings check constraint accepts them. */
export function normalizeSeverity(s: unknown): (typeof SEVERITIES)[number] {
  const v = String(s ?? "").trim().toLowerCase();
  const hit = SEVERITIES.find((x) => x.toLowerCase() === v);
  if (hit) return hit;
  if (/crit|blocker|error|fail/.test(v)) return "Critical";
  if (/high|major|important/.test(v)) return "High";
  if (/med|warn|moderate/.test(v)) return "Medium";
  if (/low|minor/.test(v)) return "Low";
  return "Info";
}

export function loadAuditData(path: string, defaultUrl?: string): AuditData {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`audit-data.json is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = AuditData.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`audit-data.json does not match the audit envelope: ${issues}`);
  }
  const data = parsed.data;
  for (const c of data.categories) {
    for (const f of c.findings) {
      f.severity = normalizeSeverity(f.severity);
      if (!f.url && defaultUrl) f.url = defaultUrl;
    }
  }
  return data;
}

/**
 * Refuse audits that didn't really run. Claude is told never to invent findings, so when its
 * tools were blocked it writes an (honest) empty envelope. Storing that would show a bogus
 * health score and feed nothing useful into proposals, so fail the job with the reason instead.
 */
export function assertAuditRan(data: AuditData, denials: unknown[], wroteLate: boolean): void {
  const scored =
    (typeof data.summary.health_score === "number" && data.summary.health_score > 0) ||
    data.categories.some((c) => typeof c.score === "number");
  const blocked = denials
    .map((d) => {
      const o = (d ?? {}) as { tool_name?: string; tool_input?: { command?: string; url?: string } };
      const what = o.tool_input?.command ?? o.tool_input?.url ?? "";
      return `${o.tool_name ?? "tool"}${what ? `: ${what.slice(0, 80)}` : ""}`;
    })
    .slice(0, 3);
  if (denials.length && (wroteLate || !scored)) {
    throw new Error(
      `claude-seo couldn't run its analysis: ${denials.length} tool call(s) were blocked by the runner's permissions ` +
        `(${blocked.join("; ")}). Nothing was stored. If the site is reachable, re-run the audit; ` +
        `otherwise check the site address and that it is publicly reachable or on an allowed local address.`,
    );
  }
  if (!scored) {
    throw new Error("The audit produced no scores, so it most likely didn't analyse the site. Nothing was stored.");
  }
}

/** Merge per-page envelopes into one (page depth with several URLs). */
export function mergeAuditData(parts: Array<{ url: string; data: AuditData }>): AuditData {
  if (parts.length === 1) return parts[0].data;
  const scores = parts.map((p) => p.data.summary.health_score).filter((n): n is number => typeof n === "number" && !Number.isNaN(n));
  const byName = new Map<string, AuditData["categories"][number]>();
  const catScores = new Map<string, number[]>();
  for (const { data } of parts) {
    for (const c of data.categories) {
      const cur = byName.get(c.name);
      if (!cur) byName.set(c.name, { ...c, findings: [...c.findings], what_works: [...(c.what_works ?? [])] });
      else {
        cur.findings.push(...c.findings);
        cur.what_works = [...(cur.what_works ?? []), ...(c.what_works ?? [])];
      }
      if (typeof c.score === "number") catScores.set(c.name, [...(catScores.get(c.name) ?? []), c.score]);
    }
  }
  for (const [name, list] of catScores) {
    const c = byName.get(name)!;
    c.score = Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  }
  return {
    summary: {
      health_score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined,
      business_type: parts.find((p) => p.data.summary.business_type)?.data.summary.business_type,
      top_findings: parts.flatMap((p) => p.data.summary.top_findings ?? []),
      quick_wins: parts.flatMap((p) => p.data.summary.quick_wins ?? []),
      pages: parts.map((p) => ({ url: p.url, health_score: p.data.summary.health_score ?? null })),
    },
    categories: [...byName.values()],
    action_plan: { pages: parts.map((p) => ({ url: p.url, action_plan: p.data.action_plan ?? null })) },
  };
}

async function runOne(ctx: JobContext, prompt: string, cwd: string, domain: string, pageUrl?: string) {
  const timeoutMs = JOB_TIMEOUTS_MS.audit;
  const run = await ctx.claude({ prompt: prompt + envelopeInstructions(domain, pageUrl), cwd, timeoutMs });
  if (run.is_error) throw new Error(`claude-seo audit failed: ${run.result || run.subtype || "unknown error"}`);
  let envelope = findEnvelope(cwd, domain);
  const wroteLate = !envelope;
  if (!envelope && run.session_id) {
    throwIfAborted(ctx.signal);
    ctx.log("warn", "audit-data.json was not written; asking Claude to write the envelope from its findings");
    const fix = await ctx.claude({
      prompt:
        `You did not write ./${domain}-audit/audit-data.json. Write it now from the findings of this analysis, ` +
        `following the seo-audit Structured Audit Data Envelope exactly (summary.health_score, categories[].findings[] with ` +
        `title, severity Critical|High|Medium|Low|Info, description, recommendation, url). ` +
        `Also write ./${domain}-audit/FULL-AUDIT-REPORT.md and ./${domain}-audit/ACTION-PLAN.md if they are missing. Do not re-run the analysis.`,
      cwd,
      resume: run.session_id,
      timeoutMs: 10 * 60_000,
    });
    if (fix.is_error) ctx.log("warn", `Envelope follow-up failed: ${fix.result}`);
    envelope = findEnvelope(cwd, domain);
  }
  if (!envelope) throw new Error(`claude-seo did not produce ${domain}-audit/audit-data.json`);
  ctx.log("info", `Found audit envelope: ${relative(ctx.workDir, envelope)}`);
  const auditDir = join(envelope, "..");
  const data = loadAuditData(envelope, pageUrl);
  assertAuditRan(data, run.permission_denials ?? [], wroteLate);
  return {
    data,
    report: readIfExists(join(auditDir, "FULL-AUDIT-REPORT.md")),
    plan: readIfExists(join(auditDir, "ACTION-PLAN.md")),
  };
}

export async function auditJob(ctx: JobContext): Promise<JobResult> {
  const site = requireSite(ctx);
  const params = JobParams.audit.parse(ctx.job.params ?? {});
  const domain = domainOf(site.url);
  let data: AuditData;
  let report_md: string | undefined;
  let action_plan_md: string | undefined;

  if (params.depth === "full") {
    ctx.log("info", `Running full claude-seo audit of ${site.url}`);
    const r = await runOne(ctx, `/seo audit ${site.url}`, ctx.workDir, domain);
    data = r.data;
    report_md = r.report;
    action_plan_md = r.plan;
  } else {
    const urls = (params.urls?.length ? params.urls : [site.url]).filter((u) => {
      try {
        assertSameHost(u, site.url);
        return true;
      } catch (e) {
        ctx.log("warn", `Skipping ${u}: ${(e as Error).message}`);
        return false;
      }
    });
    if (!urls.length) throw new Error("No valid page URLs on this site to audit");
    if (urls.length > MAX_PAGES) ctx.log("warn", `Auditing the first ${MAX_PAGES} of ${urls.length} URLs`);
    const parts: Array<{ url: string; data: AuditData; report?: string; plan?: string }> = [];
    for (const [i, url] of urls.slice(0, MAX_PAGES).entries()) {
      throwIfAborted(ctx.signal);
      const cwd = join(ctx.workDir, `page-${i + 1}`);
      mkdirSync(cwd, { recursive: true });
      ctx.log("info", `(${i + 1}/${Math.min(urls.length, MAX_PAGES)}) claude-seo page analysis of ${url}`);
      try {
        const r = await runOne(ctx, `/seo page ${url}`, cwd, domain, url);
        parts.push({ url, ...r });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        ctx.log("error", `Page ${url} failed: ${(e as Error).message}`);
      }
    }
    if (!parts.length) throw new Error("Every page analysis failed");
    data = mergeAuditData(parts);
    const join2 = (key: "report" | "plan") =>
      parts.some((p) => p[key]) ? parts.map((p) => `# ${p.url}\n\n${p[key] ?? "_(not produced)_"}`).join("\n\n---\n\n") : undefined;
    report_md = join2("report");
    action_plan_md = join2("plan");
    const merged = join(ctx.workDir, `${domain}-audit`);
    mkdirSync(merged, { recursive: true });
    writeFileSync(join(merged, "audit-data.json"), JSON.stringify(data, null, 2));
  }

  const findings = data.categories.reduce((n, c) => n + c.findings.length, 0);
  ctx.log("info", `Audit envelope OK: health ${data.summary.health_score ?? "?"}, ${data.categories.length} categories, ${findings} findings`);
  const res = await ctx.api.postAudit(site.id, {
    job_id: ctx.job.id,
    depth: params.depth,
    audit_data: data,
    ...(report_md ? { report_md } : {}),
    ...(action_plan_md ? { action_plan_md } : {}),
  });
  ctx.log("info", `Audit stored (${res.audit_id})${res.propose_job_id ? `; propose job ${res.propose_job_id} queued` : ""}`);
  return {
    audit_id: res.audit_id,
    health_score: data.summary.health_score ?? null,
    findings,
    ...(res.propose_job_id ? { propose_job_id: res.propose_job_id } : {}),
  };
}
