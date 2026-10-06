# Setup guide

About 30 minutes end to end. Order: database → control panel → runner on your PC → first site →
notifications (optional).

## 1. Database (Supabase)

1. Create a Supabase project (the `seo-autopilot` project in Mumbai already exists for Upcore).
2. Apply the migrations in `supabase/migrations/` in order (SQL editor, or `supabase db push`).
3. **Authentication → URL configuration**: set Site URL to your panel URL
   (e.g. `https://seo-autopilot.vercel.app`) and add `https://<panel-url>/**` to Redirect URLs.
4. **Project settings → API keys**: copy the project URL, the anon/publishable key and the
   **service role / secret key**. The service role key is server-only: it goes into Vercel and nowhere else.

## 2. Control panel (Vercel)

1. Import the GitHub repo in Vercel. Set the **Root Directory** to `apps/web`; it's a monorepo
   and Vercel installs the workspace from the repo root automatically.
2. Environment variables (Production + Preview):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service role / secret key |
   | `APP_URL` | the panel URL, no trailing slash |
   | `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` |
   | `ACTION_TOKEN_SECRET` | `openssl rand -base64 32` |
   | `CRON_SECRET` | `openssl rand -base64 32` |

3. Deploy. Open the panel, create your account, name the workspace.
4. The daily digest cron (08:00 IST) comes from `apps/web/vercel.json`.

## 3. Runner on your PC

Requirements: Node 20+, Git, Python 3.10+, Claude Code signed in (`claude auth login`).

```bash
git clone <your seo-autopilot repo> seo-autopilot
cd seo-autopilot
npm install && npm run build -w apps/runner && npm link -w apps/runner

seo-autopilot-runner setup          # installs claude-seo + its Python runtime and Chromium
# In the panel: Runners → Connect a runner → copy the one-time code
seo-autopilot-runner register --server https://<panel-url> --code ABCD-EFGH-JKLM
seo-autopilot-runner doctor         # everything should be OK
seo-autopilot-runner start          # leave running
seo-autopilot-runner install-service  # optional: start at login (launchd / systemd / Task Scheduler)
```

The runner uses your normal Claude Code subscription. Each job has a spending cap
(`max_budget_usd` in `~/.seo-autopilot/runner.json`, default $10). A full claude-seo audit runs up
to 17 agents, so expect it to be the most expensive job; use "Page audit" for quick checks.

## 4. Add a site

Panel → Sites → Add site. Credentials are encrypted in your browser for the runner you pick.

**WordPress**
1. Create a dedicated administrator user, e.g. `seo-agent`.
2. Users → that user → Application Passwords → add "SEO Autopilot" → copy the password.
3. Upload `seo-agent-bridge.php` (downloadable from the wizard) to `wp-content/mu-plugins/`.
   Without it you still get titles/descriptions (via Yoast/Rank Math/SEOPress), alt text and
   content edits, but not JSON-LD, redirects, robots.txt, llms.txt, cache purge or exact rollback.
4. If the connection test says "Authorization header stripped", add to `.htaccess`:
   `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`
5. Rank Math must have finished its setup wizard (connected or skipped); until then it outputs
   nothing and exposes no API.

**Shopify**: see `integrations/shopify/README.md` (Dev Dashboard app, scopes, one-time snippet).
Test on a development store first.

**Code repo (Next.js / Astro / static)**: a fine-grained GitHub token for that repo with
Contents and Pull requests set to read & write, and Deployments read. Changes arrive as a PR; set
"Repo auto-merge" in the site's Policy tab to merge automatically after the preview checks pass.

Then on the site page: **Run audit** → proposals appear in **Approvals** → approve → the runner
applies, verifies and reports back.

## 5. Notifications (optional)

Panel → Settings. Each channel has its setup steps inline.

* **Slack**: create an app from the manifest in `apps/web/README-backend.md`, set the
  Interactivity URL to `https://<panel-url>/api/webhooks/slack`, paste the bot token and signing
  secret, and add the Slack user IDs allowed to approve.
* **WhatsApp** (Meta Cloud API): app + phone number ID + permanent token + app secret.
  Webhook `https://<panel-url>/api/webhooks/whatsapp`. Create the `seo_approval_request` utility
  template (JSON in `apps/web/README-backend.md`). Add approver numbers in E.164 format.
* **Email**: Resend API key with a verified sending domain (or SMTP). Approve/Reject links
  open a confirmation page; email scanners can't approve anything by prefetching links.

## Testing an adapter against a staging site

```bash
LIVE_TEST=1 npx tsx scripts/live-adapter-test.mts wordpress https://staging.example.com \
  https://staging.example.com/some-page/ seo-agent "xxxx xxxx xxxx xxxx xxxx xxxx"
```

It applies, verifies, rolls back and re-verifies every supported change type, and leaves the site as it found it.
