import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";
import {
  applyGlobalGates,
  extractHybridAttendance,
  extractTravelRequirement,
  GLOBAL_TITLE_EXCLUSIONS,
  isTechnicalRole,
  type GateResult,
} from "../services/criteria.js";
import { normalizeWorkMode } from "./workModeNormalizer.js";
import { enrichWorkModeIfNeeded } from "../services/workModeEnrichment.js";
import { PersistedGateDecisionSchema } from "../contracts/index.js";
import { GATE_VERSION } from "../contracts/version.js";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { calculateProfessionalExperienceYears, compareStructuredRequirement, type ComparableFact } from "./requirementComparators.js";
import {
  applyVerificationAnswerOverrides,
  evaluateWorkerTerritoryRequirements,
  extractExplicitWorkerTerritoryRequirements,
  isVerificationAnswerContextApplicable,
  isVerificationAnswerProvided,
  loadVerificationAnswerContext,
  loadWorkabilityPolicy,
  normalizeVerificationDegreeSubjects,
  VERIFICATION_ANSWER_KEYS,
  normalizeVerificationExperienceDomains,
  resolveWorkspaceWorkabilityPolicy,
  type VerificationAnswerContext,
  type WorkabilityPolicy,
} from "./workabilityPolicy.js";

import {
  evaluateJobFreshness,
  evaluateMobilityMatch,
  evaluateEmployerExclusions,
  evaluateCompensationPolicy,
  inferOpportunityCategory,
  parseCompensationEvidence,
} from "../policy/stage3PolicyEngine.js";
import type { Stage3PolicyPreferences } from "../policy/stage3Contracts.js";
import { resolveWorkspacePreferenceContext } from "../policy/workspacePreferenceRegistry.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

interface PersistedRequirement {
  requirement_key: string;
  requirement_type: string;
  importance?: string;
  requirement_text: string;
  quote_text: string | null;
  structured_value: Record<string, unknown> | null;
}

export function isRequirementOptional(req: PersistedRequirement): boolean {
  const importance = (req.importance || "").toUpperCase();
  if (importance === "PREFERRED" || importance === "NICE_TO_HAVE" || importance === "OPTIONAL") {
    return true;
  }
  const structuredImportance = String(req.structured_value?.importance || "").toUpperCase();
  if (structuredImportance === "PREFERRED" || structuredImportance === "NICE_TO_HAVE" || structuredImportance === "OPTIONAL") {
    return true;
  }
  if (req.structured_value?.is_required === false || req.structured_value?.required === false) {
    return true;
  }
  return false;
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
      ...extraFacts,
    },
  };
}

function makeReject(
  codes: string[],
  evidence: string[],
  facts?: Partial<GateResult["workability_facts"]>
): GateResult {
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
      ...facts,
    },
  };
}

function makeVerification(
  codes: string[],
  evidence: string[],
  facts?: Partial<GateResult["workability_facts"]>
): GateResult {
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
      ...facts,
    },
  };
}

function quoteOrText(req: PersistedRequirement): string {
  return req.quote_text || req.requirement_text;
}

