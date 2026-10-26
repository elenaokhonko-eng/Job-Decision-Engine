import type { VerificationAnswerContext } from "./workabilityPolicy.js";

export interface ComparableRequirement {
  requirement_type: string;
  requirement_text: string;
  quote_text: string | null;
  structured_value: Record<string, unknown> | null;
}

export interface ComparableFact {
  id: string;
  statement: string;
  structured_value: Record<string, unknown> | null;
  source_type?: "PROFILE_FACT" | "CREDENTIAL" | "ENGAGEMENT";
}

interface ExperienceInterval {
  start: number;
  end: number;
}

export type StructuredComparison = {
  status: "MATCH" | "MISMATCH" | "UNKNOWN";
  rationale: string;
  fact: ComparableFact | null;
  coverage?: number;
  requiredYears?: number;
  evidencedYears?: number;
  qualificationCode?: string;
};

export function calculateProfessionalExperienceYears(
  engagements: Array<{ start_date: string | Date; end_date: string | Date | null; is_current: boolean; experience_class: string }>,
  asOf = new Date()
): number {
  const intervals = engagements
    .filter((engagement) => engagement.experience_class === "PROFESSIONAL_PRODUCTION")
    .map((engagement) => {
      const start = new Date(engagement.start_date).getTime();
      const end = engagement.is_current || !engagement.end_date
        ? asOf.getTime()
        : new Date(engagement.end_date).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
    })
    .filter((interval): interval is { start: number; end: number } => interval !== null)
    .sort((left, right) => left.start - right.start);

  let coveredMonths = 0;
  let current: { start: number; end: number } | null = null;
  for (const interval of intervals) {
    if (!current) {
      current = { ...interval };
      continue;
    }
    if (interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end);
    } else {
      coveredMonths += (current.end - current.start) / (1000 * 60 * 60 * 24 * 30.4375);
      current = { ...interval };
    }
  }
  if (current) coveredMonths += (current.end - current.start) / (1000 * 60 * 60 * 24 * 30.4375);
  return coveredMonths / 12;
}

function textForRequirement(requirement: ComparableRequirement): string {
  return [requirement.requirement_text, requirement.quote_text || "", JSON.stringify(requirement.structured_value || {})]
    .join(" ")
    .toLowerCase();
}

function textForFact(fact: ComparableFact): string {
  return [fact.statement, JSON.stringify(fact.structured_value || {})].join(" ").toLowerCase();
}

function normalizeComparableText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function structuredStrings(value: Record<string, unknown> | null): string[] {
  if (!value) return [];
  return Object.entries(value).flatMap(([key, raw]) => {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw.map((item) => `${key}: ${String(item)}`);
    if (typeof raw === "object") return [`${key}: ${JSON.stringify(raw)}`];
    return [`${key}: ${String(raw)}`];
  });
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
};

function parseNumberWord(text: string): number | null {
  const normalized = text.toLowerCase().trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return Number(normalized);
  }
  return NUMBER_WORDS[normalized] ?? null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "string") {
    const parsedWord = parseNumberWord(value);
    if (parsedWord !== null) return parsedWord;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredYears(requirement: ComparableRequirement): number | null {
  const structured = requirement.structured_value || {};
  for (const key of ["minimum_years", "years_required", "min_years", "years"]) {
    const value = numberValue(structured[key]);
    if (value !== null) return value;
  }
  const match = textForRequirement(requirement).match(/(?:at least|minimum of|min\.?|over|more than)\s*(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*years?/i)
    || textForRequirement(requirement).match(/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*years?/i);
  return match ? parseNumberWord(match[1]) : null;
}

function factYears(fact: ComparableFact): number | null {
  const structured = fact.structured_value || {};
  for (const key of ["professional_years", "experience_years", "years", "years_experience"]) {
    const value = numberValue(structured[key]);
    if (value !== null) return value;
  }
  const months = numberValue(structured.professional_months ?? structured.experience_months);
  if (months !== null) return months / 12;
  const match = textForFact(fact).match(/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*years?/i);
  return match ? parseNumberWord(match[1]) : null;
}

function experienceInterval(fact: ComparableFact): ExperienceInterval | null {
  const structured = fact.structured_value;
  if (!structured) return null;
  const startValue = structured.experience_start_date
    ?? structured.engagement_start_date
    ?? structured.start_date;
  const endValue = structured.experience_end_date
    ?? structured.engagement_end_date
    ?? structured.end_date;
  const start = new Date(String(startValue ?? "")).getTime();
  const end = endValue === null || endValue === undefined || structured.is_current === true || structured.engagement_is_current === true
    ? Date.now()
    : new Date(String(endValue)).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end }
    : null;
}

function unionExperienceYears(intervals: ExperienceInterval[]): number {
  if (intervals.length === 0) return 0;
  const ordered = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  let coveredMilliseconds = 0;
  let current = ordered[0];
  for (const interval of ordered.slice(1)) {
    if (interval.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, interval.end) };
    } else {
      coveredMilliseconds += current.end - current.start;
      current = interval;
    }
  }
  coveredMilliseconds += current.end - current.start;
  return coveredMilliseconds / (1000 * 60 * 60 * 24 * 365.25);
}

