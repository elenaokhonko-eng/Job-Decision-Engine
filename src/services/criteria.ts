import crypto from "crypto";
import { RawJob } from "../db/db.ts";
import { normalizeWorkMode } from "../pipeline/workModeNormalizer.js";
import {
  applyVerificationAnswerOverrides,
  extractTerritories,
  hasExplicitTerritoryRestriction,
  isVerificationAnswerProvided,
  loadWorkabilityPolicy,
  VERIFICATION_ANSWER_KEYS,
  type VerificationAnswerContext,
  type WorkabilityPolicy,
} from "../pipeline/workabilityPolicy.js";
import { stripHtmlToText } from "../security/sanitize.js";

/**
 * Custom weights and criteria configuration file for the Job Decision Engine.
 * This is designed for easy open-source customization.
 * Forkers can simply edit this file to match their own profile and priorities.
 */

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
  /\b(sales manager|account executive|business development representative|bdr|sdr|(?<!technical\s+)account manager)\b/i,
  /\b(marketing manager|social media|content writer|pr manager|brand manager)\b/i,
  /\b(quality assurance coordinator|manual tester|qa tester)\b/i,
  /\b(brain researcher|neuroscientist|wet lab|postdoctoral fellow)\b/i,
];

// 2. Axis 1: Target Technical Functions (Must pass)
export const TECHNICAL_FUNCTION_KEYWORDS: RegExp[] = [
  /\b(software engineer|data engineer|ml engineer|machine learning engineer|ai engineer)\b/i,
  /\b(full[\s-]stack|backend engineer|distributed systems|platform engineer|cloud engineer)\b/i,
  /\b(research engineer|quantitative developer|quant engineer|system architect|ai architect)\b/i,
  /\b(engineering|technology|technical|software|data|analytics?|ai|ml|digital|transformation|scientific)\s+(program|programme|project|portfolio|delivery|transformation)?\s*(manager|director|lead|head|officer|vp|vice president)\b/i,
  /\b(manager|director|lead|head|officer|vp|vice president)\s+of\s+(engineering|technology|software|data|analytics?|ai|ml|platform|cloud|systems?|digital|transformation|research|science)\b/i,
  /\b(software development|software delivery|application development|data science|data platform|data architecture|data analytics|technology transformation|digital transformation|data transformation|technical delivery|engineering delivery|engineering program|technical roadmap|product development|systems design|release management|cloud platform|platform engineering|software development lifecycle|sdlc)\b/i,
  /\b(python|typescript|go|c\+\+|rust|sql|postgres|fastapi|docker|kubernetes)\b/i,
  /\b(applied scientist|research scientist|bioinformatics|computational biolog(y|ist)|genomics?|biotech|drug discovery)\b/i,
  /\b(regtech|legaltech|compliance automation|contract analytics|knowledge engineer(ing)?|llm|agents?|rag|nlp|foundation models?|data pipeline)\b/i,
];

/**
 * Unified Technical Role Recognition (Axis 1)
 */
export function isTechnicalRole(title: string, description: string): { isTechnical: boolean; hasBuildingEvidence: boolean; reason?: string } {
  const t = (title || "").toLowerCase();
  const d = (description || "").toLowerCase();

  // Lane-aware technical title families, including technical leadership and delivery roles.
  const isTechnicalTitle = /\b(engineer|engineering|developer|architect|data scientist|data analyst|analytics engineer|business intelligence|machine learning|applied scientist|research scientist|scientist|quantitative researcher|quant researcher|quant developer|quantitative developer|quantitative engineer|ai researcher|software engineer|data engineer|ml platform|systems engineer|systems analyst|programmer|statistician|bioinformatician|bioinformatics scientist|bioinformatics|computational biolog(y|ist)|scientific ml|legal ai|regtech|compliance automation|contract analytics|knowledge engineer(ing)?|test automation|automation engineer|qa automation)\b/i.test(t);
  const hasTechnicalLeadershipTitle = /\b(manager|director|lead|head|officer|vp|vice president)\b/i.test(t) && /\b(engineer(?:ing)?|technology|technical|software|data|analytics?|ai|ml|machine learning|platform|cloud|systems?|digital|transformation|research|scientific|science)\b/i.test(t);
  const hasTechnicalProgramTitle = /\b(technical|technology|engineering|software|data|ai|ml|digital|transformation)\s+(program|programme|project|portfolio|delivery|transformation)\s+(manager|director|lead|head|officer|vp|vice president)\b/i.test(t);

  // Technical building / engineering / data / modeling keywords
  const buildingKeywords = [
    "python", "typescript", "javascript", "go", "golang", "c++", "rust", "sql", "postgres",
    "pytorch", "tensorflow", "scikit-learn", "keras", "jax", "pandas", "numpy", "spark",
    "fastapi", "docker", "kubernetes", "aws", "gcp", "azure", "distributed systems",
    "data pipeline", "etl", "data warehouse", "data lake", "lakehouse", "data science", "data platform", "data architecture", "data analytics",
    "model training", "fine-tuning", "rag", "agents", "agentic", "llm", "nlp", "prompt engineering",
    "bioinformatics", "genomics", "cheminformatics", "computational biology", "drug discovery",
    "regtech", "legaltech", "compliance automation", "contract analytics", "document intelligence",
    "knowledge graphs", "time-series", "portfolio analytics", "algorithmic trading", "market microstructure",
    "architecture", "software engineering", "software development", "software delivery", "application development", "technology transformation", "digital transformation", "data transformation", "technical delivery", "engineering delivery", "engineering program", "technical roadmap", "product development", "systems design", "release management", "cloud platform", "platform engineering", "software development lifecycle", "sdlc", "mlops", "ci/cd"
  ];

  const shortToken = /^[a-z0-9]{1,3}$/;
  const hasKeyword = (text: string, kw: string): boolean => {
    if (shortToken.test(kw)) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(text);
    }
    return text.includes(kw);
  };

  const hasBuildingEvidence = buildingKeywords.some(kw => hasKeyword(t, kw) || hasKeyword(d, kw)) || TECHNICAL_FUNCTION_KEYWORDS.some(p => p.test(t) || p.test(d));
  const isTechnical = isTechnicalTitle || hasTechnicalLeadershipTitle || hasTechnicalProgramTitle || hasBuildingEvidence;

  return {
    isTechnical,
    hasBuildingEvidence,
    reason: isTechnical ? undefined : "Axis 1 Failed: Role lacks evidence of technical, building, or engineering function"
  };
}

