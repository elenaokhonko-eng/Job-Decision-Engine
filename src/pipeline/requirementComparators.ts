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
  source_type?: "PROFILE_FACT" | "CREDENTIAL";
}

export type StructuredComparison = {
  status: "MATCH" | "MISMATCH" | "UNKNOWN";
  rationale: string;
  fact: ComparableFact | null;
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
  "fields", "equivalent", "environment", "environments", "building", "using"
]);

function tokenizeScope(scope: string): Set<string> {
  return new Set(
    scope
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((token) => token.length >= 3 && !SCOPE_STOP_WORDS.has(token))
  );
}

function scopesOverlap(requiredScope: string, factScope: string): boolean {
  const requiredTokens = tokenizeScope(requiredScope);
  const factTokens = tokenizeScope(factScope);
  for (const token of requiredTokens) {
    if (factTokens.has(token)) return true;
  }
  const aliases: Array<[string, string[]]> = [
    ["ai", ["artificial intelligence", "machine learning", "ml", "deep learning"]],
    ["software", ["software engineering", "software development", "application development", "coding", "full stack", "backend"]],
    ["data", ["data engineering", "data science", "analytics", "etl", "data pipeline"]],
  ];
  return aliases.some(([canonical, variants]) => {
    const requiredHas = requiredScope.includes(canonical) || variants.some((variant) => requiredScope.includes(variant));
    const factHas = factScope.includes(canonical) || variants.some((variant) => factScope.includes(variant));
    return requiredHas && factHas;
  });
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

export function compareStructuredRequirement(
  requirement: ComparableRequirement,
  facts: ComparableFact[]
): StructuredComparison {
  const requirementText = textForRequirement(requirement);

  if (requirement.requirement_type === "EXPERIENCE_YEARS") {
    const required = requiredYears(requirement);
    if (required === null) return { status: "UNKNOWN", rationale: "Required experience duration is not structured.", fact: null };
    const requiredScope = requiredExperienceScope(requirement);
    const candidates = facts
      .map((fact) => ({ fact, years: factYears(fact), scopes: experienceScopes(fact.structured_value) }))
      .filter((candidate): candidate is { fact: ComparableFact; years: number; scopes: string[] } => candidate.years !== null);
    if (candidates.length === 0) return { status: "UNKNOWN", rationale: "No structured profile experience duration is available.", fact: null };
    const scopedCandidates = requiredScope
      ? candidates.filter((candidate) => candidate.scopes.some((scope) => scopesOverlap(requiredScope, scope)))
      : candidates;
    if (requiredScope && scopedCandidates.length === 0) {
      return {
        status: "UNKNOWN",
        rationale: `No structured profile experience duration is available for the required scope: ${requiredScope}.`,
        fact: null,
      };
    }
    const best = [...scopedCandidates].sort((a, b) => b.years - a.years)[0];
    return best.years >= required
      ? { status: "MATCH", rationale: `Profile experience ${best.years.toFixed(1)} years meets the ${required}-year requirement${requiredScope ? ` for ${requiredScope}` : ""}.`, fact: best.fact }
      : { status: "MISMATCH", rationale: `Profile experience ${best.years.toFixed(1)} years is below the ${required}-year requirement${requiredScope ? ` for ${requiredScope}` : ""}.`, fact: best.fact };
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
      ? { status: "MISMATCH", rationale: requiredSubject
          ? `Profile degree evidence does not meet the required ${requiredSubject} degree level/subject.`
          : "Profile degree evidence does not meet the required degree level.", fact: degreeEvidence }
      : { status: "UNKNOWN", rationale: "No profile degree evidence is available.", fact: null };
  }

  if (requirement.requirement_type === "CREDENTIAL") {
    const specificCredential = requirementCredentialIdentifier(requirement);
    if (!specificCredential) return { status: "UNKNOWN", rationale: "Credential name is not explicit.", fact: null };
    const matching = facts.find((fact) => factCredentialIdentifiers(fact).some((value) => value.includes(specificCredential)));
    if (matching) return { status: "MATCH", rationale: "Profile evidence contains the required credential.", fact: matching };
    const credentialEvidence = facts.find((fact) => /certif|license|licence|credential/i.test(textForFact(fact)) || fact.source_type === "CREDENTIAL");
    return credentialEvidence
      ? { status: "MISMATCH", rationale: "Profile credential evidence does not match the required credential.", fact: credentialEvidence }
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