function normalizedScope(value: unknown): string {
  return normalizeComparableText(value)
    .replace(/\b(roles?|positions?|jobs?|experience|years?|of|in|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function experienceScopes(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const values = [
    record.experience_scope,
    record.experience_scopes,
    record.scope,
    record.domain,
    record.domains,
    record.role_family,
  ];
  return values.flatMap((item) => Array.isArray(item) ? item : [item])
    .map(normalizedScope)
    .filter(Boolean);
}

function requiredExperienceScope(requirement: ComparableRequirement): string | null {
  const structured = experienceScopes(requirement.structured_value);
  if (structured.length > 0) return structured.join(" ");
  const text = textForRequirement(requirement);
  const scoped = text.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*(?:years|yrs)\s+(?:of\s+)?(.+?)\s+experience\b/i)
    || text.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*years?\s+of\s+experience\s+in\s+(.+)$/i);
  return scoped?.[1] ? normalizedScope(scoped[1]) : null;
}

const SCOPE_STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "all", "any", "our", "per",
  "you", "non", "set", "use", "pro", "new", "role", "roles", "work", "team", "teams",
  "such", "than", "more", "most", "each", "both", "must", "have", "plus", "years",
  "year", "experience", "experienced", "skills", "skill", "level", "related", "field",
  "fields", "equivalent", "environment", "environments", "building", "using",
  // Generic qualifiers that do not distinguish specialized domains:
  "engineering", "engineer", "engineers", "development", "developer", "developers",
  "operations", "operator", "management", "manager", "systems", "system",
  "lead", "senior", "junior", "staff", "principal", "architect", "architects",
  "analyst", "analysts", "specialist", "specialists", "consultant", "consultants",
  "technologies", "technology", "tech", "practices", "practice", "solutions", "solution",
  "professional", "services", "service", "tools", "tool", "methods", "method", "processes", "process"
]);

function tokenizeScope(scope: string): Set<string> {
  return new Set(
    scope
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((token) => token.length >= 2 && !SCOPE_STOP_WORDS.has(token))
  );
}

const DOMAIN_FAMILY_PATTERNS: Array<{ domain: string; regex: RegExp }> = [
  { domain: "ai", regex: /\b(ai|artificial intelligence|machine learning|ml|deep learning|nlp|llm|llms|generative ai|genai|computer vision)\b/i },
  { domain: "software", regex: /\b(software|software engineering|software development|application development|coding|full stack|backend|frontend|web development)\b/i },
  { domain: "data", regex: /\b(data|data engineering|data science|analytics|etl|data pipeline|data warehousing|big data|bi|business intelligence)\b/i },
  { domain: "security", regex: /\b(cybersecurity|security|infosec|information security|appsec|soc|penetration testing|threat)\b/i },
  { domain: "cloud_devops", regex: /\b(devops|cloud|site reliability|sre|infrastructure|platform|kubernetes|terraform|aws|gcp|azure)\b/i },
  { domain: "civil", regex: /\b(civil|civil engineering|structural|construction)\b/i },
  { domain: "mechanical", regex: /\b(mechanical|aerospace|automotive)\b/i },
  { domain: "electrical", regex: /\b(electrical|electronics|hardware|semiconductor)\b/i },
  { domain: "supply_chain", regex: /\b(supply chain|logistics|procurement|inventory)\b/i },
  { domain: "finance", regex: /\b(finance|financial|quantitative|trading|accounting|fintech|banking|investment)\b/i },
  { domain: "legal", regex: /\b(legal|regulatory|compliance|regtech|contract law|attorney|lawyer)\b/i },
  { domain: "health", regex: /\b(biomedical|biotech|pharma|healthcare|clinical|medical)\b/i },
];

