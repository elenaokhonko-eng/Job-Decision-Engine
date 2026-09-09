# Quickstart (Engineers + Non‑Engineers)

This repo is meant for:

- Engineers/builders who want a reliable, auditable job-scanning pipeline.
- Neurodivergent/AuDHD users (including non-engineers) who want a predictable workflow that keeps *unknowns* visible and never turns operational failures into “career rejections”.

## What It Does

```mermaid
flowchart LR
  A[Sources] --> B[Job Vault]
  B --> C[Deterministic gates]
  C --> D[Lane routing + matching]
  D --> E[AI evaluation (retry-safe)]
  E --> F[Shortlist UI + documents]
```

## Non‑Engineer Path (GitHub Actions)

1. Fork the repository.
2. In your fork, open **Settings → Secrets and variables → Actions**.
3. Set at least:
   - `DATABASE_URL`
   - `OPENAI_API_KEY` or `GEMINI_API_KEY` (or both)
4. Run **Actions → Job Discovery Ingestion → Run workflow**.
5. Open Streamlit locally (optional) to browse results, or query the read model `v_canonical_shortlist`.

## Engineer Path (Local)

1. Install Node.js and dependencies:

```bash
npm ci
```

2. Create `.env.local` from `.env.example` and set `DATABASE_URL`.

3. Initialize schema + seed baseline:

```bash
npm run dev:setup
npm run sources:sync
```

4. Run the Streamlit console:

```bash
streamlit run streamlit_app.py
```

### Hosted Streamlit

For Streamlit Cloud, add `DATABASE_URL`, `WORKSPACE_KEY`, and `WORKSPACE_USER_KEY` to the app secrets. The app first uses `JDEC_API_BASE_URL` when it points to a reachable API; if that API is unavailable, shortlist and rejected-job reads fall back to the canonical PostgreSQL read models in read-only mode. Do not set `JDEC_API_BASE_URL` to `localhost`, `127.0.0.1`, or `0.0.0.0` unless the API is running inside the same process environment. API-backed mutations still require a reachable API endpoint.

## Troubleshooting

- If Gemini embeddings fail with `404 NOT_FOUND` / `embedContent` errors, run:

```bash
npm run gemini:models
```

Then set `EMBEDDING_PRIMARY_MODEL` to a model supporting `embedContent` (the default is `gemini-embedding-001`), and optionally set `GEMINI_API_VERSION` (e.g. `v1beta`).
