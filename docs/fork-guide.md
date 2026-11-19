# Fork guide

Everything needed to run your own copy of Job Decision Engine, from fork to a
working pipeline. This is the developer path; if you do not want to touch a
terminal, use the desktop installer instead (see the main README).

## 1. Fork and clone

Fork the repository on GitHub, then:

```bash
git clone https://github.com/<your-user>/Job-Decision-Engine.git
cd Job-Decision-Engine
npm ci
```

Node 22 or newer is required. `npm ci` installs exactly what `package-lock.json`
pins, which is what CI uses.

## 2. Create a database

Any PostgreSQL 15+ server works — Neon, Supabase, Railway, RDS, a self-hosted
instance, or local Docker. pgvector is required; the Neon and Supabase default
images already have it.

You need two connection strings:

- **pooled** — for the app at runtime (`DATABASE_URL`)
- **unpooled / direct** — for migrations and advisory locks (`DATABASE_URL_UNPOOLED`)

On Neon the pooled host contains `-pooler`. `npm run setup` derives the direct
URL for you when you only paste the pooled one.

No database yet? Start one locally:

```bash
npm run setup -- --docker
```

## 3. Run setup

```bash
npm run setup
```

This single command:

1. checks your Node version
2. takes a PostgreSQL URL, or starts the Docker container
3. applies the migration chain
4. seeds embedding spaces and the six lanes
5. verifies your AI provider key by listing the models it can actually use
6. writes `.env.local` (gitignored), merging rather than overwriting

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--database-url <url>` | Skip the database prompt |
| `--docker` | Start the bundled Postgres container first |
| `--provider gemini\|openai\|openai-compatible` | Choose the transport |
| `--api-key <key>` | Skip the key prompt |
| `--base-url <url>` | Base URL for an OpenAI-compatible endpoint |
| `--yes` | Non-interactive |
| `--skip-provider-check` | Do not call the provider during setup |

`JDEC_ENV_FILE` redirects where the env file is written, which is useful for
testing setup without touching your real configuration.

### AI providers

A provider here is a transport, not a vendor:

- `gemini` — Google Generative Language API
- `openai` — OpenAI, with an optional `OPENAI_BASE_URL` override
- `openai-compatible` — anything that speaks the OpenAI API shape: Ollama, LM Studio, vLLM, Groq, Together, OpenRouter, Moonshot/Kimi, DeepSeek, a self-hosted gateway

For a local model server:

```bash
npm run setup -- --provider openai-compatible \
  --base-url http://127.0.0.1:11434/v1 \
  --api-key local
```

The runtime reads `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY`,
so configuring it once covers evaluation, extraction, documents and embeddings.

## 4. Add your profile and lanes

```bash
mkdir -p private/profile
cp templates/profile/evidence_sources.template.json private/profile/evidence_sources.json
# edit it with your own career facts
npm run profile:import
```

`private/` is gitignored, so your career facts never get committed.

The six shipped lanes live in `config/lanes/`. To add or replace one, copy
`templates/lanes/lane.template.yml`, register it in `config/lanes/registry.yml`,
and re-seed. See `templates/README.md`.

## 5. Launch

In VS Code, `Terminal → Run Task` gives you **Setup**, **Tests**, **Lint**,
**API + Streamlit**, **Desktop app** and **Desktop packaging check**. `F5` runs
the API server or the Electron app from `.vscode/launch.json`.

From a terminal:

```bash
npm run desktop:dev   # Electron app
npm run dev           # API + web UI on http://127.0.0.1:3000
npm test              # vitest suite
```

The Streamlit dashboard is the results view and needs the Python dependencies:

```bash
pip install -r requirements.txt
streamlit run streamlit_app.py
```

See [the Streamlit dashboard](streamlit-dashboard.md) for how it fits alongside
the Electron app.

## 6. Optional: automated ingestion on GitHub Actions

The workflows in `.github/workflows/` run the pipeline on a schedule. They are
optional — you can run everything locally — but if you want them, add these in
your fork under **Settings → Secrets and variables → Actions**.

**Secrets** (never printed, never in the repo):

| Secret | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Pooled runtime connection |
| `DATABASE_URL_UNPOOLED` | yes | Direct connection for migrations |
| `GEMINI_API_KEY` | one provider | Google AI Studio key |
| `OPENAI_API_KEY` | one provider | OpenAI key |
| `GMAIL_OAUTH_CLIENT_ID` | for Gmail | Gmail API OAuth client |
| `GMAIL_OAUTH_CLIENT_SECRET` | for Gmail | Gmail API OAuth client |
| `GMAIL_OAUTH_REFRESH_TOKEN` | for Gmail | Refresh token for the alert mailbox |
| `SEARCHAPI_API_KEY` | for LinkedIn discovery | searchapi.io key |

**Variables** — most have sane defaults. The ones that change behaviour:

| Variable | Default | Effect |
| --- | --- | --- |
| `WORKFLOW_KILL_SWITCH` | unset | Set to `true` to stop all ingestion |
| `PILOT_MODE` | unset | Set to `true` to stop scheduled runs |
| `SEARCHAPI_LINKEDIN_ENABLED` | `false` | Must be `true` to spend SearchAPI credits |
| `SEARCHAPI_DAILY_CREDIT_CAP` | `60` | Hard daily credit ceiling |
| `GMAIL_FOLDER` | `Jobs-Alerts` | Gmail label holding job alerts |

SearchAPI costs one credit per call and is off by default for that reason. Leave
it off unless you specifically want LinkedIn search on top of Gmail alerts and
the saved-jobs import.

## Troubleshooting

**`Missing script: migrate`** — that command does not exist. The migration entry
point is `npm run setup` (or `npm run db:init` for migrations alone).

**Migrations fail with a pooler error** — advisory locks need a direct
connection. Set `DATABASE_URL_UNPOOLED` to the host without `-pooler`.

**Setup says the provider key is invalid** — it lists the models the key can see.
If that call fails, the key or the base URL is wrong; nothing is written until it
succeeds.

**The app opens but the shortlist is empty** — check
`GET /api/v2/setup/status`. It returns a `prerequisites` checklist covering
database, provider, model routes, lanes, profile and ingestion, plus
`blockingPrerequisites`, so you can see which one is missing instead of guessing.

**Lanes are missing or my lane edits do nothing** — config is read from
`config/`, resolved in this order: `JDEC_CONFIG_DIR`, then the packaged
`resources/config`, then the repository. A `JDEC_CONFIG_DIR` that does not
contain `lanes/registry.yml` is rejected rather than silently ignored.

**Vitest fails with `Cannot read properties of undefined (reading 'config')`** —
that is a known incompatibility between this vitest version and Node 24. Use
Node 22, which is what CI pins.