function detectOfficeDays(req: PersistedRequirement): number | null {
  const structured = req.structured_value || {};
  for (const key of ["office_days_per_week", "max_office_days_per_week", "office_days_max", "office_days_min"]) {
    const raw = structured[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  const attendance = extractHybridAttendance(quoteOrText(req));
  return attendance?.office_days_max ?? null;
}

function detectTravelPct(req: PersistedRequirement): number | null {
  const structured = req.structured_value || {};
  for (const key of ["max_travel_pct", "travel_pct_max", "travel_percentage", "maximum_travel_pct"]) {
    const raw = structured[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  return extractTravelRequirement(quoteOrText(req))?.max_pct ?? null;
}

function structuredNumber(req: PersistedRequirement, keys: string[]): number | null {
  for (const key of keys) {
    const value = req.structured_value?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

export function applyPersistedRequirementGates(
  job: {
    title: string;
    company_name: string;
    employment_type?: string;
    workplace_type?: string;
    location?: string;
    description?: string;
    posted_at?: string | Date | null;
    reposted_at?: string | Date | null;
    source_updated_at?: string | Date | null;
    freshness_basis?: string | null;
    compensation_raw?: string | null;
    salary_min?: number | null;
    salary_max?: number | null;
    salary_currency?: string | null;
    salary_period?: 'ANNUAL' | 'MONTHLY' | 'HOURLY' | 'UNKNOWN' | null;
    salary_basis?: 'GROSS' | 'NET' | 'UNKNOWN';
    component_type?: 'BASE_CASH' | 'VARIABLE_CASH' | 'EQUITY' | 'OTHER';
    guaranteed_hours_per_week?: number | null;
    paid_weeks_per_year?: number | null;
    travel_pct?: number | null;
    currency_to_sgd_rate?: number | null;
    fx_rate_date?: string | null;
    fx_rate_source?: string | null;
    fx_rate_observation_id?: string | null;
    is_startup?: boolean;
    opportunity_category?: 'COMMERCIAL' | 'UNIVERSITY_RESEARCH' | 'MISSION_MULTILATERAL' | null;
  },
  deterministicRequirements: PersistedRequirement[],
  policy: WorkabilityPolicy = loadWorkabilityPolicy(),
  answerContext?: VerificationAnswerContext | null,
  stage3Preferences?: Stage3PolicyPreferences,
): GateResult {
  const effectivePolicy = applyVerificationAnswerOverrides(policy, answerContext);
  const officeDaysAnswerUnknown = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.workplaceOfficeDays,
  ) && answerContext?.overrides.workplaceOfficeDaysCap === null;
  const travelAnswerUnknown = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.travelPercentage,
  ) && answerContext?.overrides.travelPercentageCap === null;
  const title = job.title || "";
  let pendingVerification: { codes: string[]; evidence: string[]; facts?: Partial<GateResult["workability_facts"]> } | null = null;
  let inferredWorkabilityFacts: Partial<GateResult["workability_facts"]> = {};

  // Stage 3: Freshness only uses authoritative publication or genuine-repost timestamps.
  const freshness = evaluateJobFreshness({
    posted_at: job.posted_at,
    reposted_at: job.reposted_at,
    source_updated_at: job.source_updated_at,
    freshness_basis: job.freshness_basis,
    is_repost: job.freshness_basis === 'REPOSTED_AT',
    posting_identity_is_new: job.freshness_basis === 'NEW_POSTING_ID',
  }, stage3Preferences?.freshness);
  if (freshness.is_hard_reject) {
    return makeReject(
      [freshness.rejection_code || 'GATE_STALE_POSTING'],
      [freshness.evidence]
    );
  }

  // Stage 3: enforce user-scoped hiring eligibility and mobility, never global defaults.
  const mobility = evaluateMobilityMatch({
    workplace_type: job.workplace_type,
    location: job.location,
    description: job.description,
    travel_pct: job.travel_pct,
  }, stage3Preferences?.mobility);
  if (mobility.is_hard_reject) {
    return makeReject(
      [mobility.rejection_code || 'UNWORKABLE_LOCATION_MODEL'],
      [job.description || mobility.evidence]
    );
  }

  // Stage 3: employer exclusions apply only when explicitly present in the active user preference.
  if (job.company_name) {
    const exclusion = evaluateEmployerExclusions(
      job.company_name,
      job.description || '',
      stage3Preferences?.watchlist
    );
    if (exclusion.is_excluded) {
      return makeReject(
        [exclusion.rejection_code || 'GATE_EXCLUDED_EMPLOYER'],
        [job.description || exclusion.reason || `Employer name: ${job.company_name}`]
      );
    }
  }

  // Compensation floors are handled as non-Apply-Now policy downstream unless explicitly configured as a hard reject.
  const hasStructuredSalary =
    (job.salary_min !== null && job.salary_min !== undefined)
    || (job.salary_max !== null && job.salary_max !== undefined);
  const compensationInput = hasStructuredSalary
    ? {
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        salary_currency: job.salary_currency,
        salary_period: job.salary_period,
        salary_basis: job.salary_basis,
        component_type: job.component_type,
        guaranteed_hours_per_week: job.guaranteed_hours_per_week,
        paid_weeks_per_year: job.paid_weeks_per_year,
        currency_to_sgd_rate: job.currency_to_sgd_rate,
        fx_rate_date: job.fx_rate_date,
        fx_rate_source: job.fx_rate_source,
        fx_rate_observation_id: job.fx_rate_observation_id,
        is_startup: job.is_startup,
      }
    : parseCompensationEvidence(job.compensation_raw);
  if (compensationInput) {
    const opportunityCategory = job.opportunity_category
      ?? inferOpportunityCategory(job.company_name, job.title, job.description || '');
    const compensation = evaluateCompensationPolicy(
      compensationInput,
      opportunityCategory,
      stage3Preferences?.compensation
    );
    if (compensation.is_hard_reject) {
      return makeReject(
        [compensation.rejection_code || 'COMPENSATION_BELOW_USER_FLOOR'],
        [job.description || compensation.evidence]
      );
    }
  }

  for (const pattern of GLOBAL_TITLE_EXCLUSIONS) {
    if (pattern.test(title)) {
      return makeReject(
        ["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"],
        [`Non-target title exclusion: "${title}"`]
      );
    }
  }

  const functionRequirements = deterministicRequirements.filter(
    (r) => r.requirement_type === "FUNCTION"
  );
  const domainRequirements = deterministicRequirements.filter(
    (r) => r.requirement_type === "DOMAIN"
  );

  const hasSemanticSignals = functionRequirements.length > 0 || domainRequirements.length > 0;
  const semanticCorpus = [...functionRequirements, ...domainRequirements]
    .map((r) => quoteOrText(r).toLowerCase())
    .concat(job.description ? [job.description.toLowerCase()] : [])
    .join(" \n");

  let hasTechnicalEvidence = false;
  if (hasSemanticSignals) {
    hasTechnicalEvidence = /(engineer|architect|developer|scientist|machine learning|artificial intelligence|ai\b|llm|nlp|data|bioinformatics|genomics|regtech|legaltech|quant|fintech|trading)/i.test(
      semanticCorpus
    );
  } else {
    const textCorpus = deterministicRequirements
      .map((r) => quoteOrText(r).toLowerCase())
      .concat(job.description ? [job.description.toLowerCase()] : [])
      .join(" \n");
    const techCheck = isTechnicalRole(title, textCorpus);
    hasTechnicalEvidence = techCheck.isTechnical;
  }

  if (!hasTechnicalEvidence) {
    return makeReject(
      ["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"],
      [
        hasSemanticSignals
          ? "Persisted FUNCTION/DOMAIN requirements indicate non-technical scope"
          : "Axis 1 Failed: Role lacks evidence of technical function",
      ]
    );
  }

  for (const requirement of deterministicRequirements) {
    const buildingPct = structuredNumber(requirement, [
      "building_research_pct",
      "minimum_building_research_pct",
      "hands_on_pct",
      "implementation_pct",
    ]);
    if (buildingPct !== null && buildingPct < effectivePolicy.minimumBuildingResearchPct) {
      return makeReject(["GATE_BUILDING_RESEARCH_RATIO"], [quoteOrText(requirement)], {
        office_days_min: null,
        office_days_max: null,
      });
    }

    const interactionPct = structuredNumber(requirement, [
      "interaction_pct",
      "maximum_interaction_pct",
      "stakeholder_pct",
      "client_facing_pct",
    ]);
    if (interactionPct !== null && interactionPct > effectivePolicy.maximumInteractionPct) {
      return makeReject(["GATE_HIGH_INTERACTION"], [quoteOrText(requirement)]);
    }

    const travelPct = structuredNumber(requirement, [
      "max_travel_pct",
      "travel_pct_max",
      "travel_percentage",
      "maximum_travel_pct",
    ]);
    if (travelPct !== null && travelPct > effectivePolicy.maxTravelPct) {
      return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(requirement)], {
        travel_pct_max: travelPct,
      });
    }
  }

  const employmentReq = deterministicRequirements.find((r) => r.requirement_type === "EMPLOYMENT_TYPE");
  const normalizedEmployment = (employmentReq ? quoteOrText(employmentReq) : (job.employment_type || "")).toLowerCase();
  const employmentType = normalizedEmployment.includes("contract")
    ? "CONTRACT" as const
    : /\b(permanent|full[-_ ]?time|fte)\b/i.test(normalizedEmployment)
      ? "PERMANENT" as const
      : "UNKNOWN" as const;
  if (employmentType === "CONTRACT" && !effectivePolicy.contractAllowed) {
    return makeReject(
      ["GATE_CONTRACT_ROLE"],
      [employmentReq ? quoteOrText(employmentReq) : "Structured employment_type is CONTRACT"],
      { employment_type: "CONTRACT" }
    );
  }

  const officeRequirements = deterministicRequirements.filter((r) => r.requirement_type === "OFFICE_DAYS");
  const officeReq = officeRequirements[0];
  for (const requirement of officeRequirements) {
    const days = detectOfficeDays(requirement);
    if (days !== null && days >= effectivePolicy.hardFailOfficeDaysPerWeek) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        [quoteOrText(requirement)],
        { office_days_min: days, office_days_max: days }
      );
    }
    if (days !== null && officeDaysAnswerUnknown) {
      pendingVerification = {
        codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
        evidence: [quoteOrText(requirement)],
        facts: { office_days_min: days, office_days_max: days },
      };
      continue;
    }
    if (days !== null && days > effectivePolicy.maxOfficeDaysPerWeek) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        [quoteOrText(requirement)],
        { office_days_min: days, office_days_max: days }
      );
    }
    if (days === null) {
      if (!effectivePolicy.hybridWithoutOfficeDaysAllowed) {
        pendingVerification = {
          codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
          evidence: [quoteOrText(requirement)],
          facts: { office_days_min: null, office_days_max: null },
        };
      }
    }
  }

  const workModeReq = deterministicRequirements.find((r) => r.requirement_type === "WORK_MODE");
  if (workModeReq) {
    const mode = quoteOrText(workModeReq).toLowerCase();
    if (!effectivePolicy.onsiteOnlyAllowed && (
      mode.includes("onsite only") ||
      mode.includes("on-site only") ||
      mode.includes("fully on-site") ||
      mode.includes("fully onsite") ||
      mode.includes("100% on-site") ||
      mode.includes("100% onsite")
    )) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        [quoteOrText(workModeReq)],
        { office_days_min: effectivePolicy.hardFailOfficeDaysPerWeek, office_days_max: 5 }
      );
    }
  }

  const travelRequirements = deterministicRequirements.filter((r) => r.requirement_type === "TRAVEL");
  const travelReq = travelRequirements[0];
  for (const requirement of travelRequirements) {
    const travelPct = detectTravelPct(requirement);
    const txt = quoteOrText(requirement).toLowerCase();
    const hasTravelAnswer = answerContext?.overrides.travelPercentageCap !== null
      && answerContext?.overrides.travelPercentageCap !== undefined
      || isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.travelPercentage);
    if (travelPct !== null && travelAnswerUnknown) {
      pendingVerification = {
        codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_TRAVEL"],
        evidence: [quoteOrText(requirement)],
        facts: { travel_pct_max: travelPct },
      };
      continue;
    }
    if (travelPct !== null && travelPct > effectivePolicy.maxTravelPct) {
      return makeReject(
        ["GATE_LIFESTYLE_INCOMPATIBLE"],
        [quoteOrText(requirement)],
        { travel_pct_max: travelPct }
      );
    }
    if (hasTravelAnswer && travelPct === null) {
      pendingVerification = {
        codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_TRAVEL"],
        evidence: [quoteOrText(requirement)],
        facts: { travel_pct_max: null },
      };
    } else if (!hasTravelAnswer && txt.includes("frequent travel") && !effectivePolicy.frequentTravelAllowed) {
      return makeReject(
        ["GATE_LIFESTYLE_INCOMPATIBLE"],
        [quoteOrText(requirement)],
        { travel_pct_max: travelPct }
      );
    }
  }

  const onCallReq = deterministicRequirements.find((r) => r.requirement_type === "ON_CALL");
  if (onCallReq && !effectivePolicy.regularOnCallAllowed) {
    return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(onCallReq)]);
  }

  const shiftReq = deterministicRequirements.find((r) => r.requirement_type === "SHIFT_WORK");
  if (shiftReq && !effectivePolicy.shiftWorkAllowed) {
    return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(shiftReq)]);
  }

  const workAuthRequirements = deterministicRequirements.filter((r) => r.requirement_type === "WORK_AUTH");
  const unresolvedTerritoryRequirements: string[] = [];
  const incompatibleTerritories: string[] = [];
  for (const workAuthReq of workAuthRequirements) {
    const authText = quoteOrText(workAuthReq);
    const conditions = extractExplicitWorkerTerritoryRequirements(authText);
    const territoryEvaluation = evaluateWorkerTerritoryRequirements(
      conditions,
      effectivePolicy.authorizedRegions,
      effectivePolicy.rejectExplicitForeignTerritory,
    );
    unresolvedTerritoryRequirements.push(...territoryEvaluation.unresolvedRequirements.map((condition) => condition.evidenceText));
    incompatibleTerritories.push(...territoryEvaluation.incompatibleTerritories);
  }

  // Each worker-territory condition is evaluated separately. An OR alternative
  // inside one condition never masks another mandatory restriction.
  if (incompatibleTerritories.length > 0) {
    return makeReject(
      ["WORK_AUTHORIZATION_INCOMPATIBLE"],
      workAuthRequirements.map(quoteOrText),
      { location_restriction: incompatibleTerritories[0] ?? "UNKNOWN" }
    );
  }
  if (unresolvedTerritoryRequirements.length > 0) {
    return makeVerification(
      ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_WORK_AUTHORIZATION"],
      unresolvedTerritoryRequirements,
      { ...inferredWorkabilityFacts, location_restriction: null },
    );
  }

  if (workModeReq && quoteOrText(workModeReq).toLowerCase().includes("hybrid") && officeRequirements.length === 0) {
    const attendance = extractHybridAttendance(quoteOrText(workModeReq));
    if (attendance?.contradictory || (attendance && attendance.office_days_max >= effectivePolicy.hardFailOfficeDaysPerWeek)) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        attendance?.evidence || [quoteOrText(workModeReq)],
        { office_days_min: attendance?.office_days_min ?? null, office_days_max: attendance?.office_days_max ?? null },
      );
    }
    if (attendance && attendance.office_days_max > effectivePolicy.maxOfficeDaysPerWeek) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        attendance.evidence,
        { office_days_min: attendance.office_days_min, office_days_max: attendance.office_days_max },
      );
    }
    if (officeDaysAnswerUnknown) {
      pendingVerification = {
        codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
        evidence: [quoteOrText(workModeReq)],
        facts: {
          office_days_min: attendance?.office_days_min ?? 3,
          office_days_max: attendance?.office_days_max ?? 3,
          attendance_basis: attendance ? "EMPLOYER_STATED" : "POLICY_HYBRID_3_2",
        },
      };
    } else if (!attendance && effectivePolicy.hybridWithoutOfficeDaysAllowed) {
      // The owner policy treats unspecified hybrid attendance as 3 onsite / 2 WFH.
      // Persist the assumption so later stages do not silently re-interpret it.
      inferredWorkabilityFacts = {
        office_days_min: 3,
        office_days_max: 3,
        attendance_basis: "POLICY_HYBRID_3_2",
      };
    } else if (!attendance && !effectivePolicy.hybridWithoutOfficeDaysAllowed) {
      pendingVerification = {
        codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
        evidence: [quoteOrText(workModeReq)],
        facts: { office_days_min: null, office_days_max: null },
      };
    }
  }

  if (pendingVerification) {
    return makeVerification(
      pendingVerification.codes,
      pendingVerification.evidence,
      { ...inferredWorkabilityFacts, ...pendingVerification.facts },
    );
  }

  return makePass({
    ...inferredWorkabilityFacts,
    office_days_min: officeReq ? detectOfficeDays(officeReq) : inferredWorkabilityFacts.office_days_min ?? null,
    office_days_max: officeReq ? detectOfficeDays(officeReq) : inferredWorkabilityFacts.office_days_max ?? null,
    travel_pct_max: travelReq ? detectTravelPct(travelReq) : null,
    employment_type: employmentType,
  });
}

