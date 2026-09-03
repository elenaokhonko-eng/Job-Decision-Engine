import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "./pgSsl.js";

// Load environment variables
dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: pgSslConfig(databaseUrl)
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
  content_hash?: string;
  title: string;
  company_name: string; // Used to be company
  source: string;
  raw_description: string; // Used to be description
  salary_range?: string; // Used to be salaryRange
  posted_date?: string; // Used to be postedDate
  location?: string;
  careers_portal_url: string;
  
  // Pipeline status
  processing_status?: "PENDING_GLOBAL_GATE" | "PENDING_LANE_CLASSIFICATION" | "PENDING_LLM_EVAL" | "FAILED" | "REJECTED" | "AMBIGUOUS" | "EVALUATED";
  rejection_code?: string;
  gate_version?: string;
  
  // Lane Classification
  primary_lane?: "CORE_AI_DATA" | "LEGAL_REGTECH" | "HEALTH_BIO_PHARMA" | "INVESTMENT_MARKETS_FINTECH" | string | null;
  secondary_lanes?: string[]; // Stored as JSONB in DB
  lane_confidence?: string;
  lane_evidence?: string;
  source_lane?: string;
  
  // Specific ND & stress assessment metrics
  nd_friendly_score?: number;
  politics_stress_score?: number;
  sensory_overload_index?: number;
  biological_stress_risk?: string;
  strategic_value?: string;
  recommended_cv_version?: string;
  next_action?: string;
  is_top_ten?: boolean;

  // New ND Work-Fit Fields
  nd_gate_status?: string;
  nd_score?: number;
  nd_evidence?: string;
  nd_risk_flags?: string[];
  work_mode_status?: string;
  office_days?: number;
  interaction_load?: number;
  building_research_ratio?: number;
  rejection_codes?: string[];
}

