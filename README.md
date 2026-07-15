# Job Decision Engine - Multi-Stage Weighted AI Agent

Welcome to the **Job Decision Engine** dashboard! This full-stack application is custom-built to automate the tracking, filtering, ranking, and strategic evaluation of job advertisements from **LinkedIn**, **MyCareersFuture.gov.sg**, and **eFinancialCareers**. 

It is tailored for a highly specialized 44-year-old 2E auDHD executive technologist with 20+ years of IT architecture experience, bridging immediate financial milestones (accumulating an additional $1M SGD over 3–4 years in FinTech) with long-term scientific research aspirations (a transition toward a pharmaceutical or botanical bio-tech PhD in the Netherlands).

---

## 🧭 How an Agent Differs from a Single Prompt → Response Call

In traditional generative AI applications, a user makes a **single prompt → response call**. The LLM receives static text, evaluates it against its static pre-trained weights, and yields an output. It cannot look up real-time facts, search databases, or perform calculations beyond its immediate context window.

An **AI Agent**, however, is **autonomous and action-driven**:
1. **Dynamic Execution Loop**: Instead of immediately answering, the LLM analyzes the query and decides whether it needs extra information.
2. **Tool-Calling Capabilities**: The agent is equipped with native tools. In this application, the agent has access to:
   - `queryDatabaseForJobs`: A tool to query our persistent simulated Postgres database for job vacancies.
   - `fetchExternalMarketRates`: A tool that calls an external REST API (fetching Bitcoin prices from Coindesk as an integration proof, plus loading localized monthly salary statistics for Singapore).
3. **Multi-Turn Reasoning**: The agent calls these tools, processes their returns, and feeds the resulting context back into its reasoning loop. It iterates until it has all necessary data to formulate a fully grounded, multi-stage assessment.

---

## 🛠️ Multi-Stage Weighted Decision Engine

To protect the candidate’s cognitive and physical well-being (managing auDHD sensory and political load), the agent routes and scores every job description through three logical gates:

### Gate 1: Absolute Disqualifiers (Pass/Fail)
The role is instantly set to `REJECTED` (with a score of 0) if it triggers any high-stress or client-wrangling parameters:
* Travel exceeding 10%.
* Traditional non-coding Program/Project Management or Scrum Master profiles.
* Sales, Presales, or quota-carrying relationship management.
* Office attendance exceeding 3 days per week (unless in a pure lab environment).
* High organizational politics, ambiguity, or heavy presentation overhead.

### Gate 2: Dual-Track Domain Routing
Categorizes valid roles into:
* **Track A (Capital Accumulation)**: Institutional finance, asset management AI, or RegTech (Base target ≥ $20,000 SGD/month).
* **Track B (Research Pivot)**: Bioinformatics, pharmaceutical research, or agricultural/plant data analysis.

### Gate 3: Weighted Multi-Point Scoring (100-Point Scale)
Scores opportunities across 5 distinct axes:
1. **Technical & Creative Autonomy (30%)**: Hands-on systems, Python, agentic RAG.
2. **Compensation & Capital Accumulation (25%)**: Top-tier bands aligned with the $1M goal.
3. **Domain Relevance (20%)**: Direct alignment with Track A or Track B.
4. **Environment & Biological Guardrails (15%)**: Autonomy, asynchronous culture, low politics.
5. **Future-Proofing & Netherlands Mobility (10%)**: Ties to European markets, EU AI Act, or academia.

---

## 🧪 How to Know It Still Works

We have implemented a dual-layer validation framework to ensure total operational safety.

### 1. Unit & Integration Tests (Vitest)
Run the test suite using:
```bash
npm run test
```
The suite runs 5 high-value sequential tests:
* **Test 1: Seed Read Verification**: Guarantees that our persistent simulated Postgres database initializes and reads seeded job entries correctly.
* **Test 2: Add Job (Write path)**: Ensures that custom-pasted or imported job advertisements are successfully added to the database.
* **Test 3: Delete Job (Delete path)**: Protects against data retention issues and verifies record cleanup.
* **Test 4: Interaction Logger**: Verifies that every question, selected tool, and final structured response is logged to the Postgres-like audit trail.
* **Test 5: Loud-Fail Config Guard**: Simulates a blank environment to ensure the app fails loud immediately with a helpful configuration warning if `GEMINI_API_KEY` is missing.

### 2. LLM Evaluations (`llm-evals`)
Run the evaluation harness using:
```bash
npx tsx scripts/run_evals.ts
```
**Why Evals Differ from Unit Tests**: 
* A unit test checks if the *code* compiles and returns a status. The code can be 100% correct while the AI's *answers* are poor, off-target, or hallucinated.
* The evaluation harness sends **10 Golden Questions** from `golden_questions.yaml` to the live agent and asserts logical properties of the response (verifies JSON schema integrity, min/max score constraints, presence of disqualifiers, and track routing correctness) rather than matching exact strings. It prints a pass/fail scorecard.

---

## 📂 Configuration and Workspace Rules

This workspace includes an `.agents/` configuration containing:
* **`rules/explain-before-fix.md`**: Enforces explaining the root cause of compilation or logic bugs before proposing any visual edits.
* **`rules/cite-the-code.md`**: Mandates citing specific lines and files during reviews.
* **`skills/`**: Customized helper guides for request tracing (`trace-request.md`), code reviews (`code-quality-review.md`), and codebase training (`teach-this-code.md`).

---

## 🚀 Quick Start

You can run the application either as a highly responsive **React + Express SPA** or as a **Python Streamlit Dashboard**. Both environments read and update the exact same file-backed simulated PostgreSQL database database (`data/postgres_db.json`)!

### Choice A: Custom React + Express Web App (Default)

1. **Verify Setup**:
   ```bash
   ./scripts/verify_setup.sh
   ```
2. **Run Development Mode** (Vite + Express on Port 3000):
   ```bash
   npm run dev
   ```
3. **Compile / Build**:
   ```bash
   npm run build
   ```

### Choice B: Python Streamlit Dashboard (Companion Console)

Perfect for Python developers or quick Streamlit-native cloud deployment:
1. **Install Dependencies**:
   ```bash
   pip install streamlit pandas
   ```
2. **Run Streamlit Server**:
   ```bash
   streamlit run streamlit_app.py
   ```