function combineGateResults(results: GateResult[]): GateResult {
  const hardReject = results.find((result) => result.status === "HARD_REJECT");
  const verification = results.find((result) => result.status === "NEEDS_VERIFICATION");
  const selected = hardReject || verification || results[0] || makePass();
  const rejectionCodes = [...new Set(results.flatMap((result) => result.rejection_codes))];
  const evidenceQuotes = [...new Set(results.flatMap((result) => result.evidence_quotes))];

  const workabilityFacts = { ...makePass().workability_facts };
  for (const result of results) {
    for (const [key, value] of Object.entries(result.workability_facts)) {
      if (value === null || value === undefined) continue;

      const existingValue = (workabilityFacts as Record<string, unknown>)[key];
      if (value === "UNKNOWN" && existingValue !== null && existingValue !== undefined && existingValue !== "UNKNOWN") {
        continue;
      }
      (workabilityFacts as Record<string, unknown>)[key] = value;
    }
  }

  return {
    ...selected,
    rejection_code: rejectionCodes[0],
    rejection_codes: rejectionCodes,
    evidence_quotes: evidenceQuotes,
    workability_facts: workabilityFacts,
  };
}

function verificationDegreeSubject(value: string): string | null {
  const text = value.toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(computer\s+science|computing|informatics|software\s+engineering)\b/i.test(text)) return "computer_science";
  if (/\b(data\s+science|analytics?|statistics?)\b/i.test(text)) return "data_science";
  if (/\b(mathematics?|mathematical|quantitative)\b/i.test(text)) return "mathematics";
  if (/\b(electrical|systems?)\s+engineering\b|\bengineering\b/i.test(text) && !/software\s+engineering/i.test(text)) return "engineering";
  if (/\bphysics?|computational\s+science\b/i.test(text)) return "physics";
  if (/\b(biology|biological|biomedical|biochemistry)\b/i.test(text)) return "biology";
  if (/\b(finance|financial|economics?)\b/i.test(text)) return "finance";
  if (/\b(business|management)\b/i.test(text)) return "business";
  if (/\b(law|legal\s+studies|jurisprudence)\b/i.test(text)) return "law";
  return null;
}

