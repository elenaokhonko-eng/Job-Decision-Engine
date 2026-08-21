import pg from "pg";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle database client:", err.message || err);
});

// Verify if a URL is valid and live (does not 404 or redirect to an expired page)
export async function verifyUrlLive(url: string, bypassLiveCheck = false): Promise<boolean> {
  if (!url) return false;
  if (bypassLiveCheck) {
    return true;
  }
  
  const validDomains = ["linkedin.com", "mycareersfuture.gov.sg", "efinancialcareers.com", "efinancialcareers.sg"];
  
  try {
    const parsed = new URL(url);
    if (!validDomains.some(domain => parsed.hostname.includes(domain))) {
      console.log(`❌ URL Verification Failed: Domain not in scope (${url})`);
      return false;
    }
  } catch {
    console.log(`❌ URL Verification Failed: Invalid URL format (${url})`);
    return false;
  }

  if (bypassLiveCheck) {
    return true;
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(6000)
    });

    if (response.status === 404 || response.status === 410) {
      console.log(`❌ URL Verification Failed: HTTP Status ${response.status} (${url})`);
      return false;
    }

    const finalUrl = response.url.toLowerCase();
    if (finalUrl.includes("expired") || finalUrl.includes("not-found") || finalUrl.includes("job-not-found") || finalUrl.includes("inactive")) {
      console.log(`❌ URL Verification Failed: Redirected to expired page: ${response.url}`);
      return false;
    }

    return true;
  } catch (err: any) {
    // Fail-open for timeout or scraper blocks if format/domain are correct
    console.log(`⚠️ URL Verification Warning: Could not reach URL due to network/access restriction, allowing format-only check. (${err.message || err})`);
    return true;
  }
}

// Define the interface for a Job conforming to our Postgres schema
export interface Job {
  id: string;
  title: string;
  company: string;
  source: "LinkedIn" | "MyCareersFuture" | "eFinancialCareers" | "Gmail";
  description: string;
  salaryRange?: string;
  postedDate?: string;
  location?: string;
  careers_portal_url: string; // Mandatory direct URL to company's careers portal to verify it's a real job
  
  // Scoring & ND Analytical fields populated after evaluation
  stage1_status?: "PASS" | "HARD_FAIL" | "NEEDS_VERIFICATION" | "UNASSIGNED";
  final_classification?: "PRIORITY_APPLY" | "APPLY_AFTER_VERIFICATION" | "HIGH_FIT_HIGH_RISK" | "LOW_STRATEGIC_VALUE" | "REJECTED";
  confidence_level?: "High" | "Medium" | "Low";
  
  // Stage 2: Career Horizon
  career_horizon_route?: "SCIENTIFIC_AI_CONVERGENCE" | "AI_DATA_MASTERY_BRIDGE" | "SCIENCE_DOMAIN_BRIDGE" | "TECHNICAL_ARCHITECTURE_BRIDGE" | "NONTECHNICAL_ADJACENCY" | "STRATEGIC_DEAD_END";
  career_horizon_score?: number;
  
  // Stage 3: Core Fit
  core_fit_score?: number;
  score_hands_on_mastery?: number;
  score_technical_autonomy?: number;
  score_role_purity?: number;
  score_comp_quality?: number;
  score_market_durability?: number;

  // Neurotype Compatibility Indicators
  nd_friendly_score?: number;      // 0 - 100 (high = safe/supportive)
  politics_stress_score?: number;   // 0 - 100 (high = political overhead/stressful)
  sensory_overload_index?: number;  // 0 - 100 (high = noisy open offices/constant video)
  is_toxic?: boolean;
  is_nd_approved?: boolean;
  biological_stress_risk?: string;
  strategic_value?: string;
  recommended_cv_version?: string;
  next_action?: string;
  is_top_ten?: boolean;
}

// Define the interface for a Raw Job conforming to raw_jobs staging schema
export interface RawJob {
  id: string;
  company_name: string;
  title: string;
  source: string;
  raw_description: string;
  salary_range?: string;
  posted_date?: string;
  location?: string;
  careers_portal_url: string;
  processed?: boolean;
  processed_at?: string;
  created_at?: string;
}