export interface HybridAttendanceFacts {
  office_days_min: number;
  office_days_max: number;
  evidence: string[];
  basis: "EMPLOYER_STATED" | "POLICY_HYBRID_3_2";
  contradictory: boolean;
}

function numericRange(match: RegExpMatchArray): [number, number] {
  const first = Number(match[1]);
  const second = match[2] === undefined ? first : Number(match[2]);
  return [Math.min(first, second), Math.max(first, second)];
}

/** Extract only attendance phrases; unrelated durations such as annual leave are ignored. */
export function extractHybridAttendance(description: string): HybridAttendanceFacts | null {
  const text = String(description || "").toLowerCase();
  const ranges: Array<{ range: [number, number]; evidence: string }> = [];
  const officePatterns = [
    /\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:in|at)\s+(?:the\s+)?(?:office|on-?site|onsite)\b/gi,
    /\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:on-?site|onsite|in-?office)\b/gi,
    /\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:on-?site|onsite)\b/gi,
    /\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:office|on-?site|onsite)\s+days?\b/gi,
  ];
  const wfhPatterns = [
    /\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:wfh|work\s+from\s+home|from\s+home|remote)\b/gi,
    /\b(?:wfh|work\s+from\s+home|from\s+home|remote)\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\b/gi,
  ];

  for (const pattern of officePatterns) {
    for (const match of text.matchAll(pattern)) {
      const range = numericRange(match);
      ranges.push({ range, evidence: match[0] });
    }
  }
  for (const pattern of wfhPatterns) {
    for (const match of text.matchAll(pattern)) {
      const [wfhMin, wfhMax] = numericRange(match);
      ranges.push({ range: [5 - wfhMax, 5 - wfhMin], evidence: match[0] });
    }
  }

  if (ranges.length === 0) return null;

  const intersectionMin = Math.max(...ranges.map(({ range }) => range[0]));
  const intersectionMax = Math.min(...ranges.map(({ range }) => range[1]));
  const contradictory = intersectionMin > intersectionMax;
  const officeMin = contradictory ? Math.min(...ranges.map(({ range }) => range[0])) : intersectionMin;
  const officeMax = contradictory ? Math.max(...ranges.map(({ range }) => range[1])) : intersectionMax;
  return {
    office_days_min: Math.max(0, officeMin),
    office_days_max: Math.min(7, officeMax),
    evidence: [...new Set(ranges.map(({ evidence }) => evidence))],
    basis: "EMPLOYER_STATED",
    contradictory,
  };
}

export interface TravelRequirement {
  max_pct: number;
  evidence: string;
}

/** Return the upper bound of a travel requirement, preserving range semantics. */
export function extractTravelRequirement(description: string): TravelRequirement | null {
  const text = String(description || "").toLowerCase();
  const patterns = [
    /(?:travel|travelling|traveling)(?:[^.;\n%]{0,40}?)(\d+)\s*%\s*(?:-|–|to)\s*(\d+)\s*%/gi,
    /(\d+)\s*%\s*(?:-|–|to)\s*(\d+)\s*%(?:[^.;\n%]{0,40}?)(?:travel|travelling|traveling)/gi,
    /(?:travel|travelling|traveling)(?:[^.;\n%]{0,40}?)(\d+)\s*%/gi,
    /(\d+)\s*%(?:[^.;\n%]{0,40}?)(?:travel|travelling|traveling)/gi,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const first = Number(match[1]);
    const second = match[2] === undefined ? first : Number(match[2]);
    return { max_pct: Math.max(first, second), evidence: match[0] };
  }
  return null;
}