// Define the interface for a Raw Job conforming to raw_jobs staging schema
export interface RawJob {
  id: string;
  content_hash?: string;
  company_name: string;
  title: string;
  source: string;
  raw_description: string;
  salary_range?: string;
  posted_date?: string;
  location?: string;
  careers_portal_url: string;
  processed?: boolean;
  processing_status?: string;
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

// Default initial data to seed our database (removed for Phase 1 architecture shift)
const DEFAULT_JOBS: Omit<Job, "id">[] = [];

function mapRowToJob(row: any): Job {
  return {
    id: row.id,
    content_hash: row.content_hash || undefined,
    title: row.title,
    company_name: row.company_name,
    source: row.source,
    raw_description: row.raw_description,
    salary_range: row.salary_range || undefined,
    posted_date: row.posted_date ? new Date(row.posted_date).toISOString().split('T')[0] : undefined,
    location: row.location || undefined,
    careers_portal_url: row.careers_portal_url,
    processing_status: row.processing_status || undefined,
    rejection_code: row.rejection_code || undefined,
    gate_version: row.gate_version || undefined,
    primary_lane: row.primary_lane || undefined,
    secondary_lanes: row.secondary_lanes || undefined,
    lane_confidence: row.lane_confidence || undefined,
    lane_evidence: row.lane_evidence || undefined,
    source_lane: row.source_lane || undefined,
    nd_friendly_score: row.nd_friendly_score !== null ? parseInt(row.nd_friendly_score) : undefined,
    politics_stress_score: row.politics_stress_score !== null ? parseInt(row.politics_stress_score) : undefined,
    sensory_overload_index: row.sensory_overload_index !== null ? parseInt(row.sensory_overload_index) : undefined,
    biological_stress_risk: row.biological_stress_risk || undefined,
    strategic_value: row.strategic_value || undefined,
    recommended_cv_version: row.recommended_cv_version || undefined,
    next_action: row.next_action || undefined,
    is_top_ten: row.is_top_ten || false,
    nd_gate_status: row.nd_gate_status || undefined,
    nd_score: row.nd_score !== null ? parseInt(row.nd_score) : undefined,
    nd_evidence: row.nd_evidence || undefined,
    nd_risk_flags: row.nd_risk_flags || undefined,
    work_mode_status: row.work_mode_status || undefined,
    office_days: row.office_days !== null ? parseInt(row.office_days) : undefined,
    interaction_load: row.interaction_load !== null ? parseInt(row.interaction_load) : undefined,
    building_research_ratio: row.building_research_ratio !== null ? parseInt(row.building_research_ratio) : undefined,
    rejection_codes: row.rejection_codes || undefined
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
     WHERE company_id = $1 AND processing_status != 'PENDING_GLOBAL_GATE'`,
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
    if (!job.processing_status || job.processing_status === "PENDING_GLOBAL_GATE") {
      throw new Error("Cannot insert unevaluated jobs into the final jobs table.");
    }
    
    // We removed confidence_level check since some rejected jobs might not have it

    // Check for existing job to prevent duplicate rows in jobs table
    // We use content_hash if provided, else fallback to company_name + title
    let existingJob;
    if (job.content_hash) {
      existingJob = await pool.query("SELECT id FROM jobs WHERE content_hash = $1", [job.content_hash]);
    } else {
      existingJob = await pool.query(
        "SELECT id FROM jobs WHERE (company_name = $1 AND title = $2) OR careers_portal_url = $3",
        [job.company_name, job.title, job.careers_portal_url]
      );
    }
    
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
    const compRes = await pool.query("SELECT id FROM companies WHERE name = $1", [job.company_name]);
    if (compRes.rows.length > 0) {
      companyId = compRes.rows[0].id;
    } else {
      const industry = job.title.toLowerCase().includes("bio") || job.title.toLowerCase().includes("pharma") ? "Life Sciences & Biotech" : "Institutional Finance & Asset AI";
      const insertComp = await pool.query(
        "INSERT INTO companies (name, industry, website_url, careers_page_url) VALUES ($1, $2, $3, $4) RETURNING id",
        [
          job.company_name,
          industry,
          `https://www.${job.company_name.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
          job.careers_portal_url
        ]
      );
      companyId = insertComp.rows[0].id;
    }

    let finalDesc = job.raw_description;
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
        content_hash, company_name, company_id, title, source, raw_description, salary_range, location, posted_date, careers_portal_url,
        processing_status, rejection_code, gate_version, primary_lane, secondary_lanes, lane_confidence, lane_evidence, source_lane,
        nd_friendly_score, politics_stress_score, sensory_overload_index, biological_stress_risk, strategic_value, recommended_cv_version, next_action, is_top_ten,
        nd_gate_status, nd_score, nd_evidence, nd_risk_flags, work_mode_status, office_days, interaction_load, building_research_ratio, rejection_codes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35) RETURNING *`,
      [
        job.content_hash || null, job.company_name, companyId, job.title, job.source, finalDesc,
        job.salary_range || null, job.location || null, job.posted_date || new Date().toISOString().split("T")[0], job.careers_portal_url,
        job.processing_status || "EVALUATED", job.rejection_code || null, job.gate_version || null,
        job.primary_lane || null, job.secondary_lanes ? JSON.stringify(job.secondary_lanes) : null,
        job.lane_confidence || null, job.lane_evidence || null, job.source_lane || null,
        job.nd_friendly_score || null, job.politics_stress_score || null, job.sensory_overload_index || 0,
        job.biological_stress_risk || null, job.strategic_value || null,
        job.recommended_cv_version || null, job.next_action || null,
        job.is_top_ten || false,
        job.nd_gate_status || null, job.nd_score || null, job.nd_evidence || null, job.nd_risk_flags ? JSON.stringify(job.nd_risk_flags) : null,
        job.work_mode_status || null, job.office_days || null, job.interaction_load || null, job.building_research_ratio || null,
        job.rejection_codes ? JSON.stringify(job.rejection_codes) : null
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
        processing_status = COALESCE($2, processing_status),
        rejection_code = COALESCE($3, rejection_code),
        gate_version = COALESCE($4, gate_version),
        primary_lane = COALESCE($5, primary_lane),
        secondary_lanes = COALESCE($6, secondary_lanes),
        lane_confidence = COALESCE($7, lane_confidence),
        lane_evidence = COALESCE($8, lane_evidence),
        source_lane = COALESCE($9, source_lane),
        nd_friendly_score = COALESCE($10, nd_friendly_score),
        politics_stress_score = COALESCE($11, politics_stress_score),
        sensory_overload_index = COALESCE($12, sensory_overload_index),
        biological_stress_risk = COALESCE($13, biological_stress_risk),
        strategic_value = COALESCE($14, strategic_value),
        recommended_cv_version = COALESCE($15, recommended_cv_version),
        next_action = COALESCE($16, next_action),
        careers_portal_url = COALESCE($17, careers_portal_url),
        nd_gate_status = COALESCE($18, nd_gate_status),
        nd_score = COALESCE($19, nd_score),
        nd_evidence = COALESCE($20, nd_evidence),
        nd_risk_flags = COALESCE($21, nd_risk_flags),
        work_mode_status = COALESCE($22, work_mode_status),
        office_days = COALESCE($23, office_days),
        interaction_load = COALESCE($24, interaction_load),
        building_research_ratio = COALESCE($25, building_research_ratio),
        rejection_codes = COALESCE($26, rejection_codes),
        updated_at = NOW()
      WHERE id = $1
    `;
    const res = await pool.query(query, [
      id,
      evaluation.processing_status,
      evaluation.rejection_code,
      evaluation.gate_version,
      evaluation.primary_lane,
      evaluation.secondary_lanes ? JSON.stringify(evaluation.secondary_lanes) : undefined,
      evaluation.lane_confidence,
      evaluation.lane_evidence,
      evaluation.source_lane,
      evaluation.nd_friendly_score,
      evaluation.politics_stress_score,
      evaluation.sensory_overload_index,
      evaluation.biological_stress_risk,
      evaluation.strategic_value,
      evaluation.recommended_cv_version,
      evaluation.next_action,
      evaluation.careers_portal_url,
      evaluation.nd_gate_status,
      evaluation.nd_score,
      evaluation.nd_evidence,
      evaluation.nd_risk_flags ? JSON.stringify(evaluation.nd_risk_flags) : undefined,
      evaluation.work_mode_status,
      evaluation.office_days,
      evaluation.interaction_load,
      evaluation.building_research_ratio,
      evaluation.rejection_codes ? JSON.stringify(evaluation.rejection_codes) : undefined
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
      `INSERT INTO raw_jobs (content_hash, company_name, title, source, raw_description, salary_range, location, posted_date, careers_portal_url, processed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE) RETURNING *`,
      [
        job.content_hash || null,
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
