/**
 * Pure formatting for approval notifications (no I/O): Slack Block Kit, WhatsApp text, email HTML/text.
 */
import type { Change } from "../types";

export const TYPE_LABEL: Record<string, string> = {
  title: "Title",
  meta_description: "Meta description",
  h1: "H1 heading",
  canonical: "Canonical",
  robots_meta: "Robots meta",
  og_tags: "Open Graph tags",
  image_alt: "Image alt text",
  jsonld_add: "Add structured data",
  jsonld_fix: "Fix structured data",
  redirect: "Redirect",
  robots_txt: "robots.txt",
  llms_txt: "llms.txt",
  slug: "URL slug",
  content_edit: "Content edit",
  internal_link: "Internal link",
  hreflang: "hreflang",
  code_change: "Code change",
};

export const typeLabel = (t: string) => TYPE_LABEL[t] ?? t;

export function truncate(s: string, n: number): string {
  const str = String(s ?? "");
  return str.length <= n ? str : `${str.slice(0, Math.max(0, n - 1))}…`;
}

function firstLines(s: string, lines = 3): string {
  const parts = String(s).split(/\r?\n/);
  const head = parts.slice(0, lines).join(" / ");
  return parts.length > lines ? `${head} (+${parts.length - lines} lines)` : head;
}

/** Human one-liner for a before/after value of a given change type. */
export function valueText(type: string, v: unknown): string {
  if (v === null || v === undefined) return "(none)";
  if (typeof v === "string") return v.trim() === "" ? "(empty)" : ["robots_txt", "llms_txt"].includes(type) ? firstLines(v) : v;
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  switch (type) {
    case "robots_meta":
      if ("index" in o || "follow" in o)
        return `${o.index === false ? "noindex" : "index"}, ${o.follow === false ? "nofollow" : "follow"}`;
      break;
    case "og_tags": {
      const parts = (["title", "description", "image"] as const).filter((k) => o[k]).map((k) => `${k}: ${o[k]}`);
      return parts.length ? parts.join(" | ") : "(none)";
    }
    case "image_alt":
      if ("alt" in o) return `${o.alt ? `"${o.alt}"` : "(no alt)"}${o.src ? ` on ${o.src}` : ""}`;
      break;
    case "jsonld_add":
    case "jsonld_fix":
      if ("schema_type" in o) return `${o.schema_type} JSON-LD${o.replaces_type ? ` (replaces ${o.replaces_type})` : ""}`;
      break;
    case "redirect":
      if ("from_path" in o) return `${o.from_path} → ${o.to_url} (${o.code ?? 301})`;
      break;
    case "robots_txt":
    case "llms_txt":
      if ("content" in o) return o.content ? firstLines(String(o.content)) : "(empty)";
      break;
    case "content_edit":
    case "code_change":
      if ("instructions" in o) return String(o.instructions);
      break;
    case "internal_link":
      if ("anchor" in o) return `link "${o.anchor}" → ${o.to_url}`;
      break;
    case "hreflang":
      if (Array.isArray(o.alternates))
        return (o.alternates as Array<{ lang: string; url: string }>).map((a) => `${a.lang}: ${a.url}`).join(", ");
      break;
  }
  if ("value" in o) return valueText(type, o.value);
  if (Object.keys(o).length === 0) return "(none)";
  return JSON.stringify(o);
}

export function changeUrl(c: Pick<Change, "target">): string {
  return (c.target as { url?: string })?.url ?? "";
}

