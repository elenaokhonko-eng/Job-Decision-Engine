# Job Decision Engine

[![CI](https://github.com/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/ci.yml/badge.svg)](https://github.com/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A TypeScript + PostgreSQL pipeline that ingests job observations, applies deterministic hard gates, routes jobs into target lanes, evaluates a bounded shortlist with LLMs, and supports evidence-grounded document generation.

## Current Architecture

Pipeline flow:

`source adapters + Gmail -> raw observations -> canonical jobs + versions -> hard gates -> lane routing -> budget queue -> AI evaluation -> shortlist read model -> documents`

Target lanes:

1. CORE_AI_DATA
2. LEGAL_REGTECH
3. HEALTH_BIO_PHARMA
4. INVESTMENT_MARKETS_FINTECH

Supported shared collectors include Gmail, Greenhouse, Ashby, Lever, Himalayas, Jobicy, Remotive, and attributed We Work Remotely RSS. All sources enter the same validated observation pipeline; lane logic never scrapes sources directly.

## Core Behavior Guarantees

1. Operational failures are not career rejections.
2. Unknown workability facts stay as `NEEDS_VERIFICATION`.
3. Queue evaluation failures go to `RETRY_WAIT` with backoff, then `NEEDS_MANUAL_REVIEW` when attempts are exhausted.
4. Read models are version-pinned through canonical `job_version_id` joins.
5. AI output must pass schema and identity validation before persistence.

## Local Setup

1. Install dependencies:

```bash
npm ci
```

2. Configure `.env.local` from [.env.example](.env.example).

3. Initialize database schema:

```bash
npm run db:init
```

4. Run checks:

```bash
npm run lint
npm test
```

## Runtime Scripts

1. Run migrations/init:

```bash
npm run db:init
```

2. Process queue evaluations:

```bash
npx tsx scripts/evaluate_queue.ts
```

3. Run end-to-end discovery stages:

```bash
npx tsx scripts/ingest_gmail.ts
npx tsx scripts/parse_emails.ts
npx tsx scripts/run_adapters.ts
npx tsx scripts/process_pipeline.ts
npx tsx scripts/evaluate_queue.ts
```

4. Generate documents:

```bash
npm run docs:cv
npm run docs:cover-letter
```

## GitHub Workflows

1. CI: [.github/workflows/ci.yml](.github/workflows/ci.yml)
2. Ingestion: [.github/workflows/ingest.yml](.github/workflows/ingest.yml)
3. Queue worker: [.github/workflows/queue_worker.yml](.github/workflows/queue_worker.yml)
4. Documents: [.github/workflows/documents.yml](.github/workflows/documents.yml)

## Required Secrets

1. `DATABASE_URL`
2. `GMAIL_USER`
3. `GMAIL_APP_PASSWORD`
4. At least one of `GEMINI_API_KEY` or `OPENAI_API_KEY`
5. `MASTER_PROFILE_JSON` for document workflows

## Notes For Open-Source Usage

1. Keep personal profile data and private preference policies outside public defaults.
2. Public ledgers and fixtures are anonymized examples; place real overrides under ignored private paths.
3. Prefer canonical scripts in `scripts/` and contracts in `src/contracts/`.

## Documentation

1. [Architecture](docs/architecture.md)
2. [Source adapters](docs/source-adapters.md)
3. [Data contracts](docs/data-contracts.md)
4. [Release runbook](docs/release-runbook.md)
5. [Contributing](CONTRIBUTING.md)
6. [Security](SECURITY.md)

## License

MIT. See [LICENSE](LICENSE).
