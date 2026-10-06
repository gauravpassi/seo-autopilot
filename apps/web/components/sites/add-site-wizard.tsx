"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, Code2, Globe, ShoppingBag, FileText, ShieldCheck } from "lucide-react";
import type { Platform } from "@seo-autopilot/core/schema";
import { createSite, saveSiteSecret } from "@/app/actions/sites";
import { sealForRunner } from "@/lib/encrypt-browser";
import { createBrowserClient } from "@/lib/supabase/client";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/ui/format";
import { PLATFORM } from "@/lib/ui/labels";
import { PlatformFields, splitCreds, validateCreds, type Creds } from "./platform-fields";
import { RunnerPicker, type RunnerLite } from "./runner-picker";
import { ConnectionTest } from "./connection-test";

const STEPS = ["Site", "Credentials", "Runner", "Connect"] as const;

const PLATFORM_ICON: Record<Platform, typeof Globe> = {
  wordpress: FileText,
  shopify: ShoppingBag,
  repo: Code2,
  other: Globe,
};

function normalizeUrl(u: string): string | null {
  const s = u.trim();
  if (!s) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!url.hostname.includes(".")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function AddSiteWizard({ runners }: { runners: RunnerLite[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [creds, setCreds] = useState<Creds>({ auth: "token", branch: "main" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const firstUsable = runners.find((r) => r.public_key);
  const [runnerId, setRunnerId] = useState(firstUsable?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [testJob, setTestJob] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const origin = normalizeUrl(url) ?? "";

  function next() {
    if (step === 0) {
      const e: Record<string, string> = {};
      if (!name.trim()) e.name = "Give the site a name your team will recognise.";
      if (!normalizeUrl(url)) e.url = "Enter the site's address, e.g. https://www.example.com";
      if (!platform) e.platform = "Choose how the site is built.";
      setErrors(e);
      if (Object.keys(e).length) return;
      setStep(platform === "other" ? 2 : 1);
      return;
    }
    if (step === 1 && platform) {
      const e = validateCreds(platform, creds);
      setErrors(e);
      if (Object.keys(e).length) return;
      setStep(2);
    }
  }

  async function save() {
    if (!platform) return;
    const runner = runners.find((r) => r.id === runnerId);
    if (!runner?.public_key) {
      setSaveError("Choose a registered runner.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const { secrets, config, hint } = splitCreds(platform, creds);
      // Encrypt first: if WebCrypto fails we haven't created a half-configured site.
      setPhase("Encrypting credentials in your browser");
      const envelope = platform === "other" ? null : await sealForRunner(JSON.stringify(secrets), runner.public_key);

      let id = siteId;
      if (!id) {
        setPhase("Creating the site");
        const res = await createSite({ name: name.trim(), url: origin, platform, runner_id: runner.id, config });
        if (!res.ok) throw new Error(res.error);
        id = res.id;
        setSiteId(id);
      }
      if (envelope && id) {
        setPhase("Saving encrypted credentials");
        const res = await saveSiteSecret(id, runner.id, envelope, hint);
        if (!res.ok) throw new Error(res.error);
        let jobId = (res as { job_id?: string }).job_id;
        if (!jobId) {
          // Contract doesn't promise the job id back: find the test job the action just queued (RLS read).
          const { data } = await createBrowserClient()
            .from("jobs")
            .select("id")
            .eq("site_id", id)
            .eq("kind", "test_connection")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          jobId = (data as { id?: string } | null)?.id;
        }
        if (jobId) setTestJob(jobId);
      }
      setStep(3);
      router.refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't save the site.");
    } finally {
      setSaving(false);
      setPhase(null);
    }
  }

  return (
    <section aria-labelledby="wiz-title" className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <header className="border-b border-line px-5 pt-5 pb-4 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <h2 id="wiz-title" className="text-[18px] font-semibold">
            Add a site
          </h2>
          {step < 3 && (
            <ButtonLink href="/sites" size="sm" variant="ghost">
              Cancel
            </ButtonLink>
          )}
        </div>
        <ol className="mt-4 grid grid-cols-4 gap-2" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined}>
              <div className={cn("h-1 rounded-full", i < step ? "bg-accent" : i === step ? "bg-navy" : "bg-line")} />
              <span className={cn("mt-1.5 block text-[12px]", i === step ? "font-medium text-ink" : "text-muted")}>
                <span className="sr-only">Step {i + 1}: </span>
                {s}
                {i < step && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          ))}
        </ol>
      </header>

      <div className="px-5 py-6 sm:px-6">
        {step === 0 && (
          <div className="flex flex-col gap-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Site name" htmlFor="site-name" error={errors.name}>
                <input id="site-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="Kiran Ceramics" aria-invalid={!!errors.name} />
              </Field>
              <Field label="Address" htmlFor="site-url" error={errors.url} hint={origin && !errors.url ? `Will audit ${origin}` : undefined}>
                <input
                  id="site-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className={inputClass}
                  placeholder="https://www.example.com"
                  inputMode="url"
                  aria-invalid={!!errors.url}
                />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-ink">How is the site built?</legend>
              <div role="radiogroup" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(Object.keys(PLATFORM) as Platform[]).map((p) => {
                  const Icon = PLATFORM_ICON[p];
                  const sel = platform === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={sel}
                      onClick={() => setPlatform(p)}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors",
                        sel ? "border-accent bg-accent-soft/50 ring-2 ring-accent/25" : "border-line hover:border-line-strong",
                      )}
                    >
                      <span className="flex w-full items-center justify-between">
                        <Icon size={20} aria-hidden className={sel ? "text-accent-ink" : "text-ink-2"} />
                        {sel && <Check size={16} aria-hidden className="text-accent-ink" />}
                      </span>
                      <span className="text-[14.5px] font-semibold text-ink">{PLATFORM[p].label}</span>
                      <span className="text-[12.5px] leading-snug text-muted">{PLATFORM[p].help}</span>
                    </button>
                  );
                })}
              </div>
              {errors.platform && <p className="mt-2 text-[12px] font-medium text-bad-ink">{errors.platform}</p>}
            </fieldset>
          </div>
        )}

        {step === 1 && platform && (
          <PlatformFields
            platform={platform}
            creds={creds}
            set={(k, v) => setCreds((c) => ({ ...c, [k]: v }))}
            errors={errors}
            siteUrl={origin}
          />
        )}

        {step === 2 && (
          <>
            <RunnerPicker runners={runners} value={runnerId} onChange={setRunnerId} />
            {saveError && (
              <p role="alert" className="mt-4 rounded-lg bg-bad-soft px-3 py-2 text-[13px] font-medium text-bad-ink">
                {saveError}
              </p>
            )}
          </>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <ShieldCheck size={18} aria-hidden className="text-ok" />
              {name} is saved{platform !== "other" ? " and its credentials are encrypted for the runner." : "."}
            </p>
            {testJob ? (
              <ConnectionTest jobId={testJob} />
            ) : platform !== "other" ? (
              <p className="text-[14px] text-muted">A connection test is queued. Its result appears on the site&apos;s Connection tab.</p>
            ) : null}
            <p className="text-[13.5px] text-muted">
              New sites start in <strong className="text-ink">Suggest</strong> mode: the agent proposes fixes and waits for approval for every one.
              A weekly audit is scheduled.
            </p>
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line bg-raised px-5 py-3 sm:px-6">
        {step > 0 && step < 3 && (
          <Button variant="ghost" icon={<ChevronLeft size={16} aria-hidden />} onClick={() => setStep(step === 2 && platform === "other" ? 0 : step - 1)} disabled={saving}>
            Back
          </Button>
        )}
        <div className="ml-auto flex items-center gap-3">
          {phase && <span className="hidden text-[13px] text-muted sm:inline" aria-live="polite">{phase}…</span>}
          {step < 2 && (
            <Button variant="primary" onClick={next}>
              Continue
            </Button>
          )}
          {step === 2 && (
            <Button variant="primary" onClick={save} loading={saving} disabled={!runners.some((r) => r.id === runnerId && r.public_key)}>
              {platform === "other" ? "Add site" : "Encrypt and save"}
            </Button>
          )}
          {step === 3 && siteId && (
            <>
              <ButtonLink href="/sites" variant="ghost">
                Done
              </ButtonLink>
              <ButtonLink href={`/sites/${siteId}`} variant="primary" onClick={() => toast({ tone: "info", title: "Run the first audit from the Overview tab" })}>
                Open site
              </ButtonLink>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
