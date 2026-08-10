import os
import sys
import subprocess
import urllib.request
import json
import psycopg2
from psycopg2.extras import RealDictCursor
import datetime
import pandas as pd
import streamlit as st
import docx
from fpdf import FPDF
from io import BytesIO

# Load environment variables from Streamlit secrets, .env, and .env.local
def load_dotenv():
    # Load from Streamlit Cloud Secrets if available
    try:
        if hasattr(st, "secrets") and st.secrets:
            for key, val in st.secrets.items():
                if isinstance(val, str):
                    os.environ[key] = val
    except Exception:
        pass

    # Load from local .env and .env.local files
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for name in [".env", ".env.local"]:
        filename = os.path.join(script_dir, name)
        if os.path.exists(filename):
            with open(filename, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, val = line.split("=", 1)
                        val = val.strip("'\"")
                        os.environ[key.strip()] = val

load_dotenv()


# Configure the page setting with modern style
st.set_page_config(
    page_title="Job Decision Engine - High-Autonomy Career Architect",
    page_icon="💼",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom dark-theme styling for professional visual aesthetics
st.markdown("""
<style>
    .reportview-container {
        background-color: #0F0F0F;
    }
    .metric-card {
        background-color: #161616;
        border: 1px solid #2A2A2A;
        padding: 15px;
        border-radius: 10px;
        text-align: center;
    }
    .title-accent {
        color: #D4AF37;
        font-family: 'serif';
    }
    .disclaimer {
        font-family: monospace;
        font-size: 11px;
        color: #888888;
    }
    .top-rec-card {
        background-color: #1a1a24;
        color: #e0e0e0;
        border-left: 5px solid #22c55e;
        padding: 15px;
        margin-bottom: 12px;
        border-radius: 6px;
    }
    .top-rec-card h4 {
        color: #ffffff;
        margin-top: 0;
        margin-bottom: 8px;
    }
    .top-rec-card p {
        color: #cccccc;
        margin-bottom: 4px;
        font-size: 14px;
    }
</style>
""", unsafe_allow_html=True)

# Neon Database Helper
def get_db_connection():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        st.error("❌ DATABASE_URL environment variable is missing. Please set it in your environment or Streamlit Secrets.")
        st.stop()
    
    # Ensure sslmode=require for Neon serverless Postgres
    if "sslmode=" not in database_url and "localhost" not in database_url and "127.0.0.1" not in database_url:
        if "?" in database_url:
            database_url += "&sslmode=require"
        else:
            database_url += "?sslmode=require"
            
    return psycopg2.connect(database_url)

def fetch_jobs_from_db():
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute("""
            SELECT id, title, company_name as company, source, raw_description as description, 
                   salary_range as "salaryRange", posted_date::text as "postedDate", location, 
                   careers_portal_url, status, assigned_track, confidence_level, total_score,
                   score_technical_autonomy, score_compensation_potential, score_domain_relevance,
                   score_environment_guardrails, score_future_mobility,
                   nd_friendly_score, politics_stress_score, sensory_overload_index,
                   biological_stress_risk, strategic_value, recommended_cv_version, next_action
            FROM jobs 
            ORDER BY total_score DESC, created_at DESC
        """)
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [dict(r) for r in rows]
    except Exception as e:
        st.error(f"Failed to fetch jobs from database: {e}")
        return []

def delete_job_from_db(job_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get company ID before deletion to update ratings
        cursor.execute("SELECT company_id FROM jobs WHERE id = %s", (job_id,))
        row = cursor.fetchone()
        company_id = row[0] if row else None
        
        cursor.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
        
        # If company existed, recalculate metrics
        if company_id:
            cursor.execute("""
                SELECT 
                  AVG(nd_friendly_score) as avg_nd,
                  AVG(politics_stress_score) as avg_pol,
                  AVG(sensory_overload_index) as avg_sens,
                  AVG(score_environment_guardrails) as avg_focus
                FROM jobs 
                WHERE company_id = %s AND status != 'UNASSIGNED'
            """, (company_id,))
            stats = cursor.fetchone()
            if stats and stats[0] is not None:
                avgND = float(stats[0])
                avgPol = float(stats[1])
                avgSens = float(stats[2])
                avgFocus = float(stats[3])
                isApproved = avgND >= 70 and avgPol < 50
                isToxic = avgPol >= 70 or avgND < 50
                
                cursor.execute("""
                    UPDATE companies SET
                       nd_friendly_avg_score = %s,
                       politics_stress_avg_score = %s,
                       sensory_overload_avg_index = %s,
                       focus_protection_avg_score = %s,
                       is_neurodivergent_approved = %s,
                       is_toxic_culture_blacklisted = %s,
                       updated_at = NOW()
                    WHERE id = %s
                """, (avgND, avgPol, avgSens, avgFocus, isApproved, isToxic, company_id))
            else:
                cursor.execute("DELETE FROM companies WHERE id = %s", (company_id,))
                
        conn.commit()
        cursor.close()
        conn.close()
        st.success("Listing deleted successfully!")
        return True
    except Exception as e:
        st.error(f"Failed to delete job: {e}")
        return False

def save_new_job_to_db(job):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get or create raw company
        cursor.execute("SELECT id FROM raw_companies WHERE name = %s", (job["company"],))
        row = cursor.fetchone()
        if row:
            company_id = row[0]
        else:
            industry = "Life Sciences & Biotech" if "bio" in job["title"].lower() or "pharma" in job["title"].lower() else "Institutional Finance & Asset AI"
            cursor.execute("INSERT INTO raw_companies (name, industry) VALUES (%s, %s) RETURNING id", (job["company"], industry))
            company_id = cursor.fetchone()[0]

        # Package description as structured JSON for the JSONB database column
        structured_desc = {
            "job_description": job["description"],
            "key_responsibilities": [],
            "technical_skills": [],
            "qualifications_education": [],
            "nice_to_haves": []
        }
        description_json = json.dumps(structured_desc)

        cursor.execute("""
            INSERT INTO raw_jobs (
                company_name, title, source, raw_description, salary_range, location, careers_portal_url, processed
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, FALSE)
        """, (
            job["company"], job["title"], job["source"], description_json,
            job.get("salaryRange"), job.get("location", "Singapore"), job["careers_portal_url"]
        ))
        
        conn.commit()
        cursor.close()
        conn.close()
        st.success(f"Successfully added '{job['title']}' to Staging Vault for AI evaluation!")
        return True
    except Exception as e:
        st.error(f"Failed to save job: {e}")
        return False

def convert_markdown_to_docx(md_text):
    doc = docx.Document()
    for line in md_text.split("\n"):
        line = line.strip()
        if not line:
            doc.add_paragraph()
            continue
        if line.startswith("# "):
            doc.add_heading(line[2:], level=1)
        elif line.startswith("## "):
            doc.add_heading(line[3:], level=2)
        elif line.startswith("### "):
            doc.add_heading(line[4:], level=3)
        elif line.startswith("* ") or line.startswith("- "):
            p = doc.add_paragraph(style='List Bullet')
            text = line[2:]
            parts = text.split("**")
            for idx, part in enumerate(parts):
                run = p.add_run(part)
                if idx % 2 == 1:
                    run.bold = True
        else:
            p = doc.add_paragraph()
            parts = line.split("**")
            for idx, part in enumerate(parts):
                run = p.add_run(part)
                if idx % 2 == 1:
                    run.bold = True
    bio = BytesIO()
    doc.save(bio)
    return bio.getvalue()

class PDFResume(FPDF):
    def header(self):
        pass
    def footer(self):
        self.set_y(-15)
        self.set_font('helvetica', 'I', 8)
        self.cell(0, 10, f'Page {self.page_no()}', 0, 0, 'C')

def convert_markdown_to_pdf(md_text):
    pdf = PDFResume()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_font("helvetica", size=10)
    
    for line in md_text.split("\n"):
        line = line.strip()
        if not line:
            pdf.ln(4)
            continue
            
        if line.startswith("# "):
            pdf.set_font("helvetica", "B", 16)
            pdf.cell(0, 10, line[2:], ln=True)
            pdf.ln(2)
        elif line.startswith("## "):
            pdf.set_font("helvetica", "B", 13)
            pdf.cell(0, 8, line[3:], ln=True)
            pdf.ln(1)
        elif line.startswith("### "):
            pdf.set_font("helvetica", "B", 11)
            pdf.cell(0, 6, line[4:], ln=True)
            pdf.ln(1)
        elif line.startswith("* ") or line.startswith("- "):
            pdf.set_font("helvetica", "", 10)
            text = line[2:]
            text_clean = text.replace("**", "")
            pdf.multi_cell(0, 5, f"o  {text_clean}")
        else:
            pdf.set_font("helvetica", "", 10)
            text_clean = line.replace("**", "")
            pdf.multi_cell(0, 5, text_clean)
            
    return bytes(pdf.output())

def python_generate_content(contents, system_instruction=None, response_mime_type=None):
    # Load keys
    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GEMINI_FLASH_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")
    
    # 1. Try Gemini first
    if gemini_key:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={gemini_key}"
            headers = {"Content-Type": "application/json"}
            
            body = {
                "contents": [{"parts": [{"text": contents}]}],
                "generationConfig": {}
            }
            if response_mime_type:
                body["generationConfig"]["responseMimeType"] = response_mime_type
            if system_instruction:
                body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
                
            req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=90) as response:
                res_data = json.loads(response.read().decode("utf-8"))
                text = res_data["candidates"][0]["content"]["parts"][0]["text"]
                return text
        except Exception as gemini_err:
            st.warning(f"⚠️ Gemini request failed: {gemini_err}. Trying OpenAI fallback...")
            
    # 2. Try OpenAI second
    if openai_key:
        try:
            url = "https://api.openai.com/v1/chat/completions"
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {openai_key}"
            }
            messages = []
            if system_instruction:
                messages.append({"role": "system", "content": system_instruction})
            messages.append({"role": "user", "content": contents})
            
            body = {
                "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                "messages": messages,
                "temperature": 1
            }
            if response_mime_type == "application/json":
                body["response_format"] = {"type": "json_object"}
                
            req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=90) as response:
                res_data = json.loads(response.read().decode("utf-8"))
                text = res_data["choices"][0]["message"]["content"]
                return text
        except Exception as openai_err:
            st.warning(f"⚠️ OpenAI request failed: {openai_err}.")
            
    raise Exception("All configured models (Gemini, OpenAI) failed or no API keys are set.")

