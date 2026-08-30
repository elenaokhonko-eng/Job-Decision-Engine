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
    "Max 3 days in-office (100% on-premises is unacceptable)",
    "Low stress / organizational politics",
    "Protected deep-focus time"
  ]
};

// ====================================================================
// NEW: HARD GATES EVALUATION (2-AXIS PREQUALIFICATION)
// ====================================================================

export interface GateEvaluationResult {
  passed: boolean;
  needsVerification: boolean;
  rejectionReason?: string;
  reasonCode?: string;
  axis1FunctionPassed: boolean;
  axis2DomainPassed: boolean;
}

// 1. Deterministic Global Title Exclusions (Applied to ALL lanes)
export const GLOBAL_TITLE_EXCLUSIONS: RegExp[] = [
  /\b(human resources?|hr|recruiter|talent acquisition|people operations?|people partner)\b/i,
  /\b(executive assistant|office manager|receptionist|admin assistant|administrative assistant)\b/i,
  /\b(legal counsel|attorney|lawyer|m&a|paralegal|contracts? manager)\b/i,
  /\b(sales manager|account executive|business development representative|bdr|sdr|account manager)\b/i,
  /\b(marketing manager|social media|content writer|pr manager|brand manager)\b/i,
  /\b(quality assurance coordinator|manual tester|qa tester)\b/i,
  /\b(brain researcher|neuroscientist|wet lab|postdoctoral fellow)\b/i,
];

// 2. Axis 1: Target Technical Functions (Must pass)
export const TECHNICAL_FUNCTION_KEYWORDS: RegExp[] = [
  /\b(software engineer|data engineer|ml engineer|machine learning engineer|ai engineer)\b/i,
  /\b(full[\s-]stack|backend engineer|distributed systems|platform engineer|cloud engineer)\b/i,
  /\b(research engineer|quantitative developer|quant engineer|system architect)\b/i,
  /\b(python|typescript|go|c\+\+|rust|sql|postgres|fastapi|docker|kubernetes)\b/i,
];

// 3. Workability Requirements (Zero tolerance for on-premises-only lab/clinic)
export function evaluateWorkability(location: string, workplaceType: string, description: string): { workable: boolean; needsVerify: boolean; reason?: string } {
  const isExplicitOnsiteLab = /\b(100% on-site|fully on-site|lab-based|wet lab|clinic-based)\b/i.test(description);
  if (isExplicitOnsiteLab) {
    return { workable: false, needsVerify: false, reason: 'Requires 100% on-premises laboratory/clinic presence' };
  }

  const isRemoteOrHybrid = /\b(remote|hybrid|flexible)\b/i.test(workplaceType) || /\b(remote|hybrid)\b/i.test(location);
  if (!isRemoteOrHybrid && !workplaceType) {
    return { workable: true, needsVerify: true, reason: 'Workplace model unspecified; needs manual verification' };
  }

  return { workable: true, needsVerify: false };
}

