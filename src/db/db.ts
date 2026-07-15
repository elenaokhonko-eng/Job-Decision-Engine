import fs from "fs";
import path from "path";

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

// File path for persistence
const DB_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DB_DIR, "postgres_db.json");

// Default initial data to seed our database
const DEFAULT_JOBS: Job[] = [
  {
    id: "job-1",
    title: "Lead AI & RegTech Platform Architect",
    company: "Apex Wealth Management",
    source: "eFinancialCareers",
    salaryRange: "SGD 24,000 - SGD 28,000 / month",
    postedDate: "2026-07-12",
    location: "Singapore (Hybrid, 1 day/week office)",
    careers_portal_url: "https://www.apexwealth.com/careers",
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
    is_toxic: false,
    is_nd_approved: true,
    biological_stress_risk: "Highly secure and safe. Minimal meeting overhead, asynchronous specifications protect auDHD focus cycles. Isolated technical execution avoids emotional and political burnout.",
    strategic_value: "Excellent. Directly fulfills the SGD 22k/month comp target, adds institutional wealth AI credentials, and is located in Singapore with optimal focus blocks.",
    recommended_cv_version: "AI/RegTech Architect CV",
    next_action: "Apply Immediately with Technical Portfolio"
  },
  {
    id: "job-2",
    title: "Senior Bioinformatics Data Researcher",
    company: "BioBotanic Research Singapore",
    source: "MyCareersFuture",
    salaryRange: "SGD 12,000 - SGD 15,000 / month",
    postedDate: "2026-07-11",
    location: "Singapore (Remote)",
    careers_portal_url: "https://www.biobotanicresearch.nl/careers",
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
    is_toxic: false,
    is_nd_approved: true,
    biological_stress_risk: "Perfect auDHD match. Fully remote, quiet focus, logical botanical scientific domain, zero stakeholder politics or high-stimulus meeting schedules.",
    strategic_value: "Fulfills Track B pivot goals. Directly partners with Dutch researchers, establishing clear academic/professional mobility paths to the Netherlands and planned PhD studies.",
    recommended_cv_version: "Data Research/Bio-Tech CV",
    next_action: "Apply Immediately with Technical Portfolio"
  },
  {
    id: "job-3",
    title: "Global Program Manager - Corporate Treasury",
    company: "MegaCorp Institutional Bank",
    source: "LinkedIn",
    salaryRange: "SGD 26,000 - SGD 32,000 / month",
    postedDate: "2026-07-13",
    location: "Singapore (On-site, 5 days/week)",
    careers_portal_url: "https://www.megacorpbank.com/careers",
    description: "Looking for a seasoned Scrum Master & Program Manager to coordinate cross-border stakeholders across 12 countries. You will run daily stand-ups, manage high political overhead, wrangle cross-departmental alignment, and build beautiful PowerPoint presentations for C-suite steering committees. Must have excellent client relationship skills and be willing to travel up to 35% of the time to APAC offices.",
    status: "REJECTED",
    assigned_track: "Neither",
    confidence_level: "High",
    total_score: 0,
    nd_friendly_score: 12,
    politics_stress_score: 95,
    sensory_overload_index: 85,
    is_toxic: true,
    is_nd_approved: false,
    biological_stress_risk: "Extremely high risk of neurodivergent nervous system collapse. 5 days on-site, constant stakeholder confrontation, heavy politics, and high APAC travel requirement (35%) violate multiple non-negotiable criteria.",
    strategic_value: "Fails to support either Track A hands-on tech engineering or Track B scientific relocations.",
    recommended_cv_version: "Institutional Finance CV",
    next_action: "Skip / Delete"
  },
  {
    id: "job-4",
    title: "Principal Quantitative Risk Engineer",
    company: "Quantum Capital Partners",
    source: "eFinancialCareers",
    salaryRange: "SGD 28,000 - SGD 35,000 / month",
    postedDate: "2026-07-13",
    location: "Singapore (Hybrid, 2 days/week office)",
    careers_portal_url: "https://www.quantumcapital.com/careers",
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
    is_toxic: false,
    is_nd_approved: true,
    biological_stress_risk: "Highly recommended. Complete architectural sovereignty over algorithms. Minimal live interactions, fully written asynchronous specification structures protect auDHD task-switching costs.",
    strategic_value: "Massive. High base salary easily exceeds the SGD 22k/month baseline. Accentuates high-value quant/risk engineering experience.",
    recommended_cv_version: "AI/RegTech Architect CV",
    next_action: "Apply Immediately with Technical Portfolio"
  },
  {
    id: "job-5",
    title: "Director of Digital Advisory & Presales",
    company: "FutureTech Consulting",
    source: "LinkedIn",
    salaryRange: "SGD 22,000 - SGD 25,000 / month",
    postedDate: "2026-07-10",
    location: "Singapore (On-site, 4 days/week)",
    careers_portal_url: "https://www.futuretech.com/careers",
    description: "We are hiring a Client Relationship Director to carry an annual software sales quota. You will lead presales client advisory workshops, present technical architectures to external customers, and manage a team of 15 consultants. Expect high political overhead, intense client-facing meetings, and heavy presentation workloads.",
    status: "REJECTED",
    assigned_track: "Neither",
    confidence_level: "High",
    total_score: 0,
    nd_friendly_score: 22,
    politics_stress_score: 88,
    sensory_overload_index: 78,
    is_toxic: true,
    is_nd_approved: false,
    biological_stress_risk: "High risk. Sales quota carries heavy performance anxiety. Intensive social and client presentation workloads cause severe cognitive over-stimulation and sensory exhaustion.",
    strategic_value: "Violates the non-negotiable sales/advisory and high office-attendance thresholds.",
    recommended_cv_version: "Institutional Finance CV",
    next_action: "Skip / Delete"
  }
];