def ingest_linkedin_saved_json(jobs):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        inserted_count = 0
        skipped_count = 0
        
        for job in jobs:
            title = job.get("title", "").strip()
            company = job.get("company", "").strip()
            url = job.get("url", "").strip()
            description = job.get("description", "").strip()
            location = job.get("location", "Singapore").strip()
            salary = job.get("salary")
            
            if not title or not company or not url or not description:
                skipped_count += 1
                continue
                
            # Check for duplicates in raw_jobs
            cursor.execute("SELECT id FROM raw_jobs WHERE careers_portal_url = %s OR (title = %s AND company_name = %s)", (url, title, company))
            if cursor.fetchone():
                skipped_count += 1
                continue
                
            # Check for duplicates in jobs
            cursor.execute("SELECT id FROM jobs WHERE careers_portal_url = %s OR (title = %s AND company_name = %s)", (url, title, company))
            if cursor.fetchone():
                skipped_count += 1
                continue
                
            # Package description as structured JSON for the JSONB database column
            structured_desc = {
                "job_description": description,
                "key_responsibilities": [],
                "technical_skills": [],
                "qualifications_education": [],
                "nice_to_haves": []
            }
            description_json = json.dumps(structured_desc)
            
            cursor.execute("""
                INSERT INTO raw_jobs 
                (company_name, title, source, raw_description, salary_range, location, careers_portal_url, processed) 
                VALUES (%s, %s, 'LinkedIn', %s, %s, %s, %s, FALSE)
            """, (company, title, description_json, salary, location, url))
            
            inserted_count += 1
            
        conn.commit()
        cursor.close()
        conn.close()
        return inserted_count, skipped_count
    except Exception as e:
        st.error(f"Database insertion failed: {e}")
        return 0, 0

def fetch_company_analytics_from_db():
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute("""
            SELECT name as "Company", 
                   industry as "Industry",
                   nd_friendly_avg_score as "Avg Autonomy Score",
                   politics_stress_avg_score as "Avg Politics Score",
                   sensory_overload_avg_index as "Avg Sensory Index",
                   focus_protection_avg_score as "Avg Focus Score",
                   is_neurodivergent_approved as "Approved",
                   is_toxic_culture_blacklisted as "Toxic"
            FROM companies
            ORDER BY nd_friendly_avg_score DESC
        """)
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [dict(r) for r in rows]
    except Exception as e:
        st.error(f"Failed to fetch company analytics: {e}")
        return []

# Fetch data
jobs_list = fetch_jobs_from_db()

# Title
st.title("💼 Job Decision Engine — Streamlit Console")
st.markdown("### *Multi-Stage Weighted High-Autonomy Technical Architect & Builder Console*")
st.markdown("---")

# Sidebar - Filters & Stats
st.sidebar.header("🎯 Navigation & Filters")

# Metrics
total_jobs = len(jobs_list)
evaluated_count = sum(1 for j in jobs_list if j.get("status") and j.get("status") != "UNASSIGNED")
approved_count = sum(1 for j in jobs_list if j.get("status") == "STRONG MATCH")
toxic_count = sum(1 for j in jobs_list if j.get("politics_stress_score", 0) >= 70 or j.get("nd_friendly_score", 100) < 50)

st.sidebar.subheader("📊 Engine Statistics")
st.sidebar.metric("Total Vault Jobs", total_jobs)
st.sidebar.metric("Fully Evaluated", evaluated_count)
st.sidebar.metric("Top Recommended (Strong)", approved_count)
st.sidebar.metric("Toxicity Flags", toxic_count)

