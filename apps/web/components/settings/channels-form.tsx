"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hash, Mail, MessageCircle, Save, Send, X, Plus, KeyRound } from "lucide-react";
import type { ChannelsInput, ChannelsView, NotifyKind } from "@/lib/types";
import { saveChannels, sendTestNotification } from "@/app/actions/settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CodeBlock, CopyButton } from "@/components/ui/code-block";
import { Field, Toggle, inputClass, selectClass } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/ui/format";
import { NOTIFY_EVENTS } from "@/lib/ui/labels";

const UNCHANGED = "__unchanged__";

type Slack = NonNullable<ChannelsInput["slack"]>;
type WhatsApp = NonNullable<ChannelsInput["whatsapp"]>;
type Email = NonNullable<ChannelsInput["email"]>;

/**
 * Secret input. A stored secret arrives as "__unchanged__": we show a masked "Saved" state and send
 * "__unchanged__" back unless the user chooses to replace it.
 */
function SecretInput({ id, label, value, onChange, hint, disabled, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: React.ReactNode; disabled?: boolean; placeholder?: string }) {
  const saved = value === UNCHANGED;
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      {saved ? (
        <div className="flex h-10 items-center justify-between gap-2 rounded-lg border border-line bg-sunken px-3">
          <span className="flex items-center gap-2 text-[13.5px] text-ink-2">
            <KeyRound size={14} aria-hidden className="text-ok" />
            Saved and encrypted
          </span>
          {!disabled && (
            <button id={id} type="button" className="text-[13px] font-medium text-accent-ink hover:underline" onClick={() => onChange("")}>
              Replace
            </button>
          )}
        </div>
      ) : (
        <input id={id} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} disabled={disabled} placeholder={placeholder} />
      )}
    </Field>
  );
}