// Define the interface for an Interaction
export interface Interaction {
  id: string;
  timestamp: string;
  question: string;
  toolsUsed: string[];
  answer: any; // Can be the structured JSON result
  trace: string[]; // Tool-call trace
}

// Default initial data to seed our database
const DEFAULT_JOBS: Omit<Job, "id">[] = [
  {
    title: "Lead AI & RegTech Platform Architect",
    company: "Apex Wealth Management",
    source: "eFinancialCareers",
    salaryRange: "SGD 24,000 - SGD 28,000 / month",
    postedDate: "2026-07-12",
    location: "Singapore (Hybrid, 1 day/week office)",
    careers_portal_url: "https://www.efinancialcareers.sg/jobs/lead-ai-regtech-platform-architect-apex-wealth-management-100231",
    description: "We are seeking a senior Hands-on Platform Architect with 15+ years of experience to design and build our next-generation AI compliance and risk governance platform. This role involves direct system design, Python engineering, agentic RAG system pipelines, and implementing strict LLM guardrails for $50B+ portfolio governance. You will enjoy complete technical autonomy, with no direct reports or stakeholder meetings. Work is highly asynchronous with dedicated focus hours. No travel required.",
    stage1_status: "PASS",
    final_classification: "PRIORITY_APPLY",
    career_horizon_route: "AI_DATA_MASTERY_BRIDGE",
    career_horizon_score: 85,
    confidence_level: "High",
    core_fit_score: 92,
    score_hands_on_mastery: 28,
    score_technical_autonomy: 25,
    score_role_purity: 15,
    score_comp_quality: 16,
    score_market_durability: 8,
    nd_friendly_score: 88,
    politics_stress_score: 18,
    sensory_overload_index: 22,
    biological_stress_risk: "Highly secure and safe. Minimal meeting overhead, asynchronous specifications protect builder focus cycles. Isolated technical execution avoids emotional and political burnout.",
    strategic_value: "Excellent. Directly fulfills the SGD 22k/month comp target, adds institutional wealth AI credentials, and is located in Singapore with optimal focus blocks.",
    recommended_cv_version: "AI/RegTech Architect CV",
    next_action: "Apply Immediately with Technical Portfolio"
  },
  {
    title: "Senior Bioinformatics Data Researcher",
    company: "BioBotanic Research Singapore",
    source: "MyCareersFuture",
    salaryRange: "SGD 12,000 - SGD 15,000 / month",
    postedDate: "2026-07-11",
    location: "Singapore (Remote)",
    careers_portal_url: "https://www.mycareersfuture.gov.sg/job/senior-bioinformatics-data-researcher-biobotanic-research-481902",
    description: "BioBotanic is looking for a senior scientific data developer to build pipelines for botanical and plant-based drug data collection. You will write clean Python code to analyze genomic and biochemical pathways, supporting a collaborative bridge with our clinical research labs in Amsterdam, Netherlands. Ideal for an experienced systems engineer transitioning into scientific data pipelines. Highly predictable schedule, direct culture, 0% travel.",
    stage1_status: "PASS",
    final_classification: "PRIORITY_APPLY",
    career_horizon_route: "SCIENTIFIC_AI_CONVERGENCE",
    career_horizon_score: 95,
    confidence_level: "High",
    core_fit_score: 86,
    score_hands_on_mastery: 27,
    score_technical_autonomy: 22,
    score_role_purity: 15,
    score_comp_quality: 14,
    score_market_durability: 8,
    nd_friendly_score: 95,
    politics_stress_score: 10,
    sensory_overload_index: 10,
    biological_stress_risk: "Perfect builder match. Fully remote, quiet focus, logical botanical scientific domain, zero stakeholder politics or high-stimulus meeting schedules.",
    strategic_value: "Fulfills Track B pivot goals. Directly partners with Dutch researchers, establishing clear academic/professional mobility paths to the Netherlands and planned PhD studies.",
    recommended_cv_version: "Data Research/Bio-Tech CV",
    next_action: "Apply Immediately with Technical Portfolio"
  },
  {
    title: "Global Program Manager - Corporate Treasury",
    company: "MegaCorp Institutional Bank",
    source: "LinkedIn",
    salaryRange: "SGD 26,000 - SGD 32,000 / month",
    postedDate: "2026-07-13",
    location: "Singapore (On-site, 5 days/week)",
    careers_portal_url: "https://www.linkedin.com/jobs/view/global-program-manager-megacorp-39281203",
    description: "Looking for a seasoned Scrum Master & Program Manager to coordinate cross-border stakeholders across 12 countries. You will run daily stand-ups, manage high political overhead, wrangle cross-departmental alignment, and build beautiful PowerPoint presentations for C-suite steering committees. Must have excellent client relationship skills and be willing to travel up to 35% of the time to APAC offices.",
    stage1_status: "HARD_FAIL",
    final_classification: "REJECTED",
    career_horizon_route: "STRATEGIC_DEAD_END",
    career_horizon_score: 10,
    confidence_level: "High",
    core_fit_score: 10,
    score_hands_on_mastery: 0,
    score_technical_autonomy: 0,
    score_role_purity: 0,
    score_comp_quality: 10,
    score_market_durability: 0,
    nd_friendly_score: 12,
    politics_stress_score: 95,
    sensory_overload_index: 85,
    biological_stress_risk: "Extremely high risk of severe burnout and high operational stress. 5 days on-site, constant stakeholder confrontation, heavy politics, and high APAC travel requirement (35%) violate multiple non-negotiable criteria.",
    strategic_value: "Fails to support either Track A hands-on tech engineering or Track B scientific relocations.",
    recommended_cv_version: "Institutional Finance CV",
    next_action: "Skip / Delete"
  },
  {
    title: "Principal Quantitative Risk Engineer",
    company: "Quantum Capital Partners",
    source: "eFinancialCareers",
    salaryRange: "SGD 28,000 - SGD 35,000 / month",
    postedDate: "2026-07-13",
    location: "Singapore (Hybrid, 2 days/week office)",
    careers_portal_url: "https://www.efinancialcareers.sg/jobs/principal-quantitative-risk-engineer-quantum-capital-102930",
    description: "Join us as a Principal Quantitative Risk Engineer. You will have full technical design control over institutional asset governance algorithms. The role is purely hands-on technical architecture and Python coding, implementing MAS FEAT regulatory guidelines via automated guardrails. No client-facing work, zero travel, fully asynchronous team communication.",
    stage1_status: "PASS",
    final_classification: "PRIORITY_APPLY",
    career_horizon_route: "AI_DATA_MASTERY_BRIDGE",
    career_horizon_score: 80,
    confidence_level: "High",
    core_fit_score: 95,
    score_hands_on_mastery: 30,
    score_technical_autonomy: 25,
    score_role_purity: 15,
    score_comp_quality: 17,
    score_market_durability: 8,
    nd_friendly_score: 91,
    politics_stress_score: 15,
    sensory_overload_index: 30,
    biological_stress_risk: "Highly recommended. Complete architectural sovereignty over algorithms. Minimal live interactions, fully written asynchronous specification structures protect builder task-switching costs.",
    strategic_value: "Massive. High base salary easily exceeds the SGD 22k/month baseline. Accentuates high-value quant/risk engineering experience.",
    recommended_cv_version: "AI/RegTech Architect CV",
    next_action: "Apply Immediately with Technical Portfolio"
  },
  {
    title: "Director of Digital Advisory & Presales",
    company: "FutureTech Consulting",
    source: "LinkedIn",
    salaryRange: "SGD 22,000 - SGD 25,000 / month",
    postedDate: "2026-07-10",
    location: "Singapore (On-site, 4 days/week)",
    careers_portal_url: "https://www.linkedin.com/jobs/view/director-digital-advisory-presales-futuretech-382903",
    description: "We are hiring a Client Relationship Director to carry an annual software sales quota. You will lead presales client advisory workshops, present technical architectures to external customers, and manage a team of 15 consultants. Expect high political overhead, intense client-facing meetings, and heavy presentation workloads.",
    stage1_status: "HARD_FAIL",
    final_classification: "REJECTED",
    career_horizon_route: "STRATEGIC_DEAD_END",
    career_horizon_score: 5,
    confidence_level: "High",
    core_fit_score: 20,
    score_hands_on_mastery: 0,
    score_technical_autonomy: 5,
    score_role_purity: 0,
    score_comp_quality: 15,
    score_market_durability: 0,
    nd_friendly_score: 22,
    politics_stress_score: 88,
    sensory_overload_index: 78,
    biological_stress_risk: "High risk. Sales quota carries heavy performance anxiety. Intensive social and client presentation workloads cause severe cognitive over-stimulation and sensory exhaustion.",
    strategic_value: "Violates the non-negotiable sales/advisory and high office-attendance thresholds.",
    recommended_cv_version: "Institutional Finance CV",
    next_action: "Skip / Delete"
  }
];

