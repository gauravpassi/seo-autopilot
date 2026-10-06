"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Plus, Trash2, Pencil, CircleCheck } from "lucide-react";
import type { Runner } from "@/lib/types";
import { createRunnerCode, renameRunner, revokeRunner } from "@/app/actions/runners";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/ui/code-block";
import { Dialog } from "@/components/ui/dialog";
import { Dot, EmptyState, Field, inputClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { isOnline, remaining, timeAgo } from "@/lib/ui/format";
import { useNow } from "@/lib/ui/use-now";
import { RunnerHealth } from "./runner-health";
import { AutoRefresh } from "@/components/jobs/auto-refresh";

function ConnectFlow({ appUrl, onDone }: { appUrl: string; onDone: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const [code, setCode] = useState<{ code: string; expires: string; runnerId: string } | null>(null);
  const now = useNow(1000);

  if (!code)
    return (
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const res = await createRunnerCode(name.trim() || "My computer");
            if (!res.ok) return toast({ tone: "error", title: "Couldn't create a code", detail: res.error });
            setCode({ code: res.code, runnerId: res.runner_id, expires: new Date(Date.now() + 15 * 60_000).toISOString() });
            router.refresh();
          });
        }}
      >
        <Field label="Name this computer" htmlFor="runner-name" hint="So your team knows where jobs run, e.g. “Saswata's MacBook” or “Office server”." className="flex-1">
          <input id="runner-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="Office Mac mini" maxLength={60} />
        </Field>
        <Button type="submit" variant="primary" loading={pending}>
          Get setup code
        </Button>
      </form>
    );

  const r = remaining(code.expires, now);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div>
          <p className="text-[12px] text-muted">One-time code</p>
          <p className="num text-[28px] font-semibold tracking-[0.06em] text-ink select-all">{code.code}</p>
        </div>
        <Badge tone={r?.past ? "bad" : r?.urgent ? "approve" : "neutral"}>{r?.past ? "Expired — get a new code" : `Expires in ${r?.text}`}</Badge>
      </div>
      <ol className="space-y-4">
        <li>
          <p className="mb-1.5 text-[14px] font-medium text-ink">
            <span className="num mr-2 text-muted">0</span>First time on this computer: install the runner from your copy of the SEO Autopilot repo
          </p>
          <CodeBlock code={`cd seo-autopilot && npm install && npm run build -w apps/runner && npm link -w apps/runner`} />
          <p className="mt-1.5 text-[12.5px] text-muted">Needs Node 20+, Git, Python 3.10+ and Claude Code signed in (<code className="font-mono">claude auth login</code>).</p>
        </li>
        <li>
          <p className="mb-1.5 text-[14px] font-medium text-ink">
            <span className="num mr-2 text-muted">1</span>Register it with this panel
          </p>
          <CodeBlock code={`seo-autopilot-runner register --server ${appUrl} --code ${code.code}`} />
        </li>
        <li>
          <p className="mb-1.5 text-[14px] font-medium text-ink">
            <span className="num mr-2 text-muted">2</span>Check Claude Code, claude-seo and Python are ready
          </p>
          <CodeBlock code={`seo-autopilot-runner setup`} />
          <p className="mt-1.5 text-[12.5px] text-muted">
            If something looks wrong later, <code className="font-mono">seo-autopilot-runner doctor</code> explains what to fix.
          </p>
        </li>
        <li>
          <p className="mb-1.5 text-[14px] font-medium text-ink">
            <span className="num mr-2 text-muted">3</span>Start it and leave it running
          </p>
          <CodeBlock code={`seo-autopilot-runner start`} />
        </li>
      </ol>
      <p className="text-[13px] text-muted">This list updates on its own. The runner shows as online within a few seconds of starting.</p>
      <Button variant="ghost" onClick={onDone}>
        Close
      </Button>
    </div>
  );
}

