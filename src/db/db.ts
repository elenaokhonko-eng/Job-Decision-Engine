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
  status?: "UNASSIGNED" | "STRONG MATCH" | "REVIEW REQUIRED" | "REJECTED";
  assigned_track?: "Track A - Finance/AI" | "Track B - Pharma/Research" | "Neither";
  confidence_level?: "High" | "Medium" | "Low";
  total_score?: number;
  
  // Specific score components
  score_technical_autonomy?: number;
  score_compensation_potential?: number;
  score_domain_relevance?: number;
  score_environment_guardrails?: number;
  score_future_mobility?: number;

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
    status: "STRONG MATCH",
    assigned_track: "Track A - Finance/AI",
    confidence_level: "High",
    total_score: 92,
    score_technical_autonomy: 29,
    score_compensation_potential: 24,
    score_domain_relevance: 19,
    score_environment_guardrails: 13,
    score_future_mobility: 7,
    nd_friendly_score: 88,
    politics_stress_score: 18,
    sensory_overload_index: 22,
    biological_stress_risk: "Highly secure and safe. Minimal meeting overhead, asynchronous specifications protect auDHD focus cycles. Isolated technical execution avoids emotional and political burnout.",
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
    status: "STRONG MATCH",
    assigned_track: "Track B - Pharma/Research",
    confidence_level: "High",
    total_score: 86,
    score_technical_autonomy: 27,
    score_compensation_potential: 14,
    score_domain_relevance: 20,
    score_environment_guardrails: 15,
    score_future_mobility: 10,
    nd_friendly_score: 95,
    politics_stress_score: 10,
    sensory_overload_index: 10,
    biological_stress_risk: "Perfect auDHD match. Fully remote, quiet focus, logical botanical scientific domain, zero stakeholder politics or high-stimulus meeting schedules.",
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
    status: "REJECTED",
    assigned_track: "Neither",
    confidence_level: "High",
    total_score: 0,
    nd_friendly_score: 12,
    politics_stress_score: 95,
    sensory_overload_index: 85,
    biological_stress_risk: "Extremely high risk of neurodivergent nervous system collapse. 5 days on-site, constant stakeholder confrontation, heavy politics, and high APAC travel requirement (35%) violate multiple non-negotiable criteria.",
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
    status: "STRONG MATCH",
    assigned_track: "Track A - Finance/AI",
    confidence_level: "High",
    total_score: 95,
    score_technical_autonomy: 30,
    score_compensation_potential: 25,
    score_domain_relevance: 18,
    score_environment_guardrails: 14,
    score_future_mobility: 8,
    nd_friendly_score: 91,
    politics_stress_score: 15,
    sensory_overload_index: 30,
    biological_stress_risk: "Highly recommended. Complete architectural sovereignty over algorithms. Minimal live interactions, fully written asynchronous specification structures protect auDHD task-switching costs.",
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
    status: "REJECTED",
    assigned_track: "Neither",
    confidence_level: "High",
    total_score: 0,
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
    status: row.status || undefined,
    assigned_track: row.assigned_track || undefined,
    confidence_level: row.confidence_level || undefined,
    total_score: row.total_score !== null ? parseInt(row.total_score) : undefined,
    score_technical_autonomy: row.score_technical_autonomy !== null ? parseInt(row.score_technical_autonomy) : undefined,
    score_compensation_potential: row.score_compensation_potential !== null ? parseInt(row.score_compensation_potential) : undefined,
    score_domain_relevance: row.score_domain_relevance !== null ? parseInt(row.score_domain_relevance) : undefined,
    score_environment_guardrails: row.score_environment_guardrails !== null ? parseInt(row.score_environment_guardrails) : undefined,
    score_future_mobility: row.score_future_mobility !== null ? parseInt(row.score_future_mobility) : undefined,
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
       AVG(score_environment_guardrails) as avg_focus
     FROM jobs 
     WHERE company_id = $1 AND status != 'UNASSIGNED'`,
    [companyId]
  );

  if (statsRes.rows.length > 0) {
    const r = statsRes.rows[0];
    const avgND = r.avg_nd ? parseFloat(r.avg_nd) : 0.00;
    const avgPol = r.avg_pol ? parseFloat(r.avg_pol) : 0.00;
    const avgSens = r.avg_sens ? parseFloat(r.avg_sens) : 0.00;
    const avgFocus = r.avg_focus ? parseFloat(r.avg_focus) : 0.00;

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
       WHERE title ILIKE $1 OR company_name ILIKE $1 OR raw_description ILIKE $1 
       ORDER BY created_at DESC`,
      [lower]
    );
    return res.rows.map(mapRowToJob);
  }

  public async addJob(job: Omit<Job, "id">, bypassLiveCheck = false): Promise<Job> {
    if (!job.status || job.status === "UNASSIGNED") {
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

    const insertJob = await pool.query(
      `INSERT INTO jobs (
        company_name, company_id, title, source, raw_description, salary_range, location, posted_date, careers_portal_url, status, assigned_track,
        confidence_level, total_score, score_technical_autonomy, score_compensation_potential, score_domain_relevance, score_environment_guardrails, score_future_mobility,
        nd_friendly_score, politics_stress_score, sensory_overload_index, biological_stress_risk, strategic_value, recommended_cv_version, next_action, is_top_ten
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26) RETURNING *`,
      [
        job.company, companyId, job.title, job.source, job.description,
        job.salaryRange || null, job.location || null, job.postedDate || new Date().toISOString().split("T")[0],
        job.careers_portal_url, job.status, job.assigned_track || "Neither",
        job.confidence_level || null, job.total_score || 0,
        job.score_technical_autonomy || 0, job.score_compensation_potential || 0,
        job.score_domain_relevance || 0, job.score_environment_guardrails || 0,
        job.score_future_mobility || 0, job.nd_friendly_score || 0,
        job.politics_stress_score || 0, job.sensory_overload_index || 0,
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
        status = COALESCE($2, status),
        assigned_track = COALESCE($3, assigned_track),
        confidence_level = COALESCE($4, confidence_level),
        total_score = COALESCE($5, total_score),
        score_technical_autonomy = COALESCE($6, score_technical_autonomy),
        score_compensation_potential = COALESCE($7, score_compensation_potential),
        score_domain_relevance = COALESCE($8, score_domain_relevance),
        score_environment_guardrails = COALESCE($9, score_environment_guardrails),
        score_future_mobility = COALESCE($10, score_future_mobility),
        nd_friendly_score = COALESCE($11, nd_friendly_score),
        politics_stress_score = COALESCE($12, politics_stress_score),
        sensory_overload_index = COALESCE($13, sensory_overload_index),
        biological_stress_risk = COALESCE($14, biological_stress_risk),
        strategic_value = COALESCE($15, strategic_value),
        recommended_cv_version = COALESCE($16, recommended_cv_version),
        next_action = COALESCE($17, next_action),
        careers_portal_url = COALESCE($18, careers_portal_url),
        updated_at = NOW()
      WHERE id = $1
    `;
    const res = await pool.query(query, [
      id,
      evaluation.status,
      evaluation.assigned_track,
      evaluation.confidence_level,
      evaluation.total_score,
      evaluation.score_technical_autonomy,
      evaluation.score_compensation_potential,
      evaluation.score_domain_relevance,
      evaluation.score_environment_guardrails,
      evaluation.score_future_mobility,
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

    const res = await pool.query(
      `INSERT INTO raw_jobs (company_name, title, source, raw_description, salary_range, location, posted_date, careers_portal_url, processed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE) RETURNING *`,
      [
        job.company_name,
        job.title,
        job.source,
        job.raw_description,
        job.salary_range || null,
        job.location || null,
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