function detectDomainFamilies(scope: string): Set<string> {
  const families = new Set<string>();
  for (const { domain, regex } of DOMAIN_FAMILY_PATTERNS) {
    if (regex.test(scope)) {
      families.add(domain);
    }
  }
  return families;
}

/**
 * Keep role shape separate from domain family. Architecture, hands-on
 * engineering, research, and technical delivery are transferable but are not
 * interchangeable for a scoped employer requirement.
 */
function detectRoleFamilies(scope: string): Set<string> {
  const normalized = scope.toLowerCase();
  const families = new Set<string>();
  if (/\b(architect(?:ure)?|systems? design)\b/i.test(normalized)) families.add("architecture");
  if (/\b(engineer(?:ing)?|developer|development|coding|implementation|building|hands[- ]on)\b/i.test(normalized)) {
    families.add("engineering");
  }
  if (/\b(research|scientist|scientific)\b/i.test(normalized)) families.add("research");
  if (/\b(program(?:me)?|project|product|delivery|transformation|portfolio)\b/i.test(normalized)) families.add("delivery");
  return families;
}

function scopesOverlap(requiredScope: string, factScope: string): boolean {
  const reqLower = requiredScope.toLowerCase().trim();
  const factLower = factScope.toLowerCase().trim();
  if (!reqLower || !factLower) return true;

  const reqDomains = detectDomainFamilies(reqLower);
  const factDomains = detectDomainFamilies(factLower);

  if (reqDomains.size > 0) {
    const sharesDomain = [...reqDomains].some((domain) => factDomains.has(domain));
    if (!sharesDomain) return false;
  }

  const requiredRoles = detectRoleFamilies(reqLower);
  const factRoles = detectRoleFamilies(factLower);
  if (requiredRoles.size > 0 && factRoles.size > 0) {
    if (![...requiredRoles].some((role) => factRoles.has(role))) return false;
  }

  if (reqDomains.size > 0) return true;

  const requiredTokens = tokenizeScope(reqLower);
  const factTokens = tokenizeScope(factLower);
  if (requiredTokens.size === 0) return true;

  for (const token of requiredTokens) {
    if (factTokens.has(token)) return true;
  }
  return false;
}

interface ExperienceScopeInfo {
  readonly roleFamilies: readonly string[];
  readonly domainFamilies: readonly string[];
  readonly operator: "ANY" | "ALL";
  readonly seniorityScope: string | null;
  readonly durationBasis: string;
}

