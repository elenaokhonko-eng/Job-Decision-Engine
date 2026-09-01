# Release Runbook

## Local Gates

```bash
npm ci
npm run contracts:check
npm run lint
npm run db:init
npm test
```

## GitHub Acceptance

Use one exact commit SHA for all runs.

1. Require green CI.
2. Dispatch `ingest.yml` and record migrations, model preflight, Gmail counts, per-source counts, gate counts, queue outcomes, and shortlist count.
3. Select one viable `AI_EVALUATED` row from `v_canonical_shortlist`; record its `canonical_job_id` and `job_version_id`.
4. Dispatch `documents.yml` with those IDs.
5. Confirm CV and cover-letter artifacts upload, evidence validation against `MASTER_PROFILE_JSON`, and explicit provider/fallback reporting.

## Release Evidence

Before declaring release complete, capture:

```bash
git rev-parse HEAD
git status --short
git log -1 --stat
git diff --name-status origin/main...HEAD
```

Also capture URLs for green CI, ingestion, and document-generation runs, source-by-source counts, and exact artifact names. If any evidence is missing, the release remains incomplete.

## Privacy And Security

Do not commit `.env.local`, private profile ledgers, database exports, cookies, Gmail contents, or personal policy overrides. Run a full-history secret scanner before public release. Do not rewrite history without explicit approval.
