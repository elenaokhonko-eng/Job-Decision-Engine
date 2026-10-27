/**
 * Stage 3 Policy Engine: Mobility, Compensation, Freshness & Employer Watchlist
 *
 * Implements deterministic evaluations for:
 * 1. Authoritative Job Freshness Curve & 60-Day Hard Gate
 * 2. Mobility Matching (Remote from SG, Temporary Abroad, Timezone Compatibility)
 * 3. Compensation Thresholds by Opportunity Category
 * 4. Employer Exclusions & Staffing Agency Filter
 * 5. Target Company Watchlist & Category Recognition
 * 6. Employment Stability Scoring
 */

import {
  type FreshnessPolicy,
  type MobilityPreferences,
  type CompensationPolicy,
  type EmployerWatchlistPreferences,
  type EmploymentStructurePreferences,
  type CompanyStage,
  type CompanyStagePreferences,
  type OpportunityCategory,
  FreshnessPolicySchema,
  MobilityPreferencesSchema,
  CompensationPolicySchema,
  EmployerWatchlistPreferencesSchema,
  EmploymentStructurePreferencesSchema,
} from './stage3Contracts.js';

// ============================================================================
// 1. Freshness Evaluation & 60-Day Hard Gate
// ============================================================================

export interface JobFreshnessInput {
  posted_at?: string | Date | null;
  reposted_at?: string | Date | null;
  source_updated_at?: string | Date | null;
  first_seen_at?: string | Date | null;
  freshness_basis?: string | null;
  is_repost?: boolean;
  posting_identity_is_new?: boolean;
}

export interface FreshnessEvaluationResult {
  status: 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';
  job_age_days: number | null;
  freshness_score: number;
  freshness_basis: 'REPOSTED_AT' | 'POSTED_AT' | 'NEW_POSTING_ID' | 'NO_DATE';
  freshness_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  is_hard_reject: boolean;
  rejection_code?: string;
  evidence: string;
}

export function evaluateJobFreshness(
  input: JobFreshnessInput,
  policy: FreshnessPolicy = FreshnessPolicySchema.parse({}),
  asOf: Date = new Date()
): FreshnessEvaluationResult {
  let effectiveDate: Date | null = null;
  let basis: FreshnessEvaluationResult['freshness_basis'] = 'NO_DATE';
  let confidence: FreshnessEvaluationResult['freshness_confidence'] = 'LOW';

  if (input.freshness_basis === 'NEW_POSTING_ID' && input.posting_identity_is_new === true && !input.reposted_at) {
    return {
      status: 'UNKNOWN',
      job_age_days: null,
      freshness_score: 50,
      freshness_basis: 'NEW_POSTING_ID',
      freshness_confidence: 'MEDIUM',
      is_hard_reject: false,
      evidence: 'A distinct authoritative ATS posting identity indicates a new posting instance; exact age remains unknown because no publication timestamp was supplied.',
    };
  }

  // A repost date is authoritative only when the ingestion source has marked it as a genuine repost.
  if (input.reposted_at && input.is_repost === true) {
    const parsed = new Date(input.reposted_at);
    if (!isNaN(parsed.getTime())) {
      effectiveDate = parsed;
      basis = 'REPOSTED_AT';
      confidence = 'HIGH';
    }
  }

  // Fall back to authoritative posted_at
  if (!effectiveDate && input.posted_at) {
    const parsed = new Date(input.posted_at);
    if (!isNaN(parsed.getTime())) {
      effectiveDate = parsed;
      basis = 'POSTED_AT';
      confidence = 'HIGH';
    }
  }

  // source_updated_at and first_seen_at are observation metadata, not posting timestamps.
  // They must never make an old vacancy appear fresh.

  // If no authoritative posting/reposting date is available, preserve UNKNOWN age.
  if (!effectiveDate) {
    return {
      status: 'UNKNOWN',
      job_age_days: null,
      freshness_score: 50, // Neutral score for unverified age
      freshness_basis: 'NO_DATE',
      freshness_confidence: 'LOW',
      is_hard_reject: false,
      evidence: 'No authoritative posting date or ATS timestamp available.',
    };
  }

  const ageMs = asOf.getTime() - effectiveDate.getTime();
  const ageDays = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));

  // Apply the per-user hard gate only when an active preference version configures it.
  if (
    policy.max_posting_age_days !== undefined &&
    ageDays > policy.max_posting_age_days
  ) {
    const shouldHardReject = policy.stale_gate_disposition === 'HARD_REJECT';
    return {
      status: 'STALE',
      job_age_days: ageDays,
      freshness_score: 0,
      freshness_basis: basis,
      freshness_confidence: confidence,
      is_hard_reject: shouldHardReject,
      rejection_code: shouldHardReject ? 'GATE_STALE_POSTING' : undefined,
      evidence: `Authoritative job posting age of ${ageDays} days exceeds the ${policy.max_posting_age_days}-day limit.`,
    };
  }

  // Freshness Curve:
  // 0–3 days   = 100
  // 4–7 days   = 90
  // 8–14 days  = 80
  // 15–30 days = 60
  // 31–45 days = 40
  // 46–60 days = 20
  let score = 20;
  if (ageDays <= 3) score = 100;
  else if (ageDays <= 7) score = 90;
  else if (ageDays <= 14) score = 80;
  else if (ageDays <= 30) score = 60;
  else if (ageDays <= 45) score = 40;
  else score = 20;

  return {
    status: ageDays <= 14 ? 'FRESH' : 'AGING',
    job_age_days: ageDays,
    freshness_score: score,
    freshness_basis: basis,
    freshness_confidence: confidence,
    is_hard_reject: false,
    evidence: `Authoritative posting age is ${ageDays} days (basis: ${basis}).`,
  };
}

// ============================================================================
// 2. Mobility Matching & Timezone Compatibility
// ============================================================================

export interface JobMobilityInput {
  workplace_type?: string;
  description?: string;
  location?: string;
  required_overlap_hours?: string;
  office_days_per_week?: number | null;
  travel_pct?: number | null;
}

