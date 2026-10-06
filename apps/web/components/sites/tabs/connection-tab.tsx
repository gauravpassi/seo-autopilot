"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, KeyRound, RefreshCw, Save } from "lucide-react";
import type { Site } from "@/lib/types";
import { archiveSite, saveSiteSecret, updateSite } from "@/app/actions/sites";
import { enqueueJob } from "@/app/actions/jobs";
import { sealForRunner } from "@/lib/encrypt-browser";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, inputClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { CHANGE_TYPE } from "@/lib/ui/labels";
import { dateTime } from "@/lib/ui/format";
import { PlatformFields, splitCreds, validateCreds, type Creds } from "@/components/sites/platform-fields";
import { RunnerPicker, type RunnerLite } from "@/components/sites/runner-picker";
import { ConnectionTest } from "@/components/sites/connection-test";
import type { ChangeType } from "@seo-autopilot/core/schema";

export function ConnectionTab({
  site,
  runners,
  secret,
  canEdit,
}: {
  site: Site;
  runners: RunnerLite[];
  secret: { runner_id: string; hint: string | null; updated_at: string } | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const cfg = site.config as Record<string, string | boolean | undefined>;
  const conn = site.connection as { ok?: boolean; details?: Record<string, unknown>; warnings?: string[]; capabilities?: string[]; tested_at?: string };
  const [name, setName] = useState(site.name);
  const [url, setUrl] = useState(site.url);
  const [gsc, setGsc] = useState(String(cfg.gsc_property ?? ""));
  const [creds, setCreds] = useState<Creds>({
    auth: "token",
    repo: String(cfg.repo ?? ""),
    branch: String(cfg.branch ?? "main"),
    build_command: String(cfg.build_command ?? ""),
    framework: String(cfg.framework ?? ""),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [runnerId, setRunnerId] = useState(site.runner_id ?? runners.find((r) => r.public_key)?.id ?? "");
  const [testJob, setTestJob] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const saveDetails = () =>
    start(async () => {
      const res = await updateSite(site.id, { name: name.trim(), url: url.trim(), config: { ...cfg, gsc_property: gsc.trim() || undefined } });
      if (!res.ok) toast({ tone: "error", title: "Couldn't save", detail: res.error });
      else toast({ tone: "success", title: "Site details saved" });
      router.refresh();
    });

  const saveCreds = () =>
    start(async () => {
      const e = validateCreds(site.platform, creds);
      setErrors(e);
      if (Object.keys(e).length) return;
      const runner = runners.find((r) => r.id === runnerId);
      if (!runner?.public_key) {
        toast({ tone: "error", title: "Choose a registered runner" });
        return;
      }
      try {
        const { secrets, config, hint } = splitCreds(site.platform, creds);
        const env = await sealForRunner(JSON.stringify(secrets), runner.public_key);
        if (runner.id !== site.runner_id || Object.keys(config).length) {
          const u = await updateSite(site.id, { runner_id: runner.id, config: { ...cfg, ...config } });
          if (!u.ok) throw new Error(u.error);
        }
        const res = await saveSiteSecret(site.id, runner.id, env, hint);
        if (!res.ok) throw new Error(res.error);
        toast({ tone: "success", title: "Credentials encrypted and saved", detail: "A connection test is running." });
        const jid = (res as { job_id?: string }).job_id;
        if (jid) setTestJob(jid);
        setCreds((c) => ({ ...c, app_password: "", access_token: "", client_secret: "", github_token: "", vercel_bypass_secret: "" }));
        router.refresh();
      } catch (err) {
        toast({ tone: "error", title: "Couldn't save credentials", detail: err instanceof Error ? err.message : undefined });
      }
    });

  const retest = () =>
    start(async () => {
      const res = await enqueueJob(site.id, "test_connection", {});
      if (!res.ok) toast({ tone: "error", title: "Couldn't start the test", detail: res.error });
      else setTestJob(res.id);
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Status"
          action={
            canEdit && site.platform !== "other" ? (
              <Button size="sm" icon={<RefreshCw size={14} aria-hidden />} onClick={retest} disabled={pending || !secret}>
                Test again
              </Button>
            ) : undefined
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            {conn.ok === true ? <Badge tone="ok">Connected</Badge> : conn.ok === false ? <Badge tone="bad">Failing</Badge> : <Badge>Not tested</Badge>}
            {conn.tested_at && <span className="text-muted">tested {dateTime(conn.tested_at)}</span>}
          </div>
          {testJob && <ConnectionTest jobId={testJob} onDone={() => router.refresh()} />}
          {secret ? (
            <p className="flex items-center gap-2 text-[13.5px] text-ink-2">
              <KeyRound size={15} aria-hidden className="text-accent-ink" />
              {secret.hint ?? "Credentials saved"} · encrypted for {runners.find((r) => r.id === secret.runner_id)?.name ?? "a runner"} · updated {dateTime(secret.updated_at)}
            </p>
          ) : site.platform !== "other" ? (
            <p className="text-[13.5px] text-approve-ink">No credentials saved. Add them below so the agent can apply changes.</p>
          ) : null}
          {conn.warnings?.length ? (
            <ul className="space-y-1 text-[13px] text-approve-ink">
              {conn.warnings.map((w, i) => (
                <li key={i}>– {w}</li>
              ))}
            </ul>
          ) : null}
          {conn.capabilities?.length ? (
            <div>
              <p className="mb-1.5 text-[12px] text-muted">The agent can apply these here</p>
              <ul className="flex flex-wrap gap-1.5">
                {conn.capabilities.map((c) => (
                  <li key={c}>
                    <Badge tone="info">{CHANGE_TYPE[c as ChangeType]?.short ?? c}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {conn.details && Object.keys(conn.details).length > 0 && (
            <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
              {Object.entries(conn.details)
                .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
                    <dt className="text-muted capitalize">{k.replace(/_/g, " ")}</dt>
                    <dd className="truncate text-ink-2">{String(v)}</dd>
                  </div>
                ))}
            </dl>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Site details" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="c-name">
            <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} disabled={!canEdit} />
          </Field>
          <Field label="Address" htmlFor="c-url">
            <input id="c-url" value={url} onChange={(e) => setUrl(e.target.value)} className={inputClass} disabled={!canEdit} inputMode="url" />
          </Field>
          <Field
            label="Search Console property"
            htmlFor="c-gsc"
            optional
            className="sm:col-span-2"
            hint="e.g. sc-domain:example.com. Enables traffic numbers on changes and the drop alert. The runner uses claude-seo's Google login."
          >
            <input id="c-gsc" value={gsc} onChange={(e) => setGsc(e.target.value)} className={inputClass + " sm:max-w-md"} disabled={!canEdit} placeholder="sc-domain:example.com" />
          </Field>
          {canEdit && (
            <div className="sm:col-span-2">
              <Button variant="primary" icon={<Save size={15} aria-hidden />} onClick={saveDetails} loading={pending}>
                Save details
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {canEdit && site.platform !== "other" && (
        <Card>
          <CardHeader title={secret ? "Replace credentials" : "Add credentials"} description="Saved values are never shown again. Enter them fresh to replace." />
          <CardBody className="space-y-6">
            <PlatformFields platform={site.platform} creds={creds} set={(k, v) => setCreds((c) => ({ ...c, [k]: v }))} errors={errors} siteUrl={site.url} />
            <div className="border-t border-line pt-5">
              <h3 className="mb-3 text-[14px] font-semibold">Runner</h3>
              <RunnerPicker runners={runners} value={runnerId} onChange={setRunnerId} />
            </div>
            <Button variant="primary" icon={<KeyRound size={15} aria-hidden />} onClick={saveCreds} loading={pending}>
              Encrypt and save
            </Button>
          </CardBody>
        </Card>
      )}

      {canEdit && (
        <Card className="border-bad/30">
          <CardHeader title="Archive site" description="Stops schedules and hides the site. History stays in the activity log." action={<Button variant="reject" size="sm" icon={<Archive size={14} aria-hidden />} onClick={() => setArchiveOpen(true)}>Archive</Button>} />
        </Card>
      )}
      <Dialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title={`Archive ${site.name}?`}
        description="Pending approvals are left to expire. Nothing on the live site is changed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() =>
                start(async () => {
                  const res = await archiveSite(site.id);
                  if (!res.ok) toast({ tone: "error", title: "Couldn't archive", detail: res.error });
                  else {
                    toast({ tone: "success", title: `${site.name} archived` });
                    router.push("/sites");
                  }
                })
              }
            >
              Archive site
            </Button>
          </>
        }
      />
    </div>
  );
}