st.sidebar.markdown("---")
st.sidebar.subheader("📅 Automated Schedules")
st.sidebar.info("""
* **Daily Ingestion & Evaluation**: Runs daily at **10:00 AM SGT** (02:00 UTC) via GitHub Actions.
* **Weekly LinkedIn Auto-Sync**: Runs every **Sunday at 10:00 AM SGT** (02:00 UTC) via GitHub Actions.
""")

st.sidebar.subheader("⚡ Unscheduled Action Controls")

is_local = os.path.exists(".env.local")
github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_PAT")

# Button 1: Ingest Gmail Alerts Only
if st.sidebar.button("📨 1. Ingest Gmail Alerts Only", help="Connects to Gmail, fetches unread alerts from 'Jobs-Alerts', stages them in Postgres, and moves them to 'Jobs-Alerts-Processed'."):
    if not is_local and not github_token:
        st.sidebar.error("⚠️ GITHUB_TOKEN is missing in Streamlit secrets. Please configure it to trigger GitHub Action workflows from the cloud.")
    else:
        if github_token:
            with st.spinner("Triggering GitHub Actions 1_gmail_ingestion workflow..."):
                try:
                    req = urllib.request.Request(
                        "https://api.github.com/repos/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/1_gmail_ingestion.yml/dispatches",
                        data=json.dumps({"ref": "main"}).encode("utf-8"),
                        headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json", "User-Agent": "StreamlitConsole"},
                        method="POST"
                    )
                    with urllib.request.urlopen(req) as resp:
                        if resp.status in (204, 200, 201):
                            st.success("🐙 Triggered GitHub Actions 1_gmail_ingestion workflow!")
                except Exception as gh_err:
                    st.error(f"GitHub Trigger Error: {gh_err}")
        else:
            with st.spinner("Connecting to Gmail IMAP and ingesting raw email alerts..."):
                try:
                    st.info("Fetching new emails from 'Jobs-Alerts' folder...")
                    ingest_proc = subprocess.run(["npx", "tsx", "scripts/ingest_gmail.ts"], capture_output=True, text=True, env=os.environ, shell=True)
                    if ingest_proc.returncode == 0:
                        st.success("✅ Gmail alert ingestion completed successfully!")
                        st.code(ingest_proc.stdout, language="text")
                    else:
                        st.warning(f"Ingestion Output: {ingest_proc.stdout or ingest_proc.stderr}")
                except Exception as e:
                    st.error(f"Ingestion Error: {e}")
        st.rerun()

# Button 2: Run LLM Evaluation & Processing Only
if st.sidebar.button("🧠 2. Run LLM Evaluation & Processing", help="Parses staged email alerts, extracts job URLs, evaluates jobs with LLM (Gemini or OpenAI as failover), updates final Postgres tables, and ranks Top 10."):
    if not is_local and not github_token:
        st.sidebar.error("⚠️ GITHUB_TOKEN is missing in Streamlit secrets. Please configure it to trigger GitHub Action workflows from the cloud.")
    else:
        if github_token:
            with st.spinner("Triggering GitHub Actions evaluation workflow..."):
                try:
                    req = urllib.request.Request(
                        "https://api.github.com/repos/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/2_ai_evaluation.yml/dispatches",
                        data=json.dumps({"ref": "main"}).encode("utf-8"),
                        headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json", "User-Agent": "StreamlitConsole"},
                        method="POST"
                    )
                    with urllib.request.urlopen(req) as resp:
                        if resp.status in (204, 200, 201):
                            st.success("🐙 Triggered GitHub Actions evaluation workflow!")
                            st.balloons()
                except Exception as gh_err:
                    st.error(f"GitHub Trigger Error: {gh_err}")
        else:
            with st.spinner("Staging jobs and running LLM evaluation engine..."):
                try:
                    st.info("Executing LLM job description evaluation pipeline...")
                    eval_proc = subprocess.run(["npx", "tsx", "scripts/evaluate_jobs.ts"], capture_output=True, text=True, env=os.environ, shell=True)
                    if eval_proc.returncode == 0:
                        st.success("✅ LLM evaluation completed successfully!")
                        st.code(eval_proc.stdout, language="text")
                    else:
                        st.info(f"Evaluation Details:\n{eval_proc.stdout}")
                except Exception as e:
                    st.error(f"Evaluation Error: {e}")
        st.rerun()

# Button 3: Run Full Pipeline
if st.sidebar.button("⚡ Run Full Pipeline (Both)", help="Runs Step 1 (Ingestion) followed by Step 2 (Evaluation) sequentially."):
    if not is_local and not github_token:
        st.sidebar.error("⚠️ GITHUB_TOKEN is missing in Streamlit secrets. Please configure it to trigger GitHub Action workflows from the cloud.")
    else:
        if github_token:
            with st.spinner("Triggering full pipeline via GitHub Actions workflows..."):
                try:
                    req1 = urllib.request.Request(
                        "https://api.github.com/repos/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/1_gmail_ingestion.yml/dispatches",
                        data=json.dumps({"ref": "main"}).encode("utf-8"),
                        headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json", "User-Agent": "StreamlitConsole"},
                        method="POST"
                    )
                    req2 = urllib.request.Request(
                        "https://api.github.com/repos/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/2_ai_evaluation.yml/dispatches",
                        data=json.dumps({"ref": "main"}).encode("utf-8"),
                        headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json", "User-Agent": "StreamlitConsole"},
                        method="POST"
                    )
                    with urllib.request.urlopen(req1) as resp1:
                        pass
                    with urllib.request.urlopen(req2) as resp2:
                        pass
                    st.success("🐙 Triggered full pipeline workflows on GitHub Actions!")
                except Exception as gh_err:
                    st.error(f"GitHub Trigger Error: {gh_err}")
        else:
            with st.spinner("Running full pipeline (Ingestion + AI Evaluation) locally..."):
                try:
                    st.info("Step 1/2: Fetching emails from 'Jobs-Alerts'...")
                    ingest_proc = subprocess.run(["npx", "tsx", "scripts/ingest_gmail.ts"], capture_output=True, text=True, env=os.environ, shell=True)
                    st.info("Step 2/2: Running AI evaluation pipeline...")
                    eval_proc = subprocess.run(["npx", "tsx", "scripts/evaluate_jobs.ts"], capture_output=True, text=True, env=os.environ, shell=True)
                    st.success("✅ Full pipeline execution finished!")
                    st.balloons()
                except Exception as e:
                    st.error(f"Execution Error: {e}")
        st.rerun()

st.sidebar.markdown("---")
st.sidebar.subheader("🔍 Filter Listings")
search_query = st.sidebar.text_input("Keyword Search", "")
board_filter = st.sidebar.selectbox("Filter Board Source", ["All Sources", "LinkedIn", "MyCareersFuture", "eFinancialCareers", "Gmail"])
track_filter = st.sidebar.selectbox("Filter Engine Track", ["All Tracks", "Track A - Finance/AI", "Track B - Pharma/Research", "Neither", "Unassigned"])