class PostgresDatabase {
  private data: { jobs: Job[]; interactions: Interaction[] } = { jobs: [], interactions: [] };

  constructor() {
    this.init();
  }

  private init() {
    if (process.env.NODE_ENV === "test") {
      this.resetToDefaults();
      return;
    }

    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    if (fs.existsSync(DB_FILE)) {
      try {
        const fileContent = fs.readFileSync(DB_FILE, "utf-8");
        this.data = JSON.parse(fileContent);
      } catch (e) {
        console.error("Failed to parse database file, resetting to defaults", e);
        this.resetToDefaults();
      }
    } else {
      this.resetToDefaults();
    }
  }

  private save() {
    if (process.env.NODE_ENV === "test") {
      return;
    }
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (e) {
      console.error("Failed to save database file", e);
    }
  }

  public resetToDefaults() {
    this.data = {
      jobs: JSON.parse(JSON.stringify(DEFAULT_JOBS)),
      interactions: []
    };
    this.save();
  }

  // Jobs queries
  public queryJobs(searchTerm?: string): Job[] {
    if (!searchTerm) {
      return this.data.jobs;
    }
    const lower = searchTerm.toLowerCase();
    return this.data.jobs.filter(
      (j) =>
        j.title.toLowerCase().includes(lower) ||
        j.company.toLowerCase().includes(lower) ||
        j.description.toLowerCase().includes(lower)
    );
  }

  public addJob(job: Omit<Job, "id">): Job {
    const newJob: Job = {
      ...job,
      id: `job-${Date.now()}`
    };
    this.data.jobs.unshift(newJob);
    this.save();
    return newJob;
  }

  public updateJobEvaluation(id: string, evaluation: Partial<Job>): boolean {
    const job = this.data.jobs.find((j) => j.id === id);
    if (job) {
      Object.assign(job, evaluation);
      this.save();
      return true;
    }
    return false;
  }

  public deleteJob(id: string): boolean {
    const index = this.data.jobs.findIndex((j) => j.id === id);
    if (index !== -1) {
      this.data.jobs.splice(index, 1);
      this.save();
      return true;
    }
    return false;
  }

