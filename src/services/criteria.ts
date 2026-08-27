import crypto from "crypto";
import { RawJob } from "../db/db.ts";

/**
 * Custom weights and criteria configuration file for the Job Decision Engine.
 * This is designed for easy open-source customization. 
 * Forkers can simply edit this file to match their own profile and priorities.
 */

export const CANDIDATE_PROFILE = {
  name: "Elena Okhonko",
  experienceYears: 20,
  workplacePreference: "High-Autonomy Technical Architect & SME Builder",
  minAcceptableBaseSgdMonth: 22000,
  maxTravelPercentage: 10,
  idealOfficeDaysPerWeek: 2,
  maxOfficeDaysPerWeek: 3, // Exceptions allowed for specialized physical laboratory environments
  coreSkills: [
    "IT Architecture",
    "Institutional Finance ($54B+ governance)",
    "AI/RegTech Engineering",
    "Python Coding",
    "Agentic RAG Pipelines",
    "LLM Guardrails"
  ],
  nonNegotiables: [
    "No traditional Program Manager / Project Manager / Scrum Master roles",
    "No Client Relationship Management, Sales, or Presales roles",
    "No Forward Deployed Engineering (FDE) or outsourcing/consulting roles",
    "No contract roles (only permanent FTE)",
    "Travel < 10%",
    "Max 3 days in-office (unless a physical scientific lab)",
    "Low stress / organizational politics",
    "Protected deep-focus time"
  ]
};

// Legacy Stage 1 Hard Disqualifiers - mostly unused now as we have programmatic gates
export const HARD_DISQUALIFIERS = [];

// ====================================================================
// PROGRAMMATIC DETERMINISTIC GATES
// ====================================================================