# Apply filters
filtered_jobs = jobs_list
if search_query:
    filtered_jobs = [j for j in filtered_jobs if search_query.lower() in (j.get("title") or "").lower() or search_query.lower() in (j.get("company") or "").lower() or search_query.lower() in (j.get("description") or "").lower()]
if board_filter != "All Sources":
    filtered_jobs = [j for j in filtered_jobs if j.get("source") == board_filter]
if track_filter != "All Tracks":
    if track_filter == "Unassigned":
        filtered_jobs = [j for j in filtered_jobs if not j.get("status") or j.get("status") == "UNASSIGNED"]
    else:
        filtered_jobs = [j for j in filtered_jobs if j.get("assigned_track") == track_filter]

# Main Dashboard Layout tabs
tab_dashboard, tab_add_job, tab_linkedin, tab_analytics, tab_cv = st.tabs(["📁 Postgres Job Vault", "➕ Add Job Ad", "🔗 LinkedIn Saved Jobs", "🔥 ND Culture Analytics", "📄 CV Customizer"])

with tab_dashboard:
    # Segment out Top Recommended Jobs (STRONG MATCH, sorted by score DESC, limited to 10)
    top_recommended = [j for j in jobs_list if j.get("status") == "STRONG MATCH"]
    top_recommended = sorted(top_recommended, key=lambda x: x.get("total_score", 0), reverse=True)[:10]

    st.subheader("🏆 Top 10 Recommended Jobs")
    if not top_recommended:
        st.info("No STRONG MATCH recommendations found in the database. Run the evaluation cron job to process jobs.")
    else:
        cols = st.columns(2)
        for idx, rjob in enumerate(top_recommended):
            col_idx = idx % 2
            with cols[col_idx]:
                st.markdown(f"""
                <div class="top-rec-card">
                    <h4>⭐ #{idx+1} {rjob['title']}</h4>
                    <p><b>Company:</b> {rjob['company']} | <b>Score:</b> <code style='font-size:14px;color:#22c55e;'>{rjob['total_score']}/100</code></p>
                    <p><b>Salary:</b> {rjob.get('salaryRange') or 'Not specified'}</p>
                    <p><b>Track:</b> {rjob.get('assigned_track')}</p>
                    <p><b>Workplace Autonomy:</b> Autonomy: {rjob.get('nd_friendly_score')}% | Politics: {rjob.get('politics_stress_score')}%</p>
                </div>
                """, unsafe_allow_html=True)
                st.markdown(f"🔗 [Verify Job Ad & Apply]({rjob['careers_portal_url']})")

    st.markdown("---")

    # Interactive search filters inside the main tab
    search_col1, search_col2 = st.columns(2)
    with search_col1:
        search_title = st.text_input("🔍 Search Job Title", "", key="search_title_main")
    with search_col2:
        search_company = st.text_input("🏢 Search Company Name", "", key="search_company_main")

    if search_title:
        filtered_jobs = [j for j in filtered_jobs if search_title.lower() in (j.get("title") or "").lower()]
    if search_company:
        filtered_jobs = [j for j in filtered_jobs if search_company.lower() in (j.get("company") or "").lower()]

    col_left, col_right = st.columns([2, 3])

    with col_left:
        # Sort and split active vs rejected jobs
        def status_sort_key(j):
            status = j.get("status", "UNASSIGNED")
            score = j.get("total_score", 0)
            if status == "STRONG MATCH":
                return (0, -score)
            elif status == "REVIEW REQUIRED":
                return (1, -score)
            elif status == "REJECTED":
                return (2, -score)
            else:
                return (3, -score)

        sorted_filtered_jobs = sorted(filtered_jobs, key=status_sort_key)
        active_jobs = [j for j in sorted_filtered_jobs if j.get("status") != "REJECTED"]
        rejected_jobs = [j for j in sorted_filtered_jobs if j.get("status") == "REJECTED"]

        st.subheader("📋 Available Listings Vault")
        if not active_jobs and not rejected_jobs:
            st.info("No matching jobs in the current Postgres database.")
        else:
            # Render Active (Green & Orange) Jobs
            if active_jobs:
                st.write(f"Showing {len(active_jobs)} Active Match Listings:")
                for idx, job in enumerate(active_jobs):
                    status = job.get("status", "UNASSIGNED")
                    score = job.get("total_score", 0)
                    company = job.get("company", "Unknown")
                    title = job.get("title", "Job Title")
                    badge_style = "🟢" if status == "STRONG MATCH" else "🟡"
                    
                    with st.expander(f"{badge_style} {title} — {company} ({status})"):
                        st.markdown(f"**Source Board:** `{job.get('source')}`")
                        st.markdown(f"**Salary Range:** {job.get('salaryRange') or 'Not specified'}")
                        st.markdown(f"**Location:** {job.get('location') or 'Singapore'}")
                        st.markdown(f"**Verification Link:** [Go to Careers Portal]({job.get('careers_portal_url')})")
                        st.markdown(f"**Match Score:** `{score}/100`")
                        st.markdown(f"**Autonomy Score:** `{job.get('nd_friendly_score') or 'N/A'}%` | **Politics Stress:** `{job.get('politics_stress_score') or 'N/A'}%`")
                        
                        desc_text = job.get("description", "")
                        parsed_desc = None
                        if isinstance(desc_text, dict):
                            parsed_desc = desc_text
                            desc_text = parsed_desc.get("job_description", "")
                        elif isinstance(desc_text, str) and desc_text.strip().startswith("{"):
                            try:
                                parsed_desc = json.loads(desc_text)
                                desc_text = parsed_desc.get("job_description", "")
                            except Exception:
                                pass
                        st.text_area("Full Description Brief", desc_text or "", height=100, disabled=True, key=f"active_desc_{idx}")
                        
                        if st.button("🗑️ Delete Listing", key=f"active_del_{job.get('id') or idx}"):
                            if delete_job_from_db(job.get("id")):
                                st.rerun()
            else:
                if rejected_jobs:
                    st.info(f"💡 No active matches found, but {len(rejected_jobs)} matching listings are in the Rejected/Discarded folder below.")
                else:
                    st.info("No active matching jobs (STRONG MATCH or REVIEW REQUIRED) are currently stored.")

            # Render Rejected (Red) Jobs inside an expander
            if rejected_jobs:
                st.markdown("---")
                is_search_active = bool(search_title or search_company or search_query)
                with st.expander(f"🔴 View Rejected/Discarded Listings ({len(rejected_jobs)} jobs)", expanded=is_search_active):
                    # Limit rendering of rejected popovers to top 50 to prevent severe browser lag
                    display_limit = 50
                    for idx, job in enumerate(rejected_jobs[:display_limit]):
                        company = job.get("company", "Unknown")
                        title = job.get("title", "Job Title")
                        score = job.get("total_score", 0)
                        
                        with st.popover(f"🔴 {title} — {company}"):
                            st.markdown(f"**Source Board:** `{job.get('source')}`")
                            st.markdown(f"**Verification Link:** [Go to Careers Portal]({job.get('careers_portal_url')})")
                            st.markdown(f"**Rejected Score:** `{score}/100`")
                            
                            desc_text = job.get("description", "")
                            parsed_desc = None
                            if isinstance(desc_text, dict):
                                parsed_desc = desc_text
                                desc_text = parsed_desc.get("job_description", "")
                            elif isinstance(desc_text, str) and desc_text.strip().startswith("{"):
                                try:
                                    parsed_desc = json.loads(desc_text)
                                    desc_text = parsed_desc.get("job_description", "")
                                except Exception:
                                    pass
                            st.text_area("Full Description Brief", desc_text or "", height=100, disabled=True, key=f"rej_desc_{idx}")
                            
                            if st.button("🗑️ Delete Listing Permanent", key=f"rej_del_{job.get('id') or idx}"):
                                if delete_job_from_db(job.get("id")):
                                    st.rerun()
                    if len(rejected_jobs) > display_limit:
                        st.caption(f"⚠️ Showing first {display_limit} rejected listings to maintain UI performance. Use the search inputs above to filter down further.")

    with col_right:
        st.subheader("🤖 Scoring & Match Analysis Details")
        st.write("Select an evaluated job to view detailed autonomy & focus match metrics, workplace stress assessments, and strategic CV targeting.")
        
        evaluated_jobs = [j for j in filtered_jobs if j.get("status") and j.get("status") != "UNASSIGNED"]
        selected_job_title = st.selectbox(
            "Select Job to Analyze", 
            [f"{j.get('title')} ({j.get('company')})" for j in evaluated_jobs] if evaluated_jobs else ["No Evaluated Jobs Available"]
        )
        
        # Get actual job object
        job_to_show = None
        if evaluated_jobs and selected_job_title != "No Evaluated Jobs Available":
            idx_selected = [f"{j.get('title')} ({j.get('company')})" for j in evaluated_jobs].index(selected_job_title)
            job_to_show = evaluated_jobs[idx_selected]

        if job_to_show:
            st.markdown(f"#### Selected: **{job_to_show['title']}** at *{job_to_show['company']}*")
            st.markdown(f"**Verifiable Careers Link:** `{job_to_show['careers_portal_url']}`")
            
            # Show score metrics
            st.markdown("---")
            st.markdown(f"### Match Score: `{job_to_show.get('total_score', 0)} / 100`")
            
            col1, col2, col3 = st.columns(3)
            with col1:
                st.metric("Autonomy Culture Score", f"{job_to_show.get('nd_friendly_score')}%")
            with col2:
                st.metric("Politics Stress Score", f"{job_to_show.get('politics_stress_score')}%")
            with col3:
                st.metric("Environmental Stress Index", f"{job_to_show.get('sensory_overload_index')}%")

            st.markdown("#### **Evaluation Axes Breakdown**")
            st.json({
                "Environmental & Biological Guardrails (30%)": f"{job_to_show.get('score_environment_guardrails') or 0} pts",
                "Technical & Creative Autonomy (25%)": f"{job_to_show.get('score_technical_autonomy') or 0} pts",
                "Domain Relevance (20%)": f"{job_to_show.get('score_domain_relevance') or 0} pts",
                "Compensation & Capital Potential (15%)": f"{job_to_show.get('score_compensation_potential') or 0} pts",
                "Future-Proofing & Domain Growth (10%)": f"{job_to_show.get('score_future_mobility') or 0} pts"
            })

            st.markdown("#### **Workplace & Strategic Assessment**")
            st.info(f"**Workplace Stress & Politics Risk:**\n{job_to_show.get('biological_stress_risk') or 'N/A'}")
            st.success(f"**Strategic Career Value:**\n{job_to_show.get('strategic_value') or 'N/A'}")
            
            st.markdown(f"**Target Application Strategy:**")
            st.write(f"📝 **Recommended CV:** `{job_to_show.get('recommended_cv_version') or 'N/A'}`")
            st.write(f"🚀 **Next Action:** `{job_to_show.get('next_action') or 'N/A'}`")
        else:
            st.info("No evaluated jobs in view. The daily automation pipeline automatically processes imported unread email jobs.")