  // Interactions (logging) queries
  public logInteraction(question: string, toolsUsed: string[], answer: any, trace: string[]): Interaction {
    const newInteraction: Interaction = {
      id: `interaction-${Date.now()}`,
      timestamp: new Date().toISOString(),
      question,
      toolsUsed,
      answer,
      trace
    };
    this.data.interactions.unshift(newInteraction);
    this.save();
    return newInteraction;
  }

  public getInteractions(): Interaction[] {
    return this.data.interactions;
  }

  public clearInteractions() {
    this.data.interactions = [];
    this.save();
  }

  /**
   * Analytics Aggregation Engine
   * Dynamically compiles company metrics from the job evaluations stored in the database.
   */
  public getNdCultureAnalytics() {
    const companyStats: { [name: string]: {
      company: string;
      industry: string;
      careers_page_url: string;
      nd_scores: number[];
      politics_scores: number[];
      sensory_indices: number[];
      total_scores: number[];
      jobs_count: number;
    }} = {};

    // Standard industries mapping
    const getIndustry = (company: string) => {
      const lower = company.toLowerCase();
      if (lower.includes("wealth") || lower.includes("capital") || lower.includes("bank") || lower.includes("financial")) {
        return "Institutional Finance & Asset AI";
      }
      if (lower.includes("research") || lower.includes("botanic") || lower.includes("pharma") || lower.includes("bio")) {
        return "Life Sciences & Biotech";
      }
      return "Technology Services";
    };

    this.data.jobs.forEach((job) => {
      // Only compile metrics for evaluated jobs
      if (job.status && job.status !== "UNASSIGNED") {
        const name = job.company;
        if (!companyStats[name]) {
          companyStats[name] = {
            company: name,
            industry: getIndustry(name),
            careers_page_url: job.careers_portal_url || `https://www.${name.toLowerCase().replace(/[^a-z0-9]/g, "")}.com/careers`,
            nd_scores: [],
            politics_scores: [],
            sensory_indices: [],
            total_scores: [],
            jobs_count: 0
          };
        }
        
        const stats = companyStats[name];
        stats.jobs_count += 1;
        
        if (typeof job.nd_friendly_score === "number") stats.nd_scores.push(job.nd_friendly_score);
        if (typeof job.politics_stress_score === "number") stats.politics_scores.push(job.politics_stress_score);
        if (typeof job.sensory_overload_index === "number") stats.sensory_indices.push(job.sensory_overload_index);
        if (typeof job.total_score === "number") stats.total_scores.push(job.total_score);
      }
    });

    const list = Object.values(companyStats).map((stats) => {
      const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
      const nd_score = avg(stats.nd_scores);
      const politics_score = avg(stats.politics_scores);
      const sensory_index = avg(stats.sensory_indices);
      const avg_match_score = avg(stats.total_scores);

      return {
        company: stats.company,
        industry: stats.industry,
        careers_portal_url: stats.careers_page_url,
        nd_friendly_score: nd_score || (politics_score ? 100 - politics_score : 50), // fallback calculation
        politics_stress_score: politics_score || (nd_score ? 100 - nd_score : 50),
        sensory_overload_index: sensory_index || 30,
        avg_match_score,
        jobs_count: stats.jobs_count,
        is_nd_approved: nd_score >= 70 && politics_score < 40,
        is_toxic: politics_score >= 60 || nd_score <= 40
      };
    });

    // Sort: Approved sorting by nd_friendly_score descending, Toxic sorted by politics_stress_score descending
    const ndApproved = list.filter((c) => c.is_nd_approved).sort((a, b) => b.nd_friendly_score - a.nd_friendly_score);
    const toxicBlacklist = list.filter((c) => c.is_toxic).sort((a, b) => b.politics_stress_score - a.politics_stress_score);

    return {
      ndApproved,
      toxicBlacklist,
      allCompaniesCount: list.length
    };
  }
}

export const db = new PostgresDatabase();
