# SEO Autopilot

An autonomous SEO agent for Upcore Technologies, built on top of
[claude-seo](https://github.com/AgriciDaniel/claude-seo). claude-seo diagnoses; SEO Autopilot
**fixes**: it audits a site, proposes concrete changes, asks a person when a change is risky,
applies approved changes to WordPress, Shopify or a code repo, checks the live page, and rolls
back automatically if the check fails.

```
audit (claude-seo) → propose (Claude) → classify risk (code) → approve (panel / Slack / WhatsApp / email)
      → apply (adapters) → verify live page → auto-rollback on failure → monitor Search Console
```

## What's in the box

| Part | Path | What it does |
|---|---|---|
| Control panel | `apps/web` | Next.js app on Vercel + Supabase. Sites, approvals queue with before/after diffs, findings, reports, jobs with live logs, schedules, per-site policy, runners, notification settings, activity log |
| Runner | `apps/runner` | Runs on your PC. Claims jobs, runs `claude -p` with claude-seo, applies approved changes, verifies, rolls back |
| Shared core | `packages/core` | Change types, risk classifier, crypto, page parser, verifier, platform adapters (WordPress, Shopify, GitHub/Next.js) |
| Claude plugin | `plugin/` | Skills `propose-fixes` (audit → structured proposals) and `repo-fix` (edit a repo checkout) |
| WordPress bridge | `integrations/wordpress/seo-agent-bridge.php` | One-file mu-plugin: a uniform API for titles, descriptions, canonical, robots, OG, JSON-LD, redirects, robots.txt, llms.txt, cache purge |
| Shopify snippet | `integrations/shopify/` | One-time theme snippet that prints JSON-LD stored in metafields |
| Database | `supabase/migrations` | Schema, row-level security, atomic job claiming, first-decision-wins approvals |

## Safety model

* **Claude proposes, code applies.** Claude never holds site credentials and never writes to a
  live site. It produces proposals; deterministic code reads the real "before" value, applies,
  verifies and undoes. (Repo sites: Claude edits a local branch; changes ship as a pull request.)
* **Claude never decides the risk.** `packages/core/src/risk.ts` sorts every change into
  **auto**, **approve** or **never**:
  * Auto: adding missing alt text, meta descriptions, OG tags, site-describing JSON-LD; fixing broken JSON-LD.
  * Approve: rewriting titles or existing descriptions, canonicals, redirects, robots.txt, noindex, content edits, product/review markup.
  * Never: URL/slug changes, blocking the whole site, noindex on pages with traffic, protected paths.
  * Pages with ≥ 10 clicks or ≥ 500 impressions in 28 days, the homepage and shared templates are bumped up a tier.
* **New sites start in "suggest" mode**: everything waits for approval. Switch a site to "auto"
  in its Policy tab once you trust it; only the auto tier then applies without asking.
* **Approvals bind to the exact change** (hash). If the live value changed since the proposal,
  the runner refuses to apply.
* **Site credentials are encrypted in your browser** with your runner's public key. The hosted
  panel and database only ever see ciphertext.
* Every action is written to the activity log with who did it and from where.

## Status

Verified:

* 200 unit tests across core, runner and panel.
* Database schema, security rules, job claiming and approvals tested on Postgres 16 and live on Supabase.
* WordPress adapter tested end to end against a real WordPress 7.1 install in three setups:
  * Rank Math only: 5 of 5 supported change types.
  * Rank Math + bridge: 9 of 9.
  * Bridge only: 9 of 9.
  * Each type was applied, verified on the live page, rolled back and verified again (`scripts/live-adapter-test.mts`).

Not yet run against a live site:

* Shopify adapter: tested against a fake GraphQL server only. Test it on a development store first.
* Repo adapter: git operations tested against a real local repo; the GitHub API was mocked.

## Setup

See **[docs/SETUP.md](docs/SETUP.md)**. Architecture and contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Credits

Built on [claude-seo](https://github.com/AgriciDaniel/claude-seo) by AgriciDaniel (MIT). claude-seo
is installed unmodified by `seo-autopilot-runner setup` and loaded as a plugin, so its updates can
be pulled in without merge conflicts.