export function evaluateHardGates(title: string, description: string, location: string, workplaceType: string): GateEvaluationResult {
  // Check Global Title Exclusions
  for (const pattern of GLOBAL_TITLE_EXCLUSIONS) {
    if (pattern.test(title)) {
      return {
        passed: false,
        needsVerification: false,
        rejectionReason: `Matched non-target title exclusion: ${pattern.source}`,
        reasonCode: 'NON_TARGET_ROLE_FAMILY',
        axis1FunctionPassed: false,
        axis2DomainPassed: false
      };
    }
  }

  // Evaluate Workability
  const workability = evaluateWorkability(location, workplaceType, description);
  if (!workability.workable) {
    return {
      passed: false,
      needsVerification: false,
      rejectionReason: workability.reason,
      reasonCode: 'UNWORKABLE_LOCATION_MODEL',
      axis1FunctionPassed: false,
      axis2DomainPassed: false
    };
  }

  // Axis 1: Technical Function Validation
  const hasFunctionSignal = TECHNICAL_FUNCTION_KEYWORDS.some(p => p.test(title) || p.test(description));
  if (!hasFunctionSignal) {
    return {
      passed: false,
      needsVerification: false,
      rejectionReason: 'Role lacks evidence of technical, building, or engineering function',
      reasonCode: 'NON_TECHNICAL_FUNCTION',
      axis1FunctionPassed: false,
      axis2DomainPassed: false
    };
  }

  if (workability.needsVerify) {
    return {
      passed: false,
      needsVerification: true,
      reasonCode: 'NEEDS_VERIFICATION',
      axis1FunctionPassed: true,
      axis2DomainPassed: true
    };
  }

  return {
    passed: true,
    needsVerification: false,
    axis1FunctionPassed: true,
    axis2DomainPassed: true
  };
}

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
export function extractDescriptionText(job: RawJob): string {
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

  // ── 1. Deterministic Non-Technical Title-Family Exclusions ──
  const isTechnicalTitle = /\b(engineer|developer|architect|data scientist|machine learning|applied scientist|research scientist|quantitative researcher|quant researcher|ai researcher|software engineer|data engineer|ml platform|systems engineer|programmer|statistician)\b/i.test(t);

  // A. Human Resources / Recruiting / People Ops
  const hrTitleRegex = /\b(human resources|hr manager|hr generalist|hr business partner|hrbp|talent acquisition|recruiter|recruitment|people ops|people operations|people partner)\b/i;
  if (hrTitleRegex.test(t)) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: HR / Talent role "${job.title}"`]);
  }

  // B. Executive Assistant / Administrative / Office Management
  const adminTitleRegex = /\b(executive assistant|personal assistant|office manager|administrative assistant|admin assistant|receptionist|workplace coordinator|workplace manager|facilities manager)\b/i;
  if (adminTitleRegex.test(t)) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Administrative / Office Management "${job.title}"`]);
  }

  // C. Legal Practice (Attorneys / Legal Counsel / Paralegals)
  const legalPracticeRegex = /\b(attorney|associate attorney|m&a attorney|counsel|corporate counsel|legal counsel|general counsel|lawyer|paralegal|legal assistant)\b/i;
  if (legalPracticeRegex.test(t) && !isTechnicalTitle) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Legal Practice / Counsel "${job.title}"`]);
  }

  // D. Sales / Marketing / BD
  const salesTitleRegex = /\b(account executive|sales manager|sales director|business development manager|business development executive|bdr|sdr|marketing manager|marketing director|product marketing manager|growth marketing|event coordinator)\b/i;
  if (salesTitleRegex.test(t) && !isTechnicalTitle) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Sales / Marketing "${job.title}"`]);
  }

  // E. Non-technical QA Coordination / Operations Management
  const coordTitleRegex = /\b(quality assurance coordinator|qa coordinator|compliance coordinator|operations coordinator|administrative coordinator|logistics coordinator)\b/i;
  if (coordTitleRegex.test(t) && !isTechnicalTitle) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Non-technical Coordinator "${job.title}"`]);
  }

  // F. Qualitative Finance / Banking
  const financeQualRegex = /\b(private equity associate|private equity analyst|investment banking analyst|investment banking associate|m&a analyst|m&a associate|deal advisory|commercial banker|loan officer|credit underwriter)\b/i;
  if (financeQualRegex.test(t) && !isTechnicalTitle) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Traditional Finance / Banking "${job.title}"`]);
  }

  // ── 2. Title-level intern/trainee guard ──
  const juniorTitleKw = ["intern", "internship", "graduate trainee", "apprentice", "apprenticeship"];
  for (const kw of juniorTitleKw) {
    if (t.includes(kw)) {
      return makeReject(["GATE_EXPERIENCE_TOO_LOW"], [`Title contains: "${kw}"`]);
    }
  }

  // ── 3. Office days / on-site detection (100% on-premises strictly rejected) ──
  const hardOnsiteKw = [
    "100% onsite", "100% on-site", "5 days on-site", "5 days onsite", "5 days a week in the office",
    "5 days per week on-site", "5 days per week onsite", "5 days a week on-site", "mandatory 5 days",
    "on-site only", "onsite only", "4 days in office", "4 days a week in the office",
    "4 days on-site", "4 days onsite", "fully on-site", "fully onsite", "on-premises only"
  ];
  const hardOnsiteRegex = /\b[45]\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*on-?site\b/i;
  for (const kw of hardOnsiteKw) {
    if (d.includes(kw) || hardOnsiteRegex.test(d)) {
      return makeReject(["GATE_HIGH_OFFICE_DAYS"], findEvidence(d, [kw]), { office_days_min: 4, office_days_max: 5 });
    }
  }

  // Ambiguous office expectations produce NEEDS_VERIFICATION
  const ambiguousOfficeKw = [
    "office based", "office-based", "in-office", "in office",
    "office expectations", "workplace arrangement", "workplace expectations",
    "office to be evaluated", "partner discussions", "location flexible", "location tbd"
  ];
  const hasExplicitDays = hardOnsiteKw.some(k => d.includes(k))
    || hardOnsiteRegex.test(d)
    || /\b[1-5]\s*(?:day|days)\s*(?:per week|a week|\/week)?\s*(?:in|at)?\s*(?:the\s*)?office/i.test(d)
    || d.includes("1 day/week") || d.includes("2 days/week") || d.includes("3 days/week")
    || d.includes("remote-first") || d.includes("fully remote") || d.includes("work from home");

  if (!hasExplicitDays && ambiguousOfficeKw.some(k => d.includes(k))) {
    return makeVerification(
      ["NEEDS_VERIFICATION_OFFICE_DAYS"],
      findEvidence(d, ambiguousOfficeKw.filter(k => d.includes(k))),
      { office_days_min: null, office_days_max: null }
    );
  }

  // ── 4. Geographic restrictions ──
  const locationKw = [
    "us only", "us-only", "united states only", "canada only", "eu only", "eu-only", "uk only", "uk-only", "remote - us",
    "australia only", "australian work rights", "melbourne", "sydney"
  ];
  for (const kw of locationKw) {
    if (d.includes(kw)) {
      return makeReject(["GATE_LOCATION_RESTRICTED"], findEvidence(d, [kw]), { location_restriction: kw.toUpperCase() });
    }
  }

  // ── 5. Lifestyle incompatibilities ──
  const lifestyleKw = ["shift work", "on-call rotation", "regular on-call", "24/7 support", "travel extensively", "frequent travel", "up to 50% travel", "up to 25% travel"];
  for (const kw of lifestyleKw) {
    if (d.includes(kw)) {
      const travelPct = kw.includes("50%") ? 50 : kw.includes("25%") ? 25 : null;
      return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], findEvidence(d, [kw]), { travel_pct_max: travelPct });
    }
  }

  // ── 6. Sales / Client-facing ──
  const highInteractionKw = ["sales engineering", "presales", "pre-sales", "client relationship management", "manage large teams", "escalations manager"];
  for (const kw of highInteractionKw) {
    if (d.includes(kw)) {
      return makeReject(["GATE_HIGH_INTERACTION"], findEvidence(d, [kw]));
    }
  }

  // ── 7. Hardware / SRE / Construction ──
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

  // ── 8. FDE (Forward Deployed Engineering) ──
  const fdeKw = ["forward deployed", "fde "];
  if (t.includes("fde") || fdeKw.some(k => t.includes(k) || d.includes(k))) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], findEvidence(d, fdeKw));
  }

  // ── 9. Consulting firms ──
  const consultingFirms = ["accenture", "kpmg", "bcg", "mckinsey", "bain", "deloitte", "pwc", "ernst & young", "pricewaterhousecoopers", "boston consulting group"];
  for (const firm of consultingFirms) {
    if (c.includes(firm)) {
      return makeReject(["GATE_CONSULTING_FIRM"], [`Company name: "${firm}"`]);
    }
  }
  if (c === "ey" || c === "ey pte ltd" || c.startsWith("ey ") || c.endsWith(" ey") || c.includes(" ey ")) {
    return makeReject(["GATE_CONSULTING_FIRM"], [`Company name matches EY`]);
  }

  // ── 10. IT Outsourcing ──
  const outsourcingKw = ["deployed to client", "work for our clients", "hired resource"];
  if (c.includes("red hat") || outsourcingKw.some(k => d.includes(k))) {
    const found = c.includes("red hat") ? [`Company: "red hat"`] : findEvidence(d, outsourcingKw.filter(k => d.includes(k)));
    return makeReject(["GATE_OUTSOURCING"], found);
  }

  // ── 11. Contract / Agency ──
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

  // ── 12. Heavy management / Kitchen-sink ──
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

  // ── 13. Pure Governance / Zero Technical Work Guard ──
  const pureGovKw = ["zero hands-on", "zero technical work", "steering committees", "vendor steering", "political change management"];
  for (const kw of pureGovKw) {
    if (d.includes(kw) || t.includes(kw)) {
      return makeReject(["GATE_PURE_GOVERNANCE_ZERO_BUILD"], findEvidence(d, [kw]));
    }
  }

  // ── 14. Universal Negative Domain Exclusions ──
  const universalNegativeKw = [
    "payments", "merchant acquiring", "remittance", "bnpl", "buy now pay later",
    "consumer lending", "card issuing", "credit card", "pos terminals"
  ];
  for (const kw of universalNegativeKw) {
    if (t.includes(kw)) {
      return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Universal negative domain in title: "${kw}"`]);
    }
  }

  // ── 15. TWO-AXIS PREQUALIFICATION ──
  // Axis 1: Technical Function Validation (must be builder/modeller/architect/scientist)
  const technicalFunctionPhrases = [
    "engineer", "developer", "architect", "data scientist", "machine learning",
    "software", "programming", "pipeline", "distributed systems", "modelling",
    "modeling", "algorithms", "quantitative", "pytorch", "python", "spark",
    "sql", "etl", "data warehouse", "data pipeline", "contract analytics",
    "legaltech", "regtech", "compliance", "ai", "llm", "ml", "analytics"
  ];
  const hasTechnicalFunction = isTechnicalTitle || technicalFunctionPhrases.some(kw => t.includes(kw) || d.includes(kw));
  if (!hasTechnicalFunction) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], ["Axis 1 Failed: Role lacks hands-on engineering, modeling, or architecture function"]);
  }

  // Axis 2: Target Domain Validation
  const aiDataShortRegex = /\b(?:ai|ml|nlp|llm|rag)\b/i;
  const targetDomainPhrases = [
    "artificial intelligence", "machine learning", "data engineering", "data pipeline",
    "data warehouse", "etl", "sql", "quantitative research", "time-series",
    "time series", "portfolio analytics", "computational biology", "bioinformatics",
    "cheminformatics", "genomics", "drug discovery", "clinical trial", "regtech",
    "legaltech", "fraud detection", "kyc", "aml", "compliance automation",
    "contract analytics", "digital trust", "deep learning", "agentic", "market data",
    "trading infrastructure"
  ];
  const hasDomainRelevance = aiDataShortRegex.test(t) || aiDataShortRegex.test(d) ||
    targetDomainPhrases.some(kw => t.includes(kw) || d.includes(kw));

  if (!hasDomainRelevance) {
    return makeReject(["GATE_NOT_AI_DATA"], ["Axis 2 Failed: No signal found for target domains (AI/Data, RegTech, Bio/Pharma, Quant/FinTech)"]);
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
    negative: ["traditional legal", "compliance operations", "attorney", "paralegal"]
  },
  HEALTH_BIO_PHARMA: {
    positive: ["computational biology", "bioinformatics", "scientific ml", "cheminformatics", "clinical nlp", "healthcare data science", "medical ai", "imaging", "research software engineering", "health-data platforms", "pharmaceutical ai", "data engineering", "healthcare models"],
    negative: ["laboratory-bound", "patient-facing", "clinical-operations", "wet lab"]
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
  ],
  protectiveFactors: [
    "Clear KPIs, deliverables, and role boundaries",
    "High technical autonomy with SME authority",
    "Low cross-departmental coordination overhead",
    "Stable product roadmap (not constant pivot fire drills)",
    "Technical-first leadership (engineers managing engineers)"
  ]
};