with tab_add_job:
    st.subheader("➕ Import a New Job Advertisement")
    st.write("Add raw jobs manually to the Postgres Vault. The daily evaluation cron job will automatically score and route them.")
    if "manual_import_success" in st.session_state:
        st.success(st.session_state["manual_import_success"])
        del st.session_state["manual_import_success"]

    with st.form("custom_job_form"):
        title = st.text_input("Job Title", "Principal AI Architect")
        company = st.text_input("Company Name", "Novartis Pharmaceuticals")
        source = st.selectbox("Source Portal", ["LinkedIn", "MyCareersFuture", "eFinancialCareers", "Gmail"])
        salary = st.text_input("Salary Range Indicator", "SGD 22,000 - SGD 26,000 / month")
        location = st.text_input("Location", "Singapore (Remote)")
        careers_url = st.text_input("Careers Portal Direct Link (Verification)", "https://www.novartis.com/careers")
        desc = st.text_area("Job Description Raw text", "Paste raw details here...")
        
        submitted = st.form_submit_button("Import & Save to Postgres Vault")
        if submitted:
            new_job = {
                "title": title,
                "company": company,
                "source": source,
                "salaryRange": salary,
                "postedDate": str(datetime.date.today()),
                "location": location,
                "careers_portal_url": careers_url if careers_url else f"https://www.{company.lower().replace(' ', '')}.com/careers",
                "description": desc
            }
            if save_new_job_to_db(new_job):
                st.session_state["manual_import_success"] = f"✅ Successfully added '{title}' to the Staging Vault! It is now pending evaluation. To evaluate it immediately, click the '🧠 2. Run LLM Evaluation & Processing' button in the sidebar."
                st.rerun()