function mapRowToJob(row: any): Job {
  return {
    id: row.id,
    title: row.title,
    company: row.company_name,
    source: row.source,
    description: row.raw_description,
    salaryRange: row.salary_range || undefined,
    postedDate: row.posted_date ? new Date(row.posted_date).toISOString().split('T')[0] : undefined,
    location: row.location || undefined,
    careers_portal_url: row.careers_portal_url,
    stage1_status: row.stage1_status || undefined,
    final_classification: row.final_classification || undefined,
    confidence_level: row.confidence_level || undefined,
    career_horizon_route: row.career_horizon_route || undefined,
    career_horizon_score: row.career_horizon_score !== null ? parseInt(row.career_horizon_score) : undefined,
    core_fit_score: row.core_fit_score !== null ? parseInt(row.core_fit_score) : undefined,
    score_hands_on_mastery: row.score_hands_on_mastery !== null ? parseInt(row.score_hands_on_mastery) : undefined,
    score_technical_autonomy: row.score_technical_autonomy !== null ? parseInt(row.score_technical_autonomy) : undefined,
    score_role_purity: row.score_role_purity !== null ? parseInt(row.score_role_purity) : undefined,
    score_comp_quality: row.score_comp_quality !== null ? parseInt(row.score_comp_quality) : undefined,
    score_market_durability: row.score_market_durability !== null ? parseInt(row.score_market_durability) : undefined,
    nd_friendly_score: row.nd_friendly_score !== null ? parseInt(row.nd_friendly_score) : undefined,
    politics_stress_score: row.politics_stress_score !== null ? parseInt(row.politics_stress_score) : undefined,
    sensory_overload_index: row.sensory_overload_index !== null ? parseInt(row.sensory_overload_index) : undefined,
    biological_stress_risk: row.biological_stress_risk || undefined,
    strategic_value: row.strategic_value || undefined,
    recommended_cv_version: row.recommended_cv_version || undefined,
    next_action: row.next_action || undefined,
    is_top_ten: row.is_top_ten || false
  };
}