// 3. Workability Requirements (Zero tolerance for on-premises-only lab/clinic)
export function evaluateWorkability(
  location: string,
  workplaceType: string,
  description: string,
  employmentType?: string,
  policy: WorkabilityPolicy = loadWorkabilityPolicy(),
  answerContext?: VerificationAnswerContext | null,
): { workable: boolean; needsVerify: boolean; reason?: string; reasonCode?: string; facts?: Partial<GateResult["workability_facts"]> } {
  const effectivePolicy = applyVerificationAnswerOverrides(policy, answerContext);
  const officeDaysAnswerUnknown = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.workplaceOfficeDays,
  ) && answerContext?.overrides.workplaceOfficeDaysCap === null;
  const workAuthorizationAnswerUnknown = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.workAuthorization,
  ) && answerContext?.overrides.workAuthorizationRegions.length === 0;
  const wp = normalizeWorkMode(workplaceType);
  const loc = (location || "").toLowerCase().trim();
  const d = (description || "").toLowerCase().trim();
  const emp = (employmentType || "").toUpperCase().trim();
  const removeNonEmploymentContractPhrases = (text: string): string =>
    text
      .replace(/\bsmart contracts?\b/g, " ")
      .replace(/\bcontract (analysis|analytics|management|automation|lifecycle|intelligence|review)\b/g, " ")
      .replace(/\bcontracts (analysis|analytics|management|review)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizedEmp = (() => {
    if (emp.includes("CONTRACT")) return "CONTRACT" as const;
    if (emp.includes("PERMANENT") || emp.includes("FULL_TIME") || emp === "FTE") return "PERMANENT" as const;

    const cleaned = removeNonEmploymentContractPhrases(d);
    const isContractEmployment = /\bcontract[- ]to[- ]hire\b/i.test(cleaned)
      || /\b\d{1,2}\s*(?:month|months|mo|week|weeks|wk|day|days)\s+contract\b/i.test(cleaned)
      || /\bcontract\s+(?:role|position|assignment|opportunity)\b/i.test(cleaned)
      || /\bfixed[- ]term\b/i.test(cleaned)
      || /\btemporary\b/i.test(cleaned)
      || /\bcontractor\b/i.test(cleaned);

    if (isContractEmployment) return "CONTRACT" as const;

    const isPermanentEmployment = /\bfull[- ]?time\b/i.test(d) || /\bpermanent\b/i.test(d) || /\bfte\b/i.test(d);
    if (isPermanentEmployment) return "PERMANENT" as const;

    return "UNKNOWN" as const;
  })();

  const baseFacts: Partial<GateResult["workability_facts"]> = {
    employment_type: normalizedEmp,
  };

  // Structured or strongly indicated contract employment is deterministic.
  if (normalizedEmp === "CONTRACT" && !effectivePolicy.contractAllowed) {
    return {
      workable: false,
      needsVerify: false,
      reason: "Contract employment detected",
      reasonCode: "GATE_CONTRACT_ROLE",
      facts: baseFacts
    };
  }

  // 1. Explicit ONSITE structured field or work-mode heading/text -> HARD REJECT.
  // Source adapters frequently leave workplace_type UNKNOWN while the posting
  // itself says "Full-time · Onsite" or "Location: On-site". Those are still
  // explicit work-location evidence and must be evaluated here.
  const officeDaysMatch = d.match(/\b([1-5])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*(?:in|at)?\s*(?:the\s*)?office\b/i)
    || d.match(/\b([1-5])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*on-?site\b/i);
  const isExplicitOnsiteText = /\b(100%\s*on-?site|fully\s*on-?site|on-premises\s*only|lab-based|wet\s*lab|clinic-based)\b/i.test(d)
    || /(?:^|[|·•:])\s*(?:on-?site|onsite)\b/i.test(d)
    || /\b(?:location|workplace|work\s+location)\s*:\s*(?:on-?site|onsite)\b/i.test(d)
    || /\b(?:role|position|work|working|presence|based)\s+(?:is\s+)?(?:on-?site|onsite)\b/i.test(d)
    || (officeDaysMatch !== null && Number(officeDaysMatch[1]) >= effectivePolicy.hardFailOfficeDaysPerWeek);

  if ((!effectivePolicy.onsiteOnlyAllowed && wp === "ONSITE") || (!effectivePolicy.onsiteOnlyAllowed && isExplicitOnsiteText)) {
    const minDays = officeDaysMatch ? Number(officeDaysMatch[1]) : 4;
    const maxDays = officeDaysMatch ? Number(officeDaysMatch[1]) : 5;
    return {
      workable: false,
      needsVerify: false,
      reason: "Requires 100% on-premises / on-site presence (ONSITE mode not workable)",
      reasonCode: "GATE_HIGH_OFFICE_DAYS",
      facts: { ...baseFacts, office_days_min: minDays, office_days_max: maxDays }
    };
  }

  // 2. Determine explicit remote evidence before applying territory rules. A
  // remote employer location is not the worker's required work territory.
  const isExplicitRemoteText = /\b(?:fully\s+remote|remote[- ]first|remote\s+(?:position|role|job|work|opportunity)|remote\s+(?:from|in)\b|work\s+from\s+home|work\s+remotely)\b/i.test(d)
    || /(?:^|[|·•:])\s*remote\b/i.test(d)
    || /\b(?:location|workplace|work\s+location)\s*:\s*remote\b/i.test(d);
  const isRemote = wp === "REMOTE" || (wp === "UNKNOWN" && (/\bremote\b/i.test(loc) || isExplicitRemoteText));

  // 3. Geographic restrictions. Structured foreign locations are relevant to
  // onsite/hybrid roles; remote roles require an explicit worker authorization
  // or physical-residency restriction before they can fail this gate.
  const authorizedRegions = new Set(effectivePolicy.authorizedRegions);
  const locationTerritories = extractTerritories(loc);
  const descriptionTerritories = extractTerritories(d);
  const explicitlyDisallowed = effectivePolicy.rejectExplicitForeignTerritory
    ? [
        ...(isRemote ? [] : locationTerritories),
        ...descriptionTerritories.filter((territory) => hasExplicitTerritoryRestriction(d, territory)),
      ].filter((territory) => authorizedRegions.size === 0 || !authorizedRegions.has(territory))
    : [];
  if (explicitlyDisallowed.length > 0) {
    const territory = explicitlyDisallowed[0];
    if (workAuthorizationAnswerUnknown) {
      return {
        workable: true,
        needsVerify: true,
        reason: `Work authorization for ${territory} is unknown; needs manual verification`,
        facts: { ...baseFacts, location_restriction: territory },
      };
    }
    return {
      workable: false,
      needsVerify: false,
      reason: `Geographic restriction detected: ${territory}`,
      reasonCode: "GATE_LOCATION_RESTRICTED",
      facts: { ...baseFacts, location_restriction: territory }
    };
  }

  // 4. REMOTE structured field or explicit remote work-mode text -> PASS.
  if (isRemote) {
    if (locationTerritories.length === 0 && descriptionTerritories.length === 0 && !effectivePolicy.remoteWithoutTerritoryAllowed) {
      return {
        workable: true,
        needsVerify: true,
        reason: "Remote territory is not stated and this preference mode requires it",
        facts: { ...baseFacts, office_days_min: 0, office_days_max: 0, attendance_basis: "REMOTE" }
      };
    }
    return {
      workable: true,
      needsVerify: false,
      facts: { ...baseFacts, office_days_min: 0, office_days_max: 0, attendance_basis: "REMOTE" }
    };
  }

  // 5. HYBRID checks. Explicit employer attendance wins; otherwise the
  // owner-approved 3 onsite / 2 WFH assumption is persisted as evidence.
  if (wp === "HYBRID" || /\bhybrid\b/i.test(d) || /\bhybrid\b/i.test(loc)) {
    const attendance = extractHybridAttendance(d);
    if (attendance) {
      if (attendance.contradictory || attendance.office_days_max >= effectivePolicy.hardFailOfficeDaysPerWeek) {
        return {
          workable: false,
          needsVerify: false,
          reason: attendance.contradictory
            ? "Hybrid attendance statements contradict one another"
            : "Hybrid arrangement requires 4-5 days in-office",
          reasonCode: "GATE_HIGH_OFFICE_DAYS",
          facts: { ...baseFacts, office_days_min: attendance.office_days_min, office_days_max: attendance.office_days_max, attendance_basis: "EMPLOYER_STATED" }
        };
      }
      if (officeDaysAnswerUnknown) {
        return {
          workable: true,
          needsVerify: true,
          reason: "Office-day cap answer is unknown; needs manual verification",
          facts: { ...baseFacts, office_days_min: attendance.office_days_min, office_days_max: attendance.office_days_max, attendance_basis: "EMPLOYER_STATED" },
        };
      }
      if (attendance.office_days_max > effectivePolicy.maxOfficeDaysPerWeek) {
        return {
          workable: false,
          needsVerify: false,
          reason: "Hybrid arrangement exceeds the accepted office-day cap",
          reasonCode: "GATE_HIGH_OFFICE_DAYS",
          facts: { ...baseFacts, office_days_min: attendance.office_days_min, office_days_max: attendance.office_days_max, attendance_basis: "EMPLOYER_STATED" }
        };
      }
      return {
        workable: true,
        needsVerify: false,
        facts: { ...baseFacts, office_days_min: attendance.office_days_min, office_days_max: attendance.office_days_max, attendance_basis: "EMPLOYER_STATED" }
      };
    }

    if (officeDaysAnswerUnknown) {
      return {
        workable: true,
        needsVerify: true,
        reason: "Office-day cap answer is unknown; needs manual verification",
        facts: { ...baseFacts, office_days_min: 3, office_days_max: 3, attendance_basis: "POLICY_HYBRID_3_2" },
      };
    }
    if (effectivePolicy.hybridWithoutOfficeDaysAllowed) {
      return {
        workable: true,
        needsVerify: false,
        reason: "Hybrid attendance unspecified; applied the 3 onsite / 2 WFH policy assumption",
        facts: { ...baseFacts, office_days_min: 3, office_days_max: 3, attendance_basis: "POLICY_HYBRID_3_2" }
      };
    }
    return {
      workable: true,
      needsVerify: true,
      reason: "Hybrid arrangement listed without explicit office-day count",
      facts: { ...baseFacts, office_days_min: null, office_days_max: null, attendance_basis: "UNKNOWN" }
    };
  }

  const unknownWorkModeOutcome = () => {
    const facts = { ...baseFacts, office_days_min: null, office_days_max: null, attendance_basis: "UNKNOWN" as const };
    switch (effectivePolicy.unknownWorkModeDisposition) {
      case "PASS":
        return {
          workable: true,
          needsVerify: false,
          reason: "Workplace model unspecified; accepted by configured policy",
          reasonCode: "GATE_UNKNOWN_WORK_MODE",
          facts,
        };
      case "NEEDS_VERIFICATION":
        return {
          workable: true,
          needsVerify: true,
          reason: "Workplace model unspecified; needs manual verification",
          reasonCode: "GATE_UNKNOWN_WORK_MODE",
          facts,
        };
      case "HARD_REJECT":
      default:
        return {
          workable: false,
          needsVerify: false,
          reason: "Workplace model unspecified; rejected by owner policy",
          reasonCode: "GATE_UNKNOWN_WORK_MODE",
          facts,
        };
    }
  };

  // 6. Ambiguous location / office expectations are unresolved workplace-model
  // evidence. Apply the configured disposition rather than bypassing policy.
  const ambiguousClues = [
    "office based", "office-based", "in-office", "in office",
    "office expectations", "workplace arrangement", "workplace expectations",
    "office to be evaluated", "partner discussions", "location flexible", "location tbd"
  ];
  if (ambiguousClues.some(c => d.includes(c) || loc.includes(c))) {
    return unknownWorkModeOutcome();
  }

  // 7. Never infer a work mode from a non-empty location label. Apply the
  // configured policy when no accepted work-mode evidence was established.
  if (wp === "UNKNOWN") {
    return unknownWorkModeOutcome();
  }

  return { workable: true, needsVerify: false, facts: baseFacts };
}