with tab_linkedin:
    st.subheader("🔗 Import Saved LinkedIn Jobs")
    st.write("Sync your saved LinkedIn jobs, stage them in your Postgres database for evaluation, and automatically unsave them from LinkedIn.")
    
    col_auto, col_manual = st.columns(2)
    
    with col_auto:
        st.markdown("### 🤖 Option A: Headless Auto-Sync")
        st.write("Instantly log in to LinkedIn in a headless browser, pull all saved jobs, stage them in Neon Postgres, and click 'Saved' to unsave them automatically.")
        
        has_li_cookie = os.environ.get("LINKEDIN_LI_AT") is not None
        if not has_li_cookie:
            st.warning("⚠️ `LINKEDIN_LI_AT` cookie is not set in `.env.local`. Please configure it to enable 1-Click Sync.")
            
        if st.button("🚀 Start 1-Click Sync & Unsave", disabled=not has_li_cookie):
            with st.spinner("Launching Puppeteer, connecting to LinkedIn, and processing saved jobs..."):
                try:
                    sync_proc = subprocess.run(["npx", "tsx", "scripts/sync_linkedin_saved.ts"], capture_output=True, text=True, env=os.environ, shell=True)
                    if sync_proc.returncode == 0:
                        st.success("✅ Sync & Unsave completed successfully!")
                        st.code(sync_proc.stdout, language="text")
                    else:
                        st.error(f"Sync failed with output:\n{sync_proc.stdout or sync_proc.stderr}")
                except Exception as e:
                    st.error(f"Execution Error: {e}")
                st.rerun()

    with col_manual:
        st.markdown("### 📋 Option B: Manual Export & Upload")
        st.write("If your cookie expires or you prefer manual control, run the browser console script below and upload the exported JSON file.")
        script_code = r"""(async function extractSavedJobs() {
  console.log("🚀 Starting LinkedIn Saved Jobs pagination walk...");
  
  const uniqueJobs = [];
  const processedUrls = new Set();
  let pageNum = 1;
  let hasNextPage = true;
  
  while (hasNextPage && pageNum <= 40) {
    console.log(`📄 Processing Page ${pageNum}...`);
    
    // Scroll the left panel list container to ensure elements are fully rendered
    const scrollables = Array.from(document.querySelectorAll('*')).filter(el => {
      const style = window.getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    });
    for (const s of scrollables) {
      s.scrollTop = s.scrollHeight;
    }
    await new Promise(r => setTimeout(r, 2000));
    
    // Find all job list items/rows on this page
    const jobElements = Array.from(document.querySelectorAll('li, div')).filter(el => {
      const hasJobLink = el.querySelector('a[href*="/jobs/"]');
      const text = el.innerText || '';
      return hasJobLink && text.includes('·') && !text.includes('Applied') && !text.includes('Interview') && !text.includes('Archived');
    });
    
    let pageCount = 0;
    for (const el of jobElements) {
      const links = Array.from(el.querySelectorAll('a')).filter(a => a.href && a.href.includes('/jobs/'));
      for (const a of links) {
        const title = a.innerText.trim();
        if (!title || title.length < 3 || ['apply', 'easy apply'].includes(title.toLowerCase())) continue;
        
        let jobId = '';
        if (a.href.includes('/jobs/view/')) {
          const match = a.href.match(/\/jobs\/view\/(\d+)/);
          if (match) jobId = match[1];
        } else if (a.href.includes('jobId=')) {
          const match = a.href.match(/jobId=(\d+)/);
          if (match) jobId = match[1];
        }
        
        if (jobId) {
          const standardUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
          
          if (!processedUrls.has(standardUrl)) {
            processedUrls.add(standardUrl);
            
            // Find company & location line (e.g. Adobe · Singapore)
            let company = 'Unknown Company';
            let location = 'Singapore';
            const innerSpans = Array.from(el.querySelectorAll('span, div, p'));
            for (const span of innerSpans) {
              const t = span.innerText.trim();
              if (t.includes('·') && !t.includes('\n')) {
                const parts = t.split('·');
                company = parts[0].trim();
                location = parts[1].trim();
                break;
              }
            }
            
            uniqueJobs.push({ title, company, url: standardUrl, location, element: el });
            pageCount++;
          }
        }
      }
    }
    
    console.log(`- Page ${pageNum}: Found ${pageCount} new jobs.`);
    
    // Find next page button
    const nextBtn = document.querySelector('.artdeco-pagination__button--next') || 
                    Array.from(document.querySelectorAll('button')).find(b => {
                      const text = b.innerText.trim().toLowerCase();
                      return text === 'next' || b.ariaLabel?.toLowerCase().includes('next') || text === '>';
                    });
                    
    if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains('artdeco-button--disabled')) {
      console.log("➡️ Clicking Next page button...");
      (nextBtn).click();
      pageNum++;
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log("🏁 No active Next page button found. Ending walk.");
      hasNextPage = false;
    }
  }
  
  console.log(`📊 Total unique jobs identified across all pages: ${uniqueJobs.length}`);
  
  if (uniqueJobs.length === 0) {
    console.warn("⚠️ No saved jobs identified. Make sure you are on the 'Saved' tab of your Job Tracker.");
    return;
  }
  
  console.log("🧠 Fetching job descriptions silently...");
  const finalizedJobs = [];
  const batchSize = 5;
  for (let i = 0; i < uniqueJobs.length; i += batchSize) {
    const batch = uniqueJobs.slice(i, i + batchSize);
    console.log(`⏳ Fetching batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(uniqueJobs.length/batchSize)}...`);
    await Promise.all(batch.map(async (job) => {
      try {
        const res = await fetch(job.url);
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const descEl = doc.querySelector('.jobs-description-content') || 
                      doc.querySelector('.show-more-less-html__markup') || 
                      doc.querySelector('[id^="job-details"]') || 
                      doc.querySelector('.jobs-box__html-content') ||
                      doc.querySelector('.jobs-description');
        const description = descEl ? descEl.innerText.trim() : '';
        finalizedJobs.push({
          title: job.title,
          company: job.company,
          url: job.url,
          location: job.location,
          description: description || "Full description not available. Please visit job link to apply."
        });
        console.log(`✅ Fetched description for: "${job.title}" at ${job.company}`);
      } catch (err) {
        console.error(`❌ Failed: ${job.title}`, err);
        finalizedJobs.push({
          title: job.title,
          company: job.company,
          url: job.url,
          location: job.location,
          description: "Failed to fetch description automatically."
        });
      }
    }));
    await new Promise(r => setTimeout(r, 1500));
  }
  
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(finalizedJobs, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", "linkedin_saved_jobs.json");
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  console.log("🎉 JSON File Downloaded successfully!");
  
  console.log("🧹 Starting automatic unsave cleanup on the CURRENT page...");
  let unsavedCount = 0;
  for (const job of uniqueJobs) {
    try {
      const threeDotBtn = job.element.querySelector('button[aria-label*="options"], button[aria-label*="Options"], .artdeco-dropdown__trigger');
      if (threeDotBtn && document.body.contains(threeDotBtn)) {
        (threeDotBtn).click();
        await new Promise(r => setTimeout(r, 500));
        const dropdownItems = Array.from(document.querySelectorAll('.artdeco-dropdown__item, [role="menuitem"]'));
        const unsaveOption = dropdownItems.find(el => el.innerText.trim().toLowerCase().includes('unsave') || el.innerText.trim().toLowerCase().includes('remove'));
        if (unsaveOption) {
          (unsaveOption).click();
          unsavedCount++;
          console.log(`- Unsaved job: "${job.title}" at ${job.company}`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          (threeDotBtn).click();
        }
      }
    } catch (e) {
      // Squelch DOM removal errors since we are changing pages
    }
  }
  console.log(`🧹 Cleaned up/unsaved ${unsavedCount} jobs on the current page!`);
  console.log("🎉 ALL DONE SUCCESSFULLY!");
})();"""
        st.code(script_code, language="javascript")
        
        uploaded_file = st.file_uploader("Upload your exported 'linkedin_saved_jobs.json' file", type=["json"])
        
        if uploaded_file is not None:
            try:
                jobs_data = json.load(uploaded_file)
                if not isinstance(jobs_data, list):
                    st.error("Invalid file structure. Root must be a JSON array.")
                else:
                    st.success(f"Successfully parsed JSON. Found **{len(jobs_data)}** jobs in file.")
                    
                    # Show preview
                    st.markdown("#### **Jobs Preview**")
                    preview_df = pd.DataFrame([
                        {"Title": j.get("title"), "Company": j.get("company"), "Location": j.get("location"), "URL": j.get("url")}
                        for j in jobs_data[:10]
                    ])
                    st.dataframe(preview_df, use_container_width=True)
                    if len(jobs_data) > 10:
                        st.write(f"*... and {len(jobs_data) - 10} more jobs.*")
                    
                    # Ingest button
                    if st.button("📥 Import All Saved Jobs to Staging Vault"):
                        with st.spinner("Inserting jobs into staging table..."):
                            inserted, skipped = ingest_linkedin_saved_json(jobs_data)
                            st.success(f"✅ Ingestion complete! **{inserted}** new jobs imported, **{skipped}** skipped as duplicates/invalid.")
                            st.rerun()
            except Exception as e:
                st.error(f"Error reading JSON file: {e}")

