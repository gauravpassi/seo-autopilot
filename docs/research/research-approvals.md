# Human approval requests for an autonomous SEO agent: Slack, WhatsApp, Email

Stack: Next.js App Router route handlers (Node runtime) on Vercel, data in Supabase. Researched 2026-10-06.
Note: live fetches of the Slack and Meta doc pages were blocked in this session, so several limits below come from prior knowledge plus search-result snippets. Check the items marked (verify) against the linked docs before go-live.

---

## 0. Shared core (use for every channel)

### 0.1 Supabase schema

```sql
create table approval_requests (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null,
  title         text not null,              -- "Rewrite <title> on /pricing"
  summary       text not null,              -- human diff / rationale
  diff          jsonb not null,             -- machine-applicable change
  risk          text not null default 'medium',
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','expired','applied','failed')),
  decided_by    text,                       -- 'slack:U123' | 'wa:9198xxxx' | 'email:a@b.com'
  decided_via   text,                       -- slack | whatsapp | email | dashboard
  decided_at    timestamptz,
  expires_at    timestamptz not null default now() + interval '72 hours',
  channel_refs  jsonb not null default '{}', -- {slack:{channel,ts}, wa:{message_id}, email:{id}}
  created_at    timestamptz not null default now()
);

create table approval_tokens (               -- email links (single-use)
  jti         uuid primary key,
  request_id  uuid references approval_requests(id) on delete cascade,
  action      text not null check (action in ('approve','reject')),
  recipient   text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table approval_events (               -- append-only audit log
  id          bigserial primary key,
  request_id  uuid references approval_requests(id),
  event       text not null,                 -- sent | clicked | approved | rejected | denied | replay | expired | applied
  actor       text,
  channel     text,
  ip          inet,
  user_agent  text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);
alter table approval_requests enable row level security;   -- service role only
alter table approval_tokens   enable row level security;
alter table approval_events   enable row level security;
```

### 0.2 Atomic, idempotent decision (one function for all channels)

```ts
// lib/approvals.ts
import { createClient } from '@supabase/supabase-js';
export const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

export type Decision = 'approved' | 'rejected';

/** Only first decision wins. A row comes back only if it was still pending and unexpired. */
export async function decide(id: string, decision: Decision, actor: string, via: string, meta: object = {}) {
  const { data, error } = await sb
    .from('approval_requests')
    .update({ status: decision, decided_by: actor, decided_via: via, decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select()
    .maybeSingle();
  if (error) throw error;
  await audit(id, data ? decision : 'replay', actor, via, meta);
  if (!data) {
    const { data: cur } = await sb.from('approval_requests').select('status,decided_by').eq('id', id).single();
    return { ok: false as const, current: cur };
  }
  // Apply the change in a queue or job, not inline (see 4.6)
  return { ok: true as const, request: data };
}

export async function audit(request_id: string | null, event: string, actor?: string, channel?: string, meta?: object) {
  await sb.from('approval_events').insert({ request_id, event, actor, channel, meta });
}
```

### 0.3 Raw body plus constant-time compare helpers

```ts
// lib/crypto.ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export const hmacHex = (alg: 'sha256' | 'sha1', key: string, msg: string) =>
  createHmac(alg, key).update(msg, 'utf8').digest('hex');
export function safeEqual(a: string, b: string) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}
```
Every webhook route: `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';` and read the body once with `await req.text()`. Verify on that exact string before parsing, because re-serialised JSON breaks the signature.
Slow work after the HTTP ack: `import { after } from 'next/server'` (stable since Next 15.1) runs a callback after the response is sent, within the function's maxDuration.

---

## 1. Slack

### 1.1 Setup
1. api.slack.com/apps → Create New App → **From a manifest** → paste YAML below → install to workspace.
2. Copy **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`; **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`.
3. Invite the bot to the approvals channel (`/invite @SEO Agent`), or DM users (needs `im:write` plus `conversations.open`).
4. Record approver Slack user IDs (`U…`) in `SLACK_APPROVER_IDS`.

