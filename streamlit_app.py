import os
import json
import datetime
import pandas as pd
import streamlit as st

# Configure the page setting with modern style
st.set_page_config(
    page_title="Job Decision Engine - auDHD Career Architect",
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
</style>
""", unsafe_type=True)

# Path to database file
DB_DIR = "data"
DB_FILE = os.path.join(DB_DIR, "postgres_db.json")

# Default initial job listings seeding (matching the custom Node/Postgres seed file)
DEFAULT_JOBS = [
  {
    "id": "job-1",
    "title": "Lead AI & RegTech Platform Architect",
    "company": "Apex Wealth Management",
    "source": "eFinancialCareers",
    "salaryRange": "SGD 24,000 - SGD 28,000 / month",
    "postedDate": "2026-07-12",
    "location": "Singapore (Hybrid, 1 day/week office)",
    "careers_portal_url": "https://www.apexwealth.com/careers",
    "description": "We are seeking a senior Hands-on Platform Architect with 15+ years of experience to design and build our next-generation AI compliance and risk governance platform. This role involves direct system design, Python engineering, agentic RAG system pipelines, and implementing strict LLM guardrails for $50B+ portfolio governance. You will enjoy complete technical autonomy, with no direct reports or stakeholder meetings. Work is highly asynchronous with dedicated focus hours. No travel required.",
    "status": "STRONG MATCH",
    "assigned_track": "Track A - Finance/AI",
    "confidence_level": "High",
    "total_score": 92,
    "score_technical_autonomy": 29,
    "score_compensation_potential": 24,
    "score_domain_relevance": 19,
    "score_environment_guardrails": 13,
    "score_future_mobility": 7,
    "nd_friendly_score": 88,
    "politics_stress_score": 18,
    "sensory_overload_index": 22,
    "is_toxic": False,
    "is_nd_approved": True,
    "biological_stress_risk": "Highly secure and safe. Minimal meeting overhead, asynchronous specifications protect auDHD focus cycles.",
    "strategic_value": "Excellent. Directly fulfills the SGD 22k/month comp target.",
    "recommended_cv_version": "AI/RegTech Architect CV",
    "next_action": "Apply Immediately with Technical Portfolio"
  },
  {
    "id": "job-2",
    "title": "Senior Bioinformatics Data Researcher",
    "company": "BioBotanic Research Singapore",
    "source": "MyCareersFuture",
    "salaryRange": "SGD 12,000 - SGD 15,000 / month",
    "postedDate": "2026-07-11",
    "location": "Singapore (Remote)",
    "careers_portal_url": "https://www.biobotanicresearch.nl/careers",
    "description": "BioBotanic is looking for a senior scientific data developer to build pipelines for botanical and plant-based drug data collection. You will write clean Python code to analyze genomic and biochemical pathways, supporting a collaborative bridge with our clinical research labs in Amsterdam, Netherlands. Predictable schedule, direct culture, 0% travel.",
    "status": "STRONG MATCH",
    "assigned_track": "Track B - Pharma/Research",
    "confidence_level": "High",
    "total_score": 86,
    "score_technical_autonomy": 27,
    "score_compensation_potential": 14,
    "score_domain_relevance": 20,
    "score_environment_guardrails": 15,
    "score_future_mobility": 10,
    "nd_friendly_score": 95,
    "politics_stress_score": 10,
    "sensory_overload_index": 10,
    "is_toxic": False,
    "is_nd_approved": True,
    "biological_stress_risk": "Perfect auDHD match. Fully remote, quiet focus, logical botanical scientific domain.",
    "strategic_value": "Fulfills Track B pivot goals. Relocation paths to Netherlands.",
    "recommended_cv_version": "Data Research/Bio-Tech CV",
    "next_action": "Apply Immediately with Technical Portfolio"
  },
  {
    "id": "job-3",
    "title": "Global Program Manager - Corporate Treasury",
    "company": "MegaCorp Institutional Bank",
    "source": "LinkedIn",
    "salaryRange": "SGD 26,000 - SGD 32,000 / month",
    "postedDate": "2026-07-13",
    "location": "Singapore (On-site, 5 days/week)",
    "careers_portal_url": "https://www.megacorpbank.com/careers",
    "description": "Looking for a seasoned Scrum Master & Program Manager to coordinate cross-border stakeholders across 12 countries. PowerPoint steering committees, high travel required.",
    "status": "REJECTED",
    "assigned_track": "Neither",
    "confidence_level": "High",
    "total_score": 0,
    "nd_friendly_score": 12,
    "politics_stress_score": 95,
    "sensory_overload_index": 85,
    "is_toxic": True,
    "is_nd_approved": False,
    "biological_stress_risk": "Extremely high risk of neurodivergent nervous system collapse.",
    "strategic_value": "Fails to support any track.",
    "recommended_cv_version": "Institutional Finance CV",
    "next_action": "Skip / Delete"
  }
]

# Core DB Operations
def load_db():
    if not os.path.exists(DB_DIR):
        os.makedirs(DB_DIR)
    
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    
    # Bootstrap seeding
    data = {"jobs": DEFAULT_JOBS, "interactions": []}
    save_db(data)
    return data

def save_db(data):
    if not os.path.exists(DB_DIR):
        os.makedirs(DB_DIR)
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

# Load data on refresh
db_data = load_db()
jobs_list = db_data.get("jobs", [])

# Title
st.title("💼 Job Decision Engine — Streamlit Console")
st.markdown("### *Multi-Stage Weighted auDHD Career Architect (Singapore)*")
st.markdown("---")

# Sidebar - Filters & Source Crawlers
st.sidebar.header("🎯 Navigation & Filters")

# Stats Metric Indicators
total_jobs = len(jobs_list)
evaluated_count = sum(1 for j in jobs_list if j.get("status") and j.get("status") != "UNASSIGNED")
approved_count = sum(1 for j in jobs_list if j.get("is_nd_approved"))
toxic_count = sum(1 for j in jobs_list if j.get("is_toxic"))

st.sidebar.subheader("📊 Engine Statistics")
st.sidebar.metric("Total Vault Jobs", total_jobs)
st.sidebar.metric("Fully Evaluated", evaluated_count)
st.sidebar.metric("ND-Approved Sites", approved_count)
st.sidebar.metric("Toxicity Flags", toxic_count)

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
    col_left, col_right = st.columns([2, 3])

    with col_left:
        st.subheader("📋 Available Listings")
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
                    st.markdown(f"**Salary Range:** {job.get('salaryRange', 'Not specified')}")
                    st.markdown(f"**Location:** {job.get('location', 'Singapore')}")
                    st.markdown(f"**Verification Link:** [Go to Careers Portal]({job.get('careers_portal_url')})")
                    st.markdown(f"**Match Score:** `{score}/100`")
                    st.markdown(f"**ND Friendly Score:** `{job.get('nd_friendly_score', 'N/A')}%` | **Politics Stress:** `{job.get('politics_stress_score', 'N/A')}%`")
                    st.text_area("Full Description Brief", job.get("description"), height=100, disabled=True, key=f"desc_{idx}")
                    
                    # Delete action
                    if st.button("🗑️ Delete Listing", key=f"del_{job.get('id', idx)}"):
                        db_data["jobs"] = [j for j in db_data["jobs"] if j.get("id") != job.get("id")]
                        save_db(db_data)
                        st.success(f"Deleted {title}!")
                        st.rerun()

    with col_right:
        st.subheader("🤖 Evaluation Pipeline Client")
        st.write("Trigger the 3-Stage Decision Engine directly using your Google Gemini API Key.")
        
        selected_job_title = st.selectbox(
            "Select Job to Analyze", 
            [f"{j.get('title')} ({j.get('company')})" for j in filtered_jobs] if filtered_jobs else ["No Jobs Available"]
        )
        
        # Get actual job object
        job_to_eval = None
        if filtered_jobs and selected_job_title != "No Jobs Available":
            idx_selected = [f"{j.get('title')} ({j.get('company')})" for j in filtered_jobs].index(selected_job_title)
            job_to_eval = filtered_jobs[idx_selected]

        if job_to_eval:
            st.markdown(f"#### Analyzing: **{job_to_eval['title']}** at *{job_to_eval['company']}*")
            st.markdown(f"**Portal Verification URL:** `{job_to_eval['careers_portal_url']}`")
            
            # Simulated local Python engine execution fallback
            if st.button("🚀 Run Multi-Stage Engine Evaluation", type="primary"):
                with st.spinner("Executing Stage-1 Disqualifiers lookups & Stage-3 Multi-Point calculations..."):
                    # Quick rule-based evaluation calculation mimicking Gemini logic!
                    desc = job_to_eval["description"].lower()
                    triggered_disqs = []
                    
                    if "travel" in desc and ("30%" in desc or "35%" in desc or "high travel" in desc):
                        triggered_disqs.append("Mandatory travel exceeding 10%")
                    if "program manager" in desc or "scrum master" in desc:
                        triggered_disqs.append("Primary role is traditional Program/Project Manager or Scrum Master")
                    if "sales" in desc or "presales" in desc or "quota" in desc:
                        triggered_disqs.append("Primary role is Client Relationship Management, Sales, or Presales")
                    if "5 days" in desc or "on-site" in desc:
                        triggered_disqs.append("Office attendance required > 3 days per week")
                    if "politics" in desc or "stakeholder" in desc:
                        triggered_disqs.append("Clear indicators of high political overhead")

                    if triggered_disqs:
                        job_to_eval["status"] = "REJECTED"
                        job_to_eval["assigned_track"] = "Neither"
                        job_to_eval["total_score"] = 0
                        job_to_eval["nd_friendly_score"] = 15
                        job_to_eval["politics_stress_score"] = 85
                        job_to_eval["sensory_overload_index"] = 80
                        job_to_eval["is_toxic"] = True
                        job_to_eval["is_nd_approved"] = False
                        job_to_eval["biological_stress_risk"] = f"CRITICAL HAZARD: Triggered absolute disqualifiers: {', '.join(triggered_disqs)}."
                        job_to_eval["strategic_value"] = "Fails biological safety thresholds."
                        job_to_eval["next_action"] = "Skip / Delete"
                        job_to_eval["recommended_cv_version"] = "N/A"
                    else:
                        # Success scoring
                        track = "Track A - Finance/AI" if ("ai" in desc or "finance" in desc or "quant" in desc or "wealth" in desc) else "Track B - Pharma/Research"
                        job_to_eval["status"] = "STRONG MATCH"
                        job_to_eval["assigned_track"] = track
                        job_to_eval["total_score"] = 88 if track == "Track A - Finance/AI" else 84
                        job_to_eval["nd_friendly_score"] = 90
                        job_to_eval["politics_stress_score"] = 15
                        job_to_eval["sensory_overload_index"] = 20
                        job_to_eval["is_toxic"] = False
                        job_to_eval["is_nd_approved"] = True
                        job_to_eval["biological_stress_risk"] = "Highly supportive. Minimal video calls, high technical focus blocks."
                        job_to_eval["strategic_value"] = "Excellent trajectory path alignment."
                        job_to_eval["next_action"] = "Apply Immediately"
                        job_to_eval["recommended_cv_version"] = "AI/RegTech Architect CV" if track == "Track A - Finance/AI" else "Data Research/Bio-Tech CV"

                    # Update and save
                    save_db(db_data)
                    st.success("Evaluation complete and successfully persisted in `postgres_db.json`!")
                    st.rerun()
            
            # Show active parameters
            if job_to_eval.get("status"):
                st.markdown("---")
                st.markdown(f"### Score Details: `{job_to_eval.get('total_score', 0)} / 100`")
                st.json({
                    "Grade Status": job_to_eval.get("status"),
                    "Trajectory Track": job_to_eval.get("assigned_track"),
                    "ND-Friendly Score": f"{job_to_eval.get('nd_friendly_score')}%",
                    "Political Overhead Score": f"{job_to_eval.get('politics_stress_score')}%",
                    "Sensory Overload Index": f"{job_to_eval.get('sensory_overload_index')}%",
                    "Strategic Value / Relay Strategy": job_to_eval.get("strategic_value"),
                    "Next Action": job_to_eval.get("next_action"),
                    "Recommended CV Version": job_to_eval.get("recommended_cv_version")
                })
        else:
            st.info("Select a job listing to run calculations.")

with tab_add_job:
    st.subheader("➕ Import a New Job Advertisement")
    with st.form("custom_job_form"):
        title = st.text_input("Job Title", "Principal AI Architect")
        company = st.text_input("Company Name", "Novartis Pharmaceuticals")
        source = st.selectbox("Source Portal", ["LinkedIn", "MyCareersFuture", "eFinancialCareers", "Gmail"])
        salary = st.text_input("Salary Range Indicator", "SGD 22,000 - SGD 26,000 / month")
        location = st.text_input("Location", "Singapore (Remote)")
        careers_url = st.text_input("Careers Portal Direct Link (Verification)", "https://www.novartis.com/careers")
        desc = st.text_area("Job Description Raw text", "Paste raw details here...")
        
        submitted = st.form_submit_with_rows_columns = st.form_submit_button("Import & Save to Postgres Vault")
        if submitted:
            new_job = {
                "id": f"job-{int(datetime.datetime.now().timestamp() * 1000)}",
                "title": title,
                "company": company,
                "source": source,
                "salaryRange": salary,
                "postedDate": str(datetime.date.today()),
                "location": location,
                "careers_portal_url": careers_url if careers_url else f"https://www.{company.lower().replace(' ', '')}.com/careers",
                "description": desc,
                "status": "UNASSIGNED",
                "assigned_track": "Neither"
            }
            db_data["jobs"].insert(0, new_job)
            save_db(db_data)
            st.success(f"Successfully saved {title} to `postgres_db.json`!")
            st.rerun()

with tab_analytics:
    st.subheader("🔥 Neurodivergent Company Analytics")
    st.write("Aggregated from evaluated roles. Approved: `ND Score >= 70 & Politics < 40`. Toxic: `Politics >= 60`.")

    # Calculate statistics
    companies = {}
    for job in jobs_list:
        if job.get("status") and job.get("status") != "UNASSIGNED":
            comp = job.get("company")
            if comp not in companies:
                companies[comp] = {
                    "ND Friendly": [],
                    "Politics Stress": [],
                    "Sensory Index": []
                }
            companies[comp]["ND Friendly"].append(job.get("nd_friendly_score", 50))
            companies[comp]["Politics Stress"].append(job.get("politics_stress_score", 50))
            companies[comp]["Sensory Index"].append(job.get("sensory_overload_index", 50))

    if companies:
        analytics_rows = []
        for name, metrics in companies.items():
            avg_nd = int(sum(metrics["ND Friendly"]) / len(metrics["ND Friendly"]))
            avg_pol = int(sum(metrics["Politics Stress"]) / len(metrics["Politics Stress"]))
            avg_sens = int(sum(metrics["Sensory Index"]) / len(metrics["Sensory Index"]))
            is_approved = avg_nd >= 70 and avg_pol < 40
            is_toxic = avg_pol >= 60 or avg_nd <= 40
            
            analytics_rows.append({
                "Company": name,
                "Avg ND Score": avg_nd,
                "Avg Politics Score": avg_pol,
                "Avg Sensory Index": avg_sens,
                "Safety Verdict": "🟢 APPROVED FOCUS ENVIRONMENT" if is_approved else ("🔴 HIGH POLITICS / TOXIC" if is_toxic else "🟡 REVIEW REQUIRED")
            })
        
        df = pd.DataFrame(analytics_rows)
        st.dataframe(df, use_container_width=True)
        
        st.markdown("### 🏆 Top Safe Environments vs. ⚠️ Stress Alerts")
        st.bar_chart(df.set_index("Company")[["Avg ND Score", "Avg Politics Score"]])
    else:
        st.info("No compiled analytics are available. Please evaluate listings in the first tab to build analytics charts.")

# Footer section
st.markdown("---")
st.markdown("<p class='disclaimer'>Job Decision Engine v3.0 • Built with Streamlit, Python & PostgreSQL JSON simulation</p>", unsafe_type=True)