with tab_analytics:
    st.subheader("🔥 Company Autonomy & Culture Analytics")
    st.write("Consolidated employer ratings compiled directly from Postgres database tables.")

    analytics_data = fetch_company_analytics_from_db()

    if analytics_data:
        df = pd.DataFrame(analytics_data)
        
        # Map safety verdicts
        def get_verdict(row):
            if row["Approved"]:
                return "🟢 HIGH AUTONOMY / OPTIMAL FOCUS"
            elif row["Toxic"]:
                return "🔴 HIGH POLITICS / BUREAUCRATIC"
            else:
                return "🟡 REVIEW REQUIRED"
                
        df["Safety Verdict"] = df.apply(get_verdict, axis=1)
        
        # Display table
        st.dataframe(df[["Company", "Industry", "Avg Autonomy Score", "Avg Politics Score", "Avg Sensory Index", "Avg Focus Score", "Safety Verdict"]], use_container_width=True)
        
        st.markdown("### 🏆 Top High-Autonomy Environments vs. ⚠️ Stress Alerts")
        st.bar_chart(df.set_index("Company")[["Avg Autonomy Score", "Avg Politics Score"]])
    else:
        st.info("No compiled analytics are available. Please run the evaluation engine pipeline to score listings.")

with tab_cv:
    st.subheader("📄 AI CV Customizer & Tailoring Engine")
    st.write("Align and customize your master professional profile against any evaluated job advertisement honestly and factually.")

    # Check if my_profile.md exists
    if not os.path.exists("my_profile.md"):
        st.error("⚠️ `my_profile.md` not found in workspace root. Please create this file first to store your credentials and work history.")
    else:
        # Show master profile editor button / status
        with st.expander("📝 View / Edit Master Profile (my_profile.md)"):
            with open("my_profile.md", "r", encoding="utf-8") as pf:
                profile_content = pf.read()
            edited_profile = st.text_area("Master Profile Markdown", profile_content, height=300)
            if edited_profile != profile_content:
                if st.button("💾 Save Profile Changes"):
                    with open("my_profile.md", "w", encoding="utf-8") as pf:
                        pf.write(edited_profile)
                    st.success("✅ Master profile saved successfully!")
                    st.rerun()

        # Select a job to customize against (only showing STRONG MATCH or REVIEW REQUIRED)
        eligible_jobs = [j for j in jobs_list if j.get("status") in ("STRONG MATCH", "REVIEW REQUIRED")]
        
        if not eligible_jobs:
            st.info("No eligible jobs found for tailoring. Only jobs evaluated as 'STRONG MATCH' or 'REVIEW REQUIRED' can be tailored.")
        else:
            job_options = {f"{j['company']} - {j['title']} ({j.get('status')})": j for j in eligible_jobs}
            selected_job_name = st.selectbox("Select Target Job Ad", list(job_options.keys()))
            selected_job = job_options[selected_job_name]

            # Render selected job details
            st.markdown(f"### **Target Role Details**")
            st.markdown(f"**Company**: {selected_job['company']} | **Title**: {selected_job['title']} | **Location**: {selected_job.get('location', 'Singapore')}")
            
            if selected_job.get("careers_portal_url"):
                st.markdown(f"🔗 **Job Posting URL**: [{selected_job['careers_portal_url']}]({selected_job['careers_portal_url']})")
                
            with st.expander("🔍 View Target Job Description"):
                desc = selected_job.get("description", "")
                desc_stripped = desc.strip() if isinstance(desc, str) else desc
                if not desc_stripped or desc_stripped == "No description available.":
                    st.warning("⚠️ No full job description is stored in the database. Please verify the link above or update this job record.")
                else:
                    parsed_desc = None
                    if isinstance(desc, dict):
                        parsed_desc = desc
                    elif isinstance(desc, str) and desc.strip().startswith("{"):
                        try:
                            parsed_desc = json.loads(desc)
                        except Exception:
                            pass
                    
                    if parsed_desc is not None:
                        st.markdown("### 📝 **Overview**")
                        st.write(parsed_desc.get("job_description", ""))
                        
                        if parsed_desc.get("key_responsibilities"):
                            st.markdown("### 📋 **Key Responsibilities**")
                            for r in parsed_desc["key_responsibilities"]:
                                st.markdown(f"- {r}")
                                
                        if parsed_desc.get("technical_skills"):
                            st.markdown("### 🛠️ **Technical Skills**")
                            for s in parsed_desc["technical_skills"]:
                                st.markdown(f"- {s}")
                                
                        if parsed_desc.get("qualifications_education"):
                            st.markdown("### 🎓 **Qualifications & Education**")
                            for q in parsed_desc["qualifications_education"]:
                                st.markdown(f"- {q}")
                                
                        if parsed_desc.get("nice_to_haves"):
                            st.markdown("### 🌟 **Nice-to-Haves**")
                            for n in parsed_desc["nice_to_haves"]:
                                st.markdown(f"- {n}")
                    else:
                        st.write(desc)

            # Button to trigger CV customization
            st.markdown("---")
            if st.button("✨ Generate Factual Customised CV"):
                desc_text = selected_job.get("description", "")
                actual_text = desc_text
                parsed = None
                if isinstance(desc_text, dict):
                    parsed = desc_text
                elif isinstance(desc_text, str) and desc_text.strip().startswith("{"):
                    try:
                        parsed = json.loads(desc_text)
                    except Exception:
                        pass
                
                if parsed is not None:
                    actual_text = (
                        (parsed.get("job_description") or "") + " " +
                        " ".join(parsed.get("key_responsibilities") or []) + " " +
                        " ".join(parsed.get("technical_skills") or []) + " " +
                        " ".join(parsed.get("qualifications_education") or []) + " " +
                        " ".join(parsed.get("nice_to_haves") or [])
                    ).strip()
                elif isinstance(desc_text, str):
                    actual_text = desc_text.strip()
                else:
                    actual_text = ""
                
                if not actual_text or actual_text == "No description available." or len(actual_text) < 150:
                    st.error("❌ Cannot generate CV: The target job description is missing, empty, or too short in the database. Please make sure the job details are scraped or populated before customizing.")
                    st.stop()
                    
                with st.spinner("AI is analyzing alignment, calling out experience gaps, and tailoring your CV..."):
                    try:
                        # We execute our scripts/generate_cv.ts with the selected job's ID
                        # Let's get the job's database ID from the select query
                        conn = get_db_connection()
                        cursor = conn.cursor()
                        cursor.execute("SELECT id FROM jobs WHERE title = %s AND company_name = %s LIMIT 1", (selected_job['title'], selected_job['company']))
                        db_row = cursor.fetchone()
                        conn.close()

                        if not db_row:
                            st.error("Job record not found in database.")
                        else:
                            db_job_id = db_row[0]
                            
                            # Read master profile and schema
                            with open("my_profile.md", "r", encoding="utf-8") as pf:
                                master_profile = pf.read()
                            with open("scripts/cv_response_schema.json", "r", encoding="utf-8") as sf:
                                cv_response_schema = sf.read()
                                
                            # Fetch full job details
                            conn = get_db_connection()
                            cursor = conn.cursor()
                            cursor.execute("SELECT title, company_name, raw_description, location FROM jobs WHERE id = %s", (db_job_id,))
                            job_data = cursor.fetchone()
                            conn.close()
                            
                            # Construct prompt
                            prompt = f"""You are a professional, honest, and high-fidelity CV writer and alignment agent.
Your task is to analyze the user's master professional profile against the target Job Description (JD) and output a JSON object containing both the analysis and the tailored CV.

### STRICT RULES:
1. **ABSOLUTELY NO FABRICATIONS OR LYING**: Do not invent jobs, certifications, projects, or accomplishments. Keep everything 100% factual to the master profile.
2. **HONEST GAP REPORTING**: Call out key mismatches/gaps where the user lacks direct experience. Under each mismatch:
   - Provide factual parallel exposure (e.g. if the JD asks for Kubernetes and the user only has Docker/ECS, state that).
   - Outline a brief, realistic learning plan to master it fast.
3. **TAILORED CV MARKDOWN**: In the "tailored_cv_markdown" property, write the fully customized resume in clean Markdown format:
   - At the top of the resume, introduce a summary section displaying overall fit %, core requirements % match, and key gaps (with parallel exposure/learning plan).
   - Retell the work history focusing on aligned achievements, tools, and projects factually.
   - Include studies, skills, and certifications.

### JSON RESPONSE SCHEMA:
You MUST output a JSON object conforming exactly to this schema:
{cv_response_schema}

---
### TARGET JOB SPECIFICATION:
- **Title**: {job_data[0]}
- **Company**: {job_data[1]}
- **Location**: {job_data[3] or 'Singapore'}
- **Job Description**:
{job_data[2]}

---
### USER MASTER PROFILE:
{master_profile}

---
Ensure the output is clean JSON. Do not prepend or append markdown code blocks around the JSON object."""

                            # Generate response directly
                            json_text = python_generate_content(
                                prompt,
                                system_instruction="You are a professional CV tailoring system. You analyze profiles and output strictly structured JSON conforming to the requested schema.",
                                response_mime_type="application/json"
                            )
                            json_text = json_text.strip()

                            try:
                                cv_data = json.loads(json_text)
                                analysis = cv_data.get("analysis", {})
                                cv_text = cv_data.get("tailored_cv_markdown", "")

                                st.success("✅ Tailored CV generated successfully!")
                                
                                # Show high-level metrics
                                col1, col2 = st.columns(2)
                                with col1:
                                    st.metric("Overall Fit Score", f"{analysis.get('overall_fit_percentage', 0)}%")
                                with col2:
                                    st.metric("Core Requirements Match", f"{analysis.get('core_requirements_match_percentage', 0)}%")

                                # 1. Key Analysis Takeaways
                                points = analysis.get("key_analysis_points", [])
                                if points:
                                    st.markdown("### **🎯 Key Analysis Takeaways**")
                                    for pt in points:
                                        st.markdown(f"- {pt}")
                                    st.markdown("---")

                                # 2. Core Requirements Matches (Table)
                                core_matches = analysis.get("core_matches", [])
                                if core_matches:
                                    st.markdown("### **✅ Core Requirements Match Details**")
                                    match_df = pd.DataFrame(core_matches)
                                    match_df.columns = ["Core Job Requirement", "My Corresponding Match"]
                                    st.table(match_df)
                                    st.markdown("---")

                                # 3. Mismatches / Gaps to Fill
                                gaps = analysis.get("key_mismatches", [])
                                if gaps:
                                    st.markdown("### **⚠️ Identified Gaps & Learning Plans**")
                                    for gap in gaps:
                                        st.markdown(f"**Missing Requirement**: `{gap.get('requirement')}`")
                                        st.markdown(f"*Parallel/Transferable Exposure*: {gap.get('parallel_exposure')}")
                                        st.markdown(f"*Proactive Learning Plan*: {gap.get('learning_plan')}")
                                        st.markdown("---")

                                # Download files
                                st.markdown("### **📥 Download Tailored Resume Documents**")
                                
                                clean_company = selected_job['company'].replace(' ', '_')
                                clean_title = selected_job['title'].replace(' ', '_')
                                
                                # 1. MD Download
                                st.download_button(
                                    label="📄 Download Markdown (.md)",
                                    data=cv_text,
                                    file_name=f"CV_Tailored_{clean_company}_{clean_title}.md",
                                    mime="text/markdown"
                                )

                                # 2. DOCX Download
                                docx_bytes = convert_markdown_to_docx(cv_text)
                                st.download_button(
                                    label="💼 Download Word Document (.docx)",
                                    data=docx_bytes,
                                    file_name=f"CV_Tailored_{clean_company}_{clean_title}.docx",
                                    mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                )

                                # 3. PDF Download
                                pdf_bytes = convert_markdown_to_pdf(cv_text)
                                st.download_button(
                                    label="📁 Download PDF Document (.pdf)",
                                    data=pdf_bytes,
                                    file_name=f"CV_Tailored_{clean_company}_{clean_title}.pdf",
                                    mime="application/pdf"
                                )

                            except Exception as parse_err:
                                st.error(f"Failed to parse structured JSON response: {parse_err}")
                                st.code(json_text)
                    except Exception as e:
                        st.error(f"Execution Error: {e}")

# Footer section
st.markdown("---")
st.markdown("<p class='disclaimer'>Job Decision Engine v4.0 • Powered by Neon Postgres & GitHub Actions Automation</p>", unsafe_allow_html=True)
