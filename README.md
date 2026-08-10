# Job Decision Engine — High-Autonomy Technical Architect & Builder

[![Deploy to Streamlit](https://static.streamlit.io/badges/streamlit_badge_black_white.svg)](https://share.streamlit.io)
[![GitHub License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js CI](https://github.com/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/job_ingestion_cron.yml/badge.svg)](https://github.com/elenaokhonko-eng/Job-Decision-Engine/actions)

An automated, multi-stage **AI Career Architect & Workplace Evaluation Engine** designed for **Software Architects, SME Engineers, and High-Autonomy Builders**. 

This system ingests job descriptions directly from **Gmail Job Alerts** (LinkedIn, MyCareersFuture, eFinancialCareers), parses live careers portal URLs, stages raw records in a serverless PostgreSQL vault ([Neon.tech](https://neon.tech)), and evaluates each opportunity through a weighted multi-axis AI agent (powered by LLM APIs).

---

## 🎯 What the Engine Evaluates

The engine rates opportunities on a **100-Point Scale** tailored for high-focus technical experts who thrive in low-bureaucracy, high-autonomy environments.

### ⚖️ Weighted Evaluation Axes (100 Points Total)

| Axis | Weight | Key Evaluation Criteria |
|---|:---:|---|
| **1. Environmental & Biological Guardrails** | **30%** | WFH/Remote flexibility, asynchronous communication culture, minimal forced social/sensory overload, low office politics. |
| **2. Technical & Creative Autonomy** | **25%** | SME expert authority, hands-on architecture, modern stack (FE, BE, DB/SQL), complex solutioning. Exclusion of micromanagement, low-frequency coding, or legacy C/C++ roles. |
| **3. Domain Relevance & Impact** | **20%** | **Track A**: Institutional finance, private banking, wealth management, supranational funds (GIC/Temasek), AI startups.<br>**Track B**: Bioinformatics, pharmaceutical research, and plant-based medical research. |
| **4. Compensation & Capital Potential** | **15%** | Alignment with high-yield executive/SME pay bands (Baseline ≥ SGD $22,000 / month). |
| **5. Future-Proofing & Domain Growth** | **10%** | Growth domain trajectory (AI, ML, Data Science vs dying technical domains), industry growth trajectory, and job-specific career progression. |

---

### 🚫 Automatic Disqualifiers & Red Flags (Score forced to 0)

The engine automatically **REJECTS** opportunities that exhibit high administrative overhead or restrictive organizational structures:

1. **Restricted Entities**:
   - Local Singapore Retail/Commercial Banks (*DBS, UOB, OCBC*).
   - Specific Insurance / Asset Managers (*AIA, AIAIM*).
   - Specific Recruitment Agency Postings (*Argyll Scott*).
2. **High-Stress Operational Overheads**:
   - Heavy stakeholder management without formal authority.
   - High non-reportee influence overhead.
   - Dual-hat roles requiring technical engineering + quota-carrying sales/presales.
   - Travel requirements exceeding 10–15%.

---

## 🏗️ System Architecture

```
                    ┌─────────────────────────┐
                    │   Gmail Job Alerts      │
                    └───────────┬─────────────┘
                                │ (IMAP Sync)
                                ▼
                    ┌─────────────────────────┐
                    │  Serverless Postgres    │
                    │   (raw_email_alerts)    │
                    └───────────┬─────────────┘
                                │ (URL Extraction)
                                ▼
                    ┌─────────────────────────┐
                    │      raw_jobs           │
                    │    Staging Table        │
                    └───────────┬─────────────┘
                                │ (AI Evaluation & Scoring)
                                ▼
                    ┌─────────────────────────┐
                    │       jobs &            │
                    │    companies Vault      │
                    └───────────┬─────────────┘
                                │ (Live Analytics)
                                ▼
                    ┌─────────────────────────┐
                    │   Streamlit Console     │
                    └─────────────────────────┘
```

---

## 🔧 Recent Improvements & Production Fixes
We regularly patch and optimize the engine. Recent stability updates include:
1. **JSONB Alignment on Manual Add**: Manually submitted jobs via Streamlit are structured into JSON strings before insertion, aligning with Postgres `JSONB` schemas to eliminate ingestion exceptions.
2. **Postgres Driver Deserialization Compatibility**: Refactored `evaluate_jobs.ts` to seamlessly handle both pre-parsed object types and raw strings for database description fields.
3. **LinkedIn Scraper Expiry Bypass**: Bypasses the guest scraper's 404/expired checks when a valid description has already been staged (e.g., from manual adds or previous successful scrapes), preventing low-score rejects on active roles.
4. **IMAP Dual Folder Purge**: The cleanup phase now connects to Gmail and expunges both the `Jobs-Alerts` and `Jobs-Alerts-Processed` folders to resolve duplicate labeling and prevent mail loops.
5. **Speed Optimization (3s Sleep)**: Set `EVAL_SLEEP_MS: 3000` to speed up the ingestion and evaluation of large backlogs on GitHub Actions.
6. **OpenAI Failover Integration**: Configured OpenAI as a fallback provider within workflows to guarantee seamless pipeline runs even during Gemini 429 rate limit events.

---

## 🛠️ Production Deployment Guide (Streamlit Community Cloud)

You can deploy the Streamlit Console to **Streamlit Community Cloud (`share.streamlit.io`)** for **FREE** in under 3 minutes:

### Step 1: Fork & Push Code to GitHub
Fork this repository to your GitHub account.

### Step 2: Connect Streamlit Community Cloud
1. Navigate to **[share.streamlit.io](https://share.streamlit.io)** and log in with GitHub.
2. Click **"Create app"** $\rightarrow$ **"Use existing repo"**.
3. Select your repository (`your-username/Job-Decision-Engine`).
4. Set **Main file path** to `streamlit_app.py`.

### Step 3: Configure Streamlit Cloud Secrets
In the deployment setup screen, click **"Advanced settings..."** $\rightarrow$ **"Secrets"**, and paste your environment variables in TOML format:

```toml
DATABASE_URL = "postgresql://neondb_owner:YOUR_NEON_PASSWORD@ep-xxx.neon.tech/neondb?sslmode=require"
GEMINI_API_KEY = "AIzaSy..."
OPENAI_API_KEY = "sk-proj-..."
OPENAI_MODEL = "gpt-4o-mini"
GMAIL_USER = "your.email@gmail.com"
GMAIL_APP_PASSWORD = "your-16-char-app-password"
GMAIL_FOLDER = "Jobs-Alerts"
GMAIL_PROCESSED_FOLDER = "Jobs-Alerts-Processed"
```

5. Click **"Deploy!"** Your app will be live on your custom `https://your-app.streamlit.app` URL.

---

## 💻 Local Self-Hosting & Forking Guide

Follow these steps to run the engine on your local machine:

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/elenaokhonko-eng/Job-Decision-Engine.git
cd Job-Decision-Engine

# Install Node.js dependencies
npm install

# Install Python dependencies (for Streamlit dashboard)
pip install streamlit pandas psycopg2-binary
```

### 2. Configure Environment (`.env.local`)
Create a `.env.local` file in the root directory:

```env
DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-xxx.neon.tech/neondb?sslmode=require"
GEMINI_API_KEY="AIzaSy..."
OPENAI_API_KEY="sk-proj-..."
OPENAI_MODEL="gpt-4o-mini"
GMAIL_USER="your.email@gmail.com"
GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx"
GMAIL_FOLDER="Jobs-Alerts"
GMAIL_PROCESSED_FOLDER="Jobs-Alerts-Processed"
```

### 3. Setup Database (Neon Postgres or Supabase)
Initialize database schema tables by running:
```bash
npm run db:init
```

### 4. Setup Gmail Job Alerts Label
1. Log into Gmail $\rightarrow$ Settings $\rightarrow$ Labels $\rightarrow$ Create label **`Jobs-Alerts`**.
2. Create label **`Jobs-Alerts-Processed`**.
3. Generate a 16-character **App Password** under Google Account Security $\rightarrow$ 2-Step Verification $\rightarrow$ App Passwords.

### 5. Launch Local Console
```bash
streamlit run streamlit_app.py
```
Open `http://localhost:8501` in your browser.

---

## 🧪 Testing & Validation

```bash
# Run unit test suite (Vitest)
npm run test

# Run LLM evaluation benchmark harness
npm run eval:golden
```

---

## 📜 License
Distributed under the **MIT License**. See `LICENSE` for more information.
