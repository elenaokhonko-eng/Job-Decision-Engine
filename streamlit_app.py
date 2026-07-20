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
    for filename in [".env", ".env.local"]:
        if os.path.exists(filename):
            with open(filename, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, val = line.split("=", 1)
                        val = val.strip("'\"")
                        if key.strip() not in os.environ:
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

        cursor.execute("""
            INSERT INTO raw_jobs (
                company_name, title, source, raw_description, salary_range, location, careers_portal_url, processed
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, FALSE)
        """, (
            job["company"], job["title"], job["source"], job["description"],
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

def fetch_company_analytics_from_db():
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute("""
            SELECT name as "Company", 
                   industry as "Industry",
                   nd_friendly_avg_score as "Avg ND Score",
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
st.markdown("### *Multi-Stage Weighted auDHD Career Architect (Singapore)*")
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
st.sidebar.subheader("⚡ Unscheduled Action Controls")

# Button 1: Ingest Gmail Alerts Only
if st.sidebar.button("📨 1. Ingest Gmail Alerts Only", help="Connects to Gmail, fetches unread alerts from 'Jobs-Alerts', stages them in Postgres, and moves them to 'Jobs-Alerts-Processed'."):
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

        # Optional GitHub dispatch
        github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_PAT")
        if github_token:
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
                pass
        st.rerun()

# Button 2: Run Kimi AI Evaluation Only
if st.sidebar.button("🧠 2. Run Kimi AI Evaluation", help="Parses staged email alerts, extracts job URLs, evaluates jobs with Kimi AI, updates final Postgres tables, and ranks Top 10."):
    with st.spinner("Staging jobs and running Kimi AI evaluation engine..."):
        try:
            st.info("Executing Kimi AI job description evaluation pipeline...")
            eval_proc = subprocess.run(["npx", "tsx", "scripts/evaluate_jobs.ts"], capture_output=True, text=True, env=os.environ, shell=True)
            if eval_proc.returncode == 0:
                st.success("✅ Kimi AI evaluation completed successfully!")
                st.code(eval_proc.stdout, language="text")
            else:
                st.info(f"Evaluation Details:\n{eval_proc.stdout}")
        except Exception as e:
            st.error(f"Evaluation Error: {e}")

        # Optional GitHub dispatch
        github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_PAT")
        if github_token:
            try:
                req = urllib.request.Request(
                    "https://api.github.com/repos/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/2_kimi_evaluation.yml/dispatches",
                    data=json.dumps({"ref": "main"}).encode("utf-8"),
                    headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json", "User-Agent": "StreamlitConsole"},
                    method="POST"
                )
                with urllib.request.urlopen(req) as resp:
                    if resp.status in (204, 200, 201):
                        st.success("🐙 Triggered GitHub Actions 2_kimi_evaluation workflow!")
            except Exception as gh_err:
                pass
        st.balloons()
        st.rerun()

# Button 3: Run Full Pipeline
if st.sidebar.button("⚡ Run Full Pipeline (Both)", help="Runs Step 1 (Ingestion) followed by Step 2 (Evaluation) sequentially."):
    with st.spinner("Running full pipeline (Ingestion + Kimi Evaluation)..."):
        try:
            st.info("Step 1/2: Fetching emails from 'Jobs-Alerts'...")
            ingest_proc = subprocess.run(["npx", "tsx", "scripts/ingest_gmail.ts"], capture_output=True, text=True, env=os.environ, shell=True)
            st.info("Step 2/2: Running Kimi AI evaluation pipeline...")
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
    filtered_jobs = [j for j in filtered_jobs if search_query.lower() in j["title"].lower() or search_query.lower() in j["company"].lower() or search_query.lower() in j["description"].lower()]
if board_filter != "All Sources":
    filtered_jobs = [j for j in filtered_jobs if j.get("source") == board_filter]
if track_filter != "All Tracks":
    if track_filter == "Unassigned":
        filtered_jobs = [j for j in filtered_jobs if not j.get("status") or j.get("status") == "UNASSIGNED"]
    else:
        filtered_jobs = [j for j in filtered_jobs if j.get("assigned_track") == track_filter]

# Main Dashboard Layout tabs
tab_dashboard, tab_add_job, tab_analytics = st.tabs(["📁 Postgres Job Vault", "➕ Add Job Ad", "🔥 ND Culture Analytics"])

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
                    <p><b>ND Compatibility:</b> Friendly: {rjob.get('nd_friendly_score')}% | Politics: {rjob.get('politics_stress_score')}%</p>
                </div>
                """, unsafe_allow_html=True)
                st.markdown(f"🔗 [Verify Job Ad & Apply]({rjob['careers_portal_url']})")

    st.markdown("---")

    col_left, col_right = st.columns([2, 3])

    with col_left:
        st.subheader("📋 Available Listings Vault")
        if not filtered_jobs:
            st.info("No matching jobs in the current Postgres database.")
        else:
            for idx, job in enumerate(filtered_jobs):
                status = job.get("status", "UNASSIGNED")
                score = job.get("total_score", 0)
                company = job.get("company", "Unknown")
                title = job.get("title", "Job Title")
                
                # Visual badge colors
                badge_style = "🔴" if status == "REJECTED" else ("🟢" if status == "STRONG MATCH" else "🟡")
                
                # Expandable card
                with st.expander(f"{badge_style} {title} — {company} ({status})"):
                    st.markdown(f"**Source Board:** `{job.get('source')}`")
                    st.markdown(f"**Salary Range:** {job.get('salaryRange') or 'Not specified'}")
                    st.markdown(f"**Location:** {job.get('location') or 'Singapore'}")
                    st.markdown(f"**Verification Link:** [Go to Careers Portal]({job.get('careers_portal_url')})")
                    st.markdown(f"**Match Score:** `{score}/100`")
                    st.markdown(f"**ND Friendly Score:** `{job.get('nd_friendly_score') or 'N/A'}%` | **Politics Stress:** `{job.get('politics_stress_score') or 'N/A'}%`")
                    st.text_area("Full Description Brief", job.get("description"), height=100, disabled=True, key=f"desc_{idx}")
                    
                    # Delete action
                    if st.button("🗑️ Delete Listing", key=f"del_{job.get('id') or idx}"):
                        if delete_job_from_db(job.get("id")):
                            st.rerun()

    with col_right:
        st.subheader("🤖 Scoring & Match Analysis Details")
        st.write("Select an evaluated job to view detailed auDHD match metrics, biological stress assessments, and strategic CV targeting.")
        
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
                st.metric("ND Friendly Score", f"{job_to_show.get('nd_friendly_score')}%")
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
                st.rerun()

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
        st.dataframe(df[["Company", "Industry", "Avg ND Score", "Avg Politics Score", "Avg Sensory Index", "Avg Focus Score", "Safety Verdict"]], use_container_width=True)
        
        st.markdown("### 🏆 Top Safe Environments vs. ⚠️ Stress Alerts")
        st.bar_chart(df.set_index("Company")[["Avg ND Score", "Avg Politics Score"]])
    else:
        st.info("No compiled analytics are available. Please run the evaluation engine pipeline to score listings.")

# Footer section
st.markdown("---")
st.markdown("<p class='disclaimer'>Job Decision Engine v4.0 • Powered by Neon Postgres & GitHub Actions Automation</p>", unsafe_allow_html=True)