async function updateCompanyRatings(companyId: string) {
  // Query averages from evaluated jobs for this company
  const statsRes = await pool.query(
    `SELECT 
       AVG(nd_friendly_score) as avg_nd,
       AVG(politics_stress_score) as avg_pol,
       AVG(sensory_overload_index) as avg_sens,
       0 as avg_focus
     FROM jobs 
     WHERE company_id = $1 AND stage1_status != 'UNASSIGNED'`,
    [companyId]
  );

  if (statsRes.rows.length > 0) {
    const r = statsRes.rows[0];
    const avgND = r.avg_nd ? parseFloat(r.avg_nd) : 0.00;
    const avgPol = r.avg_pol ? parseFloat(r.avg_pol) : 0.00;
    const avgSens = r.avg_sens ? parseFloat(r.avg_sens) : 0.00;
    const avgFocus = 0.00;

    const isApproved = avgND >= 70 && avgPol < 50;
    const isToxic = avgPol >= 70 || avgND < 50;

    await pool.query(
      `UPDATE companies SET
         nd_friendly_avg_score = $2,
         politics_stress_avg_score = $3,
         sensory_overload_avg_index = $4,
         focus_protection_avg_score = $5,
         is_neurodivergent_approved = $6,
         is_toxic_culture_blacklisted = $7,
         updated_at = NOW()
       WHERE id = $1`,
      [companyId, avgND, avgPol, avgSens, avgFocus, isApproved, isToxic]
    );
  }
}