function degreeRequirementSubject(requirement: PersistedRequirement): string | null {
  return verificationDegreeSubject([
    requirement.requirement_text,
    requirement.quote_text || "",
    JSON.stringify(requirement.structured_value || {}),
  ].join(" "));
}

function removeDegreeSubject(requirement: PersistedRequirement): PersistedRequirement {
  const structured = Object.fromEntries(
    Object.entries(requirement.structured_value || {})
      .filter(([key]) => !/(subject|major|discipline|field)/i.test(key)),
  );
  const source = requirement.requirement_text || requirement.quote_text || "";
  const level = source.match(/\b(phd|doctorate|doctoral|master'?s?|msc|ma|mba|bachelor'?s?|undergraduate|bsc|ba)\b/i)?.[0];
  return {
    ...requirement,
    requirement_text: level ? `${level} degree` : requirement.requirement_text,
    quote_text: level ? `${level} degree` : requirement.quote_text,
    structured_value: structured,
  };
}

function expandExperienceScope(
  requirement: PersistedRequirement,
  domains: string[],
): PersistedRequirement {
  const structured = { ...(requirement.structured_value || {}) };
  const existing = structured.experience_scope ?? structured.experience_scopes ?? structured.scope ?? structured.domain;
  const existingValues = Array.isArray(existing) ? existing : existing ? [existing] : [];
  structured.experience_scope = [...existingValues, ...domains];
  return { ...requirement, structured_value: structured };
}