export interface MobilityEvaluationResult {
  remote_from_home_base: boolean;
  remote_from_home_base_status: 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';
  temporary_abroad_allowed: boolean;
  temporary_work_abroad_status: 'ALLOWED' | 'NOT_ALLOWED' | 'UNKNOWN';
  work_from_anywhere: boolean;
  work_from_anywhere_status: 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';
  remote_from_home_base_score: number | null;
  temporary_abroad_score: number | null;
  country_flexibility_score: number | null;
  office_requirement_score: number | null;
  timezone_compatibility_score: number | null;
  remote_freedom_score: number;
  is_workable: boolean;
  is_hard_reject: boolean;
  rejection_code?: string;
  evidence: string;
}

export function evaluateMobilityMatch(
  input: JobMobilityInput,
  policy: MobilityPreferences = MobilityPreferencesSchema.parse({})
): MobilityEvaluationResult {
  const text = `${input.description || ''} ${input.location || ''} ${input.workplace_type || ''}`.toLowerCase();

  // 1. Check if workplace is hybrid vs fully remote
  const isHybrid =
    (input.workplace_type || '').toUpperCase().includes('HYBRID') ||
    /\bhybrid\b/i.test(text);

  const isExplicitRemote =
    !isHybrid &&
    (/\b(fully remote|100% remote|remote-first)\b/i.test(text) ||
      ((input.workplace_type || '').toUpperCase().includes('REMOTE') && !isHybrid) ||
      (/\bremote\b/i.test(text) && !/\b(hybrid|office \d|days? in (the )?office)\b/i.test(text)));

  const homeBase = policy.employment_home_base?.trim() || null;
  const homeBaseLower = homeBase?.toLowerCase() || '';
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const explicitlyIneligibleForHomeBase = homeBase
    ? new RegExp(`\\b(?:not eligible for|excludes|does not hire|cannot employ)\\b[^.!?]{0,100}\\b${escapeRegExp(homeBaseLower)}\\b`, 'i').test(text)
    : false;
  const requiredResidency = text.match(/\b(?:must reside in|residents? of|based in)\s+(?:the\s+)?([a-z][a-z -]{1,40})/i);
  const residencyTerritory = requiredResidency?.[1]?.trim().replace(/\s+(?:only|and|with|for|to|who).*$/i, '') || null;
  const residencyMismatch = Boolean(
    policy.requires_residency_in_home_base === true &&
    homeBaseLower &&
    residencyTerritory &&
    !residencyTerritory.includes(homeBaseLower) &&
    !homeBaseLower.includes(residencyTerritory)
  );

  if (explicitlyIneligibleForHomeBase || residencyMismatch) {
    return {
      remote_from_home_base: false,
      remote_from_home_base_status: 'UNSUPPORTED',
      temporary_abroad_allowed: false,
      temporary_work_abroad_status: 'UNKNOWN',
      work_from_anywhere: false,
      work_from_anywhere_status: 'UNSUPPORTED',
      remote_from_home_base_score: 0,
      temporary_abroad_score: null,
      country_flexibility_score: 0,
      office_requirement_score: null,
      timezone_compatibility_score: null,
      remote_freedom_score: 0,
      is_workable: false,
      is_hard_reject: true,
      rejection_code: 'UNWORKABLE_LOCATION_MODEL',
      evidence: `Job specifies a geographic hiring restriction incompatible with the configured home base${homeBase ? ` (${homeBase})` : ''}.`,
    };
  }

  const workFromAnywhere = /\b(work from anywhere|hire anywhere|any location|global remote|worldwide|anywhere in the world)\b/i.test(text);
  const explicitHomeBaseEligibility = homeBase !== null && (
    new RegExp(`\\b(remote from|remote in|hire in|eligible in|based in)\\s+(?:the\\s+)?${escapeRegExp(homeBaseLower)}\\b`, 'i').test(text) ||
    (isHybrid && text.includes(homeBaseLower)) ||
    (workFromAnywhere && policy.accept_country_list_remote === true)
  );
  const remoteFromHomeBaseStatus: MobilityEvaluationResult['remote_from_home_base_status'] =
    explicitHomeBaseEligibility ? 'SUPPORTED' : isExplicitRemote ? 'UNKNOWN' : 'UNKNOWN';
  const remoteFromHomeBase = remoteFromHomeBaseStatus === 'SUPPORTED';

  const temporaryAbroadPositive = /\b(temporary\s+(?:work|remote)(?:\s+work)?\s+abroad|work\s+(?:temporarily\s+)?from\s+abroad|work from other countries|remote weeks abroad|global mobility benefit)\b/i.test(text);
  const temporaryAbroadNegative = /\b(no work (?:allowed )?abroad|must work only in (?:the )?home country|work from (?:the )?home country only|cannot work outside)\b/i.test(text);
  const temporaryWorkAbroadStatus: MobilityEvaluationResult['temporary_work_abroad_status'] = temporaryAbroadPositive
    ? 'ALLOWED'
    : temporaryAbroadNegative ? 'NOT_ALLOWED' : 'UNKNOWN';
  const temporaryAbroadAllowed = temporaryWorkAbroadStatus === 'ALLOWED';
  const explicitlyCountryRestricted = /\b(?:country[- ]specific hiring only|residents? only|must reside in|authorized to work only in)\b/i.test(text);
  let workFromAnywhereStatus: MobilityEvaluationResult['work_from_anywhere_status'] = 'UNKNOWN';
  if (workFromAnywhere) workFromAnywhereStatus = 'SUPPORTED';
  else if (explicitlyCountryRestricted) workFromAnywhereStatus = 'UNSUPPORTED';

  const timezonePreferences = policy.timezone_preferences;
  let timezoneScore: number | null = null;
  let tzEvidence = 'Required timezone overlap not disclosed';
  const requiresUsWestHours = /\b(pst hours|pacific time|california hours|us west overlap|san francisco hours)\b/i.test(text);
  const requiresUsEastHours = /\b(est hours|eastern time|new york hours|us east overlap)\b/i.test(text);
  const requiresEuropeanHours = /\b(cet hours|european hours|gmt hours|uk overlap|bst hours)\b/i.test(text);
  if (requiresUsWestHours) {
    timezoneScore = timezonePreferences?.US_WEST ?? 50;
    tzEvidence = 'US Pacific working hours overlap explicitly required';
  } else if (requiresUsEastHours) {
    timezoneScore = timezonePreferences?.US_EAST ?? 50;
    tzEvidence = 'US Eastern working hours overlap explicitly required';
  } else if (requiresEuropeanHours) {
    timezoneScore = timezonePreferences?.EUROPE ?? 50;
    tzEvidence = 'European working hours overlap explicitly required';
  } else if (/\b(apac|singapore|asia[- ]pacific) working hours\b/i.test(text)) {
    timezoneScore = timezonePreferences?.APAC ?? 50;
    tzEvidence = 'APAC working hours overlap explicitly required';
  }

  const officeDaysFromText = text.match(/\b(\d)\s+days?\s+(?:per\s+week\s+)?(?:in|at)\s+(?:the\s+)?office\b/i)
    ?? text.match(/\boffice\s+(\d)\s+days?\s+(?:per\s+week\b)?/i);
  const officeDays = input.office_days_per_week ?? (officeDaysFromText ? Number(officeDaysFromText[1]) : null);
  const officeRequirementScore = officeDays === null
    ? isExplicitRemote ? 100 : null
    : Math.max(0, Math.min(100, 100 - officeDays * 20));
  const remoteFromHomeBaseScore = remoteFromHomeBaseStatus === 'SUPPORTED' ? 100 : null;
  const temporaryAbroadScore = temporaryWorkAbroadStatus === 'ALLOWED'
    ? 100
    : temporaryWorkAbroadStatus === 'NOT_ALLOWED' ? 0 : null;
  const countryFlexibilityScore = workFromAnywhereStatus === 'SUPPORTED'
    ? 100
    : workFromAnywhereStatus === 'UNSUPPORTED'
      ? 0
      : explicitHomeBaseEligibility ? 50 : null;

  // Weighted user desirability is neutral (50) for every unreported optional signal.
  const hasMobilityPreference =
    policy.employment_home_base !== undefined ||
    policy.preferred_work_mode !== undefined ||
    policy.temporary_foreign_work_days_per_year !== undefined ||
    policy.timezone_preferences !== undefined ||
    policy.hybrid_sg_1_3_days !== undefined;
  const remoteFreedomScore = hasMobilityPreference
    ? Math.round(
        (remoteFromHomeBaseScore ?? 50) * 0.4 +
        (temporaryAbroadScore ?? 50) * 0.25 +
        (countryFlexibilityScore ?? 50) * 0.15 +
        (officeRequirementScore ?? 50) * 0.1 +
        (timezoneScore ?? 50) * 0.1
      )
    : 50;

  return {
    remote_from_home_base: remoteFromHomeBase,
    remote_from_home_base_status: remoteFromHomeBaseStatus,
    temporary_abroad_allowed: temporaryAbroadAllowed,
    temporary_work_abroad_status: temporaryWorkAbroadStatus,
    work_from_anywhere: workFromAnywhere,
    work_from_anywhere_status: workFromAnywhereStatus,
    remote_from_home_base_score: remoteFromHomeBaseScore,
    temporary_abroad_score: temporaryAbroadScore,
    country_flexibility_score: countryFlexibilityScore,
    office_requirement_score: officeRequirementScore,
    timezone_compatibility_score: timezoneScore,
    remote_freedom_score: remoteFreedomScore,
    is_workable: true,
    is_hard_reject: false,
    evidence: `Home-base remote status: ${remoteFromHomeBaseStatus}; temporary work abroad: ${temporaryWorkAbroadStatus}; work-from-anywhere: ${workFromAnywhereStatus}; timezone evidence: ${tzEvidence}.`,
  };
}