export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname === "/" ? "" : x.pathname}`;
  } catch {
    return u;
  }
}

export type MiniChange = Pick<
  Change,
  "id" | "type" | "target" | "before" | "after" | "risk_reasons" | "status" | "approver_label" | "rationale" | "site_id"
>;

/** "✅ Approved by X" / "❌ Rejected by X" etc. for a decided change, or null while pending. */
export function decisionLine(c: MiniChange): string | null {
  const who = c.approver_label ? ` by ${c.approver_label}` : "";
  switch (c.status) {
    case "pending_approval":
      return null;
    case "approved":
    case "applying":
    case "applied":
    case "verifying":
    case "verified":
      return `✅ Approved${who}${c.status !== "approved" ? ` · now ${c.status.replace("_", " ")}` : ""}`;
    case "rejected":
      return `❌ Rejected${who}`;
    case "expired":
      return "⌛ Expired without a decision";
    default:
      return `• ${c.status.replace(/_/g, " ")}`;
  }
}

// ------------------------------------------------------------------ Slack
export const SLACK_MAX_BLOCKS = 45;
const SLACK_RESERVED = 4; // header, summary, approve-all actions, overflow context
export const SLACK_MAX_CHANGES = Math.floor((SLACK_MAX_BLOCKS - SLACK_RESERVED) / 2);

const mrkdwnEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface SlackMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

/**
 * One Slack message for a batch of changes. Pending changes get Approve/Reject buttons
 * (value = change id); decided ones show the decision instead. ≤ 45 blocks; overflow is summarized.
 */
export function slackBatchMessage(
  changes: MiniChange[],
  opts: { appUrl: string; siteNames?: Record<string, string>; title?: string },
): SlackMessage {
  const pending = changes.filter((c) => c.status === "pending_approval");
  const shown = changes.slice(0, SLACK_MAX_CHANGES);
  const hidden = changes.length - shown.length;
  const sites = [...new Set(changes.map((c) => opts.siteNames?.[c.site_id] ?? shortUrl(changeUrl(c))))];
  const title = opts.title ?? `${changes.length} SEO change${changes.length === 1 ? "" : "s"} need${changes.length === 1 ? "s" : ""} approval`;
  const blocks: Array<Record<string, unknown>> = [
    { type: "header", text: { type: "plain_text", text: truncate(title, 150), emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(
          `*Site:* ${mrkdwnEscape(sites.slice(0, 3).join(", "))}${sites.length > 3 ? ` +${sites.length - 3}` : ""}\n` +
            `${pending.length} pending · <${opts.appUrl}/approvals|Open the approvals queue>`,
          3000,
        ),
      },
    },
  ];
  for (const c of shown) {
    const url = changeUrl(c);
    const reasons = (c.risk_reasons ?? []).slice(0, 3).map((r) => `• ${mrkdwnEscape(r)}`).join("\n");
    const text =
      `*${typeLabel(c.type)}* on <${url}|${mrkdwnEscape(truncate(shortUrl(url), 80))}>\n` +
      `*Before:* ${mrkdwnEscape(truncate(valueText(c.type, c.before), 300))}\n` +
      `*After:* ${mrkdwnEscape(truncate(valueText(c.type, c.after), 600))}` +
      (reasons ? `\n${reasons}` : "");
    blocks.push({ type: "section", block_id: `chg_${c.id}`, text: { type: "mrkdwn", text: truncate(text, 3000) } });
    const decided = decisionLine(c);
    if (decided) {
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: mrkdwnEscape(decided) }] });
    } else {
      blocks.push({
        type: "actions",
        block_id: `act_${c.id}`,
        elements: [
          { type: "button", action_id: "approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: c.id },
          {
            type: "button",
            action_id: "reject",
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
            value: c.id,
          },
        ],
      });
    }
  }
  const shownPending = shown.filter((c) => c.status === "pending_approval");
  if (shownPending.length > 1) {
    blocks.push({
      type: "actions",
      block_id: "batch",
      elements: [
        {
          type: "button",
          action_id: "approve_all",
          style: "primary",
          text: { type: "plain_text", text: `Approve all ${shownPending.length}` },
          value: shownPending.map((c) => c.id).join(","),
          confirm: {
            title: { type: "plain_text", text: "Approve all?" },
            text: { type: "plain_text", text: `Approve ${shownPending.length} changes shown in this message.` },
            confirm: { type: "plain_text", text: "Approve all" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    });
  }
  if (hidden > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${hidden} more. <${opts.appUrl}/approvals|Review them in the panel>` }],
    });
  }
  return { text: `${title} (${shortUrl(changeUrl(changes[0] ?? { target: { url: "" } }))})`, blocks: blocks.slice(0, SLACK_MAX_BLOCKS) };
}

export function slackEventMessage(title: string, lines: string[], link?: string): SlackMessage {
  const body = lines.map(mrkdwnEscape).join("\n") + (link ? `\n<${link}|Open in panel>` : "");
  return {
    text: title,
    blocks: [
      { type: "header", text: { type: "plain_text", text: truncate(title, 150), emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: truncate(body || " ", 3000) } },
    ],
  };
}

// ------------------------------------------------------------------ WhatsApp
export const WA_BODY_MAX = 1024;
export const WA_BUTTON_TITLE_MAX = 20;

export function whatsappChangeBody(c: MiniChange, siteName?: string): string {
  const url = changeUrl(c);
  const reasons = (c.risk_reasons ?? []).slice(0, 2).map((r) => `• ${r}`).join("\n");
  const body =
    `*${typeLabel(c.type)}*${siteName ? ` · ${siteName}` : ""}\n${shortUrl(url)}\n\n` +
    `Before: ${truncate(valueText(c.type, c.before), 250)}\n` +
    `After: ${truncate(valueText(c.type, c.after), 400)}` +
    (reasons ? `\n\n${reasons}` : "");
  return truncate(body, WA_BODY_MAX);
}

