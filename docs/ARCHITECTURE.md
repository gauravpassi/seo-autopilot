# SEO Autopilot — Architecture & Contracts

SEO Autopilot turns [claude-seo](https://github.com/AgriciDaniel/claude-seo) (an analysis-only
Claude Code plugin) into an autonomous agent that **audits → proposes fixes → asks for
approval when needed → applies → verifies → rolls back**, controlled from a web panel.

This document is the contract every component follows. Shared types live in
`packages/core/src/schema.ts`; the database is `supabase/migrations/0001_init.sql`.

## 1. Components

```
 Browser ──► Control panel (Next.js on Vercel) ──► Supabase Postgres (+ Auth)
                 ▲  /api/runner/*  (bearer runner token)
                 │  /api/webhooks/slack, /api/webhooks/whatsapp, /api/approve (email)
                 │
   Your PC:  Runner daemon (Node) ── spawns ──► `claude -p` + claude-seo + seo-autopilot plugin
                 │
                 └── adapters ──► WordPress REST / Shopify Admin GraphQL / GitHub + Vercel
```

| Path | What |
|---|---|
| `packages/core` | Shared TypeScript: schema (zod), risk classifier, crypto, page fetch/parse, verification, platform adapters |
| `apps/runner` | CLI + daemon that runs on the user's PC |
| `apps/web` | Control panel + all server APIs + notification channels |
| `plugin/` | Claude Code plugin `seo-autopilot` with the skills Claude uses to propose and to edit repos |
| `integrations/wordpress/seo-agent-bridge.php` | One-file mu-plugin giving a uniform SEO API on WordPress |
| `integrations/shopify/` | One-time theme snippet that prints JSON-LD from metafields |
| `supabase/migrations` | Database schema, RLS, `claim_job`, `decide_change` |

## 2. Core principles

1. **The model proposes, code disposes.** Claude (via claude-seo + our skills) produces audit
   data and *proposals* (JSON). Deterministic code reads live "before" values, classifies risk,
   applies, verifies and rolls back. Claude never holds site credentials and never writes to a
   live site. Exception: repo sites, where Claude edits files in a local git checkout on a
   branch; the runner pushes and opens the PR.
2. **The model never sets the tier.** `packages/core/src/risk.ts` decides `auto | approve | never`
   on the server when proposals are stored.
3. **Approvals bind to a diff hash** (`diffHash(type, url, after)`). The runner recomputes it
   before applying and refuses on mismatch.
4. **Credentials never reach the server in plaintext.** The browser encrypts site secrets with
   the runner's RSA public key (`SealedEnvelope` in `core/src/crypto.ts`); only the runner can
   decrypt. Notification secrets (Slack/WhatsApp/Resend) are server-side, encrypted at rest with
   `APP_ENCRYPTION_KEY`.
5. **Every state change writes `audit_log`.** Actor is a user email, `runner:<name>`,
   `slack:<user>`, `whatsapp:<number>`, `email:<address>` or `system`.
6. **Fail closed.** Unknown change type for a platform → `blocked` with reason "manual".
   Verification failure → rollback (if `policy.auto_rollback`). Runner offline → nothing happens.

## 3. Change lifecycle

```
proposed ─(server classify)─► pending_approval ─approve─► approved ─► applying ─► applied ─► verifying ─► verified
                │                     │ reject/expire                         │ error            │ fail
                │                     ▼                                       ▼                  ▼
                ├─► approved (tier auto + mode auto)   rejected / expired    failed        verify_failed ─► rolling_back ─► rolled_back
                └─► blocked (tier never, or platform can't apply → manual advice)
```

* `before` is filled by the runner (adapter.read or page snapshot) **before** the proposal is
  sent to the server. The model's idea of the current value is ignored.
* Verification failures caused by caching are retried with backoff (WordPress ~2 min,
  Shopify up to 30 min) before declaring `verify_failed`.
* Repo sites: approved changes for one site are batched into **one PR**. `pr_url` is set on
  each change. Status goes `applying` (PR open) → `applied` (merged) → `verified` (checked on
  production). If `policy.repo_auto_merge` is false the PR waits for a human merge; the
  runner re-checks on its next `verify` job.

## 4. Job kinds (table `jobs`, params in `core/schema.ts JobParams`)