export function evaluateHardGates(title: string, description: string, location: string, workplaceType: string): GateEvaluationResult {
  const job = {
    id: "eval-gate",
    title,
    raw_description: description,
    location,
    workplace_type: workplaceType,
    company_name: "Generic"
  };

  const gateResult = applyGlobalGates(job as any);

  return {
    passed: gateResult.status === "PASS",
    needsVerification: gateResult.status === "NEEDS_VERIFICATION",
    rejectionReason: gateResult.evidence_quotes?.[0] || gateResult.rejection_codes?.[0] || undefined,
    reasonCode: gateResult.rejection_codes?.[0] || (gateResult.status === "NEEDS_VERIFICATION" ? "NEEDS_VERIFICATION" : undefined),
    axis1FunctionPassed: gateResult.status === "PASS" || gateResult.status === "NEEDS_VERIFICATION",
    axis2DomainPassed: gateResult.status === "PASS" || gateResult.status === "NEEDS_VERIFICATION"
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
    attendance_basis?: "EMPLOYER_STATED" | "POLICY_HYBRID_3_2" | "REMOTE" | "UNKNOWN";
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
      attendance_basis: "UNKNOWN",
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
      attendance_basis: "UNKNOWN",
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
      attendance_basis: "UNKNOWN",
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
    const merged = [
      d.job_description || "",
      ...(d.key_responsibilities || []),
      ...(d.technical_skills || []),
      ...(d.qualifications_education || []),
      ...(d.nice_to_haves || [])
    ].join("\n");
    return stripHtmlToText(merged).toLowerCase();
  }
  if (typeof job.raw_description === "string") {
    if (job.raw_description.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(job.raw_description);
        const merged = [
          parsed.job_description || "",
          ...(parsed.key_responsibilities || []),
          ...(parsed.technical_skills || []),
          ...(parsed.qualifications_education || []),
          ...(parsed.nice_to_haves || [])
        ].join("\n");
        return stripHtmlToText(merged).toLowerCase();
      } catch {
        return stripHtmlToText(job.raw_description).toLowerCase();
      }
    }
    return stripHtmlToText(job.raw_description).toLowerCase();
  }
  return "";
}

