# seo-autopilot (Claude Code plugin)

Skills the SEO Autopilot runner loads next to [claude-seo](https://github.com/AgriciDaniel/claude-seo).
claude-seo analyses; these skills turn its analysis into changes the runner can apply safely.

The runner loads the plugin per run with `--plugin-dir`, so nothing needs installing globally:

```
claude -p "/seo-autopilot:propose-fixes https://www.example.com …" \
  --plugin-dir ~/.seo-autopilot/claude-seo --plugin-dir ~/.seo-autopilot/plugin …
```

`seo-autopilot-runner setup` copies this folder to `~/.seo-autopilot/plugin`.

## Skills

### `/seo-autopilot:propose-fixes [site-url]`

Input files in the working directory (written by the runner's `propose` job):
`audit-data.json`, `findings.json`, `snapshots.json`, `capabilities.json`, `site.json`
(and optionally `FULL-AUDIT-REPORT.md`).

Output: `proposals.json` (and the same object as structured output, validated against
`ProposalFile` in `packages/core/src/schema.ts`): one proposal per concrete element with an exact
`after` value, plus `manual_recommendations` for anything the platform can't apply.

Guardrails: only types the site can apply, no invented facts in JSON-LD, no FAQPage/HowTo, no
noindex/slug/robots blocking without clear evidence, length limits for titles and descriptions,
same-host URLs, at most 60 proposals. The runner re-validates every payload, reads the real
"before" value itself and drops no-ops; the server decides the risk tier.

### `/seo-autopilot:repo-fix`

Input: `approved-changes.json` in the working directory (approved changes + where the runner
thinks each element is defined) and a git checkout passed with `--add-dir`.

Claude edits only the listed elements with file tools (no Bash, no git), following recipes for
Next.js App Router (`metadata` / `generateMetadata`, `app/robots.ts`, `metadataBase`, JSON-LD with
`<` escaped as `<`, `next/image` alt, `next.config` redirects with `permanent: true`), Next.js
Pages Router, Astro and static HTML. It finishes by writing `repo-fix-report.json`
(`{changes: [{change_id, files, done, note}]}`). The runner then builds, commits, opens a PR,
verifies the preview deployment and merges only when the site policy allows it.

## License

MIT © Upcore Technologies
