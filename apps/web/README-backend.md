# SEO Autopilot control panel — backend setup

The backend lives inside the Next.js app: route handlers (`app/api/**`), server actions
(`app/actions/**`), the email confirmation page (`app/approve`), `proxy.ts` and `lib/**`.
Contracts: `docs/ARCHITECTURE.md` (runner API, lifecycle) and `docs/WEB-CONTRACT.md` (actions, env).

## 1. Supabase

1. Create a project at supabase.com (region close to your users, e.g. Mumbai).
2. Run the migration: SQL editor → paste `supabase/migrations/0001_init.sql` → Run
   (or `supabase link --project-ref <ref> && supabase db push`).
3. Auth → URL configuration: Site URL = `APP_URL`; add `APP_URL/**` to redirect URLs.
   Enable Email (password + magic link). Invites (`inviteMember`) use Supabase's invite email.
4. Project settings → API: copy URL, anon key, service role key into the env vars below.

The browser only ever reads (RLS by org membership). Every write goes through server actions or
route handlers using the service role, which always filter by `org_id` and write `audit_log`.

## 2. Environment variables

See `.env.example`. Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`),
`ACTION_TOKEN_SECRET`, `CRON_SECRET`. Optional: `WA_GRAPH_VERSION` (default `v26.0`).

Channel credentials are **not** env vars. Admins enter them under Settings → Notifications; they
are stored in `org_settings.channels` encrypted with `APP_ENCRYPTION_KEY` (`*_enc` fields).

## 3. How notifications pick channels

`lib/notify/index.ts`:

* `notifyPending(orgId, changeIds)` — called (in `after()`) when the runner stores proposals that
  need approval. Runs only if `"pending_approval"` ∈ `channels.notify_on`. Sends to **every**
  channel that is enabled *and* fully configured:
  * Slack: `enabled`, bot token, channel id → one Block Kit message for the batch (≤ 45 blocks,
    ≤ 20 changes with Approve/Reject buttons + "Approve all"; the rest summarized with a link).
  * WhatsApp: `enabled`, phone number id, token, ≥ 1 approver → per approver, per change (max 10
    per batch): interactive reply buttons if that number messaged us in the last 24 h, otherwise
    the `seo_approval_request` template.
  * Email: `enabled`, from, approvers, Resend key (or SMTP host/user/pass) → one email per approver,
    each change with signed single-use Approve/Reject links (+ "Approve all").
* `notifyEvent(orgId, kind, payload)` for `verify_failed`, `rolled_back`, `job_failed`,
  `traffic_alert` — only if `kind ∈ notify_on`. Slack message; WhatsApp text only to approvers
  inside the 24 h window (no event template); email to all approvers.
* Daily digest (cron) re-sends the pending queue by email if `email.digest` is on.

Every channel decision funnels into `lib/approvals.ts decide()`: `decide_change` RPC per id
(first decision wins; pending + unexpired only), `audit_log`, re-render of the Slack batch
messages (WhatsApp messages can't be edited — the approver gets a confirmation reply instead),
and one `apply` job per site (skipped if one is already queued for that site).

**WhatsApp 24-hour window tracking:** stored in `org_settings.channels.whatsapp.last_inbound`
(`{ "<E.164 digits>": ISO time }`), updated by the webhook for every inbound message from an
allow-listed number. A 5-minute safety margin is applied.

**Webhook → org resolution** (single org today, but never cross-org):
* Slack: candidate orgs = Slack enabled with a signing secret, preferring `channels.slack.team_id
  === payload.team.id` (team id optional); the request must verify with that org's signing secret.
* WhatsApp: candidate orgs = `channels.whatsapp.phone_number_id` ∈ `entry[].changes[].value.metadata.phone_number_id`;
  the `X-Hub-Signature-256` must verify with that org's app secret. GET handshake matches
  `hub.verify_token` against any org's `verify_token`.

## 4. Slack app

api.slack.com/apps → Create New App → From a manifest → paste, replacing `APP_URL`:

```yaml
display_information:
  name: SEO Autopilot
  description: Approve or reject proposed website changes
features:
  bot_user:
    display_name: SEO Autopilot
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
settings:
  interactivity:
    is_enabled: true
    request_url: https://APP_URL/api/webhooks/slack
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Install to workspace, then in the panel (Settings → Slack): Bot User OAuth Token (`xoxb-…`),
Signing Secret (Basic Information), channel id (`C…`; `/invite @SEO Autopilot` in that channel),
optional team id (`T…`), and approver Slack **user ids** (`U…`, profile → ⋯ → Copy member ID).
Only allow-listed users can decide; others get an ephemeral "not an approver" reply.

