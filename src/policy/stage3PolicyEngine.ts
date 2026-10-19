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
  is_repost?: boolean;
}

export interface FreshnessEvaluationResult {
  status: 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';
  job_age_days: number | null;
  freshness_score: number;
  freshness_basis: 'REPOSTED_AT' | 'POSTED_AT' | 'SOURCE_UPDATED_AT' | 'FIRST_SEEN_AT' | 'NO_DATE';
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

  // Use genuine repost date if credible evidence exists
  if (input.reposted_at && input.is_repost !== false) {
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

  // Fall back to source_updated_at
  if (!effectiveDate && input.source_updated_at) {
    const parsed = new Date(input.source_updated_at);
    if (!isNaN(parsed.getTime())) {
      effectiveDate = parsed;
      basis = 'SOURCE_UPDATED_AT';
      confidence = 'MEDIUM';
    }
  }

  // If no date is available, do not fabricate an age; return UNKNOWN
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

  // 60-Day Hard Gate: age > 60 days -> GATE_STALE_POSTING
  if (ageDays > policy.max_posting_age_days) {
    return {
      status: 'STALE',
      job_age_days: ageDays,
      freshness_score: 0,
      freshness_basis: basis,
      freshness_confidence: confidence,
      is_hard_reject: true,
      rejection_code: 'GATE_STALE_POSTING',
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
  travel_pct?: number;
}

export interface MobilityEvaluationResult {
  remote_from_singapore: boolean;
  temporary_abroad_allowed: boolean;
  work_from_anywhere: boolean;
  timezone_compatibility_score: number;
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

  // Check for explicit foreign territory restrictions that exclude Singapore (e.g. "US residents only", "must reside in US")
  const hasUsOnlyRestriction =
    /\b(us only|must reside in (the )?(us|usa|united states)|authorized to work in the us only|us citizenship required)\b/i.test(text);

  const hasEuropeOnlyRestriction =
    /\b(eu only|must reside in (the )?(eu|europe|uk)|uk residents only)\b/i.test(text);

  const isExplicitlyIneligibleForSingapore =
    /\b(not eligible for (international or )?singapore|excludes (international or )?singapore)\b/i.test(text);

  const singaporeExplicitlyEligible =
    (/\b(singapore|apac|worldwide|any location|global)\b/i.test(text) &&
      !isExplicitlyIneligibleForSingapore);

  if (
    isExplicitlyIneligibleForSingapore ||
    (hasUsOnlyRestriction && !singaporeExplicitlyEligible) ||
    (hasEuropeOnlyRestriction && !singaporeExplicitlyEligible)
  ) {
    return {
      remote_from_singapore: false,
      temporary_abroad_allowed: false,
      work_from_anywhere: false,
      timezone_compatibility_score: 0,
      remote_freedom_score: 0,
      is_workable: false,
      is_hard_reject: true,
      rejection_code: 'UNWORKABLE_LOCATION_MODEL',
      evidence: 'Job specifies strict geographic hiring restriction excluding Singapore employment.',
    };
  }

  const remoteFromSingapore = isExplicitRemote;

  // 2. Check temporary work abroad allowance
  const temporaryAbroadAllowed =
    /\b(work from anywhere|temporary (work|remote) abroad|nomad|global mobility|remote weeks)\b/i.test(text);

  // 3. Check true work-from-anywhere
  const workFromAnywhere =
    /\b(work from anywhere|hire anywhere|any location|global remote|worldwide|anywhere in the world)\b/i.test(text);

  // 4. Timezone compatibility scoring
  let timezoneScore: number = policy.timezone_preferences.APAC ?? 100; // Default 100
  let tzEvidence = 'APAC / Singapore compatible timezone';

  const requiresUsWestHours =
    /\b(pst hours|pacific time|california hours|us west overlap|san francisco hours)\b/i.test(text);
  const requiresUsEastHours =
    /\b(est hours|eastern time|new york hours|us east overlap)\b/i.test(text);
  const requiresEuropeanHours =
    /\b(cet hours|european hours|gmt hours|uk overlap|bst hours)\b/i.test(text);

  if (requiresUsWestHours) {
    timezoneScore = policy.timezone_preferences.US_WEST ?? 20; // 20 (Poor fit)
    tzEvidence = 'Mandatory daily US Pacific (PST/PDT) working hours overlap required';
  } else if (requiresUsEastHours) {
    timezoneScore = policy.timezone_preferences.US_EAST ?? 60; // 60 (Acceptable)
    tzEvidence = 'US Eastern working hours overlap required';
  } else if (requiresEuropeanHours) {
    timezoneScore = policy.timezone_preferences.EUROPE ?? 100; // 100 (Excellent)
    tzEvidence = 'European working hours overlap (convenient SG afternoon/evening match)';
  }

  // 5. Remote freedom composite score (0-100)
  // Highest: Remote from SG + temporary abroad allowed + high timezone compatibility
  let remoteFreedomScore = 40;
  if (remoteFromSingapore && temporaryAbroadAllowed) {
    remoteFreedomScore = 100;
  } else if (remoteFromSingapore) {
    remoteFreedomScore = 85;
  } else if (isHybrid && /\bsingapore\b/i.test(text)) {
    remoteFreedomScore = 50; // Accepted, lower preference
  } else if (input.workplace_type === 'ONSITE') {
    remoteFreedomScore = 10;
  }

  // Factor in timezone compatibility
  remoteFreedomScore = Math.round(remoteFreedomScore * 0.7 + timezoneScore * 0.3);

  return {
    remote_from_singapore: remoteFromSingapore,
    temporary_abroad_allowed: temporaryAbroadAllowed,
    work_from_anywhere: workFromAnywhere,
    timezone_compatibility_score: timezoneScore,
    remote_freedom_score: remoteFreedomScore,
    is_workable: true,
    is_hard_reject: false,
    evidence: `Remote from SG: ${remoteFromSingapore}, Timezone score: ${timezoneScore} (${tzEvidence}), Remote Freedom: ${remoteFreedomScore}.`,
  };
}

// ============================================================================
// 3. Compensation Thresholds by Opportunity Category
// ============================================================================

export interface JobCompensationInput {
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  is_startup?: boolean;
}

export interface CompensationEvaluationResult {
  status: 'TARGET_MET' | 'ACCEPTABLE' | 'BELOW_FLOOR' | 'UNKNOWN';
  salary_annual_sgd: number | null;
  is_hard_reject: boolean;
  prevents_apply_now: boolean;
  rejection_code?: string;
  evidence: string;
}

export function evaluateCompensationPolicy(
  input: JobCompensationInput,
  category: OpportunityCategory = 'COMMERCIAL',
  policy: CompensationPolicy = CompensationPolicySchema.parse({})
): CompensationEvaluationResult {
  if (input.salary_min === null || input.salary_min === undefined) {
    return {
      status: 'UNKNOWN',
      salary_annual_sgd: null,
      is_hard_reject: false,
      prevents_apply_now: false,
      evidence: 'Compensation was not disclosed in the vacancy.',
    };
  }

  // Convert to annual SGD equivalent (simple baseline: USD ~ 1.35, EUR ~ 1.45, GBP ~ 1.70, SGD = 1.0)
  let multiplier = 1.0;
  const currency = (input.salary_currency || 'SGD').toUpperCase();
  if (currency === 'USD') multiplier = 1.35;
  else if (currency === 'EUR') multiplier = 1.45;
  else if (currency === 'GBP') multiplier = 1.70;

  const annualSgd = input.salary_min * multiplier;

  // Startup cash floor rule: cash salary < SGD 10,000/month (< SGD 120,000/year) is unacceptable
  if (input.is_startup && annualSgd < 120000) {
    return {
      status: 'BELOW_FLOOR',
      salary_annual_sgd: annualSgd,
      is_hard_reject: false,
      prevents_apply_now: true,
      rejection_code: 'COMPENSATION_BELOW_USER_FLOOR',
      evidence: `Startup cash compensation of SGD ${Math.round(annualSgd).toLocaleString()} is below the required SGD 10,000/month (SGD 120,000/year) cash floor.`,
    };
  }

  let minThreshold = policy.commercial_min_annual_sgd;
  let targetThreshold = policy.commercial_target_annual_sgd;

  if (category === 'UNIVERSITY_RESEARCH') {
    minThreshold = policy.university_research_min_annual_sgd;
    targetThreshold = policy.university_research_min_annual_sgd;
  } else if (category === 'MISSION_MULTILATERAL') {
    minThreshold = policy.mission_multilateral_min_annual_sgd;
    targetThreshold = policy.mission_multilateral_min_annual_sgd;
  }

  if (annualSgd < minThreshold) {
    return {
      status: 'BELOW_FLOOR',
      salary_annual_sgd: annualSgd,
      is_hard_reject: false,
      prevents_apply_now: true,
      rejection_code: 'COMPENSATION_BELOW_USER_FLOOR',
      evidence: `Annual compensation SGD ${Math.round(annualSgd).toLocaleString()} is below the user floor of SGD ${minThreshold.toLocaleString()} for ${category} opportunities.`,
    };
  }

  return {
    status: annualSgd >= targetThreshold ? 'TARGET_MET' : 'ACCEPTABLE',
    salary_annual_sgd: annualSgd,
    is_hard_reject: false,
    prevents_apply_now: false,
    evidence: `Annual compensation SGD ${Math.round(annualSgd).toLocaleString()} meets or exceeds floor (min: ${minThreshold}, target: ${targetThreshold}).`,
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

  // Check allowed exceptions first (e.g. EPAM)
  for (const exc of policy.allowed_exceptions) {
    if (normCompany.includes(exc.toLowerCase())) {
      return { is_excluded: false };
    }
  }

  // 1. Check explicit named employer exclusions (AIA, Mercer, Great Eastern, Big 4, TCS, etc.)
  for (const excluded of policy.excluded_employers) {
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

  // 2. Check staffing agency / third-party recruitment agency employment
  // Important distinction: recruiter introducing direct client role is OK; employment THROUGH agency is excluded
  const isAgencyEmployment =
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

  for (const target of policy.watchlist_companies) {
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

  let bonus = 0;
  if (isNamed) bonus += 25;
  if (matchedCategories.length > 0) bonus += Math.min(25, matchedCategories.length * 10);

  return {
    is_named_watchlist: isNamed,
    matched_name: matchedName,
    matched_categories: matchedCategories,
    watchlist_bonus_score: bonus,
  };
}

// ============================================================================
// 6. Employment Stability Scoring
// ============================================================================

export interface EmploymentStabilityInput {
  employment_type?: string;
  company_stage?: string;
  is_startup?: boolean;
  operating_history_years?: number;
  singapore_payroll?: boolean;
}

export function computeEmploymentStabilityScore(
  input: EmploymentStabilityInput,
  policy: EmploymentStructurePreferences = EmploymentStructurePreferencesSchema.parse({})
): number {
  let score = 50; // Neutral baseline

  const type = (input.employment_type || '').toUpperCase();
  if (type.includes('PERMANENT') || type.includes('FULL_TIME')) score += 25;
  else if (type.includes('CONTRACT_LONG') || type.includes('12_MONTHS')) score += 15;
  else if (type.includes('CONTRACT')) score += 5;

  if (input.singapore_payroll !== false) score += 15;
  if (input.operating_history_years && input.operating_history_years >= 5) score += 10;
  if (input.company_stage === 'SERIES_C_PLUS' || input.company_stage === 'PUBLIC') score += 15;
  else if (input.is_startup) score -= 10;

  return Math.max(0, Math.min(100, score));
}