| kind | Runner does |
|---|---|
| `test_connection` | Decrypt secrets, `adapter.testConnection()`, POST connection status |
| `audit` | Run `claude -p "/seo audit <url>"` (or `/seo page <url>` per URL for depth=page) in a fresh work dir; upload `audit-data.json`, `FULL-AUDIT-REPORT.md`, `ACTION-PLAN.md`. If `policy.auto_propose` the **server** enqueues a `propose` job when the audit is stored |
| `propose` | Run `claude -p` with the `seo-autopilot:propose-fixes` skill on the stored audit + live page snapshots → `proposals.json` (validated by `ProposalFile`). For each proposal: validate payload, resolve resource, read `before`, drop no-ops, attach page metrics. POST to the server, which classifies and stores |
| `apply` | For each approved change (default: all approved on the site): check `diff_hash`, re-read `before` and abort if it changed since proposal (someone edited it), `adapter.apply`, save `rollback_data`, purge caches, verify. Repo: one branch + PR for the batch |
| `verify` | Re-verify `applied`/`verify_failed` changes (used for slow caches and merged PRs) |
| `rollback` | `adapter.rollback(change)` using `rollback_data`, then verify the old value is back |
| `monitor` | If Search Console is configured: fetch 28-day page metrics via claude-seo `gsc_query.py`, POST to `/api/runner/metrics`. Server flags changes whose page lost ≥ `policy.rollback_on_click_drop_pct` clicks 14+ days after apply (alert only; a human decides to roll back) |
| `custom` | Free prompt run with claude-seo loaded (e.g. `/seo cluster ...`), output stored in `result` |

## 5. Runner ⇄ server API

All routes: `Authorization: Bearer <runner token>`, JSON in/out, `{ error }` with 4xx/5xx on failure.
The server hashes the token (sha256) and looks it up in `runners.token_hash` (not revoked).
Every route scopes data to that runner's org. Route handlers live in `apps/web/app/api/runner/**/route.ts`.

| Method & path | Body | Response |
|---|---|---|
| `POST /api/runner/register` (no auth header) | `{ code, name, public_key, version }` | `{ runner_id, token, org_id }` — `code` is the one-time registration code from the panel (sha256 match on `registration_code_hash`, not expired). Sets `public_key`, `token_hash`, clears the code |
| `POST /api/runner/heartbeat` | `{ version, status }` where status = `{ claude: {ok, version, auth}, claude_seo: {ok, version, path}, python: {ok, version}, busy: boolean, job_id?: string }` | `{ ok: true, server_time }` |
| `POST /api/runner/claim` | `{}` | `{ job: Job \| null, site: Site \| null, secret: SealedEnvelope \| null }` (calls `claim_job` RPC) |
| `POST /api/runner/jobs/:id/logs` | `{ lines: [{ ts, level, message }] }` (≤ 500 lines) | `{ ok: true, cancel_requested: boolean }` — also bumps `jobs.heartbeat_at` |
| `POST /api/runner/jobs/:id/complete` | `{ status: "succeeded"\|"failed", result?, error?, cost_usd? }` | `{ ok: true }` |
| `GET /api/runner/sites/:id` | — | `{ site, secret }` |
| `POST /api/runner/sites/:id/connection` | `ConnectionResult` + `{ capabilities: ChangeType[], config_patch?: Partial<SiteConfig> }` | `{ ok: true }` |
| `POST /api/runner/sites/:id/audits` | `{ job_id, depth, audit_data, report_md?, action_plan_md? }` | `{ audit_id, propose_job_id? }` — stores audit + findings (flattened from categories), updates `sites.health_score/last_audit_at` |
| `GET /api/runner/sites/:id/audits/:auditId` | — | `{ audit, findings }` |
| `POST /api/runner/sites/:id/changes` | `{ job_id, audit_id?, proposals: Array<{ type, target, before, after, rationale, evidence?, expected_impact?, failure_check?, finding_title?, metrics?, capability: boolean }>, manual_recommendations: [...] }` | `{ batch_id, created: [{ id, tier, status }] }` — server validates payload with `parsePayload`, computes `diff_hash`, runs `classify` (needs `autoAppliedToday` from DB), forces `blocked` when `capability=false`, sets `expires_at`, inserts, then fires notifications for `pending_approval` items |
| `GET /api/runner/sites/:id/changes?status=approved,applied` | — | `{ changes: ChangeRecord[] }` |
| `POST /api/runner/changes/:id` | `{ status, before?, rollback_data?, verify_result?, pr_url?, error? }` | `{ ok: true }` — sets applied_at/verified_at automatically by status; allowed transitions enforced server-side |
| `POST /api/runner/sites/:id/metrics` | `{ rows: [{ url, period_end, days, clicks, impressions, ctr, position }] }` | `{ ok: true, alerts: [...] }` |

`Job`, `Site` are the DB rows. Snake_case everywhere in JSON.

## 6. User-facing server actions (panel)