## 5. WhatsApp Cloud API (Graph v26.0)

1. developers.facebook.com → Create app (Business) → add WhatsApp. Note the **Phone number ID**.
2. Business Settings → System users → add admin user → assign the app + WABA → Generate token
   (never expires; `whatsapp_business_messaging`, `whatsapp_business_management`).
3. App → Settings → Basic → **App Secret**.
4. WhatsApp → Configuration → Webhook: Callback `https://APP_URL/api/webhooks/whatsapp`, Verify
   token = any random string (also enter it in the panel) → Verify and save → subscribe `messages`.
   Save the panel settings **before** clicking Verify (the handshake checks the stored token).
5. Create the template (WhatsApp Manager or `POST /v26.0/<WABA_ID>/message_templates`):

```json
{
  "name": "seo_approval_request",
  "language": "en",
  "category": "UTILITY",
  "components": [
    { "type": "BODY",
      "text": "SEO Autopilot proposes a change on {{1}}: {{2}}. Approve it?",
      "example": { "body_text": [["example.com/pricing", "Meta description → New description"]] } },
    { "type": "FOOTER", "text": "Reply within 72 hours" },
    { "type": "BUTTONS", "buttons": [
      { "type": "QUICK_REPLY", "text": "Approve" },
      { "type": "QUICK_REPLY", "text": "Reject" } ] }
  ]
}
```

6. Panel → Settings → WhatsApp: phone number id, token, app secret, verify token, template name
   (`seo_approval_request`), language (`en`), approver numbers (E.164, e.g. `+9198…`).
7. Each approver should send any message (e.g. "hi") to the business number once: inside the 24 h
   window they get rich interactive messages and event alerts; outside it, the template.

Button ids/payloads are `approve:<changeId>` / `reject:<changeId>` / `open:<changeId>`. They are
safe because the webhook is authenticated by Meta's signature and the sender must be allow-listed;
the decision is still bound to the change's `diff_hash` and pending state.

## 6. Email

* **Resend** (recommended): verify your sending domain (SPF + DKIM, add DMARC), create an API key,
  set provider `resend`, API key and `from` (e.g. `SEO Autopilot <agent@mail.example.com>`).
  Requests carry an `Idempotency-Key`.
* **SMTP** fallback (nodemailer): host, port (465 = TLS), user, password (e.g. Gmail app password).

Approval links go to `/approve?t=<token>`. The GET page only shows the change(s) and a Confirm
button; only the POST (server action) acts, so link scanners can't approve. Tokens are HMAC-signed
(`ACTION_TOKEN_SECRET`) with `{jti, cids, act, rcpt, exp, org}`, stored in `action_tokens`,
single-use (`update … where used_at is null returning`), expire with the change, and the recipient
must still be in the email approver list at click time.

## 7. Vercel deploy + cron

1. Import the repo in Vercel, Root Directory `apps/web` (framework: Next.js). npm workspaces
   install from the repo root automatically.
2. Add all env vars (Production + Preview). Set `APP_URL` to the production domain.
3. `vercel.json` schedules `GET /api/cron/digest` daily at `30 2 * * *` (02:30 UTC = 08:00 IST).
   Vercel sends `Authorization: Bearer $CRON_SECRET`. The job expires stale approvals (updating
   Slack messages) and emails the pending digest per org.
4. Manual run: `curl -H "Authorization: Bearer $CRON_SECRET" https://APP_URL/api/cron/digest`.

## 8. Runner API summary

All under `/api/runner/*`, bearer runner token (sha256 → `runners.token_hash`, not revoked;
bumps `last_seen_at`): `register` (no auth; one-time code), `heartbeat`, `claim`,
`jobs/:id/logs` (≤ 500 lines, 8000 chars each; returns `cancel_requested`), `jobs/:id/complete`,
`sites/:id` (GET), `sites/:id/connection`, `sites/:id/audits` (POST + `/:auditId` GET),
`sites/:id/changes` (POST + GET `?status=a,b&ids=…`), `changes/:id` (status transitions, see
`lib/transitions.ts`), `sites/:id/metrics`.

## 9. Tests

`npm test -w apps/web` (vitest): Slack/WhatsApp signature verification, browser sealing ↔ core
`unseal`, email token signing / single use / allow-list, the transitions map, proposal ingest
(classification, daily cap, dedupe, metrics enrichment, blocking) with an in-memory Supabase fake,
traffic alerts, and notification formatting limits.