// ============================================================================
// 3. Compensation Thresholds by Opportunity Category
// ============================================================================

export function inferOpportunityCategory(
  companyName: string,
  _title: string,
  _description: string,
  organizationType?: string | null,
): OpportunityCategory | null {
  const identity = `${companyName} ${organizationType ?? ""}`.toLowerCase();
  if (/\b(university|college|polytechnic|academic institution|research institute)\b/i.test(identity)) {
    return "UNIVERSITY_RESEARCH";
  }
  if (/\b(world bank|united nations|unicef|undp|unhcr|international finance corporation|intergovernmental organization)\b/i.test(identity)) {
    return "MISSION_MULTILATERAL";
  }
  return null;
}

export type SalaryPeriod = "ANNUAL" | "MONTHLY" | "HOURLY" | "UNKNOWN";
export type SalaryComponentType = "BASE_CASH" | "VARIABLE_CASH" | "EQUITY" | "OTHER";
export type SalaryBasis = "GROSS" | "NET" | "UNKNOWN";

export interface JobCompensationInput {
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  salary_period?: SalaryPeriod | null;
  salary_basis?: SalaryBasis;
  component_type?: SalaryComponentType;
  guaranteed_hours_per_week?: number | null;
  paid_weeks_per_year?: number | null;
  currency_to_sgd_rate?: number | null;
  fx_rate_date?: string | null;
  fx_rate_source?: string | null;
  fx_rate_observation_id?: string | null;
  is_startup?: boolean;
}

export interface CompensationEvaluationResult {
  status: "TARGET_MET" | "ACCEPTABLE" | "BELOW_FLOOR" | "UNKNOWN";
  salary_annual_sgd: number | null;
  salary_annual_sgd_max: number | null;
  applied_floor_sgd: number | null;
  opportunity_category: OpportunityCategory | "UNKNOWN";
  fx_rate_observation_id: string | null;
  is_hard_reject: boolean;
  prevents_apply_now: boolean;
  rejection_code?: string;
  evidence: string;
}

function parseSalaryAmount(value: string): number | null {
  const normalized = value.replace(/,/g, "").trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([kK])?$/);
  if (!match) return null;
  const amount = Number(match[1]) * (match[2] ? 1000 : 1);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

const BASE_CASH_TEXT_PATTERN = /\b(base salary|base pay|base cash|guaranteed base(?: salary| cash)?)\b/i;

