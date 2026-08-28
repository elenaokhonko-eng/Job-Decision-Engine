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
  maxOfficeDaysPerWeek: 3,
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
    "Max 3 days in-office (unless a physical scientific laboratory environment)",
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
  const normalizedDesc = (rawDesc || "").toLowerCase().trim().slice(0, 1000);
  const payload = `${normalizedCompany}|${normalizedTitle}|${normalizedDesc}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export interface GateResult {
  passed: boolean;
  status: "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";
  rejection_code?: string;
  rejection_codes: string[];
  evidence_quotes: string[];
  workability_facts: {
    office_days_min: number | null;
    office_days_max: number | null;
    travel_pct_max: number | null;
    employment_type: "PERMANENT" | "CONTRACT" | "UNKNOWN";
    location_restriction: string | null;
  };
}

function makePass(extraFacts?: Partial<GateResult["workability_facts"]>): GateResult {
  return {
    passed: true,
    status: "PASS",
    rejection_codes: [],
    evidence_quotes: [],
    workability_facts: {
      office_days_min: null,
      office_days_max: null,
      travel_pct_max: null,
      employment_type: "UNKNOWN",
      location_restriction: null,
      ...extraFacts
    }
  };
}

function makeReject(codes: string[], evidence: string[], facts?: Partial<GateResult["workability_facts"]>): GateResult {
  return {
    passed: false,
    status: "HARD_REJECT",
    rejection_code: codes[0],
    rejection_codes: codes,
    evidence_quotes: evidence,
    workability_facts: {
      office_days_min: null,
      office_days_max: null,
      travel_pct_max: null,
      employment_type: "UNKNOWN",
      location_restriction: null,
      ...facts
    }
  };
}

function makeVerification(codes: string[], evidence: string[], facts?: Partial<GateResult["workability_facts"]>): GateResult {
  return {
    passed: false,
    status: "NEEDS_VERIFICATION",
    rejection_code: codes[0],
    rejection_codes: codes,
    evidence_quotes: evidence,
    workability_facts: {
      office_days_min: null,
      office_days_max: null,
      travel_pct_max: null,
      employment_type: "UNKNOWN",
      location_restriction: null,
      ...facts
    }
  };
}

/**
 * Extract a readable text corpus from a raw job (handles string, JSON-string, or object descriptions).
 */
function extractDescriptionText(job: RawJob): string {
  if (!job.raw_description) return "";
  if (typeof job.raw_description === "object") {
    const d = job.raw_description as any;
    return [
      d.job_description || "",
      ...(d.key_responsibilities || []),
      ...(d.technical_skills || []),
      ...(d.qualifications_education || []),
      ...(d.nice_to_haves || [])
    ].join(" ").toLowerCase();
  }
  if (typeof job.raw_description === "string") {
    if (job.raw_description.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(job.raw_description);
        return [
          parsed.job_description || "",
          ...(parsed.key_responsibilities || []),
          ...(parsed.technical_skills || []),
          ...(parsed.qualifications_education || []),
          ...(parsed.nice_to_haves || [])
        ].join(" ").toLowerCase();
      } catch {
        return job.raw_description.toLowerCase();
      }
    }
    return job.raw_description.toLowerCase();
  }
  return "";
}

/** Find the first matching snippet from the description text for an evidence quote. */
function findEvidence(d: string, keywords: string[]): string[] {
  const quotes: string[] = [];
  for (const kw of keywords) {
    const idx = d.indexOf(kw);
    if (idx !== -1) {
      const start = Math.max(0, idx - 20);
      const end = Math.min(d.length, idx + kw.length + 40);
      quotes.push(`"…${d.substring(start, end)}…"`);
    }
  }
  return quotes;
}


export function applyGlobalGates(job: RawJob): GateResult {
  const t = (job.title || "").toLowerCase();
  const c = (job.company_name || "").toLowerCase();
  const d = extractDescriptionText(job);

  // ── 1. Title-level junior/intern guard (deterministic, no experience-range regex) ──
  const juniorTitleKw = ["junior", "entry level", "entry-level", "intern", "internship", "graduate trainee"];
  for (const kw of juniorTitleKw) {
    if (t.includes(kw)) {
      return makeReject(["GATE_EXPERIENCE_TOO_LOW"], [`Title contains: "${kw}"`]);
    }
  }

  // ── 2. Office days / on-site detection ──
  const hardOnsiteKw = [
    "100% onsite", "100% on-site", "5 days on-site", "5 days onsite", "5 days a week in the office",
    "on-site only", "onsite only", "4 days in office", "4 days a week in the office",
    "4 days on-site", "4 days onsite", "fully on-site", "fully onsite"
  ];
  for (const kw of hardOnsiteKw) {
    if (d.includes(kw)) {
      const isPhysicalLab = t.includes("laboratory") || d.includes("physical laboratory") || d.includes("wet lab");
      if (!isPhysicalLab) {
        return makeReject(["GATE_HIGH_OFFICE_DAYS"], findEvidence(d, [kw]), { office_days_min: 4, office_days_max: 5 });
      }
    }
  }

  // Office days NEEDS_VERIFICATION: description mentions office days but count is ambiguous
  const ambiguousOfficeKw = ["office based", "office-based", "in-office", "in office"];
  const knowsOfficeDays = hardOnsiteKw.some(k => d.includes(k))
    || /\b[1-5]\s*(?:day|days)\s*(?:per week|a week|\/week)?\s*(?:in|at)?\s*(?:the\s*)?office/i.test(d)
    || d.includes("hybrid") || d.includes("remote-first") || d.includes("fully remote") || d.includes("work from home");

  if (!knowsOfficeDays && ambiguousOfficeKw.some(k => d.includes(k))) {
    return makeVerification(
      ["NEEDS_VERIFICATION_OFFICE_DAYS"],
      findEvidence(d, ambiguousOfficeKw.filter(k => d.includes(k))),
      { office_days_min: null, office_days_max: null }
    );
  }

  // ── 3. Geographic restrictions ──
  const locationKw = ["us only", "us-only", "united states only", "canada only", "eu only", "eu-only", "uk only", "uk-only", "remote - us"];
  for (const kw of locationKw) {
    if (d.includes(kw)) {
      return makeReject(["GATE_LOCATION_RESTRICTED"], findEvidence(d, [kw]), { location_restriction: kw.toUpperCase() });
    }
  }

  // ── 4. Lifestyle incompatibilities ──
  const lifestyleKw = ["shift work", "on-call rotation", "regular on-call", "24/7 support", "travel extensively", "frequent travel", "up to 50% travel", "up to 25% travel"];
  for (const kw of lifestyleKw) {
    if (d.includes(kw)) {
      const travelPct = kw.includes("50%") ? 50 : kw.includes("25%") ? 25 : null;
      return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], findEvidence(d, [kw]), { travel_pct_max: travelPct });
    }
  }

  // ── 5. Sales / Client-facing ──
  const highInteractionKw = ["sales engineering", "presales", "pre-sales", "client relationship management", "manage large teams", "escalations manager"];
  for (const kw of highInteractionKw) {
    if (d.includes(kw)) {
      return makeReject(["GATE_HIGH_INTERACTION"], findEvidence(d, [kw]));
    }
  }

  // ── 6. Hardware / SRE / Construction ──
  const hardwareStrictTitle = ["hardware", "hardware architect", "gpu hardware", "gpu architect", "infrastructure data center", "sre", "site reliability", "construction"];
  const hardwareStrictDesc = ["hardware engineering", "infrastructure data center", "data center construction", "construction project"];
  for (const kw of hardwareStrictTitle) {
    if (t.includes(kw)) {
      return makeReject(["GATE_HARDWARE_INFRASTRUCTURE"], [`Title contains: "${kw}"`]);
    }
  }
  for (const kw of hardwareStrictDesc) {
    if (d.includes(kw)) {
      return makeReject(["GATE_HARDWARE_INFRASTRUCTURE"], findEvidence(d, [kw]));
    }
  }

  // ── 7. FDE (Forward Deployed Engineering) ──
  const fdeKw = ["forward deployed", "fde "];
  if (t.includes("fde") || fdeKw.some(k => t.includes(k) || d.includes(k))) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], findEvidence(d, fdeKw));
  }

  // ── 8. Consulting firms ──
  const consultingFirms = ["accenture", "kpmg", "bcg", "mckinsey", "bain", "deloitte", "pwc", "ernst & young", "pricewaterhousecoopers", "boston consulting group"];
  for (const firm of consultingFirms) {
    if (c.includes(firm)) {
      return makeReject(["GATE_CONSULTING_FIRM"], [`Company name: "${firm}"`]);
    }
  }
  if (c === "ey" || c === "ey pte ltd" || c.startsWith("ey ") || c.endsWith(" ey") || c.includes(" ey ")) {
    return makeReject(["GATE_CONSULTING_FIRM"], [`Company name matches EY`]);
  }

  // ── 9. IT Outsourcing ──
  const outsourcingKw = ["deployed to client", "work for our clients", "hired resource"];
  if (c.includes("red hat") || outsourcingKw.some(k => d.includes(k))) {
    const found = c.includes("red hat") ? [`Company: "red hat"`] : findEvidence(d, outsourcingKw.filter(k => d.includes(k)));
    return makeReject(["GATE_OUTSOURCING"], found);
  }

  // ── 10. Contract / Agency ──
  const contractKw = ["contract", "contractor", "temp", "temporary", "freelance"];
  const agencyKw = ["recruitment", "recruiting", "staffing", "talent acquisition", "hays", "randstad", "pagegroup", "michael page", "adecco", "charterhouse", "huxley", "robert half", "robert walters", "kelly services", "monroe consulting", "recruit"];
  const isAgency = agencyKw.some(kw => c.includes(kw)) || d.includes("on behalf of our client") || d.includes("our client is looking for") || d.includes("hiring for our client");
  if (isAgency) {
    const isContract = contractKw.some(kw => t.includes(kw) || d.includes(kw)) || d.includes("renewable");
    if (isContract) {
      return makeReject(["GATE_CONTRACT_ROLE"], [`Agency posting with contract terms`]);
    }
  }
  for (const kw of contractKw) {
    if (t.includes(kw) && !t.includes("permanent contract") && !d.includes("permanent contract")) {
      return makeReject(["GATE_CONTRACT_ROLE"], [`Title contains: "${kw}"`]);
    }
  }

  // ── 11. Heavy management / Kitchen-sink ──
  const mgmtKw = ["manage large teams", "manage client teams", "manage client expectations", "client relationship management"];
  for (const kw of mgmtKw) {
    if (d.includes(kw)) {
      return makeReject(["GATE_HEAVY_MANAGEMENT"], findEvidence(d, [kw]));
    }
  }
  let rolesCount = 0;
  if (d.includes("project manager") || d.includes("scrum master") || d.includes("project management")) rolesCount++;
  if (d.includes("people manager") || d.includes("people management") || d.includes("line manager")) rolesCount++;
  if (d.includes("client manager") || d.includes("delivery manager") || d.includes("account manager")) rolesCount++;
  if (d.includes("architect") || d.includes("architecture")) rolesCount++;
  if (d.includes("developer") || d.includes("engineer")) rolesCount++;
  if (rolesCount >= 4) {
    return makeReject(["GATE_KITCHEN_SINK"], [`Role combines ${rolesCount} distinct function types`]);
  }

  // ── 12. Lane relevance (must have AI/Data signal) ──
  const aiDataKw = ["ai", "artificial intelligence", "ml", "machine learning", "data", "quantitative", "time-series", "time series", "portfolio analytics", "research", "deep learning", "nlp", "llm", "agentic", "data engineering", "architecture", "architect", "regtech", "fintech", "biotech", "pharma", "clinical"];
  const hasRelevance = aiDataKw.some(kw => t.includes(kw) || d.includes(kw));
  if (!hasRelevance) {
    return makeReject(["GATE_NOT_AI_DATA"], [`No AI/Data/domain signal found in title or description`]);
  }

  // ── All deterministic gates passed ──
  return makePass();
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
