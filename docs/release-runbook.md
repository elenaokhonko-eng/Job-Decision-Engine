# Release Runbook

## Local Gates

```bash
npm ci
npm run contracts:check
npm run lint
# If using Docker Compose local Postgres:
npm run dev:setup
# If using managed Postgres (Neon/hosted):
# npm run db:init
npm run sources:sync
npm run docs:compliance
npm run backfill:v22 -- --dry-run
npm run cutover:audit
npm test
```

## GitHub Acceptance

Use one exact commit SHA for all runs.

1. Require green CI.
2. Dispatch `ingest.yml` and record migrations, model preflight, Gmail counts, per-source counts, gate counts, queue outcomes, and shortlist count.
3. Select one viable `AI_EVALUATED` row from `v_canonical_shortlist`; record its `canonical_job_id` and `job_version_id`.
4. Dispatch `documents.yml` with those IDs.
5. Confirm CV and cover-letter artifacts upload, provenance/claim validation against the active PostgreSQL profile facts, and explicit provider/fallback reporting (contact info may come from `DOCUMENT_CONTACT_JSON` or legacy `MASTER_PROFILE_JSON.contact`).

## Release Evidence

Before declaring release complete, capture:

```bash
git rev-parse HEAD
git status --short
git log -1 --stat
git diff --name-status origin/main...HEAD
```

Also capture URLs for green CI, ingestion, and document-generation runs, source-by-source counts, and exact artifact names. If any evidence is missing, the release remains incomplete.

## Tagging

Only after all gates pass and parity/backfill audits are recorded:

```bash
git tag -a v2.2.0 -m "Job Decision Engine v2.2.0"
git push origin v2.2.0
```

## Desktop Release

Desktop releases are built by the manual `Desktop Release` workflow. Run it first with `publish=false`; this produces a Windows NSIS installer artifact without publishing an update feed. Use `publish=true` only after these repository secrets exist: `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`, and the workflow-provided `GITHUB_TOKEN` has contents write permission.

Local desktop checks:

```bash
npm run desktop:assets
npm run desktop:release:validate -- --channel=stable --publish=never
npm run desktop:dist -- --channel=stable --publish=never
npm run desktop:release:evidence -- --channel=stable --publish=never --output-dir=<desktop-output-dir>
```

Strict publish validation:

```bash
GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v1.0.0 JDEC_DESKTOP_ENABLE_UPDATES=true npm run desktop:release:validate -- --strict --channel=stable --publish=always
```

Release channels are defined in `desktop/release/release-policy.json`. `stable` maps to the production update feed, while `alpha` and `beta` are prerelease channels for supervised testing. Do not enable desktop auto-updates for an unsigned or unpublished build.

Version guardrails are enforced before packaging. `stable` requires a plain semver version such as `1.0.0`; `beta` requires a prerelease version such as `1.0.0-beta.1`; `alpha` requires a prerelease version such as `1.0.0-alpha.1`. Publish builds must run from a git tag that exactly matches `v<package.json version>`.

## Privacy And Security

Do not commit `.env.local`, private profile ledgers, database exports, cookies, Gmail contents, or personal policy overrides. Run a full-history secret scanner before public release. Do not rewrite history without explicit approval.