/** Template variables cannot contain newlines/tabs or > 4 consecutive spaces. */
export function waTemplateParam(s: string, max = 200): string {
  return truncate(String(s).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim() || "-", max);
}

// ------------------------------------------------------------------ Email
const html = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface EmailChangeLinks {
  change: MiniChange;
  approveUrl: string;
  rejectUrl: string;
}

export function approvalEmail(
  items: EmailChangeLinks[],
  opts: { appUrl: string; approveAllUrl?: string; heading?: string; siteNames?: Record<string, string> },
): { subject: string; html: string; text: string } {
  const n = items.length;
  const heading = opts.heading ?? `${n} SEO change${n === 1 ? "" : "s"} waiting for your approval`;
  const site = items[0] ? (opts.siteNames?.[items[0].change.site_id] ?? shortUrl(changeUrl(items[0].change))) : "";
  const subject = n === 1 ? `Approve: ${typeLabel(items[0].change.type)} on ${shortUrl(changeUrl(items[0].change))}` : `${heading}${site ? ` (${site})` : ""}`;
  const rows = items
    .map(({ change: c, approveUrl, rejectUrl }) => {
      const url = changeUrl(c);
      const reasons = (c.risk_reasons ?? []).map((r) => `<li>${html(r)}</li>`).join("");
      return `<tr><td style="padding:16px 0;border-bottom:1px solid #e5e7eb">
<div style="font-weight:600;font-size:15px">${html(typeLabel(c.type))}</div>
<div style="font-size:13px;color:#4b5563;margin:2px 0 8px"><a href="${html(url)}" style="color:#2563eb">${html(shortUrl(url))}</a></div>
<div style="font-size:13px"><span style="color:#6b7280">Before:</span> ${html(truncate(valueText(c.type, c.before), 400))}</div>
<div style="font-size:13px;margin-top:4px"><span style="color:#6b7280">After:</span> <strong>${html(truncate(valueText(c.type, c.after), 800))}</strong></div>
${reasons ? `<ul style="font-size:12px;color:#6b7280;margin:8px 0 0;padding-left:18px">${reasons}</ul>` : ""}
<div style="margin-top:12px">
<a href="${html(approveUrl)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;margin-right:8px">Approve</a>
<a href="${html(rejectUrl)}" style="display:inline-block;background:#fff;color:#b91c1c;border:1px solid #fca5a5;text-decoration:none;padding:7px 14px;border-radius:6px;font-size:13px">Reject</a>
</div></td></tr>`;
    })
    .join("");
  const all = opts.approveAllUrl
    ? `<p style="margin:20px 0 0"><a href="${html(opts.approveAllUrl)}" style="color:#16a34a;font-weight:600">Approve all ${n}</a></p>`
    : "";
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px">
<tr><td><div style="font-size:18px;font-weight:700">${html(heading)}</div>
<div style="font-size:13px;color:#6b7280;margin-top:4px">Each link opens a confirmation page. Nothing changes until you press Confirm.</div></td></tr>
${rows}
<tr><td>${all}<p style="font-size:12px;color:#9ca3af;margin-top:20px">Or review everything in the <a href="${html(opts.appUrl)}/approvals" style="color:#6b7280">approvals queue</a>. Links are single-use and expire with the change.</p></td></tr>
</table></td></tr></table></body></html>`;
  const text =
    `${heading}\n\n` +
    items
      .map(
        ({ change: c, approveUrl, rejectUrl }) =>
          `${typeLabel(c.type)} — ${changeUrl(c)}\n  Before: ${truncate(valueText(c.type, c.before), 300)}\n  After:  ${truncate(
            valueText(c.type, c.after),
            600,
          )}\n  Approve: ${approveUrl}\n  Reject:  ${rejectUrl}`,
      )
      .join("\n\n") +
    (opts.approveAllUrl ? `\n\nApprove all ${n}: ${opts.approveAllUrl}` : "") +
    `\n\nApprovals queue: ${opts.appUrl}/approvals\nLinks open a confirmation page, are single-use and expire with the change.`;
  return { subject: truncate(subject, 140), html: htmlBody, text };
}

export function eventEmail(title: string, lines: string[], link?: string): { subject: string; html: string; text: string } {
  const htmlBody = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;padding:24px">
<h2 style="font-size:18px;margin:0 0 12px">${html(title)}</h2>
${lines.map((l) => `<p style="font-size:14px;margin:4px 0">${html(l)}</p>`).join("")}
${link ? `<p style="margin-top:16px"><a href="${html(link)}" style="color:#2563eb">Open in panel</a></p>` : ""}
</body></html>`;
  return { subject: truncate(title, 140), html: htmlBody, text: `${title}\n\n${lines.join("\n")}${link ? `\n\n${link}` : ""}` };
}
