"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Save, Info } from "lucide-react";
import { ChangeType, type AutopilotMode, type Platform, type SitePolicy, type Tier } from "@seo-autopilot/core/schema";
import { updateSite } from "@/app/actions/sites";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TierBadge } from "@/components/ui/badge";
import { Field, Toggle, inputClass, selectClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/ui/format";
import { CHANGE_TYPE, MODE, TIER } from "@/lib/ui/labels";

/**
 * Default tier per type as decided by core/risk.ts baseTier. Types listed as "auto" are only
 * auto when the value is missing today; they need approval when replacing an existing value.
 */
const DEFAULT_TIER: Record<ChangeType, { tier: Tier; note?: string }> = {
  title: { tier: "auto", note: "auto only when missing" },
  meta_description: { tier: "auto", note: "auto only when missing" },
  h1: { tier: "approve" },
  canonical: { tier: "approve" },
  robots_meta: { tier: "approve" },
  og_tags: { tier: "auto", note: "auto only when missing" },
  image_alt: { tier: "auto", note: "auto only when missing" },
  jsonld_add: { tier: "auto", note: "site-describing types only" },
  jsonld_fix: { tier: "auto" },
  redirect: { tier: "approve" },
  robots_txt: { tier: "approve", note: "never if it blocks the whole site" },
  llms_txt: { tier: "auto", note: "auto only when missing" },
  slug: { tier: "never" },
  content_edit: { tier: "approve" },
  internal_link: { tier: "approve" },
  hreflang: { tier: "approve" },
  code_change: { tier: "approve" },
};

const MODES: AutopilotMode[] = ["off", "suggest", "auto"];

export function PolicyEditor({ siteId, platform, initial, canEdit }: { siteId: string; platform: Platform; initial: SitePolicy; canEdit: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [p, setP] = useState<SitePolicy>(initial);
  const [newPath, setNewPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(p) !== JSON.stringify(initial), [p, initial]);
  const set = <K extends keyof SitePolicy>(k: K, v: SitePolicy[K]) => setP((x) => ({ ...x, [k]: v }));

  const types = ChangeType.options.filter((t) => platform === "repo" || t !== "code_change");

  function setOverride(t: ChangeType, v: string) {
    const o = { ...p.overrides };
    if (v === "") delete o[t];
    else o[t] = v as Tier;
    set("overrides", o);
  }

  const num = (k: "traffic_clicks_threshold" | "traffic_impressions_threshold" | "max_auto_per_day" | "max_batch_size" | "approval_ttl_hours" | "rollback_on_click_drop_pct", min: number, max?: number) => ({
    id: `pol-${k}`,
    type: "number" as const,
    inputMode: "numeric" as const,
    min,
    max,
    value: Number.isFinite(p[k]) ? p[k] : "",
    disabled: !canEdit,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = e.target.value === "" ? NaN : Number(e.target.value);
      set(k, (Number.isFinite(n) ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : min) as SitePolicy[typeof k]);
    },
    className: cn(inputClass, "num w-32"),
  });

  return (
    <div className="space-y-4 pb-24">
      <Card>
        <CardHeader title="Autopilot mode" description="How much the agent may do on its own on this site." />
        <CardBody>
          <div role="radiogroup" aria-label="Autopilot mode" className="grid gap-2 md:grid-cols-3">
            {MODES.map((m) => {
              const sel = p.mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={sel}
                  disabled={!canEdit}
                  onClick={() => set("mode", m)}
                  className={cn(
                    "rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed",
                    sel ? "border-accent bg-accent-soft/50 ring-2 ring-accent/25" : "border-line hover:border-line-strong",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className={cn("grid size-4 place-items-center rounded-full border-2", sel ? "border-accent" : "border-line-strong")} aria-hidden>
                      {sel && <span className="size-2 rounded-full bg-accent" />}
                    </span>
                    <span className="text-[15px] font-semibold">{MODE[m].label}</span>
                    <span className="text-[13px] text-muted">{MODE[m].summary}</span>
                  </span>
                  <span className="mt-2 block text-[13px] leading-relaxed text-ink-2">{MODE[m].detail}</span>
                </button>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Rules per change type"
          description="The risk check sets a tier for every proposal. You can make a type stricter, or relax it one step. Types that are never automated can at most be raised to needs-approval."
        />
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-[14px]">
            <thead className="text-left text-[12px] text-muted">
              <tr className="border-b border-line">
                <th scope="col" className="px-5 py-2 font-medium">Change type</th>
                <th scope="col" className="px-3 py-2 font-medium">Default</th>
                <th scope="col" className="px-5 py-2 font-medium">This site</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => {
                const d = DEFAULT_TIER[t];
                const ov = p.overrides?.[t] ?? "";
                const allowAuto = d.tier !== "never";
                return (
                  <tr key={t} className="border-b border-line last:border-0">
                    <th scope="row" className="px-5 py-2.5 text-left font-normal">
                      <span className="block font-medium text-ink">{CHANGE_TYPE[t].label}</span>
                      <span className="block text-[12.5px] text-muted">{CHANGE_TYPE[t].help}</span>
                    </th>
                    <td className="px-3 py-2.5 align-middle">
                      <TierBadge tier={d.tier} />
                      {d.note && <span className="mt-1 block text-[11.5px] text-muted">{d.note}</span>}
                    </td>
                    <td className="px-5 py-2.5 align-middle">
                      <select
                        aria-label={`Rule for ${CHANGE_TYPE[t].label}`}
                        value={ov}
                        disabled={!canEdit}
                        onChange={(e) => setOverride(t, e.target.value)}
                        className={cn(selectClass, "h-9 w-48", ov && "border-accent")}
                      >
                        <option value="">Use default</option>
                        {allowAuto && <option value="auto">{TIER.auto.label}</option>}
                        <option value="approve">{TIER.approve.label}</option>
                        <option value="never">{TIER.never.label}</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="flex gap-2 px-5 py-3 text-[12.5px] text-muted">
          <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
          Even with a type set to auto, pages with real traffic, the homepage and protected paths still need approval, and Suggest mode overrides everything.
        </p>
      </Card>

      <Card>
        <CardHeader title="Limits" description="Guard rails on what counts as an important page and how much happens at once." />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field label="Important page: clicks in 28 days" htmlFor="pol-traffic_clicks_threshold" hint="At or above this, auto changes need approval.">
            <input {...num("traffic_clicks_threshold", 0)} />
          </Field>
          <Field label="Important page: impressions in 28 days" htmlFor="pol-traffic_impressions_threshold" hint="Either threshold makes a page important.">
            <input {...num("traffic_impressions_threshold", 0)} />
          </Field>
          <Field label="Auto changes per day" htmlFor="pol-max_auto_per_day" hint="Extra changes wait for approval.">
            <input {...num("max_auto_per_day", 0)} />
          </Field>
          <Field label="Largest batch that can auto-apply" htmlFor="pol-max_batch_size" hint="Bigger batches need approval for every change.">
            <input {...num("max_batch_size", 1)} />
          </Field>
          <Field label="Approvals expire after (hours)" htmlFor="pol-approval_ttl_hours" hint="Expired changes are never applied.">
            <input {...num("approval_ttl_hours", 1)} />
          </Field>
          <Field label="Traffic drop alert (%)" htmlFor="pol-rollback_on_click_drop_pct" hint="Alert when a changed page loses this share of clicks. Needs Search Console.">
            <input {...num("rollback_on_click_drop_pct", 0, 100)} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Protected paths" description="The agent never changes pages under these paths. Prefix match: /checkout protects /checkout/anything." />
        <CardBody>
          {p.protected_paths.length > 0 && (
            <ul className="mb-3 flex flex-wrap gap-2">
              {p.protected_paths.map((path) => (
                <li key={path} className="inline-flex items-center gap-1 rounded-lg bg-sunken py-1 pr-1 pl-2.5 font-mono text-[13px] ring-1 ring-line">
                  {path}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => set("protected_paths", p.protected_paths.filter((x) => x !== path))}
                      className="rounded p-1 text-muted hover:bg-bad-soft hover:text-bad-ink"
                      aria-label={`Remove ${path}`}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newPath.trim();
                if (!v.startsWith("/")) return setPathError("Paths start with /");
                if (p.protected_paths.includes(v)) return setPathError("Already protected");
                setPathError(null);
                set("protected_paths", [...p.protected_paths, v]);
                setNewPath("");
              }}
            >
              <label htmlFor="pol-path" className="sr-only">
                Path to protect
              </label>
              <input
                id="pol-path"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="/checkout"
                className={cn(inputClass, "max-w-xs font-mono")}
                aria-invalid={!!pathError}
                aria-describedby={pathError ? "pol-path-err" : undefined}
              />
              <Button type="submit" icon={<Plus size={15} aria-hidden />}>
                Add
              </Button>
            </form>
          )}
          {pathError && (
            <p id="pol-path-err" className="mt-1.5 text-[12px] font-medium text-bad-ink">
              {pathError}
            </p>
          )}
          {p.protected_paths.length === 0 && !canEdit && <p className="text-[14px] text-muted">None.</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Behaviour" />
        <CardBody className="divide-y divide-line pt-0">
          <Toggle id="pol-auto_propose" checked={p.auto_propose} disabled={!canEdit} onChange={(v) => set("auto_propose", v)} label="Propose fixes after every audit" description="Otherwise use “Propose fixes” on the Overview tab." />
          <Toggle id="pol-auto_rollback" checked={p.auto_rollback} disabled={!canEdit} onChange={(v) => set("auto_rollback", v)} label="Undo automatically when the live check fails" description="Restores the previous value if the change doesn't appear correctly on the page." />
          {platform === "repo" && (
            <Toggle id="pol-repo_auto_merge" checked={p.repo_auto_merge} disabled={!canEdit} onChange={(v) => set("repo_auto_merge", v)} label="Merge pull requests automatically" description="Only after the build and preview checks pass. Off means a person merges each PR." />
          )}
        </CardBody>
      </Card>

      {canEdit && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-pop backdrop-blur md:left-64" role="region" aria-label="Unsaved policy changes">
          <div className="mx-auto flex max-w-4xl items-center gap-2">
            <p className="mr-auto text-[14px] text-ink">You have unsaved changes</p>
            <Button variant="ghost" onClick={() => setP(initial)} disabled={pending}>
              Discard
            </Button>
            <Button
              variant="primary"
              loading={pending}
              icon={<Save size={16} aria-hidden />}
              onClick={() =>
                start(async () => {
                  const res = await updateSite(siteId, { policy: p });
                  if (!res.ok) toast({ tone: "error", title: "Couldn't save the policy", detail: res.error });
                  else {
                    toast({ tone: "success", title: "Policy saved", detail: "New proposals follow these rules. Changes already waiting keep their tier." });
                    router.refresh();
                  }
                })
              }
            >
              Save policy
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