export function RunnersView({
  runners,
  appUrl,
  canEdit,
  siteCount,
  openConnect,
}: {
  runners: Runner[];
  appUrl: string;
  canEdit: boolean;
  siteCount: Record<string, number>;
  openConnect?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const now = useNow(5000);
  const [connect, setConnect] = useState(!!openConnect || (runners.length === 0 && canEdit));
  const [rename, setRename] = useState<Runner | null>(null);
  const [newName, setNewName] = useState("");
  const [revoke, setRevoke] = useState<Runner | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-4">
      <AutoRefresh enabled ms={10_000} />
      {canEdit && (
        <Card>
          <CardHeader
            title="Connect a runner"
            description="Takes about two minutes. The computer needs Node.js 20+, Claude Code (signed in) and Python 3."
            action={!connect ? <Button variant="primary" icon={<Plus size={16} aria-hidden />} onClick={() => setConnect(true)}>Connect a runner</Button> : undefined}
          />
          {connect && (
            <div className="border-t border-line px-5 py-5">
              <ConnectFlow appUrl={appUrl} onDone={() => setConnect(false)} />
            </div>
          )}
        </Card>
      )}

      {runners.length === 0 ? (
        <Card>
          <EmptyState icon={Cpu} title="No runners yet">
            {canEdit ? "Connect one above. Nothing runs until a runner is online." : "Ask an admin to connect a runner."}
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {runners.map((r) => {
            const on = isOnline(r.last_seen_at, now);
            const registered = !!r.public_key;
            const st = r.status as { busy?: boolean; job_id?: string };
            return (
              <li key={r.id}>
                <Card className="p-5">
                  <div className="flex items-start gap-3">
                    <span className="mt-1.5">
                      <Dot tone={!registered ? "approve" : on ? "ok" : "bad"} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[16px] font-semibold">{r.name}</p>
                      <p className="text-[13px] text-muted">
                        {!registered
                          ? r.registration_expires_at && new Date(r.registration_expires_at).getTime() > now
                            ? "Waiting for registration"
                            : "Setup code expired — remove and connect again"
                          : on
                            ? st.busy
                              ? "Online · working on a job"
                              : "Online · idle"
                            : `Offline · last seen ${timeAgo(r.last_seen_at, now)}`}
                        {r.version && ` · v${r.version.replace(/^v/, "")}`}
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex shrink-0 gap-0.5">
                        <Button size="sm" variant="ghost" aria-label={`Rename ${r.name}`} icon={<Pencil size={14} aria-hidden />} onClick={() => { setRename(r); setNewName(r.name); }} />
                        <Button size="sm" variant="ghost" aria-label={`Remove ${r.name}`} icon={<Trash2 size={14} aria-hidden />} onClick={() => setRevoke(r)} />
                      </div>
                    )}
                  </div>
                  {registered && (
                    <div className="mt-4 border-t border-line pt-3">
                      <RunnerHealth status={r.status} />
                      <p className="mt-2 text-[12.5px] text-muted">
                        {siteCount[r.id] ?? 0} {(siteCount[r.id] ?? 0) === 1 ? "site" : "sites"} use this runner
                        {st.job_id && on && (
                          <>
                            {" · "}
                            <a href={`/jobs/${st.job_id}`} className="text-accent-ink underline underline-offset-2">
                              current job
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={!!rename}
        onClose={() => setRename(null)}
        title="Rename runner"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRename(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={() =>
                start(async () => {
                  if (!rename) return;
                  const res = await renameRunner(rename.id, newName.trim());
                  if (!res.ok) toast({ tone: "error", title: "Couldn't rename", detail: res.error });
                  else toast({ tone: "success", title: "Runner renamed" });
                  setRename(null);
                  router.refresh();
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Name" htmlFor="rn">
          <input id="rn" value={newName} onChange={(e) => setNewName(e.target.value)} className={inputClass} maxLength={60} />
        </Field>
      </Dialog>

      <Dialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title={`Remove ${revoke?.name ?? "runner"}?`}
        description="Its token stops working immediately."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoke(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() =>
                start(async () => {
                  if (!revoke) return;
                  const res = await revokeRunner(revoke.id);
                  if (!res.ok) toast({ tone: "error", title: "Couldn't remove", detail: res.error });
                  else toast({ tone: "success", title: `${revoke.name} removed` });
                  setRevoke(null);
                  router.refresh();
                })
              }
            >
              Remove runner
            </Button>
          </>
        }
      >
        {revoke && (siteCount[revoke.id] ?? 0) > 0 ? (
          <p className="flex gap-2 rounded-lg bg-approve-soft px-3 py-2.5 text-[13.5px] text-approve-ink">
            {siteCount[revoke.id]} {siteCount[revoke.id] === 1 ? "site's credentials are" : "sites' credentials are"} encrypted for this runner only. After removing it, re-enter those
            credentials on each site&apos;s Connection tab for another runner.
          </p>
        ) : (
          <p className="flex items-center gap-2 text-[14px] text-ink-2">
            <CircleCheck size={16} aria-hidden className="text-ok" /> No sites depend on this runner.
          </p>
        )}
      </Dialog>
    </div>
  );
}
