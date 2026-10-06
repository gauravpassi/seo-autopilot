import type { Metadata } from "next";
import { readActionToken } from "@/lib/action-tokens";
import { createAdmin } from "@/lib/supabase/server";
import { typeLabel, valueText, shortUrl } from "@/lib/notify/format";
import type { Change } from "@/lib/types";
import { confirmEmailDecision } from "./actions";

export const metadata: Metadata = {
  title: "Confirm decision",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-900">
      <div className="mx-auto max-w-2xl">
        <p className="mb-6 text-sm font-semibold tracking-wide text-slate-500">SEO Autopilot</p>
        {children}
      </div>
    </main>
  );
}

function Notice({ title, body, tone = "neutral" }: { title: string; body?: string; tone?: "good" | "bad" | "neutral" }) {
  const ring = tone === "good" ? "border-emerald-200 bg-emerald-50" : tone === "bad" ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white";
  return (
    <Shell>
      <div className={`rounded-xl border p-6 ${ring}`}>
        <h1 className="text-xl font-semibold">{title}</h1>
        {body ? <p className="mt-2 text-sm text-slate-600">{body}</p> : null}
      </div>
    </Shell>
  );
}

const RESULT: Record<string, { title: string; body: string; tone: "good" | "bad" | "neutral" }> = {
  invalid: { title: "This link is not valid", body: "It may be incomplete or was changed. Open the approvals queue in the panel instead.", tone: "bad" },
  mismatch: { title: "This link is not valid", body: "It does not match what we sent. Open the approvals queue in the panel instead.", tone: "bad" },
  expired_or_used: { title: "This link was already used or has expired", body: "Each email link works once and expires with the change.", tone: "neutral" },
  not_approver: { title: "You are no longer an approver", body: "Ask an admin to add your email to the approver list.", tone: "bad" },
};

export default async function ApprovePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const result = one(sp.result);
  if (result) {
    if (result === "approved" || result === "rejected") {
      const n = Number(one(sp.n) ?? 0);
      const s = Number(one(sp.s) ?? 0);
      if (n === 0)
        return <Notice title="Nothing changed" body="Someone already decided these changes, or they expired." />;
      return (
        <Notice
          tone="good"
          title={`${result === "approved" ? "Approved" : "Rejected"} ${n} change${n === 1 ? "" : "s"}`}
          body={`${result === "approved" ? "The runner will apply and verify them." : "They will not be applied."}${s ? ` ${s} were already decided or expired.` : ""}`}
        />
      );
    }
    const r = RESULT[result] ?? RESULT.invalid;
    return <Notice title={r.title} body={r.body} tone={r.tone} />;
  }

  const token = one(sp.t) ?? "";
  const claims = readActionToken(token);
  if (!claims) return <Notice tone="bad" title="This link is invalid or has expired" body="Open the approvals queue in the panel to review pending changes." />;

  const db = createAdmin();
  const [{ data: tok }, { data: rows }] = await Promise.all([
    db.from("action_tokens").select("used_at").eq("jti", claims.jti).maybeSingle(),
    db.from("changes").select("id, site_id, type, target, before, after, rationale, risk_reasons, status, approver_label, expires_at").eq("org_id", claims.org).in("id", claims.cids),
  ]);
  if (!tok) return <Notice tone="bad" title="This link is not valid" />;
  if (tok.used_at) return <Notice title="This link was already used" body="Each email link works once." />;
  const changes = (rows ?? []) as Array<Pick<Change, "id" | "site_id" | "type" | "target" | "before" | "after" | "rationale" | "risk_reasons" | "status" | "approver_label" | "expires_at">>;
  const pending = changes.filter((c) => c.status === "pending_approval");
  const isApprove = claims.act === "approve";

  return (
    <Shell>
      <h1 className="text-2xl font-semibold">
        {isApprove ? "Approve" : "Reject"} {changes.length === 1 ? "this change" : `${changes.length} changes`}?
      </h1>
      <p className="mt-1 text-sm text-slate-600">Signed in as {claims.rcpt}. Nothing happens until you press the button below.</p>

      <ul className="mt-6 space-y-4">
        {changes.map((c) => {
          const url = c.target?.url ?? "";
          return (
            <li key={c.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{typeLabel(c.type)}</span>
                {c.status !== "pending_approval" ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    already {c.status.replace(/_/g, " ")}
                    {c.approver_label ? ` by ${c.approver_label}` : ""}
                  </span>
                ) : null}
              </div>
              <a href={url} className="mt-1 block break-all text-sm text-blue-600 hover:underline" rel="noreferrer noopener" target="_blank">
                {shortUrl(url)}
              </a>
              <dl className="mt-3 grid gap-2 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Before</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap break-words rounded-md bg-rose-50 px-3 py-2 text-slate-800">{valueText(c.type, c.before)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">After</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap break-words rounded-md bg-emerald-50 px-3 py-2 text-slate-900">{valueText(c.type, c.after)}</dd>
                </div>
              </dl>
              {c.rationale ? <p className="mt-3 text-sm text-slate-600">{c.rationale}</p> : null}
              {c.risk_reasons?.length ? (
                <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">
                  {c.risk_reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {pending.length > 0 ? (
        <form action={confirmEmailDecision} className="mt-8">
          <input type="hidden" name="t" value={token} />
          <button
            type="submit"
            className={`w-full rounded-lg px-5 py-3 text-base font-semibold text-white shadow-sm sm:w-auto ${isApprove ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"}`}
          >
            Confirm: {isApprove ? "approve" : "reject"} {pending.length === 1 ? "change" : `${pending.length} changes`}
          </button>
        </form>
      ) : (
        <p className="mt-8 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">Nothing left to decide here.</p>
      )}
    </Shell>
  );
}