function normalizedCompensationText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\u00a0/g, " ").trim();
}

function baseCashSegments(raw: string | null | undefined): string[] {
  return normalizedCompensationText(raw)
    .split(/[;|\n]+/)
    .filter((segment) => BASE_CASH_TEXT_PATTERN.test(segment));
}

export function isBaseSalaryExplicitlyUndisclosed(raw: string | null | undefined): boolean {
  return baseCashSegments(raw).some((segment) => {
    const match = segment.match(BASE_CASH_TEXT_PATTERN);
    if (!match || match.index === undefined) return false;
    const disclosure = segment.slice(match.index + match[0].length);
    return /^\s*(?:[:=-]\s*)?(?:(?:is|was)\s+)?\(?\s*(?:competitive|undisclosed|not\s+disclosed|unknown|n\/?a)\b/i.test(disclosure);
  });
}

function parseCompensationSegment(
  raw: string | null | undefined,
  structured: Partial<JobCompensationInput> = {},
): JobCompensationInput | null {
  const text = normalizedCompensationText(raw);
  if (/^(unknown|undisclosed|competitive|not disclosed|n\/?a)$/i.test(text)) return null;
  const segments = baseCashSegments(text);
  const explicitlyBaseCash = segments.length > 0;
  const baseCashSegment = segments[0];
  const variableCompensationPattern = /\b(bonus|commission|ote|on[- ]target|variable|equity|stock|rsu|options?)\b/i;
  const variableStart = baseCashSegment?.search(variableCompensationPattern) ?? -1;
  const salaryText = baseCashSegment
    ? variableStart >= 0 ? baseCashSegment.slice(0, variableStart) : baseCashSegment
    : text;
  const explicitCurrency = salaryText.match(/\b(SGD|USD|EUR|GBP|AUD|CAD|HKD|MYR|JPY)\b|S\$|US\$/i)?.[0].toUpperCase();
  const salaryCurrency = structured.salary_currency?.toUpperCase()
    ?? (explicitCurrency === "S$" ? "SGD" : explicitCurrency === "US$" ? "USD" : explicitCurrency ?? null);
  const periodText = `${salaryText} ${structured.salary_period ?? ""}`.toLowerCase();
  const salaryPeriod: SalaryPeriod = structured.salary_period
    ?? (/\b(hourly|per\s+hour|\/\s*hour|per\s+hr)\b/i.test(periodText)
      ? "HOURLY"
      : /\b(monthly|per\s+month|a\s+month|\/\s*month)\b/i.test(periodText)
        ? "MONTHLY"
        : /\b(annual|annually|yearly|per\s+year|per\s+annum|\/\s*year)\b/i.test(periodText)
          ? "ANNUAL"
          : "UNKNOWN");
  const currencyToken = String.raw`(?:SGD|USD|EUR|GBP|AUD|CAD|HKD|MYR|JPY|S\$|US\$|\$)`;
  const amountToken = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*[kK]?`;
  const rangeMatch = salaryText.match(new RegExp(String.raw`(?:^|[^A-Z0-9])(?:${currencyToken}\s*)?(${amountToken})\s*(?:-|–|to)\s*(?:${currencyToken}\s*)?(${amountToken})`, "i"));
  const singleMatch = rangeMatch ? null : salaryText.match(new RegExp(String.raw`(?:^|[^A-Z0-9])(?:${currencyToken}\s*)?(${amountToken})`, "i"));
  const rangeMin = rangeMatch ? parseSalaryAmount(rangeMatch[1]) : null;
  const rangeMax = rangeMatch ? parseSalaryAmount(rangeMatch[2]) : null;
  const singleAmount = singleMatch ? parseSalaryAmount(singleMatch[1]) : null;
  const salaryMin = structured.salary_min ?? rangeMin ?? singleAmount ?? null;
  const salaryMax = structured.salary_max ?? rangeMax ?? singleAmount ?? salaryMin;
  const componentType = structured.component_type
    ?? (explicitlyBaseCash
      ? "BASE_CASH"
      : /\b(equity|stock|rsu|options?)\b/i.test(text)
        ? "EQUITY"
        : /\b(ote|on[- ]target|commission|bonus|variable)\b/i.test(text)
          ? "VARIABLE_CASH"
          : "BASE_CASH");
  const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:guaranteed\s+)?hours?\s*(?:per|a|\/)\s*week/i);
  const basis: SalaryBasis = structured.salary_basis
    ?? (/\bnet\b/i.test(salaryText) ? "NET" : /\bgross\b/i.test(salaryText) ? "GROSS" : "UNKNOWN");
  if (salaryMin === null && salaryMax === null) return null;
  return {
    ...structured,
    salary_min: salaryMin,
    salary_max: salaryMax,
    salary_currency: salaryCurrency,
    salary_period: salaryPeriod,
    salary_basis: basis,
    component_type: componentType,
    guaranteed_hours_per_week: structured.guaranteed_hours_per_week ?? (hoursMatch ? Number(hoursMatch[1]) : null),
  };
}

function annualizeSalaryValue(input: JobCompensationInput, value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (input.salary_period === "ANNUAL") return Math.round(value);
  if (input.salary_period === "MONTHLY") return Math.round(value * 12);
  return null;
}

function sameBaseSalaryDisclosure(left: JobCompensationInput, right: JobCompensationInput): boolean {
  if (left.salary_currency !== right.salary_currency || left.salary_basis !== right.salary_basis) return false;
  if (left.salary_period === right.salary_period) {
    return left.salary_min === right.salary_min && left.salary_max === right.salary_max;
  }
  const leftMinimum = annualizeSalaryValue(left, left.salary_min);
  const leftMaximum = annualizeSalaryValue(left, left.salary_max);
  const rightMinimum = annualizeSalaryValue(right, right.salary_min);
  const rightMaximum = annualizeSalaryValue(right, right.salary_max);
  return leftMinimum !== null && leftMaximum !== null &&
    rightMinimum !== null && rightMaximum !== null &&
    Math.abs(leftMinimum - rightMinimum) <= 1 && Math.abs(leftMaximum - rightMaximum) <= 1;
}

export function hasConflictingBaseSalaryDisclosures(raw: string | null | undefined): boolean {
  const segments = baseCashSegments(raw);
  if (segments.some((segment) =>
    (segment.match(new RegExp(BASE_CASH_TEXT_PATTERN.source, "gi"))?.length ?? 0) > 1
  )) return true;
  if (segments.length < 2) return false;

  const parsed = segments.map((segment) => parseCompensationSegment(segment));
  const supported = parsed.filter((item): item is JobCompensationInput => item !== null);
  if (supported.length === 0) return false;
  if (supported.length !== parsed.length) return true;

  const reference = supported[0];
  return supported.some((item) => !sameBaseSalaryDisclosure(item, reference));
}

export function parseCompensationEvidence(
  raw: string | null | undefined,
  structured: Partial<JobCompensationInput> = {},
): JobCompensationInput | null {
  if (hasConflictingBaseSalaryDisclosures(raw)) return null;
  const segments = baseCashSegments(raw);
  return parseCompensationSegment(segments.length > 1 ? segments[0] : raw, structured);
}

export function evaluateCompensationPolicy(
  input: JobCompensationInput,
  category: OpportunityCategory | null = null,
  policy: CompensationPolicy = CompensationPolicySchema.parse({}),
  asOf: Date = new Date(),
): CompensationEvaluationResult {
  const categoryName = category ?? "UNKNOWN";
  const unknown = (evidence: string, annualMin: number | null = null, annualMax: number | null = null, floor: number | null = null): CompensationEvaluationResult => ({
    status: "UNKNOWN",
    salary_annual_sgd: annualMin,
    salary_annual_sgd_max: annualMax,
    applied_floor_sgd: floor,
    opportunity_category: categoryName,
    fx_rate_observation_id: input.fx_rate_observation_id ?? null,
    is_hard_reject: false,
    prevents_apply_now: true,
    evidence,
  });

  if (input.component_type && input.component_type !== "BASE_CASH") {
    return unknown("Variable pay, OTE, equity, or non-base compensation is not counted as guaranteed base cash.");
  }
  const salaryMinimum = input.salary_min ?? null;
  const salaryMaximum = input.salary_max ?? salaryMinimum;
  if ((salaryMinimum === null && salaryMaximum === null) || !input.salary_period || input.salary_period === "UNKNOWN") {
    return unknown("A guaranteed salary amount or pay period is unknown; no floor decision was inferred.");
  }
  if (!policy.target_salary_basis || !input.salary_basis || input.salary_basis === "UNKNOWN" || input.salary_basis !== policy.target_salary_basis) {
    return unknown("Gross/net salary basis is missing or does not match the active compensation preference; no conversion was assumed.");
  }

  const currency = (input.salary_currency ?? "").toUpperCase();
  let conversionRate: number | null = currency === "SGD" ? 1 : input.currency_to_sgd_rate ?? null;
  if (currency !== "SGD") {
    const rateDate = input.fx_rate_date ? new Date(input.fx_rate_date) : null;
    const rateAgeDays = rateDate && Number.isFinite(rateDate.getTime())
      ? Math.abs(asOf.getTime() - rateDate.getTime()) / (24 * 60 * 60 * 1000)
      : Number.POSITIVE_INFINITY;
    if (input.fx_rate_source !== "FRANKFURTER" || rateAgeDays > (policy.fx_rate_max_age_days ?? 7)) {
      conversionRate = null;
    }
  }
  if (conversionRate === null || !Number.isFinite(conversionRate) || conversionRate <= 0) {
    return unknown(`Compensation currency ${currency || "UNKNOWN"} has no current, source-attributed SGD rate.`);
  }

  let annualizationFactor = input.salary_period === "MONTHLY" ? 12 : 1;
  if (input.salary_period === "HOURLY") {
    if (!input.guaranteed_hours_per_week || !input.paid_weeks_per_year) {
      return unknown("Hourly compensation cannot be annualized without guaranteed weekly hours and paid weeks per year.");
    }
    annualizationFactor = input.guaranteed_hours_per_week * input.paid_weeks_per_year;
  }
  const annualMin = salaryMinimum === null ? null : Math.round(salaryMinimum * annualizationFactor * conversionRate);
  const annualMax = salaryMaximum === null ? null : Math.round(salaryMaximum * annualizationFactor * conversionRate);

  let minThreshold: number | undefined;
  let targetThreshold: number | undefined;
  if (category === "UNIVERSITY_RESEARCH") {
    minThreshold = policy.university_research_min_annual_sgd;
  } else if (category === "MISSION_MULTILATERAL") {
    minThreshold = policy.mission_multilateral_min_annual_sgd;
  } else {
    minThreshold = policy.commercial_min_annual_sgd;
    if (category === "COMMERCIAL") targetThreshold = policy.commercial_target_annual_sgd;
  }
  const configuredFloor = input.is_startup
    ? Math.max(minThreshold ?? 0, (policy.startup_min_cash_salary_monthly_sgd ?? 0) * 12)
    : minThreshold ?? 0;
  if (configuredFloor <= 0) {
    return unknown("No active compensation floor is configured for this opportunity category.", annualMin, annualMax);
  }

  if (annualMax !== null && category === null && annualMax < configuredFloor) {
    return unknown("Opportunity category is not verified; no discounted floor was applied and a below-floor conflict cannot be confirmed.", annualMin, annualMax, configuredFloor);
  }
  if (annualMax !== null && annualMax < configuredFloor) {
    const disposition = policy.disposition_below_floor ?? "WARN";
    return {
      status: "BELOW_FLOOR",
      salary_annual_sgd: annualMin,
      salary_annual_sgd_max: annualMax,
      applied_floor_sgd: configuredFloor,
      opportunity_category: categoryName,
      fx_rate_observation_id: input.fx_rate_observation_id ?? null,
      is_hard_reject: disposition === "HARD_REJECT",
      prevents_apply_now: disposition === "HARD_REJECT" || disposition === "PREVENT_APPLY_NOW",
      rejection_code: "COMPENSATION_BELOW_USER_FLOOR",
      evidence: `Maximum guaranteed base cash SGD ${Math.round(annualMax).toLocaleString()} is below the configured SGD ${configuredFloor.toLocaleString()} floor for ${categoryName}${input.is_startup && policy.startup_min_cash_salary_monthly_sgd !== undefined ? `; startup monthly cash floor is SGD ${policy.startup_min_cash_salary_monthly_sgd.toLocaleString()}` : ""}.`,
    };
  }
  if (annualMin === null || annualMax === null) {
    return unknown("A minimum guaranteed base-cash bound is missing; compensation cannot be confirmed as meeting the configured floor.", annualMin, annualMax, configuredFloor);
  }
  if (annualMin < configuredFloor) {
    return unknown(`Guaranteed base-cash range SGD ${annualMin.toLocaleString()}–${annualMax.toLocaleString()} straddles the configured SGD ${configuredFloor.toLocaleString()} floor; eligibility depends on the eventual offer.`, annualMin, annualMax, configuredFloor);
  }

  return {
    status: targetThreshold !== undefined && annualMin >= targetThreshold ? "TARGET_MET" : "ACCEPTABLE",
    salary_annual_sgd: annualMin,
    salary_annual_sgd_max: annualMax,
    applied_floor_sgd: configuredFloor,
    opportunity_category: categoryName,
    fx_rate_observation_id: input.fx_rate_observation_id ?? null,
    is_hard_reject: false,
    prevents_apply_now: false,
    evidence: `Guaranteed base cash SGD ${Math.round(annualMin).toLocaleString()}–${Math.round(annualMax).toLocaleString()} meets the configured SGD ${configuredFloor.toLocaleString()} floor${targetThreshold === undefined ? "" : `; target is SGD ${targetThreshold.toLocaleString()}`}.`,
  };
}

// ============================================================================
// 4. Employer Exclusions & Staffing Agency Filter
// ============================================================================

export interface EmployerExclusionResult {
  is_excluded: boolean;
  rejection_code?: string;
  reason?: string;
  matched_employer?: string;
  matched_model?: string;
}

export function evaluateEmployerExclusions(
  companyName: string,
  description: string = '',
  policy: EmployerWatchlistPreferences = EmployerWatchlistPreferencesSchema.parse({})
): EmployerExclusionResult {
  const normCompany = companyName.trim().toLowerCase();
  const desc = description.toLowerCase();

  // Check allowed exceptions first (e.g. per-user exception entries)
  for (const exc of policy.allowed_exceptions ?? []) {
    if (normCompany.includes(exc.toLowerCase())) {
      return { is_excluded: false };
    }
  }

  // 1. Check explicit named employer exclusions (AIA, Mercer, Great Eastern, Big 4, TCS, etc.)
  for (const excluded of policy.excluded_employers ?? []) {
    const normExcluded = excluded.toLowerCase();
    // Word boundary check
    const regex = new RegExp(`(^|[^a-z0-9])${normExcluded}([^a-z0-9]|$)`, 'i');
    if (regex.test(normCompany)) {
      return {
        is_excluded: true,
        rejection_code: 'GATE_EXCLUDED_EMPLOYER',
        reason: `Employer "${companyName}" matches explicit user exclusion list (${excluded}).`,
        matched_employer: excluded,
      };
    }
  }

  // 2. Exclude staffing models only when the active user policy explicitly excludes them.
  // A recruiter introducing a direct role is not treated as the legal employer.
  const excludedModels = new Set(policy.excluded_operating_models ?? []);
  const isAgencyEmployment =
    excludedModels.has('STAFFING_AGENCY_EMPLOYMENT') &&
    /\b(employed by|contracted through|on our agency payroll|placement on behalf of our client)\b/i.test(desc) &&
    /\b(staffing agency|recruitment agency|third-party payroll)\b/i.test(desc);

  if (isAgencyEmployment) {
    return {
      is_excluded: true,
      rejection_code: 'GATE_EXCLUDED_EMPLOYER',
      reason: 'Role involves employment through a third-party recruitment/staffing agency rather than direct company employment.',
      matched_model: 'STAFFING_AGENCY_EMPLOYMENT',
    };
  }

  // 3. Check client-leasing / body-shopping outsourcing model
  const isBodyShopping =
    excludedModels.has('CLIENT_LEASING_BODYSHOPPING_OUTSOURCING') &&
    /\b(billable client engagements|client billable hours|deployed across multiple client projects)\b/i.test(desc) &&
    /\b(outsourcing|consulting services|body shopping|it staff augmentation)\b/i.test(desc);

  if (isBodyShopping) {
    return {
      is_excluded: true,
      rejection_code: 'GATE_EXCLUDED_EMPLOYER',
      reason: 'Role operates on a client-leasing / body-shopping model spreading staff across multiple client engagements.',
      matched_model: 'CLIENT_LEASING_BODYSHOPPING_OUTSOURCING',
    };
  }

  return { is_excluded: false };
}

// ============================================================================
// 5. Target Company Watchlist & Category Recognition
// ============================================================================

export interface WatchlistMatchResult {
  is_named_watchlist: boolean;
  matched_name?: string;
  matched_categories: string[];
  watchlist_bonus_score: number;
}

export function evaluateEmployerWatchlist(
  companyName: string,
  description: string = '',
  policy: EmployerWatchlistPreferences = EmployerWatchlistPreferencesSchema.parse({})
): WatchlistMatchResult {
  const normCompany = companyName.toLowerCase();
  const desc = description.toLowerCase();

  let isNamed = false;
  let matchedName: string | undefined;

  for (const target of policy.watchlist_companies ?? []) {
    if (normCompany.includes(target.toLowerCase())) {
      isNamed = true;
      matchedName = target;
      break;
    }
  }

  const matchedCategories: string[] = [];
  if (/\b(developer infrastructure|devtools|infra for developers)\b/i.test(desc)) {
    matchedCategories.push('DEVELOPER_INFRASTRUCTURE');
  }
  if (/\b(database|postgres|vector database|data platform)\b/i.test(desc)) {
    matchedCategories.push('DATABASE_DATA_PLATFORMS');
  }
  if (/\b(foundation model|llm provider|frontier model)\b/i.test(desc)) {
    matchedCategories.push('AI_FOUNDATION_MODELS');
  }
  if (/\b(agentic ai|multi-agent|autonomous agents)\b/i.test(desc)) {
    matchedCategories.push('AGENTIC_AI_INFRASTRUCTURE');
  }
  if (/\b(legaltech|access to justice|compliance automation)\b/i.test(desc)) {
    matchedCategories.push('LEGALTECH');
  }
  if (/\b(scientific computing|bioinformatics|genomics|research technology)\b/i.test(desc)) {
    matchedCategories.push('RESEARCH_TECHNOLOGY');
  }
  if (/\b(market data|investment technology|asset management software)\b/i.test(desc)) {
    matchedCategories.push('MARKET_INVESTMENT_TECHNOLOGY');
  }

  let bonus = isNamed ? 25 : 0;
  const userPreferredCategories = new Set<string>(policy.preferred_categories ?? []);
  const matchedPreferredCategoryCount = matchedCategories.filter((category) => userPreferredCategories.has(category)).length;
  if (matchedPreferredCategoryCount > 0) {
    bonus += Math.min(25, matchedPreferredCategoryCount * 10);
  }

  return {
    is_named_watchlist: isNamed,
    matched_name: matchedName,
    matched_categories: matchedCategories,
    watchlist_bonus_score: bonus,
  };
}

// ============================================================================
// 6. Remote-Employer Discovery Signals
// ============================================================================

export type RemoteEmployerSignal =
  | 'REMOTE_FIRST'
  | 'DISTRIBUTED_TEAM'
  | 'ASYNC_WORK'
  | 'WORK_FROM_ANYWHERE'
  | 'INTERNATIONAL_HIRING'
  | 'EOR_SUPPORTED'
  | 'SINGAPORE_ELIGIBLE'
  | 'APAC_REMOTE';

export interface RemoteEmployerSignalEvidence {
  readonly signal: RemoteEmployerSignal;
  readonly quote: string;
  readonly distinction: 'WORKPLACE_MARKETING' | 'HIRING_ELIGIBILITY' | 'GEOGRAPHY_SCOPE';
}

const REMOTE_EMPLOYER_SIGNAL_PATTERNS: ReadonlyArray<{
  signal: RemoteEmployerSignal;
  pattern: RegExp;
  distinction: RemoteEmployerSignalEvidence['distinction'];
}> = [
  { signal: 'REMOTE_FIRST', pattern: /\bremote[- ]first\b/i, distinction: 'WORKPLACE_MARKETING' },
  { signal: 'DISTRIBUTED_TEAM', pattern: /\bdistributed (?:team|workforce|company)\b/i, distinction: 'WORKPLACE_MARKETING' },
  { signal: 'ASYNC_WORK', pattern: /\b(?:async|asynchronous)(?:[- ]first)?\b/i, distinction: 'WORKPLACE_MARKETING' },
  { signal: 'WORK_FROM_ANYWHERE', pattern: /\b(?:work from anywhere|anywhere in the world|global remote)\b/i, distinction: 'GEOGRAPHY_SCOPE' },
  { signal: 'INTERNATIONAL_HIRING', pattern: /\b(?:hire internationally|international hiring|employ in multiple countries)\b/i, distinction: 'HIRING_ELIGIBILITY' },
  { signal: 'EOR_SUPPORTED', pattern: /\b(?:employer of record|\bEOR\b)\b/i, distinction: 'HIRING_ELIGIBILITY' },
  { signal: 'SINGAPORE_ELIGIBLE', pattern: /\b(?:Singapore eligible|hire in Singapore|employ in Singapore|Singapore-based employees)\b/i, distinction: 'HIRING_ELIGIBILITY' },
  { signal: 'APAC_REMOTE', pattern: /\b(?:APAC remote|remote across APAC|hire across APAC)\b/i, distinction: 'GEOGRAPHY_SCOPE' },
];

export function classifyRemoteEmployerSignals(text: string): RemoteEmployerSignalEvidence[] {
  return REMOTE_EMPLOYER_SIGNAL_PATTERNS.flatMap(({ signal, pattern, distinction }) => {
    const match = pattern.exec(text);
    return match ? [{ signal, quote: match[0], distinction }] : [];
  });
}

// ============================================================================
// 7. Employment Stability Scoring
// ============================================================================

export interface EmploymentStabilityInput {
  stability_type?: 'PERMANENT' | 'STARTUP_SALARY_EQUITY' | 'LONG_CONTRACT' | 'CONTRACTOR';
  employment_structure?: 'SG_EMPLOYEE' | 'EOR_EMPLOYEE' | 'DIRECT_OVERSEAS_EMPLOYEE' | 'OWN_COMPANY_CONSULTANT' | 'INDIVIDUAL_CONTRACTOR';
  operating_history_years?: number | null;
  company_stage?: 'PUBLIC' | 'PROFITABLE_SCALEUP' | 'SERIES_C_PLUS' | 'SERIES_A_B' | 'EARLY_STARTUP' | 'UNKNOWN';
}

export function computeEmploymentStabilityScore(
  input: EmploymentStabilityInput,
  policy: EmploymentStructurePreferences = EmploymentStructurePreferencesSchema.parse({})
): number {
  const ranking = policy.stability_ranking;
  if (!input.stability_type || !ranking || ranking.length === 0) return 50;

  const rankIndex = ranking.indexOf(input.stability_type);
  if (rankIndex < 0) return 50;
  const rankScore = ranking.length <= 1
    ? 100
    : Math.round(100 - (rankIndex / (ranking.length - 1)) * 60);

  // Employer maturity is supporting evidence, never a standalone hard gate.
  if (input.company_stage === 'UNKNOWN' || input.company_stage === undefined) return rankScore;
  if (input.company_stage === 'PUBLIC' || input.company_stage === 'PROFITABLE_SCALEUP') {
    return Math.min(100, rankScore + 5);
  }
  if (input.company_stage === 'EARLY_STARTUP') return Math.max(0, rankScore - 5);
  return rankScore;
}

export type CompanyStageEvidenceSource =
  | 'OFFICIAL_COMPANY_SOURCE'
  | 'OFFICIAL_REGULATORY_SOURCE'
  | 'OFFICIAL_JOB_POSTING'
  | 'USER_REPORTED'
  | 'MEDIA_REPORTING'
  | 'ANECDOTAL_REVIEW';

export interface CompanyStageEvidence {
  readonly stage: CompanyStage;
  readonly confidence: number | null;
  readonly source: CompanyStageEvidenceSource;
}

export interface CompanyStageEvaluationResult {
  readonly status: 'PREFERRED' | 'CONDITIONAL' | 'EXCLUDED' | 'UNSPECIFIED' | 'UNKNOWN';
  readonly score: number | null;
  readonly preventsApplyNow: boolean;
  readonly isHardReject: false;
  readonly evidence: string;
}

const TRUSTED_COMPANY_STAGE_SOURCES: ReadonlySet<CompanyStageEvidenceSource> = new Set([
  'OFFICIAL_COMPANY_SOURCE',
  'OFFICIAL_REGULATORY_SOURCE',
]);

export function evaluateCompanyStagePreference(
  evidence: CompanyStageEvidence,
  preferences: CompanyStagePreferences = {}
): CompanyStageEvaluationResult {
  if (
    evidence.stage === 'UNKNOWN' ||
    evidence.confidence === null ||
    evidence.confidence < 80 ||
    !TRUSTED_COMPANY_STAGE_SOURCES.has(evidence.source)
  ) {
    return {
      status: 'UNKNOWN',
      score: null,
      preventsApplyNow: false,
      isHardReject: false,
      evidence: 'Company maturity evidence is missing, low-confidence, or not from an authoritative source.',
    };
  }

  if (preferences.excluded?.includes(evidence.stage)) {
    return {
      status: 'EXCLUDED',
      score: 0,
      preventsApplyNow:
        evidence.stage !== 'UNDERFUNDED_EARLY_STARTUP' ||
        preferences.underfunded_startup_prevents_apply_now === true,
      isHardReject: false,
      evidence: `Authoritative company-stage evidence identifies an excluded stage (${evidence.stage}).`,
    };
  }
  if (preferences.preferred?.includes(evidence.stage)) {
    return {
      status: 'PREFERRED',
      score: 90,
      preventsApplyNow: false,
      isHardReject: false,
      evidence: `Authoritative company-stage evidence identifies a preferred stage (${evidence.stage}).`,
    };
  }
  if (preferences.conditional?.includes(evidence.stage)) {
    return {
      status: 'CONDITIONAL',
      score: 65,
      preventsApplyNow: false,
      isHardReject: false,
      evidence: `Authoritative company-stage evidence identifies a conditional stage (${evidence.stage}).`,
    };
  }
  return {
    status: 'UNSPECIFIED',
    score: 50,
    preventsApplyNow: false,
    isHardReject: false,
    evidence: `Company stage is known (${evidence.stage}) but is not configured as preferred, conditional, or excluded.`,
  };
}

export type EmploymentVerifiabilityFactor =
  | 'payroll_consistency'
  | 'employment_structure'
  | 'income_period'
  | 'company_maturity';

export interface EmploymentVerifiabilitySignal {
  readonly score: number;
  readonly confidence: number;
  readonly source: CompanyStageEvidenceSource;
}

export interface EmploymentVerifiabilityResult {
  readonly score: number | null;
  readonly availableFactors: readonly EmploymentVerifiabilityFactor[];
  readonly evidence: string;
}

const EMPLOYMENT_VERIFIABILITY_WEIGHTS: Readonly<Record<EmploymentVerifiabilityFactor, number>> = {
  payroll_consistency: 35,
  employment_structure: 35,
  income_period: 15,
  company_maturity: 15,
};
const EMPLOYMENT_VERIFIABILITY_FACTORS: ReadonlySet<string> = new Set(
  Object.keys(EMPLOYMENT_VERIFIABILITY_WEIGHTS)
);

function isEmploymentVerifiabilityFactor(value: string): value is EmploymentVerifiabilityFactor {
  return EMPLOYMENT_VERIFIABILITY_FACTORS.has(value);
}

export function computeEmploymentVerifiabilityScore(
  signals: Partial<Record<EmploymentVerifiabilityFactor, EmploymentVerifiabilitySignal>>
): EmploymentVerifiabilityResult {
  const trustedSignals = Object.entries(signals).flatMap(([factor, signal]) => {
    if (!isEmploymentVerifiabilityFactor(factor)) return [];
    if (
      !signal ||
      !Number.isFinite(signal.score) ||
      signal.score < 0 ||
      signal.score > 100 ||
      !Number.isFinite(signal.confidence) ||
      signal.confidence < 80 ||
      signal.confidence > 100 ||
      signal.source === 'USER_REPORTED' ||
      signal.source === 'MEDIA_REPORTING' ||
      signal.source === 'ANECDOTAL_REVIEW' ||
      (factor === 'payroll_consistency' && signal.source === 'OFFICIAL_JOB_POSTING')
    ) {
      return [];
    }
    return [{ factor, signal }];
  });
  const availableFactors = trustedSignals.map(({ factor }) => factor);
  if (
    !availableFactors.includes('payroll_consistency') ||
    !availableFactors.includes('employment_structure')
  ) {
    return {
      score: null,
      availableFactors,
      evidence: 'Payroll consistency and employment structure both require authoritative evidence; no verifiability score was inferred.',
    };
  }

  const totalWeight = trustedSignals.reduce(
    (total, { factor }) => total + EMPLOYMENT_VERIFIABILITY_WEIGHTS[factor],
    0
  );
  const weightedScore = trustedSignals.reduce(
    (total, { factor, signal }) => total + signal.score * EMPLOYMENT_VERIFIABILITY_WEIGHTS[factor],
    0
  );
  return {
    score: Math.round(weightedScore / totalWeight),
    availableFactors,
    evidence: 'Score reflects only high-confidence payroll, employment-structure, income-period, and company-maturity evidence; it is not a credit or mortgage-approval prediction.',
  };
}