export function applyExactProfileGates(
  deterministicRequirements: PersistedRequirement[],
  profileFacts: ComparableFact[],
  answerContext?: VerificationAnswerContext | null,
): GateResult {
  // Employer qualifications (EXPERIENCE_YEARS, DEGREE, CREDENTIAL) are evaluated
  // in deterministic profile-to-job matching, NOT as global deterministic hard gates.
  // Genuine legal work-authorization incompatibility remains an approved global gate.
  const exactRequirements = deterministicRequirements.filter((requirement) =>
    ["WORK_AUTH"].includes(requirement.requirement_type)
  );
  if (exactRequirements.length === 0) return makePass();

  const mismatches: string[] = [];
  const mismatchEvidence: string[] = [];
  for (const requirement of exactRequirements) {
    if (isRequirementOptional(requirement)) {
      continue;
    }

    let comparison = compareStructuredRequirement(requirement, profileFacts, answerContext ?? undefined);
    if (comparison.status === "UNKNOWN" && answerContext) {
      if (requirement.requirement_type === "WORK_AUTH"
        && answerContext.overrides.workAuthorizationRegions.length > 0) {
        const answerFact: ComparableFact = {
          id: `verification-answer:${answerContext.answerRevisionId || "unversioned"}`,
          statement: `Verification answer explicitly authorizes work in ${answerContext.overrides.workAuthorizationRegions.join(", ")}.`,
          structured_value: { authorized_regions: answerContext.overrides.workAuthorizationRegions },
          source_type: "PROFILE_FACT",
        };
        comparison = compareStructuredRequirement(requirement, [...profileFacts, answerFact], answerContext ?? undefined);
      }
    }

    if (comparison.status === "MISMATCH") {
      mismatches.push("WORK_AUTHORIZATION_INCOMPATIBLE");
      mismatchEvidence.push(comparison.rationale);
    }
    // An absent profile authorization fact is not a manual-review trigger.
    // Explicit incompatible evidence is handled above; otherwise the remote
    // role advances under the active Singapore authorization policy.
  }

  if (mismatches.length > 0) return makeReject(mismatches, mismatchEvidence);
  return makePass();
}