interface ProfileExperienceInfo {
  readonly fact: ComparableFact;
  readonly years: number;
  readonly roleFamilies: readonly string[];
  readonly domainFamilies: readonly string[];
  readonly seniorityScope: string | null;
  readonly durationBasis: string;
  readonly interval: ExperienceInterval | null;
  readonly aggregationKind: string;
  readonly aggregationGroupId: string | null;
  readonly overlapGroupId: string | null;
  readonly scopeComplete: boolean;
  readonly attestedTotal: boolean;
  readonly attestedComponent: boolean;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function inferExperienceRoleFamilies(text: string): string[] {
  const families = new Set<string>();
  if (/\barchitect(?:ure)?\b/i.test(text)) families.add("ARCHITECTURE");
  if (/\b(ai|machine learning|ml|llm|artificial intelligence)\b/i.test(text)) families.add("AI_ENGINEERING");
  if (/\bdata (?:engineering|engineer|platform)\b/i.test(text)) families.add("DATA_ENGINEERING");
  if (/\b(software\s+(?:engineering|development)|coding|programming|developer|development|engineering|engineer|implementation|hands[- ]on|full[- ]stack|backend|frontend|web development)\b/i.test(text)) {
    families.add("HANDS_ON_SOFTWARE_ENGINEERING");
  }
  if (/\b(research software|research engineer|scientific computing|scientific software)\b/i.test(text)) {
    families.add("RESEARCH_SOFTWARE");
  }
  if (/\b(technical project|technical programme|technical program|technical delivery)\b/i.test(text)) {
    families.add("TECHNICAL_DELIVERY");
  }
  if (/\b(technical product|product management)\b/i.test(text)) families.add("TECHNICAL_PRODUCT");
  if (/\b(sales ownership|quota|prospecting|closing)\b/i.test(text)) families.add("SALES_OWNERSHIP");
  if (/\b(people manager|people management|managed a team)\b/i.test(text)) families.add("PEOPLE_MANAGEMENT");
  return [...families];
}

function inferExperienceDomainFamilies(text: string): string[] {
  const domains = new Set<string>();
  if (/\b(ai|machine learning|ml|llm|artificial intelligence)\b/i.test(text)) domains.add("AI");
  if (/\b(software|coding|programming|developer|development|full[- ]stack|backend|frontend|web development)\b/i.test(text)) domains.add("SOFTWARE");
  if (/\b(data|analytics|etl|data pipeline)\b/i.test(text)) domains.add("DATA");
  if (/\b(legal|regtech|regulatory|compliance technology)\b/i.test(text)) domains.add("LEGAL_REGTECH");
  if (/\b(health|biomedical|biotech|pharma|clinical)\b/i.test(text)) domains.add("HEALTH_BIO_PHARMA");
  if (/\b(investment|financial|fintech|trading|markets)\b/i.test(text)) domains.add("INVESTMENT_MARKETS_FINTECH");
  if (/\b(multilateral|humanitarian|social impact|development sector)\b/i.test(text)) domains.add("SOCIAL_IMPACT_MULTILATERAL");
  if (/\b(university|academic|research)\b/i.test(text)) domains.add("UNIVERSITY_AI_RESEARCH");
  return [...domains];
}

function experienceScopeInfo(requirement: ComparableRequirement): ExperienceScopeInfo {
  const structured = requirement.structured_value ?? {};
  const nested = recordValue(structured.experience_scope_v2) ?? structured;
  const legacyText = experienceScopes(structured).join(" ") || textForRequirement(requirement);
  const roles = stringValues(nested.role_families);
  const domains = stringValues(nested.domain_families);
  return {
    roleFamilies: roles.length > 0 ? roles : inferExperienceRoleFamilies(legacyText),
    domainFamilies: domains.length > 0 ? domains : inferExperienceDomainFamilies(legacyText),
    operator: nested.operator === "ALL" ? "ALL" : "ANY",
    seniorityScope: typeof nested.seniority_scope === "string" ? nested.seniority_scope : null,
    durationBasis: typeof nested.duration_basis === "string" ? nested.duration_basis : "PROFESSIONAL_PRODUCTION",
  };
}

function profileExperienceInfo(fact: ComparableFact): ProfileExperienceInfo | null {
  const structured = fact.structured_value;
  const nested = structured ? recordValue(structured.experience_scope_v2) ?? structured : null;
  const years = factYears(fact);
  if (years === null) return null;
  const text = [fact.statement, ...experienceScopes(structured)].join(" ");
  const basis = typeof nested?.duration_basis === "string"
    ? nested.duration_basis
    : /\b(coursework|classroom|academic project)\b/i.test(text)
      ? "COURSEWORK"
      : structured && (structured.professional_years !== undefined || structured.professional_months !== undefined)
        ? "PROFESSIONAL_PRODUCTION"
        : "UNSPECIFIED";
  const yearsLower = numberValue(nested?.years_lower_bound ?? structured?.years_lower_bound) ?? years;
  const attestation = nested?.attestation_status ?? structured?.attestation_status;
  const evidenceBasis = nested?.evidence_basis ?? structured?.evidence_basis;
  return {
    fact,
    years: yearsLower,
    roleFamilies: stringValues(nested?.role_families).length > 0
      ? stringValues(nested?.role_families)
      : inferExperienceRoleFamilies(text),
    domainFamilies: stringValues(nested?.domain_families).length > 0
      ? stringValues(nested?.domain_families)
      : inferExperienceDomainFamilies(text),
    seniorityScope: typeof nested?.seniority_scope === "string" ? nested.seniority_scope : null,
    durationBasis: basis,
    interval: experienceInterval(fact),
    aggregationKind: typeof nested?.aggregation_kind === "string" ? nested.aggregation_kind : "UNKNOWN",
    aggregationGroupId: typeof nested?.aggregation_group_id === "string" ? nested.aggregation_group_id : null,
    overlapGroupId: typeof nested?.overlap_group_id === "string" ? nested.overlap_group_id : null,
    scopeComplete: nested?.scope_complete_for_profile === true || structured?.scope_complete_for_profile === true,
    attestedTotal: evidenceBasis === "ATTESTED_TOTAL_DURATION"
      && (attestation === "VERIFIED" || attestation === "SELF_ATTESTED"),
    attestedComponent: evidenceBasis === "ATTESTED_COMPONENT_DURATION"
      && (attestation === "VERIFIED" || attestation === "SELF_ATTESTED"),
  };
}

function matchesExperienceScope(
  requirement: ExperienceScopeInfo,
  profile: ProfileExperienceInfo,
): boolean {
  if (requirement.roleFamilies.length > 0) {
    if (profile.roleFamilies.length === 0) return false;
    const matchingRoles = requirement.roleFamilies.filter((role) => profile.roleFamilies.includes(role));
    if (requirement.operator === "ALL" ? matchingRoles.length !== requirement.roleFamilies.length : matchingRoles.length === 0) {
      return false;
    }
  }
  if (requirement.domainFamilies.length > 0) {
    if (!requirement.domainFamilies.some((domain) => profile.domainFamilies.includes(domain))) return false;
  }
  if (requirement.seniorityScope) {
    const profileSeniority = profile.seniorityScope?.toLowerCase() ?? "";
    if (!profileSeniority || !profileSeniority.includes(requirement.seniorityScope.toLowerCase())) return false;
  }
  return true;
}

function degreeLevel(text: string): number | null {
  if (/\b(phd|doctorate|doctoral)\b/i.test(text)) return 3;
  if (/\b(master'?s?|msc|ma|mba)\b/i.test(text)) return 2;
  if (/\b(bachelor'?s?|undergraduate|bsc|ba)\b/i.test(text)) return 1;
  return null;
}

function degreeSubject(text: string): string | null {
  const normalized = normalizeComparableText(text);
  const subjectAliases: Array<[string, string[]]> = [
    ["computer science", ["computer science", "computing", "software engineering", "informatics"]],
    ["data science", ["data science", "analytics", "statistics", "applied statistics"]],
    ["engineering", ["engineering", "electrical engineering", "computer engineering", "systems engineering"]],
    ["mathematics", ["mathematics", "mathematical", "applied mathematics"]],
    ["biology", ["biology", "biological", "biomedical", "biochemistry"]],
    ["finance", ["finance", "financial", "economics", "financial economics"]],
    ["business", ["business administration", "business management", "management"]],
    ["law", ["law", "legal studies", "jurisprudence"]],
  ];
  for (const [canonical, aliases] of subjectAliases) {
    if (aliases.some((alias) => normalized.includes(alias))) return canonical;
  }
  return null;
}

function requirementCredentialIdentifier(requirement: ComparableRequirement): string | null {
  const structured = requirement.structured_value || {};
  const structuredCandidate = [
    structured.credential_id,
    structured.credential_name,
    structured.credential_reference,
    structured.certification,
    structured.license,
    structured.licence,
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  const source = String(structuredCandidate || requirement.quote_text || requirement.requirement_text || "");
  const normalized = normalizeComparableText(source);
  const known = normalized.match(/\b(aws certified [a-z0-9 .+#-]+|cissp|cfa|cpa|pmp|prince2|scrum master|kubernetes|terraform|azure certified [a-z0-9 .+#-]+|google cloud [a-z0-9 .+#-]+)\b/i);
  if (known) return normalizeComparableText(known[1]);
  const genericRemoved = normalized
    .replace(/\b(required|required certification|preferred|certification|certificate|credential|license|licence|holder|must have|or equivalent)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return genericRemoved.length >= 3 ? genericRemoved : null;
}

function factCredentialIdentifiers(fact: ComparableFact): string[] {
  const structured = fact.structured_value || {};
  return [
    fact.statement,
    ...structuredStrings(structured),
  ]
    .map(normalizeComparableText)
    .filter(Boolean);
}

function factExplicitlyLacksCredential(fact: ComparableFact, credential: string): boolean {
  const structured = fact.structured_value || {};
  const negativeFlag = ["has_credential", "credential_present", "possesses_credential", "verified"]
    .some((key) => structured[key] === false);
  if (negativeFlag) return true;
  const text = normalizeComparableText(`${fact.statement} ${JSON.stringify(structured)}`);
  return new RegExp(`\\b(no|not|without|missing|lacks?)\\b[^.]{0,80}\\b${credential.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "i").test(text)
    || new RegExp(`\\b${credential.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b[^.]{0,80}\\b(no|not|without|missing|lacks?)\\b`, "i").test(text);
}

function extractJurisdictions(value: string): string[] {
  const normalized = normalizeComparableText(value);
  const aliases: Array<[string, string[]]> = [
    ["united states", ["united states", "usa", "us"]],
    ["canada", ["canada"]],
    ["united kingdom", ["united kingdom", "uk", "great britain"]],
    ["european union", ["european union", "eu"]],
    ["australia", ["australia"]],
    ["singapore", ["singapore"]],
  ];
  return aliases
    .filter(([, values]) => values.some((alias) => new RegExp(`\\b${alias.replace(/ /g, "\\s+")}\\b`, "i").test(normalized)))
    .map(([canonical]) => canonical);
}

function explicitAuthorizationText(fact: ComparableFact): string {
  const structured = fact.structured_value || {};
  const structuredAuthorization = Object.entries(structured)
    .filter(([key]) => /auth|eligib|jurisdiction|country|visa|citizen|right/i.test(key))
    .map(([, value]) => String(value))
    .join(" ");
  return `${fact.statement} ${structuredAuthorization}`.toLowerCase();
}

export function verificationDegreeSubject(value: string): string | null {
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

export function degreeRequirementSubject(requirement: ComparableRequirement): string | null {
  return verificationDegreeSubject([
    requirement.requirement_text,
    requirement.quote_text || "",
    JSON.stringify(requirement.structured_value || {}),
  ].join(" "));
}

export function removeDegreeSubject(requirement: ComparableRequirement): ComparableRequirement {
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

export function expandExperienceScope(
  requirement: ComparableRequirement,
  domains: string[],
): ComparableRequirement {
  const structured = { ...(requirement.structured_value || {}) };
  const existing = structured.experience_scope ?? structured.experience_scopes ?? structured.scope ?? structured.domain;
  const existingValues = Array.isArray(existing) ? existing : existing ? [existing] : [];
  const expandedScope = [...existingValues, ...domains];
  const expandedText = expandedScope.join(" ");
  const roleFamilies = inferExperienceRoleFamilies(expandedText);
  const acceptedSoftwareDomain = domains.some((domain) => inferExperienceDomainFamilies(domain).includes("SOFTWARE"));
  if (acceptedSoftwareDomain && roleFamilies.includes("AI_ENGINEERING") && !roleFamilies.includes("HANDS_ON_SOFTWARE_ENGINEERING")) {
    roleFamilies.push("HANDS_ON_SOFTWARE_ENGINEERING");
  }
  structured.experience_scope = expandedScope;
  structured.role_families = roleFamilies;
  structured.domain_families = inferExperienceDomainFamilies(expandedText);
  structured.operator = "ANY";
  return { ...requirement, structured_value: structured };
}

export function compareStructuredRequirement(
  requirement: ComparableRequirement,
  facts: ComparableFact[],
  answerContext?: VerificationAnswerContext
): StructuredComparison {
  if (answerContext) {
    if (requirement.requirement_type === "DEGREE" && answerContext.overrides?.degreeSubjects?.length > 0) {
      const subject = degreeRequirementSubject(requirement);
      if (subject && !answerContext.overrides.degreeSubjects.includes(subject)) {
        return {
          status: "MISMATCH",
          rationale: `Verification answer does not accept the required ${subject.replace(/_/g, " ")} degree subject.`,
          fact: null,
          qualificationCode: "MATCH_QUALIFICATION_DEGREE_GAP",
        };
      } else if (subject) {
        requirement = removeDegreeSubject(requirement);
      }
    } else if (requirement.requirement_type === "EXPERIENCE_YEARS"
      && answerContext.overrides?.experienceDomains?.length > 0) {
      requirement = expandExperienceScope(requirement, answerContext.overrides.experienceDomains);
    }
  }

  const requirementText = textForRequirement(requirement);

  if (requirement.requirement_type === "EXPERIENCE_YEARS") {
    const required = requiredYears(requirement);
    if (required === null) return { status: "UNKNOWN", rationale: "Required experience duration is not structured.", fact: null };
    const requiredScope = experienceScopeInfo(requirement);
    const scopeLabel = requiredExperienceScope(requirement) ?? "professional experience";
    const candidates = facts
      .map(profileExperienceInfo)
      .filter((candidate): candidate is ProfileExperienceInfo => candidate !== null)
      .filter((candidate) => candidate.durationBasis === requiredScope.durationBasis)
      .filter((candidate) => matchesExperienceScope(requiredScope, candidate));

    if (candidates.length === 0) {
      return {
        status: "UNKNOWN",
        rationale: `No profile duration with positive evidence for the required role/domain scope: ${scopeLabel}.`,
        fact: null,
      };
    }

    const intervalCandidates = candidates.filter((candidate) => candidate.interval !== null);
    const undatedCandidates = candidates.filter((candidate) => candidate.interval === null);
    const intervalYears = unionExperienceYears(intervalCandidates.flatMap((candidate) => candidate.interval ? [candidate.interval] : []));
    let totalYears = intervalYears;

    if (intervalCandidates.length === 0 && undatedCandidates.length > 0) {
      const aggregateTotals = undatedCandidates.filter((candidate) => candidate.aggregationKind === "AGGREGATE_TOTAL");
      if (aggregateTotals.length > 0) {
        totalYears = Math.max(...aggregateTotals.map((candidate) => candidate.years));
      } else {
        const components = undatedCandidates.filter((candidate) => candidate.aggregationKind === "COMPONENT");
        const provenIndependentComponents = components.length > 0
          && components.every((candidate) => candidate.attestedComponent && candidate.overlapGroupId !== null)
          && new Set(components.map((candidate) => candidate.overlapGroupId)).size === components.length;
        totalYears = provenIndependentComponents
          ? components.reduce((sum, candidate) => sum + candidate.years, 0)
          : Math.max(...undatedCandidates.map((candidate) => candidate.years));
      }
    }

    const representative = [...candidates].sort((left, right) => right.years - left.years)[0];
    const scopeIsComplete = candidates.some((candidate) => candidate.scopeComplete || candidate.attestedTotal);
    const scopeSuffix = ` for ${scopeLabel}`;
    const coverage = required > 0 ? Math.min(1, Math.max(0, totalYears / required)) : 1;
    const evidenceDetails = {
      fact: representative.fact,
      coverage: Number(coverage.toFixed(3)),
      requiredYears: required,
      evidencedYears: Number(totalYears.toFixed(3)),
    };

    if (totalYears >= required) {
      return {
        status: "MATCH",
        rationale: `Supported profile experience ${totalYears.toFixed(1)} years meets the ${required}-year requirement${scopeSuffix}.`,
        ...evidenceDetails,
      };
    }
    if (!scopeIsComplete) {
      return {
        status: "UNKNOWN",
        rationale: `At least ${totalYears.toFixed(1)} years are evidenced${scopeSuffix}, but the experience ledger is not attested complete enough to establish a shortfall against ${required} years.`,
        ...evidenceDetails,
      };
    }
    return {
      status: "MISMATCH",
      rationale: `Attested complete profile experience ${totalYears.toFixed(1)} years is below the ${required}-year requirement${scopeSuffix}.`,
      ...evidenceDetails,
      qualificationCode: "MATCH_QUALIFICATION_EXPERIENCE_GAP",
    };
  }

  if (requirement.requirement_type === "DEGREE") {
    const requiredLevel = degreeLevel(requirementText);
    if (requiredLevel === null) return { status: "UNKNOWN", rationale: "Degree level is not explicit.", fact: null };
    const requiredSubject = degreeSubject(requirementText);
    const matching = facts.find((fact) => {
      const factText = textForFact(fact);
      const level = degreeLevel(factText);
      const factSubject = degreeSubject(factText);
      return level !== null && level >= requiredLevel && (!requiredSubject || factSubject === requiredSubject);
    });
    if (matching) return { status: "MATCH", rationale: "Profile evidence contains the required degree level.", fact: matching };
    const degreeEvidence = facts.find((fact) => degreeLevel(textForFact(fact)) !== null);
    if (requiredSubject && degreeEvidence && facts.every((fact) => {
      if (degreeLevel(textForFact(fact)) === null) return true;
      return degreeSubject(textForFact(fact)) === null;
    })) {
      return {
        status: "UNKNOWN",
        rationale: `Profile degree level is present, but the required ${requiredSubject} subject cannot be verified.`,
        fact: degreeEvidence,
      };
    }
    return degreeEvidence
      ? {
          status: "MISMATCH",
          rationale: requiredSubject
            ? `Profile degree evidence does not meet the required ${requiredSubject} degree level/subject.`
            : "Profile degree evidence does not meet the required degree level.",
          fact: degreeEvidence,
          qualificationCode: "MATCH_QUALIFICATION_DEGREE_GAP",
        }
      : { status: "UNKNOWN", rationale: "No profile degree evidence is available.", fact: null };
  }

  if (requirement.requirement_type === "CREDENTIAL") {
    const specificCredential = requirementCredentialIdentifier(requirement);
    if (!specificCredential) return { status: "UNKNOWN", rationale: "Credential name is not explicit.", fact: null };
    const explicitAbsence = facts.find((fact) => factExplicitlyLacksCredential(fact, specificCredential));
    if (explicitAbsence) {
      return {
        status: "MISMATCH",
        rationale: "Profile evidence explicitly confirms that the required credential is not held.",
        fact: explicitAbsence,
        qualificationCode: "MATCH_QUALIFICATION_MANDATORY_CERT_MISSING",
      };
    }
    const matching = facts.find((fact) => factCredentialIdentifiers(fact).some((value) => value.includes(specificCredential)));
    if (matching) return { status: "MATCH", rationale: "Profile evidence contains the required credential.", fact: matching };
    const credentialEvidence = facts.find((fact) => /certif|license|licence|credential/i.test(textForFact(fact)) || fact.source_type === "CREDENTIAL");
    return credentialEvidence
      ? {
          status: "MISMATCH",
          rationale: "Profile credential evidence does not match the required credential.",
          fact: credentialEvidence,
          qualificationCode: "MATCH_QUALIFICATION_MANDATORY_CERT_MISSING",
        }
      : { status: "UNKNOWN", rationale: "No profile credential evidence is available.", fact: null };
  }

  if (requirement.requirement_type === "WORK_AUTH") {
    const jurisdictions = extractJurisdictions(requirementText);
    if (jurisdictions.length === 0) return { status: "UNKNOWN", rationale: "Work authorization jurisdiction is not explicit.", fact: null };
    const authorizationFacts = facts
      .map((fact) => ({ fact, text: explicitAuthorizationText(fact), jurisdictions: extractJurisdictions(explicitAuthorizationText(fact)) }))
      .filter((candidate) => /authori[sz]|work rights|eligible to work|right to work|citizen|permanent resident|visa/i.test(candidate.text));
    const matching = authorizationFacts.find((candidate) => jurisdictions.some((jurisdiction) => candidate.jurisdictions.includes(jurisdiction)));
    return matching
      ? { status: "MATCH", rationale: "Profile evidence explicitly contains the required work authorization jurisdiction.", fact: matching.fact }
      : authorizationFacts.length > 0
        ? { status: "MISMATCH", rationale: "Profile work authorization evidence does not include the required jurisdiction.", fact: authorizationFacts[0].fact }
        : { status: "UNKNOWN", rationale: "Required work authorization cannot be verified from profile evidence.", fact: null };
  }

  return { status: "UNKNOWN", rationale: "No exact structured comparator applies to this requirement type.", fact: null };
}