export function generateContentHash(company: string, title: string, rawDesc: string): string {
  const normalizedCompany = (company || "").toLowerCase().trim();
  const normalizedTitle = (title || "").toLowerCase().trim();
  const normalizedDesc = (rawDesc || "").toLowerCase().trim().slice(0, 1000); // use first 1000 chars of desc to avoid minor dynamic differences
  
  const payload = `${normalizedCompany}|${normalizedTitle}|${normalizedDesc}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export interface GateResult {
  passed: boolean;
  rejection_code?: string;
}

export function applyGlobalGates(job: RawJob): GateResult {
  const t = (job.title || "").toLowerCase();
  const c = (job.company_name || "").toLowerCase();
  let d = "";

  if (job.raw_description) {
    if (typeof job.raw_description === "object") {
      const descObj = job.raw_description as any;
      d = (
        (descObj.job_description || "") + " " +
        (descObj.key_responsibilities || []).join(" ") + " " +
        (descObj.technical_skills || []).join(" ") + " " +
        (descObj.qualifications_education || []).join(" ") + " " +
        (descObj.nice_to_haves || []).join(" ")
      ).toLowerCase();
    } else if (typeof job.raw_description === "string") {
      if (job.raw_description.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(job.raw_description);
          d = (
            (parsed.job_description || "") + " " +
            (parsed.key_responsibilities || []).join(" ") + " " +
            (parsed.technical_skills || []).join(" ") + " " +
            (parsed.qualifications_education || []).join(" ") + " " +
            (parsed.nice_to_haves || []).join(" ")
          ).toLowerCase();
        } catch {
          d = job.raw_description.toLowerCase();
        }
      } else {
        d = job.raw_description.toLowerCase();
      }
    }
  }

  // 1. Fully On-site / 4+ Office Days Rejection
  if (
    d.includes("100% onsite") || d.includes("5 days on-site") || d.includes("5 days onsite") || 
    d.includes("on-site only") || d.includes("onsite only") || d.includes("4 days in office") ||
    d.includes("4 days a week in the office") || d.includes("4 days on-site") || d.includes("4 days onsite")
  ) {
    return { passed: false, rejection_code: "GATE_HIGH_OFFICE_DAYS" };
  }

  // 1a. Structured Remote Exclusions
  if (
    d.includes("us only") || d.includes("us-only") || d.includes("united states only") || 
    d.includes("canada only") || d.includes("eu only") || d.includes("eu-only") || 
    d.includes("uk only") || d.includes("uk-only") || d.includes("remote - us")
  ) {
    return { passed: false, rejection_code: "GATE_LOCATION_RESTRICTED" };
  }

  // 1b. Regular on-call, shift work, frequent travel
  if (d.includes("shift work") || d.includes("on-call rotation") || d.includes("regular on-call") || d.includes("24/7 support") || d.includes("travel extensively") || d.includes("frequent travel") || d.includes("up to 50% travel") || d.includes("up to 25% travel")) {
    return { passed: false, rejection_code: "GATE_LIFESTYLE_INCOMPATIBLE" };
  }

  // 1c. Sales / Client-facing / Large-team management / Stakeholder dominance
  if (
    d.includes("sales engineering") || d.includes("presales") || d.includes("pre-sales") || 
    d.includes("client relationship management") || d.includes("manage large teams") || 
    d.includes("stakeholder coordination") || d.includes("firefighting") || d.includes("escalations manager")
  ) {
    return { passed: false, rejection_code: "GATE_HIGH_INTERACTION" };
  }

  // 2. Not enough experience (<10 years).
  if (t.includes("junior") || t.includes("entry level") || t.includes("intern") || t.includes("entry-level")) {
    return { passed: false, rejection_code: "GATE_EXPERIENCE_TOO_LOW" };
  }
  const expRegex = /([1-7])\s*(?:-|to)\s*([1-8])\s*years/i;
  const match = d.match(expRegex);
  if (match) {
    const maxExp = parseInt(match[2]);
    if (maxExp < 10) {
      return { passed: false, rejection_code: "GATE_EXPERIENCE_TOO_LOW" };
    }
  }

  // 3. Construction / Data Center Build / Hardware / SRE / GPU Hardware Roles
  const hardwareKw = [
    "construction", "site reliability", "sre", "hardware engineering", 
    "hardware", "facility", "infrastructure data center", "data center construction",
    "gpu", "gpu hardware", "gpu architect", "hardware architect"
  ];
  if (hardwareKw.some(kw => t.includes(kw) || d.includes(kw))) {
    // Hardware keyword exception: "hardware" keyword might appear innocently in SWE job if they mention "hardware teams".
    // We reject if it's the core focus. "Hardware engineering" is a strict reject.
    // Infrastructure, Data center, GPU hardware are strict rejects as per user instruction.
    if (d.includes("hardware engineering") || t.includes("hardware") || t.includes("hardware architect") || t.includes("gpu hardware") || t.includes("gpu architect") || t.includes("infrastructure data center") || d.includes("infrastructure data center") || t.includes("sre") || d.includes("sre") || t.includes("site reliability") || d.includes("site reliability") || t.includes("construction") || d.includes("data center construction") || d.includes("construction")) {
        return { passed: false, rejection_code: "GATE_HARDWARE_INFRASTRUCTURE" };
    }
  }

  // 4. FDE (Forward Deployed Engineering) check
  if (t.includes("fde") || t.includes("forward deployed") || d.includes("forward deployed") || d.includes("fde ")) {
    return { passed: false, rejection_code: "GATE_OUT_OF_SCOPE_DOMAIN" }; // Forward Deployed
  }

  // 5. Consulting Firms check
  const consultingFirms = [
    "accenture", "kpmg", "bcg", "mckinsey", "bain", "deloitte", "pwc", 
    "ernst & young", "pricewaterhousecoopers", "boston consulting group"
  ];
  for (const firm of consultingFirms) {
    if (c.includes(firm)) {
      return { passed: false, rejection_code: "GATE_CONSULTING_FIRM" };
    }
  }
  if (c === "ey" || c === "ey pte ltd" || c.startsWith("ey ") || c.endsWith(" ey") || c.includes(" ey ") || c.includes("ey.com")) {
    return { passed: false, rejection_code: "GATE_CONSULTING_FIRM" };
  }

  // 6. IT Outsourcing check
  if (c.includes("red hat") || d.includes("deployed to client") || d.includes("work for our clients") || d.includes("hired resource")) {
    return { passed: false, rejection_code: "GATE_OUTSOURCING" };
  }

  // 7. Recruitment Agency / Contract check
  const contractKeywords = ["contract", "contractor", "temp", "temporary", "freelance"];
  const agencyKeywords = [
    "recruitment", "recruiting", "staffing", "talent acquisition",
    "hays", "randstad", "pagegroup", "michael page", "adecco", 
    "charterhouse", "huxley", "robert half", "robert walters", "kelly services", 
    "monroe consulting", "recruit"
  ];
  const isAgency = agencyKeywords.some(kw => c.includes(kw)) || 
                   d.includes("on behalf of our client") || 
                   d.includes("our client is looking for") || 
                   d.includes("hiring for our client");
                   
  if (isAgency) {
    const isContract = contractKeywords.some(kw => t.includes(kw) || d.includes(kw)) || d.includes("renewable");
    if (isContract) {
      return { passed: false, rejection_code: "GATE_CONTRACT_ROLE" };
    }
  }

  for (const kw of contractKeywords) {
    if (t.includes(kw)) {
      if (t.includes("permanent contract") || d.includes("permanent contract")) {
        continue;
      }
      return { passed: false, rejection_code: "GATE_CONTRACT_ROLE" };
    }
  }

  // 8. Kitchen-sink / Multi-role (Extreme management/delivery overhead)
  const managementKeywords = ["manage large teams", "manage client teams", "manage client expectations", "client relationship management"];
  for (const kw of managementKeywords) {
    if (d.includes(kw)) {
      return { passed: false, rejection_code: "GATE_HEAVY_MANAGEMENT" };
    }
  }

  let rolesCount = 0;
  if (d.includes("project manager") || d.includes("scrum master") || d.includes("project management")) rolesCount++;
  if (d.includes("people manager") || d.includes("people management") || d.includes("line manager")) rolesCount++;
  if (d.includes("client manager") || d.includes("delivery manager") || d.includes("account manager")) rolesCount++;
  if (d.includes("architect") || d.includes("architecture")) rolesCount++;
  if (d.includes("developer") || d.includes("engineer")) rolesCount++;

  if (rolesCount >= 4) {
    return { passed: false, rejection_code: "GATE_KITCHEN_SINK" };
  }

  // 9. Lane Relevance Threshold (Must have some AI/Data/ML keywords)
  const aiDataKeywords = ["ai", "artificial intelligence", "ml", "machine learning", "data", "quantitative", "time-series", "time series", "portfolio analytics", "research", "deep learning", "nlp", "llm", "agentic", "data engineering", "architecture", "architect"];
  const hasRelevance = aiDataKeywords.some(kw => t.includes(kw) || d.includes(kw));
  if (!hasRelevance) {
    return { passed: false, rejection_code: "GATE_NOT_AI_DATA" };
  }

  return { passed: true };
}

export const MULTI_LANE_SCORECARDS = {
  HEALTH_BIO_PHARMA: {
    description: "Life sciences, health and scientific ML",
    criteria: "Requires evidence of pharma, bioinformatics, biotech, or medical research domain AND a substantive AI/ML/data engineering function."
  },
  LEGAL_REGTECH: {
    description: "LegalTech, RegTech, fraud and digital trust",
    criteria: "Requires evidence of compliance, regulatory tech, fraud detection, KYC/AML, or legal domain AND a substantive AI/ML/data engineering function."
  },
  INVESTMENT_MARKETS_FINTECH: {
    description: "Investment management, asset management, wealth management, public markets, institutional investing, WealthTech, and market infrastructure.",
    criteria: "Must contain substantive AI, ML, quantitative research, time-series modelling, investment-data engineering, portfolio/risk analytics, research automation, or technical architecture work (sector membership alone is insufficient). Excludes payments, cards, merchant acquiring, remittance, BNPL, consumer lending, corporate finance, treasury, M&A, private equity, investment banking, deal advisory, and unrelated fintech."
  },
  CORE_AI_DATA: {
    description: "General AI/data platforms and ML architecture",
    criteria: "General lane. Requires evidence of strong AI/Data platforms, ML architecture, or agentic workflows."
  }
};

export const LANE_VOCABULARIES = {
  CORE_AI_DATA: {
    positive: ["machine learning engineer", "applied ai engineer", "research engineer", "applied scientist", "data scientist", "ml platform engineer", "ai evaluation engineer", "agent or rag engineer", "data/ai platform architect", "model evaluation", "training-data"],
    negative: ["presales", "solutions consulting", "customer success", "fde", "technical account management", "programme governance", "people-management-heavy"]
  },
  LEGAL_REGTECH: {
    positive: ["legal ai", "legaltech", "regulatory technology", "claims and disputes technology", "legal knowledge engineering", "fraud", "scams", "financial crime", "aml", "kyc", "compliance automation", "digital trust", "legal nlp", "document intelligence", "knowledge graphs"],
    negative: ["traditional legal", "compliance operations"]
  },
  HEALTH_BIO_PHARMA: {
    positive: ["computational biology", "bioinformatics", "scientific ml", "cheminformatics", "clinical nlp", "healthcare data science", "medical ai", "imaging", "research software engineering", "health-data platforms", "pharmaceutical ai", "data engineering", "healthcare models"],
    negative: ["laboratory-bound", "patient-facing", "clinical-operations"]
  },
  INVESTMENT_MARKETS_FINTECH: {
    positive: ["quantitative research", "time-series ml", "investment-data engineering", "portfolio analytics", "optimisation", "risk modelling", "trading technology", "market-data platforms", "investment-research automation", "wealthtech", "investtech", "asset/fund-management ai", "digital-asset analytics", "custody", "trading infrastructure"],
    negative: ["payments", "cards", "consumer lending", "bnpl", "corporate finance", "treasury", "m&a", "private equity", "investment banking", "deal advisory", "fundraising", "generic commercial banking", "retail banking"]
  }
};

// Independent Axis: Neurodivergent-Friendliness (0-100)
// Scored based on evidence in the JD, independently of the 100-point core fit.
export const ND_FRIENDLY_DIMENSIONS = {
  highSupportiveFactors: [
    "Clear, direct, and written communication mentioned",
    "Asynchronous work patterns (Slack/written spec first)",
    "Protected focus blocks (e.g., 'No-meeting Wednesdays', 'Deep Work')",
    "Results-Oriented Work Environment (ROWE)",
    "Remote-first or explicit low office attendance (0-2 days)",
    "Strong global ND or disability inclusion program (e.g., AstraZeneca, Microsoft, SAP, IBM)"
  ],
  redFlags: [
    "Open office environment explicitly mentioned",
    "Heavy emphasis on 'highly collaborative physical workspaces' or 'constant video calls'",
    "Mandatory social team-bonding"
  ]
};

// Independent Axis: Politics & Stress Risk (0-100)
// Scored based on evidence in the JD, independently of the 100-point core fit.
export const POLITICS_STRESS_RISK_DIMENSIONS = {
  highRiskFactors: [
    "High corporate politics, backchannel alignment, and unwritten rules",
    "Frequent presentation/storytelling to steer committees",
    "Managing stakeholders without direct authority ('highly matrixed')",
    "Wearing dual hats as both a technical specialist and a sales/client-facing representative",
    "Buzzword: 'Fast-paced, dynamic environment' (Minor penalty unless combined with other flags)",
    "Buzzword: 'Thrive under pressure' or 'Comfortable with ambiguity'",
    "Buzzword: 'Wear many hats' or 'Roll up your sleeves' (High context-switching)",
    "Buzzword: 'Work hard, play hard' (Boundary bleed)",
    "Over-emphasis on Agile/Scrum ceremonies, daily standups, and constant collaboration"
  ]
};