import { isOccurrenceNegated } from "../requirements/clauseAnalysis.js";

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

function findNonNegatedEvidence(d: string, keywords: string[]): string[] {
  const quotes: string[] = [];
  for (const kw of keywords) {
    let startPos = 0;
    while (startPos < d.length) {
      const idx = d.indexOf(kw, startPos);
      if (idx === -1) break;
      if (!isOccurrenceNegated(d, idx, kw.length)) {
        const start = Math.max(0, idx - 20);
        const end = Math.min(d.length, idx + kw.length + 40);
        quotes.push(`"…${d.substring(start, end)}…"`);
      }
      startPos = idx + kw.length;
    }
  }
  return quotes;
}

export function applyGlobalGates(
  job: RawJob & { location?: string; workplace_type?: string; employment_type?: string },
  policy: WorkabilityPolicy = loadWorkabilityPolicy(),
  answerContext?: VerificationAnswerContext | null,
): GateResult {
  const effectivePolicy = applyVerificationAnswerOverrides(policy, answerContext);
  const travelAnswerProvided = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.travelPercentage,
  );
  const travelAnswerUnknown = travelAnswerProvided && answerContext?.overrides.travelPercentageCap === null;
  const workAuthorizationAnswerUnknown = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.workAuthorization,
  ) && answerContext?.overrides.workAuthorizationRegions.length === 0;
  const t = (job.title || "").toLowerCase();
  const c = (job.company_name || "").toLowerCase();
  const d = extractDescriptionText(job);
  const loc = (job.location || "").toLowerCase();
  const wp = (job.workplace_type || "").toUpperCase();
  const emp = (job.employment_type || "").toUpperCase();
  let pendingVerification: { reason: string; facts?: Partial<GateResult["workability_facts"]> } | null = null;

  // ── 0. Global Title Exclusions ──
  for (const pattern of GLOBAL_TITLE_EXCLUSIONS) {
    if (pattern.test(job.title || "")) {
      return makeReject(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-target title exclusion: "${job.title}"`]);
    }
  }

  // FDE is a global exclusion, even when the posting also contains strong AI
  // engineering signals.
  if (/\b(?:fde|forward[- ]deployed(?:\s+engineer(?:ing)?)?)\b/i.test(`${t} ${d}`)) {
    const evidence = findNonNegatedEvidence(d, ["forward deployed", "fde"]);
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], evidence.length > 0 ? evidence : [`FDE role: "${job.title}"`]);
  }

  // Generic consultancy/advisory work is outside the target role families;
  // technically substantive delivery and transformation titles remain eligible.
  const consultancyTitle = /\b(consult(?:ant|ancy)|advis(?:er|ory))\b/i.test(t);
  const approvedTechnicalConsultancy = /\b(?:technical|technology|engineering|software|data|ai|ml|digital|transformation)\b/i.test(t)
    && /\b(?:engineer(?:ing)?|architect(?:ure)?|program(?:me)?|project|product|delivery|transformation)\b/i.test(t);
  if (consultancyTitle && !approvedTechnicalConsultancy) {
    return makeReject(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"], [`Generic consultancy/advisory title: "${job.title}"`]);
  }

  // ── 0a. Workability Check (location / workplace / employment type) ──
  const workability = evaluateWorkability(job.location || "", job.workplace_type || "", d, job.employment_type || "", effectivePolicy, answerContext);
  if (!workability.workable) {
    if (workability.reasonCode === "GATE_CONTRACT_ROLE") {
      return makeReject(["GATE_CONTRACT_ROLE"], [workability.reason || "Contract role is not eligible"], workability.facts);
    }
    if (workability.reasonCode === "GATE_LOCATION_RESTRICTED") {
      return makeReject(["GATE_LOCATION_RESTRICTED"], [workability.reason || "Geographic restriction detected"], workability.facts);
    }
    if (workability.reasonCode === "GATE_UNKNOWN_WORK_MODE") {
      return makeReject(["GATE_UNKNOWN_WORK_MODE"], [workability.reason || "Workplace model is unspecified"], workability.facts);
    }
    return makeReject(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], [workability.reason || "Unworkable location/workplace model"], workability.facts);
  }

  // ── 0c. Unified Technical Function Check (Axis 1) ──
  const techCheck = isTechnicalRole(job.title || "", d);
  if (!techCheck.isTechnical) {
    return makeReject(["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"], [techCheck.reason || "Axis 1 Failed: Role lacks evidence of technical function"]);
  }

  if (workability.needsVerify) {
    pendingVerification = {
      reason: workability.reason || "Workplace model unspecified; needs manual verification",
      facts: workability.facts,
    };
  }

  if (effectivePolicy.blacklistedCompanies.some((company) => c === company || c.includes(company))) {
    return makeReject(["GATE_BLACKLISTED_COMPANY"], [`Company is configured as blacklisted: "${job.company_name}"`]);
  }

  const buildingPctBefore = d.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:time\s+)?(?:spent\s+on\s+)?(?:in\s+)?(?:building|research|hands-on|implementation|technical delivery|architecture)/i);
  const buildingPctAfter = d.match(/(?:building|research|hands-on|implementation|technical delivery|architecture)\s*(?:is|:|accounts\s+for|\()\s*(\d+(?:\.\d+)?)\s*%/i);
  const buildingPct = buildingPctBefore ? Number(buildingPctBefore[1]) : (buildingPctAfter ? Number(buildingPctAfter[1]) : null);
  const buildingSnippet = buildingPctBefore?.[0] ?? buildingPctAfter?.[0] ?? null;

  const interactionPctBefore = d.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:time\s+)?(?:spent\s+on\s+)?(?:in\s+)?(?:interaction|stakeholder|client-facing|client facing)/i);
  const interactionPctAfter = d.match(/(?:interaction|stakeholder|client-facing|client facing)\s*(?:is|:|accounts\s+for|\()\s*(\d+(?:\.\d+)?)\s*%/i);
  const interactionPct = interactionPctBefore ? Number(interactionPctBefore[1]) : (interactionPctAfter ? Number(interactionPctAfter[1]) : null);
  const interactionSnippet = interactionPctBefore?.[0] ?? interactionPctAfter?.[0] ?? null;

  const isBuildingFailed = buildingPct !== null && buildingPct < effectivePolicy.minimumBuildingResearchPct;
  const isInteractionFailed = interactionPct !== null && interactionPct > effectivePolicy.maximumInteractionPct;

  if (isBuildingFailed && isInteractionFailed) {
    return makeReject(
      ["GATE_BUILDING_RESEARCH_RATIO", "GATE_HIGH_INTERACTION"],
      [buildingSnippet ?? `${buildingPct}% building`, interactionSnippet ?? `${interactionPct}% interaction`]
    );
  }
  if (isBuildingFailed) {
    return makeReject(["GATE_BUILDING_RESEARCH_RATIO"], [buildingSnippet ?? `${buildingPct}% building`]);
  }
  if (isInteractionFailed) {
    return makeReject(["GATE_HIGH_INTERACTION"], [interactionSnippet ?? `${interactionPct}% interaction`]);
  }

  const travelRequirement = extractTravelRequirement(d);
  const frequentTravelEvidence = findNonNegatedEvidence(d, ["frequent travel", "travel extensively"]);
  if (travelRequirement && travelAnswerUnknown) {
    pendingVerification = {
      reason: "Travel cap answer is unknown; needs manual verification",
      facts: { travel_pct_max: travelRequirement.max_pct },
    };
  } else if (travelRequirement && travelRequirement.max_pct > effectivePolicy.maxTravelPct) {
    return makeReject(
      ["GATE_LIFESTYLE_INCOMPATIBLE"],
      [travelRequirement.evidence],
      { travel_pct_max: travelRequirement.max_pct }
    );
  } else if (frequentTravelEvidence.length > 0 && !effectivePolicy.frequentTravelAllowed && !travelAnswerProvided) {
    return makeReject(
      ["GATE_LIFESTYLE_INCOMPATIBLE"],
      frequentTravelEvidence,
      { travel_pct_max: null }
    );
  }

  // ── 1. Deterministic Non-Technical Title-Family Exclusions ──

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
  if (legalPracticeRegex.test(t) && !techCheck.isTechnical) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Legal Practice / Counsel "${job.title}"`]);
  }

  // D. Sales / Marketing / BD
  const salesTitleRegex = /\b(account executive|sales manager|sales director|business development manager|business development executive|bdr|sdr|marketing manager|marketing director|product marketing manager|growth marketing|event coordinator)\b/i;
  if (salesTitleRegex.test(t) && !techCheck.isTechnical) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Sales / Marketing "${job.title}"`]);
  }

  // E. Non-technical QA Coordination / Operations Management
  const coordTitleRegex = /\b(quality assurance coordinator|qa coordinator|compliance coordinator|operations coordinator|administrative coordinator|logistics coordinator)\b/i;
  if (coordTitleRegex.test(t) && !techCheck.isTechnical) {
    return makeReject(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Non-technical Coordinator "${job.title}"`]);
  }

  // F. Qualitative Finance / Banking
  const financeQualRegex = /\b(private equity associate|private equity analyst|investment banking analyst|investment banking associate|m&a analyst|m&a associate|deal advisory|commercial banker|loan officer|credit underwriter)\b/i;
  if (financeQualRegex.test(t) && !techCheck.isTechnical) {
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
  const hardOnsiteRegex = /\b([45])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*on-?site\b/i;
  const configuredOfficeDaysRegex = new RegExp(
    `\\b(\\d+)\\s*days?\\s*(?:per\\s*week|a\\s*week|\\/week)?\\s*(?:in|at)?\\s*(?:the\\s*)?(?:office|on-?site)\\b`,
    "i"
  );
  const configuredOfficeDaysMatch = d.match(configuredOfficeDaysRegex);
  if (configuredOfficeDaysMatch && (Number(configuredOfficeDaysMatch[1]) >= effectivePolicy.hardFailOfficeDaysPerWeek
    || Number(configuredOfficeDaysMatch[1]) > effectivePolicy.maxOfficeDaysPerWeek)) {
    return makeReject(
      ["GATE_HIGH_OFFICE_DAYS"],
      [configuredOfficeDaysMatch[0]],
      {
        office_days_min: Number(configuredOfficeDaysMatch[1]),
        office_days_max: Number(configuredOfficeDaysMatch[1]),
      }
    );
  }
  const hardOnsiteKeyword = hardOnsiteKw.find((kw) => d.includes(kw));
  const hardOnsiteMatch = d.match(hardOnsiteRegex);
  const hardOnsiteDays = hardOnsiteKeyword?.match(/\b([45])\s*days?\b/i)?.[1] ?? hardOnsiteMatch?.[1];
  const hardOnsiteAllowedByAnswer =
    hardOnsiteDays !== undefined && effectivePolicy.maxOfficeDaysPerWeek >= Number(hardOnsiteDays);
  if ((hardOnsiteKeyword !== undefined || hardOnsiteMatch !== null) && !hardOnsiteAllowedByAnswer) {
    const evidenceKeyword = hardOnsiteKeyword ?? hardOnsiteMatch?.[0] ?? "on-site requirement";
    return makeReject(["GATE_HIGH_OFFICE_DAYS"], findEvidence(d, [evidenceKeyword]), { office_days_min: 4, office_days_max: 5 });
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

  // A hybrid posting without an exact office-day count is explicitly accepted
  // by policy. Phrases such as "office expectations" commonly occur in those
  // postings as context and must not override the hybrid policy. They remain
  // verification clues only when the posting has no accepted remote/hybrid
  // work-mode signal at all.
  const hasAcceptedFlexibleWorkMode = /\bhybrid\b/i.test(d)
    || /\b(remote|remote-first|fully remote|work from home)\b/i.test(d)
    || wp === "REMOTE"
    || wp === "HYBRID";
  if (!hasExplicitDays && ambiguousOfficeKw.some(k => d.includes(k)) && !pendingVerification && !hasAcceptedFlexibleWorkMode) {
    pendingVerification = {
      reason: "Workplace model ambiguous/unspecified; needs manual verification",
      facts: { office_days_min: null, office_days_max: null },
    };
  }

  // ── 4. Geographic restrictions ──
  const authorizedRegions = new Set(effectivePolicy.authorizedRegions);
  const locationTerritories = extractTerritories(String(job.location || ""));
  const descriptionTerritories = extractTerritories(d);
  const disallowedTerritories = effectivePolicy.rejectExplicitForeignTerritory
    ? [
        ...locationTerritories,
        ...descriptionTerritories.filter((territory) => hasExplicitTerritoryRestriction(d, territory)),
      ].filter((territory) => authorizedRegions.size === 0 || !authorizedRegions.has(territory))
    : [];
  if (disallowedTerritories.length > 0) {
    const territory = disallowedTerritories[0];
    if (!workAuthorizationAnswerUnknown) {
      return makeReject(["GATE_LOCATION_RESTRICTED"], [`Explicit work territory restriction: ${territory}`], {
        location_restriction: territory,
      });
    }
    pendingVerification = {
      reason: `Work authorization for ${territory} is unknown; needs manual verification`,
      facts: { location_restriction: territory },
    };
  }

  // ── 5. Lifestyle incompatibilities ──
  const lifestyleKw = ["shift work", "on-call rotation", "regular on-call", "24/7 support", "travel extensively", "frequent travel", "up to 50% travel", "up to 25% travel"];
  for (const kw of lifestyleKw) {
    if (d.includes(kw)) {
      const isShiftConflict = ["shift work"].includes(kw) && !effectivePolicy.shiftWorkAllowed;
      const isOnCallConflict = ["on-call rotation", "regular on-call", "24/7 support"].includes(kw) && !effectivePolicy.regularOnCallAllowed;
      const isTravelConflict = ["travel extensively", "frequent travel", "up to 50% travel", "up to 25% travel"].includes(kw) && !effectivePolicy.frequentTravelAllowed;
      if (!isShiftConflict && !isOnCallConflict && !isTravelConflict) continue;
      const evidence = findNonNegatedEvidence(d, [kw]);
      if (evidence.length === 0) continue; // Negated or optional occurrence
      const travelPct = kw.includes("50%") ? 50 : kw.includes("25%") ? 25 : null;
      const hasTravelAnswer = answerContext?.overrides.travelPercentageCap !== null
        && answerContext?.overrides.travelPercentageCap !== undefined
        || isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.travelPercentage);
      if (hasTravelAnswer && travelPct === null) {
        pendingVerification = {
          reason: "Travel expectation is stated without a deterministic percentage; needs manual verification",
          facts: { travel_pct_max: null },
        };
        continue;
      }
      // A numeric travel requirement has already been checked against the
      // answer-adjusted maxTravelPct above; do not apply the legacy generic
      // frequent-travel reject a second time.
      if (hasTravelAnswer && travelPct !== null) continue;
      return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], evidence, { travel_pct_max: travelPct });
    }
  }

  // ── 6. Sales / Client-facing ──
  const highInteractionKw = ["sales engineering", "presales", "pre-sales", "client relationship management", "manage large teams", "escalations manager"];
  for (const kw of highInteractionKw) {
    if (d.includes(kw) && !effectivePolicy.externalClientPrimaryAllowed) {
      const evidence = findNonNegatedEvidence(d, [kw]);
      if (evidence.length === 0) continue;
      return makeReject(["GATE_HIGH_INTERACTION"], evidence);
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
    if (d.includes(kw) && !effectivePolicy.peopleManagementPrimaryAllowed) {
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
  // Axis 2: Target Domain Validation
  const aiDataShortRegex = /\b(?:ai|ml|nlp|llm|rag)\b/i;
  const targetDomainPhrases = [
    "artificial intelligence", "machine learning", "data engineering", "data pipeline",
    "data warehouse", "etl", "sql", "quantitative", "quantitative research", "time-series",
    "time series", "portfolio analytics", "algorithmic trading", "market microstructure",
    "trading systems", "fintech", "order book", "computational biology", "bioinformatics",
    "cheminformatics", "genomics", "drug discovery", "clinical trial", "regtech",
    "legaltech", "fraud detection", "kyc", "aml", "compliance automation",
    "contract analytics", "digital trust", "deep learning", "agentic", "market data",
    "trading infrastructure", "software development", "software platform", "data science", "data analytics", "business intelligence", "data platform", "data architecture", "technology transformation", "digital transformation", "data transformation", "technical program", "technical project",
    "cloud", "cloud infrastructure", "cloud architecture", "solutions architect", "enterprise architect", "cloud architect", "microservices", "software architecture", "technical delivery", "techno-functional", "devops", "platform engineering", "engineering delivery", "systems architecture", "hands-on architecture", "technical discovery", "hands-on engineering",
    "technical transformation", "engineering transformation", "devops modernization", "cloud migration", "technical deployment", "technical client deployment", "systems engineering", "systems engineer", "data engineer", "data scientist", "data platform", "lakehouse", "ai engineer", "ml engineer", "machine learning engineer", "high-throughput", "core infrastructure"
  ];
  const hasDomainRelevance = aiDataShortRegex.test(t) || aiDataShortRegex.test(d) ||
    targetDomainPhrases.some(kw => t.includes(kw) || d.includes(kw));

  if (!hasDomainRelevance) {
    if (pendingVerification) {
      return makeVerification(
        ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
        [pendingVerification.reason],
        pendingVerification.facts
      );
    }
    return makeReject(["GATE_NOT_AI_DATA"], ["Axis 2 Failed: No signal found for target domains (AI/Data, RegTech, Bio/Pharma, Quant/FinTech)"]);
  }

  // ── All deterministic gates passed ──
  if (pendingVerification) {
    return makeVerification(
      ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
      [pendingVerification.reason],
      pendingVerification.facts
    );
  }

  return makePass(workability.facts);
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
