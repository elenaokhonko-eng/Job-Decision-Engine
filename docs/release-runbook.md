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
3. Generate application documents locally from the reviewed Streamlit application flow; the public repository has no GitHub Actions document-generation workflow.
4. Confirm the CV and cover letter against the active PostgreSQL profile evidence, and review the rendered files before any submission. Active profile-graph contact facts are authoritative; legacy contact sources are fallback-only.

## Single-Job Supervised Pilot

1. Set `PILOT_MODE=true` and keep `WORKFLOW_KILL_SWITCH` false. This pauses scheduled ingestion, backlog drains, and the global evaluation queue while allowing only a manually dispatched scoped pilot. `WORKFLOW_KILL_SWITCH=true` pauses all pipeline processing, including the pilot.
2. Verify the selected canonical job ID, current job-version ID, source identity, and absence of prior evaluation, application, or document history.
3. Run `npx tsx scripts/run_scoped_pilot.ts --canonical-job-id <uuid> --job-version-id <uuid>` only from reviewed `main` code. The runner requires `PILOT_MODE=true`, the kill switch off, both database URLs targeting the same branch, and a direct `DATABASE_URL_UNPOOLED` for the worker lock. It refreshes the official ATS source, then scopes task seeding, reconciliation, execution, and evaluation to the selected job version. Re-running the same IDs resumes existing pipeline history and reuses only a current persisted evaluation; it refuses versions with application or document history. The runner does not create applications or documents. In GitHub Actions, the `Evaluation Queue Worker` manual dispatch uses its scoped path only in pilot mode with both IDs supplied; it verifies that the migration ledger has no pending entries and skips the global queue processor. The `Documents Generator` manual dispatch always requires pinned job/version IDs and an `INTENT` application record; it checks current readiness, a linked current document pair, actual DOCX/PDF files, and the CV phone before uploading artifacts. Both workflows reject non-main refs before production credentials are accessed.
4. Continue only if the persisted decision and current readiness permit document preparation. Create one draft application through the existing workflow, generate both documents from the active profile graph, and inspect the rendered DOCX and PDF. For local Streamlit downloads of CI-generated artifacts, place the downloaded files under `scripts/exports`; the app resolves a remote manifest path by filename only when the stored SHA-256 matches.
5. Record neither document review nor employer submission without explicit user confirmation. Keep broad processing paused after the pilot.

## Model Provider Capacity: Stop Rule

Every worker run prints `providerCalls` in its summary JSON, the evaluation queue prints its own, and `scripts/report_pipeline_status.ts` adds `provider_calls_by_model` (calls, 429s, timeouts, 5xx and retries per provider/model over the last `PIPELINE_PROVIDER_CALL_WINDOW_MINUTES`, default 90) to the report and the step summary.

- **Stop rule: pause scaling when more than 5% of a run's model calls are rate limited (HTTP 429).** The report sets `stop_rule_triggered` and prints a `STOP RULE` line. Do not raise worker concurrency, `GEMINI_MAX_REQUESTS_PER_MINUTE`, `GEMINI_MAX_CONCURRENCY` or stage caps until a later run is back under 5%; lower the per-model limits (`GEMINI_MODEL_LIMITS_JSON`) or move the pipeline to Vertex AI first.
- A 429 never dead-letters a task or marks a job as a processing error: the task waits in `RETRY_WAIT` (reason `RATE_LIMITED: ...`) and returns after the provider's suggested delay.

## Vertex AI Cut-over (Gemini)

1. In Google Cloud: enable the Vertex AI API on the project; create a service account with `roles/aiplatform.user`; create a Workload Identity pool and GitHub provider restricted to this repository and allow it to impersonate the service account.
2. Locally: `GEMINI_BACKEND=vertex`, `GOOGLE_CLOUD_PROJECT=<project>`, `GOOGLE_CLOUD_LOCATION=global`, and `GOOGLE_APPLICATION_CREDENTIALS` pointing at a key file (or `gcloud auth application-default login`). Run `npm run models:check` (checks every configured model id with `models.get` on Vertex) and `npx tsx scripts/compare_embedding_backends.ts --run` (cosine >= 0.999 against 20 stored vectors; it writes nothing).
3. Repository variables (no secrets needed for Vertex): `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `GOOGLE_CLOUD_PROJECT`, optionally `GOOGLE_CLOUD_LOCATION` (default `global`) and `GEMINI_PIPELINE_FLEX`. Then set `GEMINI_BACKEND=vertex`; the model-calling jobs authenticate with `google-github-actions/auth` only when it is set.
4. Watch the first runs' `provider_calls_by_model` against the stop rule. Roll back by setting `GEMINI_BACKEND=studio` (or deleting it); the AI Studio secrets stay in place until Vertex has run cleanly.

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