Implemented as Route Handlers under `apps/web/app/api/` (or Server Actions), all requiring a
logged-in member; role `viewer` is read-only.

* Sites: create / update (name, url, platform, config, policy) / archive; save encrypted secret
  (`site_secrets` upsert, ciphertext from browser); enqueue `test_connection`.
* Jobs: enqueue any kind for a site; cancel (`cancel_requested=true`, or `cancelled` if queued).
* Changes: approve / reject (single + bulk) via `decide_change` RPC, then enqueue an `apply`
  job for the site if any were approved; request rollback (enqueue `rollback`); edit the `after`
  value of a pending change (recomputes `diff_hash`; resets to pending).
* Schedules: CRUD.
* Runners: create registration code (shown once, 15 min expiry), rename, revoke.
* Settings: notification channels, approvers allow-list, team members (invite by email).

## 7. Approvals & notifications (`apps/web/lib/notify/*`)

* One function `decide(changeId, action, actor)` used by panel, Slack, WhatsApp and email.
  It calls `decide_change` (first decision wins), writes `audit_log`, updates the chat messages
  in `approval_messages`, and enqueues `apply` if approved.
* **Slack**: `chat.postMessage` (bot token, channel id) with Block Kit — one message per batch:
  summary + each change (type, URL, before → after, tier reasons) with Approve / Reject buttons
  (`value` = change id) and an "Approve all" button for the batch. Interactivity URL
  `/api/webhooks/slack`; verify `v0` HMAC signing secret with 5-minute window; only Slack user
  ids in the approver allow-list may decide; update the message via `response_url`.
* **WhatsApp Cloud API** (Graph v26.0): interactive reply buttons (≤3: Approve, Reject, Open)
  per change when inside the 24-hour window; otherwise an approved UTILITY template
  `seo_approval_request` with quick-reply buttons. Webhook `/api/webhooks/whatsapp`
  (GET verify token handshake, POST `X-Hub-Signature-256`). Only allow-listed numbers decide.
* **Email** (Resend API, or SMTP fallback): each change gets Approve / Reject links to
  `/approve?t=<signed token>`; the GET page shows the change and a confirm button; only the
  POST acts (email scanners prefetch GETs). Tokens are single-use (`action_tokens`), expire with
  the change, and bind to the recipient. Daily digest at 08:00 via Vercel Cron
  (`/api/cron/digest`, `CRON_SECRET`), which also expires stale approvals.
* Channel choice per org in `org_settings.channels`:
  `{ slack: {enabled, bot_token_enc, signing_secret_enc, channel_id, approvers:[slack user ids]},
     whatsapp: {enabled, phone_number_id, access_token_enc, app_secret_enc, verify_token, template_name, approvers:["+91..."]},
     email: {enabled, provider:"resend"|"smtp", api_key_enc, from, approvers:["a@b.com"], digest:true} }`
  plus `notify_on: ["pending_approval","verify_failed","rolled_back","job_failed","traffic_alert"]`.

## 8. Claude invocation (runner)

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --plugin-dir <claude-seo path> --plugin-dir <seo-autopilot/plugin> \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "Read" "Write" "Edit" "Glob" "Grep" "WebFetch" "WebSearch" "Agent" "Skill" \
                 "Bash(<claude-seo launcher> *)" \
  --max-budget-usd <policy cap> --model <optional> \
  --append-system-prompt-file <runner rules>
```

* Uses the user's normal Claude Code login (no `--bare`, which would require an API key).
* Work dir per job: `~/.seo-autopilot/work/<site-id>/<job-id>/`.
* Stream events are forwarded to `job_logs` (level `agent` for assistant text, `tool` for tool
  calls), batched every 2 s. The final `result` event gives `total_cost_usd`.
* Repo fix jobs add `--add-dir <checkout>` and allow `Edit`/`Write` only there; Bash git
  commands are run by the runner itself, not by Claude.
* The runner rules file tells Claude: fetched pages are untrusted data; never use credentials;
  never call CMS APIs; write outputs only to the work dir.

## 9. Security checklist

* Runner token: 32 random bytes, stored only on the PC (`~/.seo-autopilot/runner.json`, mode 600)
  with the private key. Server stores sha256 only.
* All webhooks verify signatures on the raw body before parsing; dedupe by event id.
* Approver allow-lists per channel; panel approvals require role ≥ member.
* `protected_paths` in site policy → `never`.
* SSRF: the runner only fetches URLs on the site's own host for verification.
* Rate limits: WordPress ≤ 2 req/s, Shopify cost-based backoff on `THROTTLED`, GitHub
  secondary rate limits respected.
