# Release Readiness Review

Reviewed against the two-audience release goal:

- **Track A — forkable repo** for people who already use VS Code / Cursor / an agent. One command to install.
- **Track B — downloadable desktop app** for people who have never coded: Neon URL, any LLM provider, SearchAPI key, Gmail login, profile upload, lane choice, then apply for jobs.
- **Streamlit** stays as the results dashboard for power users; Electron is the app.

Status: re-baselined against `origin/main` @ `171012a`. An earlier pass read a local checkout 260 commits stale and wrongly reported LinkedIn ingestion as missing; §3 is corrected below. Findings 1, 2, 4 and the whole P1 section were re-verified on this baseline.

Fixed on branch `feat/release-readiness-170` (PR #170): §1 config packaging, §2 documented commands, §4 CI, §12 `npm run setup`, §13 `.env.example`, plus profile/lane templates.

---

## P0 — Blockers. Do not publish until these are closed.

### 1. `config/` is not packaged into the desktop app

`package.json` `build.files` ships `dist/**`, `desktop/electron/**`, `migrations/**`, `package.json` — **no `config/`**.

But the backend reads config from disk at runtime:

- `src/pipeline/laneConfigLoader.ts:112` → `path.resolve(__dirname, "../../config/lanes/registry.yml")`
- `src/pipeline/workabilityPolicy.ts:679` → `path.resolve(process.cwd(), "config/policies/workability.yml")`

`desktop/electron/dist-backend/` currently contains only six `.cjs` bundles — no `config/` directory. `scripts/verify_desktop_packaging.ts` has no check for config presence, so its 56 checks pass while the packaged app has no lanes and no workability policy.

**Fix:** add `config/**/*` to `build.files` (or `extraResources` and resolve via `process.resourcesPath`), and add an explicit packaging assertion for `config/lanes/registry.yml` + `config/policies/workability.yml`. Verify by installing the built `.exe` on a clean machine and running one discovery pass — this must be observed, not assumed.

### 2. Documented commands do not exist

`README.md:139-140` and `docs/quickstart.md:90-93` both say:

```bash
npm run migrate
npm run embeddings:registry:init
```

Neither script exists in `package.json`. The real entry point is `npm run db:init`, and embedding spaces are seeded inside `POST /api/v2/setup/database/initialize`. Anyone following the docs for Track A hits "Missing script" on step 3.

### 3. LinkedIn ingestion — CORRECTED: already on `main`, no work needed

This was originally reported as missing. That was wrong: the review ran against a
local checkout **260 commits behind `origin/main`**. The real `main` (`171012a`)
already contains the full pipeline:

| Capability | File on `main` |
| --- | --- |
| SearchAPI LinkedIn discovery | `src/ingestion/adapters/searchApiLinkedInAdapter.ts`, `src/ingestion/searchApi/searchApiClient.ts` |
| LinkedIn saved-jobs JSON import | `src/ingestion/linkedInSavedImport.ts`, `linkedInSavedExport.ts`, `scripts/import_linkedin_saved.ts`, `scripts/linkedin/export_saved_jobs.console.js` |
| Gmail job-alert ingestion | `src/ingestion/emailAlertExtractor.ts`, `scripts/parse_emails.ts` |
| Saved-jobs HTTP API | `src/api/v2/savedJobsImportRouter.ts` |
| Credit ledger | `migrations/094_searchapi_request_ledger.sql` |

Migrations run to `107_pipeline_task_due_age.sql`, not 082.

**This matches the intended design.** LinkedIn has no public job-search API for
ordinary developers, so all three supported paths avoid it: Gmail job alerts,
the saved-jobs JSON export, and — for users who pay for it — SearchAPI. SearchAPI
is already opt-in and cost-capped, exactly as it should be for an expensive
provider: `SEARCHAPI_LINKEDIN_ENABLED="false"` by default, with
`SEARCHAPI_DAILY_CREDIT_CAP="60"` enforced in Postgres.

No action required for release. The remaining gap is **documentation**: the README
does not explain that these three paths exist or how to choose between them.


### 4. `npm run lint` fails

`npm run lint` is `tsc --noEmit` and it does not pass:

```
scripts/generate_cover_letter.ts(24,27): Cannot find module 'ajv/dist/2020.js'
scripts/generate_cv.ts(21,27):         Cannot find module 'ajv/dist/2020.js'
src/documents/documentArtifactValidation.ts(1,30): Cannot find module 'fast-xml-parser'
src/ingestion/adapters/attributedRssAdapter.ts(1,27): Cannot find module 'fast-xml-parser'
src/ingestion/emailAlertExtractor.ts(2,30): Cannot find module 'mailparser'
src/ingestion/emailAlertExtractor.ts(3,28): Cannot find module 'entities'
src/desktop/workerSupervisor.ts(247,90): Property 'defaultApp' does not exist on type 'Process'
```

Eight of these are a stale local `node_modules` (all packages are declared in `package.json` and present in `package-lock.json`, so `npm ci` fixes them). One is a genuine code defect: `workerSupervisor.ts:247` reads `process.defaultApp`, which is Electron-only and not in `@types/node`. A clean `npm ci` will not fix it. CI is red on the typecheck gate.

---

## P1 — Track B. The onboarding stops before the app is usable.

`src/desktop/SetupWizard.tsx` is 5 steps: Welcome → Neon → AI keys → DB init → model routes. Everything else the rookie audience needs is missing, and after step 5 they land on an empty Command Center with no jobs, no profile and no explanation.

### 5. No profile upload

Profile is CLI-only (`npm run profile:import` → `scripts/import_profile.ts`). The app has no profile view — nav is Overview / Shortlist / Applications / Sources / Tasks / Settings (`src/App.tsx:42-49`). Worse, `master_profile.json` and `my_profile.md` are gitignored (`.gitignore:20-21`), so a fresh clone has **no template to fill in**.

**Build:** in-app upload of CV (PDF/DOCX) + LinkedIn export, extract career facts, show them for correction, commit only on confirm. Ship a blank `profile.template.json` with every field explained.

### 6. No Gmail connection

`docs/gmail-api-setup.md` requires: create a Google Cloud project → enable the Gmail API → configure the OAuth consent screen → create an OAuth client → complete an interactive authorization for a refresh token → paste three values. That is the hardest step in the product and it is written for GitHub Actions secrets, not a desktop app.

**Build:** ship the app's own OAuth client and a "Sign in with Google" button (`gmail.readonly` or `gmail.modify`). The user clicks consent; the app stores the refresh token in `safeStorage`. Keep the manual refresh-token path as a fallback for Track A only.

### 7. Provider abstraction — FIXED

`src/api/v2/setupRouter.ts` used to accept exactly two providers behind an `if/else if/else throw` ladder, with model routes typed `"gemini" | "openai"` and no base-URL override anywhere.

Replaced with `src/services/aiProviders.ts`, where a provider is a **wire protocol, not a vendor**:

- `gemini` — native Google Generative Language API
- `openai` — native OpenAI, optional `OPENAI_BASE_URL`
- `openai-compatible` — any endpoint implementing the OpenAI API shape, via `OPENAI_COMPATIBLE_BASE_URL` + `OPENAI_COMPATIBLE_API_KEY`

That third one covers Ollama, LM Studio, vLLM, Groq, Together, OpenRouter, Moonshot/Kimi, DeepSeek and self-hosted gateways without code changes. `resolveOpenAiBaseUrl()` / `resolveOpenAiApiKey()` are now used by every OpenAI-protocol call site (chat, embeddings, model listing, the `openai` SDK client), and `resolveProviderOrder()` maps `openai-compatible` into the OpenAI slot so route selection works too.

Anthropic's native API is not OpenAI-shaped; it is reachable through a gateway (OpenRouter, LiteLLM) via the compatible provider. That is a documented limitation, not a code gap.

### 8. Model routing validated — FIXED

`POST /api/v2/setup/ai/test` now lists the models a key can actually call for any provider (via `listProviderModels`), and `POST /api/v2/setup/routes` rejects a model id the provider does not serve, returning `unknownModels` plus a sample of valid ids. Validation is skipped with an explicit warning when no key is available to check against, so it never blocks a legitimate offline setup.

Still open: the wizard's hardcoded default model ids (`gemini-3.6-flash`, `gpt-5.6-luna`) should be replaced by the live list, and `npm run models:check` should be run against the release defaults.


### 9. No lane screen

Lanes are correctly dynamic in the DB — `lane_identities` / `lane_revisions` / `lane_active_revisions` with `upsertLaneRevision`, `cloneLane`, `deactivateLane` (`src/lanes/registry.ts`), and `loadWorkspaceLanesConfig` seeds from `config/lanes/*.yml` with a FILES fallback. So the six lanes work out of the box.

What is missing is any way for a non-coder to see, clone, edit or disable them. The editing scripts live on an unmerged branch.

**Build:** a Lanes screen (list active, clone, edit thresholds/concepts, disable, republish) over the registry functions that already exist. Keep YAML as the Track A path.

### 10. `setup/status` reports success while the pipeline is still dead

`isComplete` (`setupRouter.ts:132-137`) only checks DB connected + migrations applied + an AI key + model routes. It ignores Gmail, SearchAPI, profile and lanes. The wizard therefore declares victory on an app that will ingest nothing and rank nothing.

**Fix:** extend status to every prerequisite and render a blocking checklist on the dashboard ("3 of 6 connected — Gmail not connected") instead of a bare empty state.

### 11. No "why is my shortlist empty" diagnostics

The Sources and Tasks views are read-only tables. When a fresh install produces zero jobs, nothing tells the user which of the six prerequisites is missing.

---

## P2 — Track A. The forkable repo and the one-command install.

### 12. No single install command

Today: clone → `npm ci` → `cp .env.example .env.local` → hand-edit → `npm run db:init` → `npm run desktop:dev` — and step 3 of that is documented wrong (§2). `npm run dev:setup` exists but spins up Docker Postgres (`scripts/dev_setup.ts`), which contradicts the Neon-first story.

**Build:** `npm run setup` that (a) checks Node version, (b) installs, (c) prompts for `DATABASE_URL`, (d) derives the unpooled URL, (e) runs migrations, (f) seeds embedding spaces + lanes, (g) validates the provider key, (h) prints next steps. Neon path with no Docker; keep Docker as an opt-in flag for contributors.

### 13. `.env.example` is out of sync

- Missing `ALLOW_AI_EVALUATION` and `ALLOW_DOCUMENTS`, which `docs/quickstart.md:82-83` says are required.
- Missing all `SEARCHAPI_*` variables (they exist on the feature branch).
- No variable for a custom provider base URL (§7).

### 14. Repo hygiene

Not tracked (good — `.gitignore` covers them): `.claude/`, `.worktrees/` (26 checkouts), `private/`, `_closeout_pack_*`, `dist/`, `build/`, `master_profile.json`, `my_profile.md`, `.env.local`.

Still worth cleaning before a public launch:

- **180+ branches** on `origin`, including process names like `fix/agent67-68-final-postgres` and `worktree-agent-*`. Archive or delete after merging the features that matter (§3).
- `.agents/`, `.github/agents/`, `.github/skills/`, `crewpilot.config.json` — internal agent scaffolding that will confuse external contributors.
- Confirm the publish target. `package.json` points at `elenaokhonko-eng/Job-Decision-Engine` while this workspace is `Job-Decision-Engine-1`; badge URLs, download links and `publish` must all agree.
- `CODE_SIGNING_POLICY.md` and the SignPath badge make a signing claim — only keep it if releases are actually signed.

### 15. Decide and document the Streamlit split

Seven `streamlit_*.py` modules (main file 2,941 lines) plus `.streamlit/secrets.toml.template` — a second surface with its own DB/API configuration. Shipping both to a rookie is a fork in the road at the worst moment.

**Recommendation:** Electron is the only thing a rookie installs. Streamlit is documented as an optional results dashboard for power users, in its own section of the README with its own setup path.

---

## Suggested order

1. ~~**Land the pipeline on `main`** (§3)~~ — already done; §3 was a stale-checkout error.
2. **Fix the package** (§1) — done on PR #170, including a packaging assertion that fails if `config/` is dropped again. Still needs **one real `.exe` install on a clean machine** to confirm.
3. **Fix the docs** (§2, §13) — done on PR #170.
4. **Green CI** (§4) — done on PR #170.
5. **`npm run setup`** (§12) — done on PR #170; Docker path needs a re-test against a container with a published port.
6. **Provider abstraction** (§7, §8) — the largest remaining piece. Unblocks "any LLM".
7. **Wizard v2**: profile (§5), Gmail OAuth (§6), lanes (§9), readiness checklist (§10, §11) — closes Track B.
8. **Repo hygiene** (§14, §15) immediately before the public flip.


---

## Not verified in this review

- I did not build or install the packaged `.exe`; §1 is established from the packaging config and the on-disk bundle contents, not from watching a packaged app fail.
- I did not run `npm test` or the pytest suite.
- Model IDs in the defaults were not checked against live provider model lists (§8).