class PostgresDatabase {
  // Jobs queries
  public async queryJobs(searchTerm?: string): Promise<Job[]> {
    if (!searchTerm) {
      const res = await pool.query("SELECT * FROM jobs ORDER BY created_at DESC");
      return res.rows.map(mapRowToJob);
    }
    const lower = `%${searchTerm.toLowerCase()}%`;
    const res = await pool.query(
      `SELECT * FROM jobs 
       WHERE title ILIKE $1 OR company_name ILIKE $1 OR raw_description::text ILIKE $1 
       ORDER BY created_at DESC`,
      [lower]
    );
    return res.rows.map(mapRowToJob);
  }

  public async addJob(job: Omit<Job, "id">, bypassLiveCheck = false): Promise<Job> {
    if (!job.stage1_status || job.stage1_status === "UNASSIGNED") {
      throw new Error("Cannot insert unevaluated jobs into the final jobs table.");
    }
    if (!job.confidence_level) {
      throw new Error("Cannot insert job into the final jobs table without a valid confidence_level.");
    }

    // Check for existing job to prevent duplicate rows in jobs table
    const existingJob = await pool.query(
      "SELECT id FROM jobs WHERE (company_name = $1 AND title = $2) OR careers_portal_url = $3",
      [job.company, job.title, job.careers_portal_url]
    );
    if (existingJob.rows.length > 0) {
      const existingId = existingJob.rows[0].id;
      await this.updateJobEvaluation(existingId, job);
      const updated = await pool.query("SELECT * FROM jobs WHERE id = $1", [existingId]);
      return mapRowToJob(updated.rows[0]);
    }

    // Strictly validate the careers_portal_url before inserting
    const isUrlValid = await verifyUrlLive(job.careers_portal_url, bypassLiveCheck);
    if (!isUrlValid) {
      throw new Error(`Invalid or expired careers_portal_url: ${job.careers_portal_url}`);
    }

    // Check/insert company
    let companyId: string | null = null;
    const compRes = await pool.query("SELECT id FROM companies WHERE name = $1", [job.company]);
    if (compRes.rows.length > 0) {
      companyId = compRes.rows[0].id;
    } else {
      const industry = job.title.toLowerCase().includes("bio") || job.title.toLowerCase().includes("pharma") ? "Life Sciences & Biotech" : "Institutional Finance & Asset AI";
      const insertComp = await pool.query(
        "INSERT INTO companies (name, industry, website_url, careers_page_url) VALUES ($1, $2, $3, $4) RETURNING id",
        [
          job.company,
          industry,
          `https://www.${job.company.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
          job.careers_portal_url
        ]
      );
      companyId = insertComp.rows[0].id;
    }

    let finalDesc = job.description;
    if (finalDesc && typeof finalDesc === "string" && !finalDesc.trim().startsWith("{")) {
      finalDesc = JSON.stringify({
        job_description: finalDesc,
        key_responsibilities: [],
        technical_skills: [],
        qualifications_education: [],
        nice_to_haves: []
      });
    }

    const insertJob = await pool.query(
      `INSERT INTO jobs (
        company_name, company_id, title, source, raw_description, salary_range, location, posted_date, careers_portal_url,
        stage1_status, final_classification, confidence_level,
        career_horizon_route, career_horizon_score,
        core_fit_score, score_hands_on_mastery, score_technical_autonomy, score_role_purity, score_comp_quality, score_market_durability,
        nd_friendly_score, politics_stress_score, sensory_overload_index, biological_stress_risk, strategic_value, recommended_cv_version, next_action, is_top_ten
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28) RETURNING *`,
      [
        job.company, companyId, job.title, job.source, finalDesc,
        job.salaryRange || null, job.location || null, job.postedDate || new Date().toISOString().split("T")[0],
        job.careers_portal_url, job.stage1_status || "UNASSIGNED", job.final_classification || null,
        job.confidence_level || null, job.career_horizon_route || null, job.career_horizon_score || 0,
        job.core_fit_score || 0, job.score_hands_on_mastery || 0, job.score_technical_autonomy || 0,
        job.score_role_purity || 0, job.score_comp_quality || 0, job.score_market_durability || 0,
        job.nd_friendly_score || null, job.politics_stress_score || null, job.sensory_overload_index || 0,
        job.biological_stress_risk || null, job.strategic_value || null,
        job.recommended_cv_version || null, job.next_action || null,
        job.is_top_ten || false
      ]
    );

    // If evaluated already, update company averages
    if (companyId) {
      await updateCompanyRatings(companyId);
    }

    return mapRowToJob(insertJob.rows[0]);
  }

  public async updateJobEvaluation(id: string, evaluation: Partial<Job>): Promise<boolean> {
    const query = `
      UPDATE jobs SET
        stage1_status = COALESCE($2, stage1_status),
        final_classification = COALESCE($3, final_classification),
        confidence_level = COALESCE($4, confidence_level),
        career_horizon_route = COALESCE($5, career_horizon_route),
        career_horizon_score = COALESCE($6, career_horizon_score),
        core_fit_score = COALESCE($7, core_fit_score),
        score_hands_on_mastery = COALESCE($8, score_hands_on_mastery),
        score_technical_autonomy = COALESCE($9, score_technical_autonomy),
        score_role_purity = COALESCE($10, score_role_purity),
        score_comp_quality = COALESCE($11, score_comp_quality),
        score_market_durability = COALESCE($12, score_market_durability),
        nd_friendly_score = COALESCE($13, nd_friendly_score),
        politics_stress_score = COALESCE($14, politics_stress_score),
        sensory_overload_index = COALESCE($15, sensory_overload_index),
        biological_stress_risk = COALESCE($16, biological_stress_risk),
        strategic_value = COALESCE($17, strategic_value),
        recommended_cv_version = COALESCE($18, recommended_cv_version),
        next_action = COALESCE($19, next_action),
        careers_portal_url = COALESCE($20, careers_portal_url),
        updated_at = NOW()
      WHERE id = $1
    `;
    const res = await pool.query(query, [
      id,
      evaluation.stage1_status,
      evaluation.final_classification,
      evaluation.confidence_level,
      evaluation.career_horizon_route,
      evaluation.career_horizon_score,
      evaluation.core_fit_score,
      evaluation.score_hands_on_mastery,
      evaluation.score_technical_autonomy,
      evaluation.score_role_purity,
      evaluation.score_comp_quality,
      evaluation.score_market_durability,
      evaluation.nd_friendly_score,
      evaluation.politics_stress_score,
      evaluation.sensory_overload_index,
      evaluation.biological_stress_risk,
      evaluation.strategic_value,
      evaluation.recommended_cv_version,
      evaluation.next_action,
      evaluation.careers_portal_url
    ]);

    // Update company ratings!
    const jobRes = await pool.query("SELECT company_id FROM jobs WHERE id = $1", [id]);
    if (jobRes.rows.length > 0 && jobRes.rows[0].company_id) {
      await updateCompanyRatings(jobRes.rows[0].company_id);
    }

    return res.rowCount !== null && res.rowCount > 0;
  }

  public async deleteJob(id: string): Promise<boolean> {
    const jobRes = await pool.query("SELECT company_id FROM jobs WHERE id = $1", [id]);
    const res = await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    
    if (jobRes.rows.length > 0 && jobRes.rows[0].company_id) {
      await updateCompanyRatings(jobRes.rows[0].company_id);
    }

    return res.rowCount !== null && res.rowCount > 0;
  }

  // Interactions (logging) queries
  public async logInteraction(question: string, toolsUsed: string[], answer: any, trace: string[]): Promise<Interaction> {
    const res = await pool.query(
      `INSERT INTO interactions_log (question, tools_used, agent_trace, structured_answer) 
       VALUES ($1, $2, $3, $4) RETURNING id, created_at as timestamp, question, tools_used as "toolsUsed", agent_trace as trace, structured_answer as answer`,
      [question, toolsUsed, trace, JSON.stringify(answer)]
    );
    return res.rows[0];
  }

  public async getInteractions(): Promise<Interaction[]> {
    const res = await pool.query(
      `SELECT id, created_at as timestamp, question, tools_used as "toolsUsed", structured_answer as answer, agent_trace as trace 
       FROM interactions_log ORDER BY created_at DESC`
    );
    return res.rows;
  }

  public async clearInteractions(): Promise<void> {
    await pool.query("DELETE FROM interactions_log");
  }

  /**
   * Analytics Aggregation Engine
   * Dynamically compiles company metrics from the database.
   */
  public async getNdCultureAnalytics(): Promise<any> {
    const approved = await pool.query("SELECT * FROM nd_approved_companies");
    const toxic = await pool.query("SELECT * FROM nd_blacklisted_companies");
    const totalRes = await pool.query("SELECT COUNT(*) as count FROM companies");

    return {
      ndApproved: approved.rows.map((r) => ({
        company: r.name,
        industry: r.industry,
        careers_portal_url: r.careers_page_url,
        nd_friendly_score: Math.round(parseFloat(r.nd_score || "50")),
        politics_stress_score: Math.round(parseFloat(r.politics_index || "50")),
        sensory_overload_index: 30, // standard sensory fallback
        avg_match_score: 85, // standard match fallback
        is_nd_approved: true,
        is_toxic: false
      })),
      toxicBlacklist: toxic.rows.map((r) => ({
        company: r.name,
        industry: r.industry,
        careers_portal_url: r.careers_page_url,
        nd_friendly_score: Math.round(parseFloat(r.nd_score || "50")),
        politics_stress_score: Math.round(parseFloat(r.toxic_politics_score || "50")),
        sensory_overload_index: Math.round(parseFloat(r.sensory_hazard_index || "50")),
        avg_match_score: 0,
        is_nd_approved: false,
        is_toxic: true
      })),
      allCompaniesCount: parseInt(totalRes.rows[0]?.count || "0")
    };
  }

  public async addRawJob(job: Omit<RawJob, "id" | "processed" | "processed_at" | "created_at">): Promise<RawJob> {
    // Populate raw_companies table automatically
    if (job.company_name) {
      const industry = job.title.toLowerCase().includes("bio") || job.title.toLowerCase().includes("pharma") ? "Life Sciences & Biotech" : "Institutional Finance & Asset AI";
      await pool.query(
        "INSERT INTO raw_companies (name, industry, website_url, careers_page_url) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING",
        [
          job.company_name,
          industry,
          `https://www.${job.company_name.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
          job.careers_portal_url
        ]
      );
    }

    let finalRawDesc = job.raw_description;
    if (finalRawDesc && typeof finalRawDesc === "string" && !finalRawDesc.trim().startsWith("{")) {
      finalRawDesc = JSON.stringify({
        job_description: finalRawDesc,
        key_responsibilities: [],
        technical_skills: [],
        qualifications_education: [],
        nice_to_haves: []
      });
    }

    const res = await pool.query(
      `INSERT INTO raw_jobs (company_name, title, source, raw_description, salary_range, location, posted_date, careers_portal_url, processed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE) RETURNING *`,
      [
        (job.company_name || "Unknown").substring(0, 255),
        (job.title || "Unknown").substring(0, 255),
        (job.source || "Unknown").substring(0, 50),
        finalRawDesc,
        job.salary_range ? job.salary_range.substring(0, 255) : null,
        job.location ? job.location.substring(0, 255) : null,
        job.posted_date || new Date().toISOString().split("T")[0],
        job.careers_portal_url
      ]
    );
    return res.rows[0];
  }

  public async queryRawJobs(unprocessedOnly = true): Promise<RawJob[]> {
    const queryStr = unprocessedOnly 
      ? "SELECT * FROM raw_jobs WHERE processed = FALSE ORDER BY created_at DESC"
      : "SELECT * FROM raw_jobs ORDER BY created_at DESC";
    const res = await pool.query(queryStr);
    return res.rows;
  }

  public async markRawJobProcessed(id: string): Promise<boolean> {
    const res = await pool.query(
      "UPDATE raw_jobs SET processed = TRUE, processed_at = NOW() WHERE id = $1",
      [id]
    );
    return res.rowCount !== null && res.rowCount > 0;
  }

  public async resetToDefaults(): Promise<void> {
    await pool.query("DELETE FROM jobs");
    await pool.query("DELETE FROM companies");
    await pool.query("DELETE FROM interactions_log");
    await pool.query("DELETE FROM raw_jobs");
    await pool.query("DELETE FROM raw_companies");

    for (const job of DEFAULT_JOBS) {
      await this.addJob(job, true);
    }
  }
}

export const db = new PostgresDatabase();