export async function runHardGates(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    canonicalJobIds?: string[];
    limit?: number;
    reprocess?: boolean;
    /** Optional immutable answer context supplied by a task caller. */
    verificationAnswerContext?: VerificationAnswerContext | null;
    /** Answer revision identity from the task payload; stale revisions are ignored. */
    verificationAnswerRevisionId?: string | null;
    /** Current job-version identity for a revision loaded for one task. */
    verificationJobVersionId?: string | null;
    /** Short alias for callers that already use the jobVersionId name. */
    jobVersionId?: string | null;
    /** Alias retained for direct callers that already use the shorter name. */
    answerContext?: VerificationAnswerContext | null;
  }
): Promise<{ passed: number; hardRejected: number; needsVerification: number; errors: number }> {
  console.log("Starting Hard Gate engine on RAW_STAGED canonical jobs...");
  const pool = clientOrPool || defaultPool;

  let passedCount = 0;
  let rejectedCount = 0;
  let needsVerificationCount = 0;
  let errorCount = 0;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
  const preferenceContext = await resolveWorkspacePreferenceContext(client as pg.PoolClient, ctx, ['stage3']);
  const stage3Preferences: Stage3PolicyPreferences = preferenceContext.stage3 ?? {};
  const pipelineRunId = crypto.randomUUID();
  const policyResolution = await resolveWorkspaceWorkabilityPolicy(client as any, { context: ctx });
  console.log(
    `Hard Gate workability policy: ${policyResolution.source}` +
      `${policyResolution.modeKey ? ` mode=${policyResolution.modeKey}` : ""}` +
      ` hash=${policyResolution.policyHash.slice(0, 12)}`
  );

  const requestedAnswerJobVersionId = options?.verificationJobVersionId
    ?? options?.jobVersionId
    ?? (options?.jobVersionIds?.length === 1 ? options.jobVersionIds[0] : null);
  let answerContext = options?.verificationAnswerContext ?? options?.answerContext ?? null;
  if (!answerContext && options?.verificationAnswerRevisionId) {
    answerContext = await loadVerificationAnswerContext(client as any, {
      context: ctx,
      answerRevisionId: options.verificationAnswerRevisionId,
      jobVersionId: requestedAnswerJobVersionId,
    });
  }
  if (answerContext && !isVerificationAnswerContextApplicable(answerContext, {
    answerRevisionId: options?.verificationAnswerRevisionId,
  })) {
    answerContext = null;
  }

  const reprocess = options?.reprocess === true;
  const params: unknown[] = [ctx.workspaceId, reprocess];
  const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
  const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
  const jobVersionFilter = jobVersionIds.length > 0
    ? `AND jv.id = ANY($${params.push(jobVersionIds)}::uuid[])`
    : "";
  const canonicalJobFilter = canonicalJobIds.length > 0
    ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])`
    : "";
  const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
    ? Number(options?.limit)
    : null;
  const limitClause = limit ? `LIMIT $${params.push(limit)}` : "";

  const { rows: stagedJobs } = await client.query(
    `
      SELECT c.*, jv.description_text, jv.id AS job_version_id,
             jv.source_published_at AS posted_at,
             jv.reposted_at,
             jv.source_updated_at,
             jv.freshness_basis,
             jv.first_seen_at,
             jv.last_seen_at,
             source_observation.compensation_raw
      FROM canonical_jobs c
      JOIN job_versions jv ON jv.id = COALESCE(
        c.latest_job_version_id,
        (
          SELECT jv2.id
          FROM job_versions jv2
          WHERE jv2.workspace_id = $1
            AND jv2.canonical_job_id = c.id
          ORDER BY jv2.observed_at DESC
          LIMIT 1
        )
      )
      LEFT JOIN LATERAL (
        SELECT observation.compensation_raw
        FROM raw_job_observations AS observation
        WHERE observation.workspace_id = jv.workspace_id
          AND observation.job_version_id = jv.id
        ORDER BY observation.retrieved_at DESC, observation.id DESC
        LIMIT 1
      ) AS source_observation ON TRUE
      WHERE c.workspace_id = $1
        AND jv.workspace_id = $1
        AND (
          COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
          OR (
            $2::boolean = TRUE
            AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
          )
        )
        ${jobVersionFilter}
        ${canonicalJobFilter}
      ORDER BY c.created_at ASC, c.id ASC
      ${limitClause}
    `,
    params
  );

  console.log(`Found ${stagedJobs.length} canonical jobs to gate.`);
  try {
    for (const job of stagedJobs) {
      await client.query("BEGIN");
      try {
        const rawJobAdapter = {
          id: job.id,
          title: job.normalized_title,
          company_name: job.company_name,
          source: "canonical",
          raw_description: job.description_text,
          careers_portal_url: job.canonical_url,
          location: job.location,
          workplace_type: job.workplace_type,
          employment_type: job.employment_type,
          compensation_raw: job.compensation_raw
        };
        const jobAnswerContext = answerContext && isVerificationAnswerContextApplicable(answerContext, {
          jobVersionId: job.job_version_id,
        })
          ? answerContext
          : null;
        const freshnessEvaluation = evaluateJobFreshness({
          posted_at: job.posted_at,
          reposted_at: job.reposted_at,
          source_updated_at: job.source_updated_at,
          first_seen_at: job.first_seen_at,
          freshness_basis: job.freshness_basis,
          is_repost: job.freshness_basis === 'REPOSTED_AT',
          posting_identity_is_new: job.freshness_basis === 'NEW_POSTING_ID',
        }, stage3Preferences.freshness);
        await client.query(
          `UPDATE job_versions
           SET job_age_days = COALESCE(job_age_days, $1),
               freshness_score = COALESCE(freshness_score, $2),
               freshness_basis = COALESCE(freshness_basis, $3),
               freshness_confidence = COALESCE(freshness_confidence, $4)
           WHERE workspace_id = $5 AND id = $6`,
          [
            freshnessEvaluation.job_age_days,
            freshnessEvaluation.job_age_days === null ? null : freshnessEvaluation.freshness_score,
            freshnessEvaluation.job_age_days === null ? 'UNKNOWN' : freshnessEvaluation.freshness_basis,
            freshnessEvaluation.job_age_days === null ? null : freshnessEvaluation.freshness_confidence === 'HIGH' ? 100 : 50,
            ctx.workspaceId,
            job.job_version_id,
          ]
        );

        const { rows: requirementRows } = await client.query(
          `SELECT jr.requirement_key, jr.requirement_type, jr.importance, jr.requirement_text, jr.quote_text, jr.structured_value
           FROM job_versions jv
           JOIN job_requirements jr
             ON jr.workspace_id = jv.workspace_id
            AND (
              (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
              OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
            )
           WHERE jv.workspace_id = $1
             AND jv.id = $2
             AND jr.status = 'VALIDATED'
           ORDER BY jr.requirement_key ASC`,
          [ctx.workspaceId, job.job_version_id]
        );

        const deterministicRequirements = requirementRows as PersistedRequirement[];
        let profileFacts: ComparableFact[] = [];
        if (deterministicRequirements.some((requirement) =>
          ["WORK_AUTH"].includes(requirement.requirement_type)
        )) {
          const { rows: activeProfileRows } = await client.query<{ id: string }>(
            `SELECT id
             FROM profile_versions
             WHERE workspace_id = $1
               AND status = 'ACTIVE'
             ORDER BY created_at DESC
             LIMIT 1`,
            [ctx.workspaceId]
          );
          const activeProfileVersionId = activeProfileRows[0]?.id ?? null;
          const { rows: profileFactRows } = await client.query(
            `SELECT pf.id, pf.statement, pf.structured_value
             FROM profile_facts pf
             WHERE pf.workspace_id = $1
               AND pf.fact_type <> 'CONTACT'
             ${activeProfileVersionId ? "AND pf.profile_version_id = $2" : "AND FALSE"}`,
            activeProfileVersionId ? [ctx.workspaceId, activeProfileVersionId] : [ctx.workspaceId]
          );
          profileFacts = profileFactRows as ComparableFact[];
        }
        const requirementHints = deterministicRequirements
          .map((r) => r.quote_text || r.requirement_text)
          .filter(Boolean)
          .slice(0, 60)
          .join("\n");

        if (normalizeWorkMode(rawJobAdapter.workplace_type) === "UNKNOWN") {
          const enriched = await enrichWorkModeIfNeeded(client, ctx, {
            canonical_job_id: job.id,
            job_version_id: job.job_version_id,
            canonical_url: job.canonical_url,
            workplace_type: job.workplace_type,
            location: job.location,
            description_text: job.description_text,
          });
          if (enriched.workplace_type !== "UNKNOWN") {
            rawJobAdapter.workplace_type = enriched.workplace_type;
            await client.query(
              `UPDATE canonical_jobs
               SET workplace_type = $1, updated_at = NOW()
               WHERE workspace_id = $2 AND id = $3`,
              [enriched.workplace_type, ctx.workspaceId, job.id]
            );
          }
        }

        const globalGateResult = applyGlobalGates({
          ...(rawJobAdapter as any),
          raw_description: requirementHints
            ? `${rawJobAdapter.raw_description}\n\n---\nExtracted requirements:\n${requirementHints}`
            : rawJobAdapter.raw_description,
        } as any, policyResolution.policy, jobAnswerContext);
        const persistedGateResult = applyPersistedRequirementGates(
          {
            title: rawJobAdapter.title,
            company_name: rawJobAdapter.company_name,
            employment_type: rawJobAdapter.employment_type,
            workplace_type: rawJobAdapter.workplace_type,
            location: rawJobAdapter.location,
            description: rawJobAdapter.raw_description,
            posted_at: job.posted_at,
            reposted_at: job.reposted_at,
            source_updated_at: job.source_updated_at,
            freshness_basis: job.freshness_basis,
            compensation_raw: rawJobAdapter.compensation_raw,
          },
          deterministicRequirements,
          policyResolution.policy,
          jobAnswerContext,
          stage3Preferences
        );
        const exactProfileGateResult = applyExactProfileGates(
          deterministicRequirements,
          profileFacts,
          jobAnswerContext,
        );
        const gateResult = combineGateResults([globalGateResult, persistedGateResult, exactProfileGateResult]);

        let processingStatus: string;
        switch (gateResult.status) {
          case "HARD_REJECT":
            processingStatus = "HARD_REJECTED";
            rejectedCount++;
            break;
          case "NEEDS_VERIFICATION":
            processingStatus = "NEEDS_VERIFICATION";
            needsVerificationCount++;
            break;
          default:
            processingStatus = "PREQUALIFIED";
            passedCount++;
        }

        // Update canonical job with gate outcome + structured workability facts + evidence
        await client.query(
          `UPDATE canonical_jobs
           SET gate_decision      = $1::varchar,
               processing_state   = $2,
               processing_status  = $2,
               rejection_reason   = $3,
               gate_evidence_quotes = $4,
               workability_facts  = $5,
               workplace_type = CASE WHEN $1::varchar = 'PASS' AND ($5::jsonb->>'workplace_type') = 'ASSUMED_HYBRID' THEN 'ASSUMED_HYBRID' ELSE workplace_type END,
               primary_lane = CASE WHEN $8::boolean THEN NULL ELSE primary_lane END,
               secondary_lanes = CASE WHEN $8::boolean THEN NULL ELSE secondary_lanes END,
               lane_confidence = CASE WHEN $8::boolean THEN NULL ELSE lane_confidence END,
               lane_evidence = CASE WHEN $8::boolean THEN NULL ELSE lane_evidence END,
               semantic_score = CASE WHEN $8::boolean THEN 0.0 ELSE semantic_score END,
               deterministic_match_score = CASE WHEN $8::boolean THEN NULL ELSE deterministic_match_score END,
               deterministic_match_coverage = CASE WHEN $8::boolean THEN NULL ELSE deterministic_match_coverage END,
               latest_match_run_id = CASE WHEN $8::boolean THEN NULL ELSE latest_match_run_id END,
               latest_lane_decision_id = CASE WHEN $8::boolean THEN NULL ELSE latest_lane_decision_id END,
               latest_deterministic_decision_id = CASE WHEN $8::boolean THEN NULL ELSE latest_deterministic_decision_id END,
               recommendation_eligibility = CASE WHEN $8::boolean THEN NULL ELSE recommendation_eligibility END,
               recommendation_outcome = CASE WHEN $8::boolean THEN NULL ELSE recommendation_outcome END,
               recommendation_requirement_score = CASE WHEN $8::boolean THEN NULL ELSE recommendation_requirement_score END,
               recommendation_coverage_score = CASE WHEN $8::boolean THEN NULL ELSE recommendation_coverage_score END,
               recommendation_evidence_completeness = CASE WHEN $8::boolean THEN NULL ELSE recommendation_evidence_completeness END,
               recommendation_decided_at = CASE WHEN $8::boolean THEN NULL ELSE recommendation_decided_at END,
               updated_at         = NOW()
           WHERE workspace_id = $6
             AND id = $7`,
          [
            gateResult.status,
            processingStatus,
            gateResult.rejection_codes.length > 0 ? gateResult.rejection_codes.join(", ") : null,
            JSON.stringify(gateResult.evidence_quotes),
            JSON.stringify(gateResult.workability_facts),
            ctx.workspaceId,
            job.id,
            reprocess
          ]
        );

        // Validate the complete audit envelope before writing the immutable row.
        const persistedGateDecision = PersistedGateDecisionSchema.parse({
          schema_version: GATE_VERSION,
          canonical_job_id: job.id,
          job_version_id: job.job_version_id,
          pipeline_run_id: pipelineRunId,
          gate_version: GATE_VERSION,
          status: gateResult.status,
          rejection_codes: gateResult.rejection_codes,
          evidence_quotes: gateResult.evidence_quotes,
          workability_facts: gateResult.workability_facts,
          evaluated_at: new Date().toISOString(),
        });

        // Write immutable gate_decisions audit row (invariant 6)
        await client.query(
          `INSERT INTO gate_decisions (
             workspace_id,
             canonical_job_id, job_version_id, pipeline_run_id, gate_version,
             decision, rejection_codes, evidence_quotes, workability_facts,
             preference_user_id, preference_context_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            ctx.workspaceId,
            persistedGateDecision.canonical_job_id,
            persistedGateDecision.job_version_id,
            persistedGateDecision.pipeline_run_id,
            persistedGateDecision.gate_version,
            persistedGateDecision.status,
            JSON.stringify(persistedGateDecision.rejection_codes),
            JSON.stringify(persistedGateDecision.evidence_quotes),
            JSON.stringify(persistedGateDecision.workability_facts),
            preferenceContext.contextId ? ctx.userId : null,
            preferenceContext.contextId,
          ]
        );

        await client.query("COMMIT");

        const codeStr = gateResult.rejection_codes.length ? ` [${gateResult.rejection_codes.join(", ")}]` : "";
        console.log(`-> ${job.company_name} - ${job.normalized_title} : ${gateResult.status}${codeStr}`);
      } catch (err) {
        await client.query("ROLLBACK");
        errorCount++;
        console.error(`❌ Failed to gate job ${job.id}:`, err);
      }
    }
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }

  console.log(
    `Hard Gates complete. Passed: ${passedCount}, Hard Rejected: ${rejectedCount}, Needs Verification: ${needsVerificationCount}, Errors: ${errorCount}`
  );
  return {
    passed: passedCount,
    hardRejected: rejectedCount,
    needsVerification: needsVerificationCount,
    errors: errorCount,
  };
}
