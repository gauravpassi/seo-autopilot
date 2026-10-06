# Control panel contract (apps/web)

Next.js 16.3 App Router, React 19, Tailwind v4, Supabase (`@supabase/ssr`). Read
`apps/web/node_modules/next/dist/docs/` (or root `node_modules/next/dist/docs/`) before using
any Next API: this version has breaking changes (e.g. `middleware.ts` is now `proxy.ts`,
`cookies()`/`headers()`/`params` are async).

Two agents build the web app in parallel:
* **Backend** owns `apps/web/lib/**` (except `lib/ui/**`), `apps/web/app/api/**`,
  `apps/web/app/actions/**`, `apps/web/proxy.ts`, `apps/web/app/approve/**`, `vercel.json`, `.env.example`.
* **Frontend** owns everything else under `apps/web/app/**` and `apps/web/components/**`,
  `apps/web/lib/ui/**`, global styles.

## Environment variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
APP_URL=https://autopilot.example.com      # used in notification links
APP_ENCRYPTION_KEY=                        # 32 bytes base64 (openssl rand -base64 32)
ACTION_TOKEN_SECRET=                       # HMAC secret for email approval links
CRON_SECRET=                               # Vercel Cron bearer
```

## Shared server modules (backend writes, frontend imports)

* `lib/supabase/server.ts` → `createClient()` (async, user session, RLS) and `createAdmin()` (service role).
* `lib/supabase/client.ts` → `createBrowserClient()` for client components (realtime not required).
* `lib/auth.ts` → `requireMember(): Promise<{ user, orgId, role, email }>` — redirects to `/login` if no
  session, to `/onboarding` if the user has no org.
* `lib/types.ts` → row types: `Org, Runner, Site, SiteSecretRow, Job, JobLog, Audit, Finding, Change,
  Schedule, AuditLogRow, OrgSettings` mirroring `supabase/migrations/0001_init.sql` (snake_case fields).
* `lib/format.ts` (frontend may also add helpers in `lib/ui/`).
* `lib/encrypt-browser.ts` (client-safe, WebCrypto) → `sealForRunner(plaintextJson: string, publicKeyPem: string): Promise<SealedEnvelope>`
  producing exactly `packages/core/src/crypto.ts` `SealedEnvelope` (RSA-OAEP SHA-256 wrap of an
  AES-256-GCM key; data = ciphertext‖tag).

## Server Actions (`app/actions/*.ts`, `"use server"`, backend writes)

All return `{ ok: true, ...data } | { ok: false, error: string }`, check role (viewer = read-only),
write `audit_log`, and call `revalidatePath` for affected pages.

| File | Action | Signature |
|---|---|---|
| `org.ts` | `bootstrapOrg` | `(name: string)` — creates org, owner membership, default org_settings; only if the user has no org |
| `org.ts` | `inviteMember` | `(email: string, role: "admin"\|"member"\|"viewer")` — Supabase admin `inviteUserByEmail` + membership |
| `org.ts` | `updateMemberRole` / `removeMember` | `(userId: string, role)` / `(userId: string)` |
| `sites.ts` | `createSite` | `(input: { name, url, platform, runner_id?, config?, policy? }) → { ok, id }` — also creates default schedules: weekly audit (168h), daily monitor (24h) disabled until GSC set |
| `sites.ts` | `updateSite` | `(id, patch: { name?, url?, runner_id?, config?, policy? })` — policy validated with `SitePolicy` |
| `sites.ts` | `archiveSite` | `(id)` |
| `sites.ts` | `saveSiteSecret` | `(siteId, runnerId, ciphertext: SealedEnvelope, hint?: string)` — then enqueues `test_connection` |
| `jobs.ts` | `enqueueJob` | `(siteId: string, kind: JobKind, params?: object) → { ok, id }` — params validated with `JobParams[kind]` |
| `jobs.ts` | `cancelJob` | `(jobId)` |
| `changes.ts` | `decideChanges` | `(ids: string[], action: "approve"\|"reject", note?: string) → { ok, decided: number, skipped: number }` — uses `lib/approvals.ts decide()`; enqueues one `apply` job per site with approvals |
| `changes.ts` | `approveAllAuto` | `(siteId)` — approve pending changes whose reasons only mention suggest-mode |
| `changes.ts` | `editChangeAfter` | `(id, after: unknown)` — only while `pending_approval`; revalidates payload, recomputes `diff_hash` |
| `changes.ts` | `requestRollback` | `(ids: string[], reason?: string)` — enqueues `rollback` job(s) |
| `schedules.ts` | `upsertSchedule` | `({ id?, site_id, kind, every_hours, enabled, params? })` |
| `schedules.ts` | `deleteSchedule` | `(id)` |
| `runners.ts` | `createRunnerCode` | `(name: string) → { ok, runner_id, code }` — code like `ABCD-EFGH-JKLM`, 15 min |
| `runners.ts` | `renameRunner` / `revokeRunner` | `(id, name)` / `(id)` |
| `settings.ts` | `saveChannels` | `(channels: ChannelsInput)` — secrets that come back as `"__unchanged__"` keep the stored value; new secret values are encrypted with `APP_ENCRYPTION_KEY` |
| `settings.ts` | `sendTestNotification` | `(channel: "slack"\|"whatsapp"\|"email")` |
| `settings.ts` | `getChannelsForEdit` | `() → ChannelsView` — same shape with secrets replaced by `"__unchanged__"` when set, `""` when not |

## Data reads (frontend)

Server Components read with `createClient()` (RLS restricts to the user's org). Pages that show live
progress (job logs, runner status, change statuses) poll every 3 s via a small client component
calling a GET route the backend provides:

* `GET /api/ui/jobs/:id?after=<logId>` → `{ job, logs: JobLog[] }`
* `GET /api/ui/overview` → `{ runners, pending_count, running_jobs, recent_changes }`

## Pages (frontend)

| Route | Content |
|---|---|
| `/login` | Email + password and magic link (Supabase Auth) |
| `/onboarding` | Create org (first user) |
| `/` Dashboard | Runner status card (online if `last_seen_at` < 90 s, claude / claude-seo health), approvals waiting (count + top 5 with quick approve/reject), sites grid with health score + last audit + pending count, running jobs, recent activity (audit_log) |
| `/approvals` | Queue of `pending_approval` changes across sites: filters (site, type, tier reason), each card shows type, URL, **before → after diff** (text diff for strings, JSON diff for schema, code block for robots/llms), rationale, evidence, expected impact, risk reasons, expires in; approve / reject / edit-then-approve; bulk select |
| `/sites` | List + "Add site" wizard: name, URL, platform → platform-specific setup step (WordPress: username + app password + bridge plugin download link; Shopify: shop domain + token or client id/secret; Repo: GitHub owner/repo, branch, build command, token, Vercel bypass) → runner select → encrypt with that runner's public key in the browser → save → live connection test result |
| `/sites/[id]` | Tabs: **Overview** (health score trend from audits, category scores, connection status, quick actions: Run audit (full/page), Propose fixes, Apply approved, Verify), **Findings** (latest audit, grouped by category + severity), **Changes** (all statuses, filters, rollback button on applied/verified, PR links), **Report** (rendered `report_md` / `action_plan_md`), **Schedules**, **Policy** (mode off/suggest/auto with clear explanation, per-type tier overrides table, thresholds, protected paths, auto-rollback, repo auto-merge), **Connection** (update credentials, re-test) |
| `/jobs` and `/jobs/[id]` | Job list with status/kind/site/cost/duration; detail with live log stream (agent text, tool calls, errors), result JSON, cancel |
| `/runners` | Runners list (online/offline, version, health), "Connect a runner" flow showing the install command and one-time code, revoke |
| `/settings` | Notification channels (Slack, WhatsApp, Email) with setup instructions inline, approver allow-lists, test buttons, notify_on toggles; Team members |
| `/activity` | `audit_log` table, filterable |
| `/approve?t=` | Email confirmation page (backend owns) |