function ListEditor({ id, label, items, onChange, placeholder, validate, hint, disabled }: { id: string; label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string; validate: (v: string) => string | null; hint?: string; disabled?: boolean }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const x = v.trim();
    if (!x) return;
    const e = validate(x) ?? (items.includes(x) ? "Already in the list" : null);
    setErr(e);
    if (e) return;
    onChange([...items, x]);
    setV("");
  };
  return (
    <Field label={label} htmlFor={id} hint={hint} error={err}>
      {items.length > 0 && (
        <ul className="mb-1 flex flex-wrap gap-1.5">
          {items.map((x) => (
            <li key={x} className="inline-flex items-center gap-1 rounded-lg bg-sunken py-0.5 pr-0.5 pl-2.5 text-[13px] text-ink ring-1 ring-line">
              {x}
              {!disabled && (
                <button type="button" onClick={() => onChange(items.filter((i) => i !== x))} className="rounded p-1 text-muted hover:text-bad-ink" aria-label={`Remove ${x}`}>
                  <X size={12} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex gap-2">
          <input
            id={id}
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            className={inputClass}
            placeholder={placeholder}
            aria-invalid={!!err}
          />
          <Button onClick={add} icon={<Plus size={15} aria-hidden />} aria-label={`Add to ${label}`}>
            <span className="hidden sm:inline">Add</span>
          </Button>
        </div>
      )}
    </Field>
  );
}

function SetupSteps({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-line bg-raised">
      <summary className="cursor-pointer list-none px-4 py-3 text-[14px] font-medium text-ink [&::-webkit-details-marker]:hidden">
        <span className="mr-2 inline-block transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
        {title}
      </summary>
      <ol className="list-decimal space-y-2 px-4 pb-4 pl-9 text-[13.5px] leading-relaxed text-ink-2 marker:text-muted">{children}</ol>
    </details>
  );
}

function ChannelCard({
  icon,
  title,
  description,
  enabled,
  onToggle,
  configured,
  onTest,
  testing,
  canEdit,
  children,
  id,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  configured: boolean;
  onTest: () => void;
  testing: boolean;
  canEdit: boolean;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <Card aria-labelledby={`${id}-title`}>
      <header className="flex items-start gap-3 px-5 pt-5 pb-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken text-ink-2 ring-1 ring-line" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="flex flex-wrap items-center gap-2 text-[16px] font-semibold">
            {title}
            {enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">{description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${title} notifications`}
          disabled={!canEdit}
          onClick={() => onToggle(!enabled)}
          className={cn("relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50", enabled ? "bg-accent" : "bg-line-strong")}
        >
          <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", enabled ? "translate-x-5.5" : "translate-x-0.5")} />
        </button>
      </header>
      <CardBody className="space-y-4 border-t border-line pt-4">
        {children}
        {canEdit && (
          <div className="flex items-center gap-3 pt-1">
            <Button size="sm" icon={<Send size={14} aria-hidden />} onClick={onTest} loading={testing} disabled={!configured}>
              Send test message
            </Button>
            {!configured && <span className="text-[12.5px] text-muted">Save the settings first.</span>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ChannelsForm({ initial, appUrl, canEdit }: { initial: ChannelsView; appUrl: string; canEdit: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [testing, setTesting] = useState<string | null>(null);
  const [slack, setSlack] = useState<Slack>(initial.slack!);
  const [wa, setWa] = useState<WhatsApp>(initial.whatsapp!);
  const [email, setEmail] = useState<Email>(initial.email!);
  const [notify, setNotify] = useState<NotifyKind[]>(initial.notify_on ?? []);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const current = JSON.stringify({ ...initial, slack, whatsapp: wa, email, notify_on: notify });
  const dirty = current !== saved;
  const savedObj = useMemo(() => JSON.parse(saved) as ChannelsView, [saved]);

  const slackOk = !!savedObj.slack?.bot_token && !!savedObj.slack?.channel_id;
  const waOk = !!savedObj.whatsapp?.access_token && !!savedObj.whatsapp?.phone_number_id;
  const emailOk = !!savedObj.email?.from && (!!savedObj.email?.api_key || !!savedObj.email?.smtp_host);

  const save = () =>
    start(async () => {
      const res = await saveChannels({ slack, whatsapp: wa, email, notify_on: notify });
      if (!res.ok) return toast({ tone: "error", title: "Couldn't save notification settings", detail: res.error });
      toast({ tone: "success", title: "Notification settings saved" });
      // secrets the user typed are now stored: show them as saved
      const mask = (v: string | undefined) => (v ? UNCHANGED : "");
      const s2 = { ...slack, bot_token: mask(slack.bot_token), signing_secret: mask(slack.signing_secret) };
      const w2 = { ...wa, access_token: mask(wa.access_token), app_secret: mask(wa.app_secret) };
      const e2 = { ...email, api_key: mask(email.api_key), smtp_pass: mask(email.smtp_pass) };
      setSlack(s2);
      setWa(w2);
      setEmail(e2);
      setSaved(JSON.stringify({ ...initial, slack: s2, whatsapp: w2, email: e2, notify_on: notify }));
      router.refresh();
    });

  const test = (c: "slack" | "whatsapp" | "email") =>
    start(async () => {
      setTesting(c);
      const res = await sendTestNotification(c);
      setTesting(null);
      if (!res.ok) toast({ tone: "error", title: "Test message failed", detail: res.error });
      else toast({ tone: "success", title: "Test message sent", detail: typeof res.detail === "string" ? res.detail : undefined });
    });

  const slackUrl = `${appUrl}/api/webhooks/slack`;
  const waUrl = `${appUrl}/api/webhooks/whatsapp`;
  const dis = !canEdit;

  return (
    <div className="space-y-4 pb-24">
      <Card>
        <CardHeader title="What to send" description="Applies to every channel that is on." />
        <CardBody className="divide-y divide-line pt-0">
          {NOTIFY_EVENTS.map((e) => (
            <Toggle
              key={e.id}
              id={`notify-${e.id}`}
              label={e.label}
              description={e.help}
              checked={notify.includes(e.id as NotifyKind)}
              disabled={dis}
              onChange={(v) => setNotify((n) => (v ? [...n, e.id as NotifyKind] : n.filter((x) => x !== e.id)))}
            />
          ))}
        </CardBody>
      </Card>

      <ChannelCard
        id="slack"
        icon={<Hash size={18} />}
        title="Slack"
        description="One message per batch, with Approve and Reject buttons on every change."
        enabled={slack.enabled}
        onToggle={(v) => setSlack({ ...slack, enabled: v })}
        configured={slackOk}
        onTest={() => test("slack")}
        testing={testing === "slack"}
        canEdit={canEdit}
      >
        <SetupSteps title="How to set up the Slack app">
          <li>
            Go to <a className="text-accent-ink underline" href="https://api.slack.com/apps" target="_blank" rel="noreferrer noopener">api.slack.com/apps</a>, create an app from scratch in your workspace.
          </li>
          <li>
            Under <strong>OAuth &amp; Permissions</strong>, add the bot scope <code className="font-mono text-[12.5px]">chat:write</code>, install the app, and copy the Bot User OAuth Token (starts with xoxb-).
          </li>
          <li>
            Under <strong>Interactivity &amp; Shortcuts</strong>, turn it on and paste this Request URL:
            <CodeBlock code={slackUrl} className="mt-1.5" />
          </li>
          <li>From <strong>Basic Information</strong>, copy the Signing Secret.</li>
          <li>Invite the bot to the approvals channel (<code className="font-mono text-[12.5px]">/invite @YourApp</code>) and copy the channel ID from the channel details.</li>
          <li>Add the Slack member IDs of people allowed to approve (profile → ⋯ → Copy member ID).</li>
        </SetupSteps>
        <div className="grid gap-4 sm:grid-cols-2">
          <SecretInput id="slack-bot" label="Bot token" value={slack.bot_token} onChange={(v) => setSlack({ ...slack, bot_token: v })} placeholder="xoxb-…" disabled={dis} />
          <SecretInput id="slack-sign" label="Signing secret" value={slack.signing_secret} onChange={(v) => setSlack({ ...slack, signing_secret: v })} disabled={dis} />
          <Field label="Channel ID" htmlFor="slack-ch">
            <input id="slack-ch" value={slack.channel_id} onChange={(e) => setSlack({ ...slack, channel_id: e.target.value.trim() })} className={inputClass} placeholder="C0123456789" disabled={dis} />
          </Field>
          <Field label="Workspace ID" htmlFor="slack-team" optional hint="Starts with T. Needed only if you run more than one workspace.">
            <input id="slack-team" value={slack.team_id ?? ""} onChange={(e) => setSlack({ ...slack, team_id: e.target.value.trim() })} className={inputClass} placeholder="T0123456789" disabled={dis} />
          </Field>
        </div>
        <ListEditor
          id="slack-appr"
          label="Who may approve from Slack"
          items={slack.approvers}
          onChange={(v) => setSlack({ ...slack, approvers: v })}
          placeholder="U0123456789"
          hint="Slack member IDs. Buttons pressed by anyone else are ignored."
          validate={(x) => (/^[UW][A-Z0-9]{6,}$/.test(x) ? null : "Member IDs start with U or W, e.g. U0123456789")}
          disabled={dis}
        />
      </ChannelCard>

      <ChannelCard
        id="whatsapp"
        icon={<MessageCircle size={18} />}
        title="WhatsApp"
        description="Approve from your phone with reply buttons. Uses the WhatsApp Cloud API."
        enabled={wa.enabled}
        onToggle={(v) => setWa({ ...wa, enabled: v })}
        configured={waOk}
        onTest={() => test("whatsapp")}
        testing={testing === "whatsapp"}
        canEdit={canEdit}
      >
        <SetupSteps title="How to set up WhatsApp Cloud API">
          <li>
            In <a className="text-accent-ink underline" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer noopener">Meta for Developers</a>, create a Business app and add the WhatsApp product.
          </li>
          <li>Copy the Phone number ID, and create a permanent access token for a system user with <code className="font-mono text-[12.5px]">whatsapp_business_messaging</code>.</li>
          <li>From App settings → Basic, copy the App secret.</li>
          <li>
            Under WhatsApp → Configuration, set the Callback URL to the address below, use the verify token you choose here, and subscribe to <strong>messages</strong>.
            <CodeBlock code={waUrl} className="mt-1.5" />
          </li>
          <li>
            Create a Utility message template named <code className="font-mono text-[12.5px]">{wa.template_name || "seo_approval_request"}</code> with Approve and Reject quick-reply buttons. It's used
            when an approver hasn't messaged the number in the last 24 hours.
          </li>
        </SetupSteps>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone number ID" htmlFor="wa-pn">
            <input id="wa-pn" value={wa.phone_number_id} onChange={(e) => setWa({ ...wa, phone_number_id: e.target.value.trim() })} className={inputClass} inputMode="numeric" disabled={dis} />
          </Field>
          <SecretInput id="wa-token" label="Access token" value={wa.access_token} onChange={(v) => setWa({ ...wa, access_token: v })} disabled={dis} />
          <SecretInput id="wa-secret" label="App secret" value={wa.app_secret} onChange={(v) => setWa({ ...wa, app_secret: v })} hint="Used to check that webhook calls really come from Meta." disabled={dis} />
          <Field label="Verify token" htmlFor="wa-verify" hint="Any random string; paste the same value in Meta.">
            <div className="flex gap-2">
              <input id="wa-verify" value={wa.verify_token} onChange={(e) => setWa({ ...wa, verify_token: e.target.value.trim() })} className={inputClass} disabled={dis} />
              {!dis && (
                <Button
                  onClick={() => {
                    const b = new Uint8Array(18);
                    crypto.getRandomValues(b);
                    setWa({ ...wa, verify_token: btoa(String.fromCharCode(...b)).replace(/[^a-zA-Z0-9]/g, "") });
                  }}
                >
                  Generate
                </Button>
              )}
              {wa.verify_token && <CopyButton value={wa.verify_token} />}
            </div>
          </Field>
          <Field label="Template name" htmlFor="wa-tpl">
            <input id="wa-tpl" value={wa.template_name} onChange={(e) => setWa({ ...wa, template_name: e.target.value.trim() })} className={inputClass} disabled={dis} />
          </Field>
          <Field label="Template language" htmlFor="wa-lang">
            <input id="wa-lang" value={wa.template_language ?? "en"} onChange={(e) => setWa({ ...wa, template_language: e.target.value.trim() })} className={inputClass} disabled={dis} placeholder="en" />
          </Field>
        </div>
        <ListEditor
          id="wa-appr"
          label="Who may approve from WhatsApp"
          items={wa.approvers}
          onChange={(v) => setWa({ ...wa, approvers: v })}
          placeholder="+91 98765 43210"
          hint="Phone numbers in international format. Each approver gets the request; only these numbers can decide."
          validate={(x) => (/^\+?[1-9][\d\s-]{7,18}$/.test(x) ? null : "Use international format, e.g. +91 98765 43210")}
          disabled={dis}
        />
      </ChannelCard>

      <ChannelCard
        id="email"
        icon={<Mail size={18} />}
        title="Email"
        description="Approve and Reject links in each email, plus a daily digest at 08:00."
        enabled={email.enabled}
        onToggle={(v) => setEmail({ ...email, enabled: v })}
        configured={emailOk}
        onTest={() => test("email")}
        testing={testing === "email"}
        canEdit={canEdit}
      >
        <SetupSteps title="How to set up email">
          <li>
            Recommended: create a <a className="text-accent-ink underline" href="https://resend.com/api-keys" target="_blank" rel="noreferrer noopener">Resend API key</a> with sending access, and verify your sending domain in Resend.
          </li>
          <li>Or use any SMTP server (Google Workspace, Zoho, SES) with an app password.</li>
          <li>Links in the email open a confirmation page; nothing is approved by just opening the email, so link scanners can&apos;t approve by accident.</li>
        </SetupSteps>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider" htmlFor="em-prov">
            <select id="em-prov" value={email.provider} onChange={(e) => setEmail({ ...email, provider: e.target.value as Email["provider"] })} className={selectClass} disabled={dis}>
              <option value="resend">Resend</option>
              <option value="smtp">SMTP</option>
            </select>
          </Field>
          <Field label="From address" htmlFor="em-from" hint="Must be on a domain you've verified.">
            <input id="em-from" value={email.from} onChange={(e) => setEmail({ ...email, from: e.target.value.trim() })} className={inputClass} placeholder="SEO Autopilot <seo@upcore.ai>" disabled={dis} />
          </Field>
          {email.provider === "resend" ? (
            <SecretInput id="em-key" label="Resend API key" value={email.api_key} onChange={(v) => setEmail({ ...email, api_key: v })} placeholder="re_…" disabled={dis} />
          ) : (
            <>
              <Field label="SMTP host" htmlFor="em-host">
                <input id="em-host" value={email.smtp_host ?? ""} onChange={(e) => setEmail({ ...email, smtp_host: e.target.value.trim() })} className={inputClass} placeholder="smtp.gmail.com" disabled={dis} />
              </Field>
              <Field label="Port" htmlFor="em-port">
                <input id="em-port" type="number" value={email.smtp_port ?? 465} onChange={(e) => setEmail({ ...email, smtp_port: Number(e.target.value) })} className={inputClass + " num w-28"} disabled={dis} />
              </Field>
              <Field label="Username" htmlFor="em-user">
                <input id="em-user" value={email.smtp_user ?? ""} onChange={(e) => setEmail({ ...email, smtp_user: e.target.value.trim() })} className={inputClass} disabled={dis} autoComplete="off" />
              </Field>
              <SecretInput id="em-pass" label="Password" value={email.smtp_pass ?? ""} onChange={(v) => setEmail({ ...email, smtp_pass: v })} disabled={dis} />
            </>
          )}
        </div>
        <ListEditor
          id="em-appr"
          label="Who receives approval emails"
          items={email.approvers}
          onChange={(v) => setEmail({ ...email, approvers: v })}
          placeholder="name@company.com"
          hint="Each link only works for the address it was sent to."
          validate={(x) => (emailRe.test(x) ? null : "Enter a valid email address")}
          disabled={dis}
        />
        <Toggle id="em-digest" checked={email.digest} onChange={(v) => setEmail({ ...email, digest: v })} label="Daily digest" description="A summary of everything waiting, every morning at 08:00." disabled={dis} />
      </ChannelCard>

      {canEdit && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-pop backdrop-blur md:left-64" role="region" aria-label="Unsaved settings">
          <div className="mx-auto flex max-w-4xl items-center gap-2">
            <p className="mr-auto text-[14px]">Unsaved notification settings</p>
            <Button
              variant="ghost"
              onClick={() => {
                const s = JSON.parse(saved) as ChannelsView;
                setSlack(s.slack!);
                setWa(s.whatsapp!);
                setEmail(s.email!);
                setNotify(s.notify_on ?? []);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" icon={<Save size={16} aria-hidden />} loading={pending && !testing} onClick={save}>
              Save settings
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
