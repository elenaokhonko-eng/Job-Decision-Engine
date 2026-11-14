# Quickstart & Distribution Modes

Job Decision Engine is a **standalone desktop application** and local pipeline engine. Each user connects their own private [Neon PostgreSQL](https://neon.tech) database and supplies their own AI provider credentials (Google Gemini or OpenAI).

There is **no requirement** for a hosted SaaS backend, Render deployment, cloud account operated by the repository owner, or developer-supplied API tokens.

```mermaid
flowchart LR
  subgraph Local Desktop [User Desktop Device]
    App[Desktop App UI] <--> Loopback[Local Companion Engine\n127.0.0.1]
    Loopback <--> Keychain[OS Secure Storage\nDPAPI / Keychain]
  end
  subgraph User Cloud [User's Own Cloud Accounts]
    Loopback <--> Neon[(User's Neon Postgres)]
    Loopback <--> AI[User's AI API\nGemini / OpenAI]
  end
```

---

## Distribution Mode 1: Non-technical Users (Desktop Installer)

This mode requires **no terminal, no Node.js installation, no server commands, and no port configuration**.

### 1. Download & Install
1. Go to the [GitHub Releases](https://github.com/elenaokhonko-eng/Job-Decision-Engine/releases) page.
2. Download the installer for your operating system:
   - **Windows**: `Job-Decision-Engine-Setup-*.exe`
   - **macOS**: `Job-Decision-Engine-*.dmg`
   - **Linux**: `Job-Decision-Engine-*.AppImage` or `.deb`
3. Run the installer and open **Job Decision Engine**.

### 2. Complete the Guided Setup Wizard
On first launch, the app launches an interactive 5-step setup wizard:
1. **Welcome**: Overview of local privacy and architecture.
2. **Neon Database**:
   - Create a free project at [neon.tech](https://neon.tech).
   - Paste your Neon connection string. The app tests connection latency and automatically derives the direct unpooled URL for migrations.
3. **AI Provider Credentials**:
   - Provide your **Google Gemini** API key (from Google AI Studio) or **OpenAI** API key.
   - Click "Test Credentials" to verify live model availability and quota.
4. **Model Routing**: Select your preferred AI preset (Google Gemini 1.5 Flash or OpenAI GPT-4o-mini).
5. **Schema Initialization**: Click "Initialize Database & Run Migrations". The app bundles and runs all database migrations directly into your database and registers default vector embedding spaces.

All credentials are saved locally in OS-backed secure storage (Windows Credential Manager / macOS Keychain / Linux Secret Service) and are never transmitted to third-party servers.

---

## Distribution Mode 2: Technical Users (Developer / Local Clone)

Developers and technical users can clone or fork the repository and run the engine locally.

### 1. Prerequisites
- Node.js 20+ or 22+
- npm or pnpm
- A Neon PostgreSQL database

### 2. Setup Environment
```bash
# 1. Clone repository
git clone https://github.com/elenaokhonko-eng/Job-Decision-Engine.git
cd Job-Decision-Engine

# 2. Install dependencies
npm ci

# 3. Configure local environment
cp .env.example .env.local
```

Edit `.env.local` with your credentials:
```env
# Neon PostgreSQL database connections
DATABASE_URL=postgresql://user:password@ep-xyz-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://user:password@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require

# AI Provider API Keys (at least one required)
GEMINI_API_KEY=your_gemini_api_key_here
# OPENAI_API_KEY=your_openai_api_key_here

# User Consents (required for AI evaluation and document synthesis)
ALLOW_AI_EVALUATION=true
ALLOW_DOCUMENTS=true

```

### 3. Initialize Database & Run Migrations
```bash
# Run schema migrations (001 through 046)
npm run migrate

# Initialize embedding spaces and model routes
npm run embeddings:registry:init
```

### 4. Run the Desktop Application
```bash
# Run Electron desktop app in development mode
npm run desktop:dev

# Or run the local web frontend + companion API server
npm run dev
```

### 4b. Run the Streamlit Dashboard With Its API (one command)
```bash
npm run workspace
```

This starts the managed API on `127.0.0.1` (port 3000), waits until its authenticated
`/api/v2/health` answers, then starts Streamlit (`http://127.0.0.1:8501`) pointed at it. Closing
either process, or pressing Ctrl+C, stops both. Without it, `python -m streamlit run streamlit_app.py`
shows read-only data, and actions such as **Add to tracker**, **Prepare application documents**
and the technical-error actions report that the local API isn't running.

- The API token is `JDEC_API_TOKEN` from the environment or `.env.local`; when neither sets one, a
  random token is generated for the session. It is passed to both processes through their
  environment and is never printed.
- Options: `JDEC_WORKSPACE_API_PORT` (default 3000), `JDEC_WORKSPACE_STREAMLIT_PORT` (default
  8501), `JDEC_PYTHON` (default `python` on Windows, `python3` elsewhere).
- Python needs the packages in `requirements.txt` (`pip install -r requirements.txt`).

### Dashboard statuses
The sidebar splits every current job into one status (`v_job_status_buckets_scoped`):
**Rejected** (failed a hard workability gate), **Unmatched** (passed the gates, but no target lane
fits or a mandatory qualification is missing), **Removed** (you removed or dismissed it), and the
jobs between the gates and Apply Now: **Review (awaiting AI)**, **Review (evaluated, not ready)**,
**Track (below review threshold)**, **Needs verification**, **Skip** and **Processing**. The
sidebar's "What do these statuses mean?" explains each. Technical errors list the actions that
resolve each kind of error (fetch or paste the full description, retry, or dismiss); every action is
recorded in `job_support_actions`.

### 5. Verification & Testing
```bash
# Run unit and integration tests
npm test

# Run desktop packaging verification (verifies local bundle, safeStorage, and packaged migrations)
npm run desktop:verify

# Run standalone desktop E2E gate check
npm run desktop:e2e-gate
```

---

## Security & Architecture Invariants

1. **Local-First & Private**: The app connects directly from your local machine to your private Neon PostgreSQL database. There is no middleman SaaS or hosted intermediary.
2. **Bring Your Own Keys (BYOK)**: All AI evaluation and embedding generation uses your personal API keys.
3. **OS Secure Storage**: Desktop secrets (`DATABASE_URL`, `GEMINI_API_KEY`, `OPENAI_API_KEY`) are encrypted using Electron's `safeStorage` API backed by OS primitives.
4. **Deterministic Invariants**: Infrastructure errors, timeouts, or API quota limits never become job rejections. Non-fits are eliminated by deterministic rules before AI evaluation.