### 1.2 Minimal manifest
```yaml
display_information:
  name: SEO Agent
  description: Approve or reject proposed website changes
features:
  bot_user:
    display_name: SEO Agent
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write          # post + chat.update its own messages
      - im:write            # optional: DM approvers via conversations.open
      - users:read          # optional: show approver names
settings:
  interactivity:
    is_enabled: true
    request_url: https://YOUR-APP.vercel.app/api/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

### 1.3 Send: `chat.postMessage` with Block Kit buttons
`POST https://slack.com/api/chat.postMessage` · `Authorization: Bearer xoxb-…` · `Content-Type: application/json; charset=utf-8`

```ts
// lib/slack.ts
export async function slackApi(method: string, body: object) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
  return j;
}

export async function postApproval(req: { id: string; title: string; summary: string; url: string }) {
  const res = await slackApi('chat.postMessage', {
    channel: process.env.SLACK_APPROVAL_CHANNEL,           // C… or a DM channel id
    text: `Approval needed: ${req.title}`,                  // notification / fallback text
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Proposed website change' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${req.title}*\n${req.summary}\n<${req.url}|View full diff>` } },
      {
        type: 'actions',
        block_id: 'approval',
        elements: [
          { type: 'button', action_id: 'approve', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: req.id },
          {
            type: 'button', action_id: 'reject', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: req.id,
            confirm: { title: { type: 'plain_text', text: 'Reject change?' }, text: { type: 'plain_text', text: 'The agent will discard it.' },
                       confirm: { type: 'plain_text', text: 'Reject' }, deny: { type: 'plain_text', text: 'Cancel' } },
          },
        ],
      },
    ],
  });
  // store res.channel + res.ts in approval_requests.channel_refs.slack → needed for chat.update
  return { channel: res.channel as string, ts: res.ts as string };
}
```
Limits (verify): button `value` up to 2000 chars, `action_id` up to 255, button text up to 75. Put only the request UUID in `value` and keep state in Supabase.

### 1.4 Verify (signing secret, v0)
Headers: `X-Slack-Request-Timestamp`, `X-Slack-Signature` (`v0=<hex>`).
Algorithm: `basestring = "v0:" + timestamp + ":" + rawBody` → HMAC-SHA256 with signing secret → hex → compare to header after `v0=`. Reject if |now − timestamp| > 300 s (replay).

```ts
export function verifySlack(raw: string, h: Headers) {
  const ts = h.get('x-slack-request-timestamp') ?? '';
  const sig = h.get('x-slack-signature') ?? '';
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = 'v0=' + hmacHex('sha256', process.env.SLACK_SIGNING_SECRET!, `v0:${ts}:${raw}`);
  return safeEqual(expected, sig);
}
```

### 1.5 Interactivity route: ack in under 3 s, then update
The payload arrives as `application/x-www-form-urlencoded` with one field `payload` holding JSON (`type: "block_actions"`).

```ts
// app/api/slack/interactions/route.ts
import { after } from 'next/server';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlack(raw, req.headers)) return new Response('bad signature', { status: 401 });

  const p = JSON.parse(new URLSearchParams(raw).get('payload')!);
  if (p.type !== 'block_actions') return new Response('', { status: 200 });
  const action = p.actions[0];                        // { action_id, value, ... }
  const userId: string = p.user.id;

  after(async () => {
    const allowed = (process.env.SLACK_APPROVER_IDS ?? '').split(',').includes(userId);
    if (!allowed) {
      await audit(action.value, 'denied', `slack:${userId}`, 'slack');
      await fetch(p.response_url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: 'You are not an approver.' }) });
      return;
    }
    const decision = action.action_id === 'approve' ? 'approved' : 'rejected';
    const r = await decide(action.value, decision, `slack:${userId}`, 'slack', { team: p.team?.id });
    const text = r.ok
      ? `${decision === 'approved' ? 'Approved' : 'Rejected'} by <@${userId}>`
      : `Already ${r.current?.status} by ${r.current?.decided_by}`;
    // Option A: response_url (valid 30 min, up to 5 uses; no token needed)
    await fetch(p.response_url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace_original: true, text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${p.message.blocks[1].text.text}\n\n*${text}*` } }] }) });
    // Option B (any time later, e.g. when apply finishes): chat.update
    // await slackApi('chat.update', { channel: p.channel.id, ts: p.message.ts, text, blocks: [...] });
  });
  return new Response('', { status: 200 });          // ack immediately
}
```
- Removing the `actions` block in the update stops repeat clicks. `decide()` still guards against double clicks that arrive together.
- Slack retries un-acked requests. Idempotency comes from the `status='pending'` guard.

---

## 2. WhatsApp Business Cloud API (Meta)

Current Graph version: **v26.0** (released 2026-07-29). Pin it in an env var (`WA_GRAPH_VERSION=v26.0`). Each version lives about 2 years.
Base: `https://graph.facebook.com/v26.0`

### 2.1 Setup
1. developers.facebook.com → Create App → use case/type **Business** → add **WhatsApp** product. Link or create a Meta Business portfolio and WhatsApp Business Account (WABA).
2. WhatsApp → API Setup: note **Phone number ID** (`WA_PHONE_NUMBER_ID`) and **WABA ID**. Use the test number first, then add a real number (display name review, 2FA PIN, register).
3. **Permanent token:** Business Settings → Users → **System users** → Add (Admin) → Assign assets (the app with full control, the WABA) → **Generate token** → expiration **Never** → permissions `whatsapp_business_messaging`, `whatsapp_business_management` → `WA_TOKEN`.
4. App → Settings → Basic → **App Secret** → `WA_APP_SECRET`.
5. WhatsApp → Configuration → Webhook: Callback URL `https://YOUR-APP.vercel.app/api/whatsapp/webhook`, Verify token = your random `WA_VERIFY_TOKEN` → Verify and save → subscribe field **messages**.
6. Make sure the app is subscribed to the WABA: `POST /v26.0/{WABA_ID}/subscribed_apps` (Bearer token). The dashboard normally does this.
7. Add a payment method for business-initiated templates, and submit the template in 2.3.
8. Store approver numbers in E.164 digits (`WA_APPROVER_NUMBERS=9198xxxxxxxx,…`). The webhook `from` field (wa_id) has no `+`.

### 2.2 The 24-hour customer service window
- Free-form messages, including **interactive reply buttons**, can go out only within 24 h of the user's last inbound message to you.
- Outside the window you must send an **approved template**. Use a UTILITY template with QUICK_REPLY buttons for approvals. When the approver taps a button, that inbound message reopens the window.
- Pricing has been per message since 2025-07-01. Utility templates sent inside an open service window are free (verify current rate card).
- Pattern: try an interactive message if `last_inbound_at > now-24h`, otherwise send the template.

### 2.3 Interactive reply-button message (inside window)
Limits: **max 3 buttons**; button `title` ≤ 20 chars; button `id` ≤ 256 chars (unique within the message); body ≤ 1024; header text ≤ 60; footer ≤ 60.

```ts
// lib/whatsapp.ts
const WA = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION ?? 'v26.0'}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
async function waSend(body: object) {
  const r = await fetch(WA, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`WA ${r.status}: ${JSON.stringify(j.error)}`); // 131047 = outside 24h window
  return j.messages[0].id as string;                                          // wamid.… → channel_refs.wa
}

export const sendWaInteractive = (to: string, req: { id: string; title: string; summary: string }, tok: { a: string; r: string }) =>
  waSend({
    to, type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Approval needed' },
      body: { text: `${req.title}\n\n${req.summary}`.slice(0, 1024) },
      footer: { text: 'SEO Agent' },
      action: { buttons: [
        { type: 'reply', reply: { id: tok.a, title: 'Approve' } },   // id = signed action token (4.1), ≤256 chars
        { type: 'reply', reply: { id: tok.r, title: 'Reject' } },
        { type: 'reply', reply: { id: `view:${req.id}`, title: 'View details' } },
      ] },
    },
  });
```

### 2.4 Template with quick-reply buttons (outside window)
Create once (or in WhatsApp Manager UI): `POST /v26.0/{WABA_ID}/message_templates`
```json
{
  "name": "seo_change_approval",
  "language": "en",
  "category": "UTILITY",
  "components": [
    { "type": "BODY", "text": "SEO Agent proposes a change on {{1}}: {{2}}. Approve it?",
      "example": { "body_text": [["example.com/pricing", "New meta title"]] } },
    { "type": "FOOTER", "text": "Reply within 72 hours" },
    { "type": "BUTTONS", "buttons": [
      { "type": "QUICK_REPLY", "text": "Approve" },
      { "type": "QUICK_REPLY", "text": "Reject" } ] }
  ]
}
```
Send, attaching a per-button payload (index matches the button order):
```ts
export const sendWaTemplate = (to: string, page: string, change: string, tok: { a: string; r: string }) =>
  waSend({
    to, type: 'template',
    template: {
      name: 'seo_change_approval', language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: page }, { type: 'text', text: change }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: tok.a }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: tok.r }] },
      ],
    },
  });
```
Template variables cannot contain newlines or tabs, or more than 4 consecutive spaces, so keep `{{2}}` short and link to a details page. UTILITY templates must be transactional; promotional wording gets the template re-categorised as MARKETING.

### 2.5 Webhook route (GET verify plus POST signed events)
```ts
// app/api/whatsapp/webhook/route.ts
import { after } from 'next/server';
export const runtime = 'nodejs';

export async function GET(req: Request) {                       // subscription handshake
  const q = new URL(req.url).searchParams;
  if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === process.env.WA_VERIFY_TOKEN)
    return new Response(q.get('hub.challenge') ?? '', { status: 200 });
  return new Response('forbidden', { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get('x-hub-signature-256') ?? '';      // "sha256=<hex>"
  const expected = 'sha256=' + hmacHex('sha256', process.env.WA_APP_SECRET!, raw);
  if (!safeEqual(expected, sig)) return new Response('bad signature', { status: 401 });

  const body = JSON.parse(raw);
  after(async () => {
    for (const entry of body.entry ?? [])
      for (const change of entry.changes ?? []) {
        const v = change.value;
        for (const m of v.messages ?? []) {
          // Reply button on an interactive message:
          //   m.type === 'interactive', m.interactive.type === 'button_reply', m.interactive.button_reply = { id, title }
          // Quick reply on a template:
          //   m.type === 'button', m.button = { payload, text }
          const token =
            m.type === 'interactive' && m.interactive?.type === 'button_reply' ? m.interactive.button_reply.id :
            m.type === 'button' ? m.button.payload : null;
          if (!token) continue;                                     // free text: ignore or treat as a comment
          await handleWaDecision(m.from, token, m.id, m.context?.id); // context.id = wamid of the message tapped
        }
        // v.statuses[] = sent/delivered/read/failed for your outbound messages; log them
      }
  });
  return new Response('OK', { status: 200 });                     // answer 200 fast or Meta retries for days
}

async function handleWaDecision(from: string, token: string, wamid: string, ctx?: string) {
  if (!(process.env.WA_APPROVER_NUMBERS ?? '').split(',').includes(from))
    return audit(null, 'denied', `wa:${from}`, 'whatsapp', { wamid });
  const t = verifyActionToken(token);                                // 4.1: checks signature, expiry, action
  if (!t || t.sub !== `wa:${from}`) return audit(null, 'denied', `wa:${from}`, 'whatsapp', { reason: 'bad token' });
  const r = await decide(t.rid, t.act === 'approve' ? 'approved' : 'rejected', `wa:${from}`, 'whatsapp', { wamid, ctx });
  await waSend({ to: from, type: 'text', context: { message_id: wamid },
    text: { body: r.ok ? `Recorded: ${t.act === 'approve' ? 'approved' : 'rejected'}.` : `Already ${r.current?.status}.` } }); // inside window now
}
```
Meta retries failed deliveries with backoff and can send duplicates. Dedupe on `m.id` (unique index on `approval_events.meta->>'wamid'`, or a `processed_webhooks` table) as well as the status guard.

### 2.6 Twilio WhatsApp (alternative)
- Easier onboarding (Twilio handles the WABA through Senders and has a sandbox). Higher per-message cost on top of Meta fees.
- Create the buttons with the **Content API** (`twilio/quick-reply` content type, up to 3 buttons; to use outside 24 h, submit it for WhatsApp approval). Send with `client.messages.create({ from: 'whatsapp:+1…', to: 'whatsapp:+91…', contentSid: 'HX…', contentVariables: JSON.stringify({ 1: page }) })`.
- The inbound webhook (form-encoded) has `From`, `ButtonPayload`, `ButtonText`, `OriginalRepliedMessageSid`.
- Verify with `twilio.validateRequest(authToken, req.headers['x-twilio-signature'], fullUrl, params)` (HMAC-SHA1 of the URL plus sorted POST params). The URL must match exactly what Twilio called, including https and the Vercel domain.

---

## 3. Email (Resend or Gmail SMTP)

### 3.1 Why GET must not act
Link scanners (Microsoft Defender Safe Links, Mimecast, Proofpoint, Gmail image/link proxies, Outlook previews) **prefetch every URL** in an email, sometimes with a headless browser. If GET approves, the scanner approves.
Rule: **GET renders a confirmation page. Only POST (a button the human clicks) changes state.** Do not auto-submit the form with JS, because headless scanners execute JS. Optionally add a Supabase Auth or magic-link session check for high-risk changes.

### 3.2 Signed, single-use, expiring action token
Use a compact HMAC token (below) or a JWT (`jose`: `new SignJWT({rid, act}).setProtectedHeader({alg:'HS256'}).setJti(uuid).setSubject(email).setExpirationTime('72h').sign(key)`).

```ts
// lib/action-token.ts
import { randomUUID, createHmac } from 'node:crypto';
import { safeEqual } from './crypto';
type Claims = { rid: string; act: 'approve' | 'reject'; sub: string; exp: number; jti: string };
const KEY = process.env.ACTION_TOKEN_SECRET!;               // 32+ random bytes; rotate with a kid if needed
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signActionToken(c: Omit<Claims, 'jti' | 'exp'>, ttlSec = 72 * 3600): { token: string; claims: Claims } {
  const claims: Claims = { ...c, jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64u(JSON.stringify(claims));
  const s = createHmac('sha256', KEY).update(p).digest('base64url');
  return { token: `${p}.${s}`, claims };
}
export function verifyActionToken(token: string): Claims | null {
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const expected = createHmac('sha256', KEY).update(p).digest('base64url');
  if (!safeEqual(expected, s)) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims;
  return c.exp > Date.now() / 1000 ? c : null;
}
```
WhatsApp button ids (≤256 chars): keep claims short, e.g. `{rid, act, sub, exp, jti}`, which comes to about 200 chars. Or use an opaque random id that maps to a DB row.

Insert `approval_tokens(jti, request_id, action, recipient, expires_at)` when sending. On POST, mark it used atomically:
```ts
const { data: tok } = await sb.from('approval_tokens').update({ used_at: new Date().toISOString() })
  .eq('jti', c.jti).is('used_at', null).gt('expires_at', new Date().toISOString()).select().maybeSingle();
if (!tok) /* replayed or expired */ ...
```

### 3.3 Landing page (GET = confirm, POST = act)
```tsx
// app/approve/[token]/page.tsx   (GET: read-only)
import { verifyActionToken } from '@/lib/action-token';
import { sb } from '@/lib/approvals';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const c = verifyActionToken(token);
  if (!c) return <p>This link is invalid or expired.</p>;
  const { data: r } = await sb.from('approval_requests').select('title,summary,status').eq('id', c.rid).single();
  if (r?.status !== 'pending') return <p>Already {r?.status}.</p>;
  return (
    <main>
      <h1>{c.act === 'approve' ? 'Approve' : 'Reject'} change?</h1>
      <h2>{r.title}</h2><pre>{r.summary}</pre>
      <form method="post" action="/api/approvals/decide">
        <input type="hidden" name="token" value={token} />
        <button type="submit">Confirm {c.act}</button>
      </form>
    </main>
  );
}
```
```ts
// app/api/approvals/decide/route.ts   (POST: performs action)
export async function POST(req: Request) {
  const form = await req.formData();
  const c = verifyActionToken(String(form.get('token') ?? ''));
  if (!c) return new Response('Invalid or expired', { status: 400 });
  if (!(process.env.EMAIL_APPROVERS ?? '').split(',').includes(c.sub)) return new Response('Forbidden', { status: 403 });
  const { data: tok } = await sb.from('approval_tokens').update({ used_at: new Date().toISOString() })
    .eq('jti', c.jti).is('used_at', null).select().maybeSingle();
  if (!tok) return new Response('Link already used', { status: 409 });
  const r = await decide(c.rid, c.act === 'approve' ? 'approved' : 'rejected', `email:${c.sub}`, 'email', {
    ip: req.headers.get('x-forwarded-for'), ua: req.headers.get('user-agent') });
  return Response.redirect(new URL(`/approvals/${c.rid}?result=${r.ok ? c.act : 'already'}`, req.url), 303);
}
```
Also: send `Referrer-Policy: no-referrer` on the landing page so the token does not leak. Keep tokens out of logs, and an Origin/Sec-Fetch-Site check on POST is cheap CSRF hardening.

### 3.4 Send via Resend
Setup: resend.com → verify sending domain (SPF, DKIM records, plus DMARC) → API key → `RESEND_API_KEY`.
`POST https://api.resend.com/emails` · `Authorization: Bearer re_…` · optional `Idempotency-Key` header (deduplicates retries).
```ts
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);
const base = process.env.APP_URL; // https://your-app.vercel.app
const { data, error } = await resend.emails.send(
  {
    from: 'SEO Agent <agent@mail.yourdomain.com>',
    to: [approverEmail],
    subject: `Approval needed: ${req.title}`,
    html: `<p>${req.summary}</p>
           <p><a href="${base}/approve/${approveTok}">Approve</a> &nbsp; <a href="${base}/approve/${rejectTok}">Reject</a></p>
           <p style="color:#888">Links open a confirmation page and expire in 72h.</p>`,
    text: `${req.summary}\nApprove: ${base}/approve/${approveTok}\nReject: ${base}/approve/${rejectTok}`,
    tags: [{ name: 'request_id', value: req.id }],
  },
  { idempotencyKey: `approval-${req.id}-${approverEmail}` },
);
```
Raw HTTP body is the same JSON (`from`, `to`, `subject`, `html`, `text`, `tags`, `headers`, `scheduled_at`). Resend webhooks (`email.delivered`, `email.bounced`) are signed via Svix (`svix-id`, `svix-timestamp`, `svix-signature`), so verify them with `resend.webhooks.verify` or the `svix` package.

### 3.5 Gmail SMTP alternative
Requires 2-Step Verification on the Google account → myaccount.google.com/apppasswords → 16-char App Password. Workspace admins can disable this. Personal Gmail is limited to about 500 recipients/day, and Workspace to about 2,000.
```ts
import nodemailer from 'nodemailer';
const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
await tx.sendMail({ from: `SEO Agent <${process.env.GMAIL_USER}>`, to, subject, html, text });
```
Outbound SMTP on 465/587 works from Vercel Node functions. Use Resend or another ESP for deliverability, bounce webhooks and domain alignment.

### 3.6 Digest pattern
- Low or medium risk items go into a queue. A Vercel Cron job (`vercel.json` `"crons":[{"path":"/api/cron/digest","schedule":"30 3 * * *"}]`) sends one email per approver listing N pending changes. Each item gets Approve/Reject links, plus an "Approve all low-risk (N)" link whose token claims `{batch:[ids…]}` or a `batch_id` row.
- Protect the cron route: Vercel sends `Authorization: Bearer ${CRON_SECRET}`, so check it.
- A batch POST still runs `decide()` per id (each one idempotent) and shows the per-item results.
- Send high-risk items immediately (Slack or WhatsApp), never in the digest.
- Auto-expire: a cron job sets `status='expired'` where `expires_at < now()` and edits the Slack/WA message, or sends a follow-up.

---

## 4. Security checklist (all channels)

1. **Verify every inbound request** against the raw body: Slack v0 HMAC with a 5-min timestamp window, Meta `X-Hub-Signature-256` with the app secret, Twilio `X-Twilio-Signature`, Resend/Svix. Compare in constant time. Return 401 before parsing.
2. **Signed action tokens**: the token binds `request_id + action + recipient + exp + jti`. Never put a bare UUID in a link, or a bare "approve" in a button id that can be forged. For Slack, the request signature already authenticates, so `value` can be the UUID. For WhatsApp, Meta's signature authenticates the webhook. Still use a signed token as the button id or payload, so a reply is bound to one request, one action and one recipient, and expires.
3. **Allow-list approvers per channel**: Slack `user.id` (plus `team.id`), WhatsApp `from` wa_id, email `sub`. On mismatch, record `denied` in the audit log and tell the user. Optionally keep per-site approvers in a table instead of env vars.
4. **Idempotency and single decision**: conditional update `WHERE status='pending' AND expires_at > now()`, single-use `jti`, and dedupe webhook delivery ids (Slack retries with `X-Slack-Retry-Num`, Meta `messages[].id`, Resend `svix-id`). The first decision across any channel wins. Other channels' messages get updated to "Decided by X via Y".
5. **Expiry**: 24–72 h tokens. Expired items go to `expired` and are never applied silently.
6. **Audit log**: append-only `approval_events` (sent, viewed, clicked, approved, rejected, denied, replay, applied, failed), recording actor, channel, IP/UA and message ids. Keep the exact `diff` that was approved, and apply *that* snapshot (hash it, then re-check the hash at apply time) so the change cannot be swapped after approval.
7. **Least privilege and secrets**: Vercel env vars (sensitive), Supabase service-role key server-only, RLS on, a Slack bot with `chat:write` only, and a WA system user scoped to one WABA. Rotate `ACTION_TOKEN_SECRET` with a `kid`.
8. **Ack fast, apply async**: respond 200 within Slack's 3 s and Meta's timeout, and do the work in `after()` or a queue (Supabase queue/pgmq, Vercel Queues, Inngest). Applying the website change (deploy, CMS write) is a separate job with retry, triggered by `status='approved'`. Report its result back to the thread or chat.
9. **Risk tiers**: high-risk changes (robots.txt, canonical/noindex, redirects, deletions) need approval in a channel that proves identity (Slack, or email plus login), not just an email link. Consider 2 approvers.
10. **Privacy**: show summaries in messages and full diffs behind an authenticated page. WhatsApp/Slack message bodies leave your infrastructure.

---

## Sources
- Slack request verification: https://docs.slack.dev/authentication/verifying-requests-from-slack (legacy: https://api.slack.com/docs/verifying-requests-from-slack)
- Slack interactivity / handling user interaction: https://docs.slack.dev/interactivity/handling-user-interaction
- Slack chat.postMessage / chat.update: https://docs.slack.dev/reference/methods/chat.postMessage , https://docs.slack.dev/reference/methods/chat.update
- Slack app manifests: https://docs.slack.dev/reference/app-manifest
- Meta Graph API v26.0: https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/ , https://developers.facebook.com/docs/graph-api/changelog/version26.0
- WhatsApp interactive reply buttons: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
- WhatsApp webhooks / signature: https://developers.facebook.com/docs/graph-api/webhooks/getting-started , https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
- WhatsApp templates + pricing: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates , https://developers.facebook.com/docs/whatsapp/pricing
- Twilio WhatsApp + Content API + webhook security: https://www.twilio.com/docs/whatsapp , https://www.twilio.com/docs/content , https://www.twilio.com/docs/usage/webhooks/webhooks-security
- Resend send email + idempotency: https://resend.com/docs/api-reference/emails/send-email
- Next.js `after`: https://nextjs.org/docs/app/api-reference/functions/after
- Vercel Cron (CRON_SECRET): https://vercel.com/docs/cron-jobs/manage-cron-jobs
- Gmail app passwords: https://support.google.com/accounts/answer/185833
