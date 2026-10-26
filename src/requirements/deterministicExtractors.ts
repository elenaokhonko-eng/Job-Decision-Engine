import {
  JobRequirementSchema,
  RequirementImportanceSchema,
  RequirementTypeSchema,
} from './contracts.js';
import { z } from 'zod';
import {
  isOccurrenceNegated,
  inferClauseImportance,
  findFirstNonNegatedMatch,
  findAllMatches,
} from './clauseAnalysis.js';

export { isOccurrenceNegated };

const EXTRACTOR_VERSION = 'deterministic_v3';

export interface DeterministicExtractorInput {
  canonical_job_id: string;
  job_version_id: string;
  description_text: string;
}

export type DeterministicRequirement = Omit<
  z.infer<typeof JobRequirementSchema>,
  'id' | 'created_at' | 'status'
>;

export interface DeterministicExtractorResult {
  requirements: DeterministicRequirement[];
  warnings: string[];
}

interface MatchInfo {
  quote_text: string;
  quote_start_offset: number;
  quote_end_offset: number;
}

const MIN_QUOTE_LENGTH = 5;

function isQuoteBoundary(char: string): boolean {
  return /[\s<>"'.,;:()[\]{}]/.test(char);
}

function trimMatch(description: string, start: number, end: number): MatchInfo | null {
  const raw = description.slice(start, end);
  const leading = raw.match(/^\s*/)?.[0].length ?? 0;
  const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
  const quoteStart = start + leading;
  const quoteEnd = end - trailing;
  const quote = description.slice(quoteStart, quoteEnd);
  if (!quote) {
    return null;
  }
  return {
    quote_text: quote,
    quote_start_offset: quoteStart,
    quote_end_offset: quoteEnd,
  };
}

function expandShortMatch(description: string, start: number, end: number): MatchInfo | null {
  let expandedStart = start;
  let expandedEnd = end;
  let best = trimMatch(description, expandedStart, expandedEnd);

  const consumeRightToken = () => {
    while (expandedEnd < description.length && isQuoteBoundary(description[expandedEnd])) {
      expandedEnd += 1;
    }
    while (expandedEnd < description.length && !isQuoteBoundary(description[expandedEnd])) {
      expandedEnd += 1;
    }
  };

  const consumeLeftToken = () => {
    while (expandedStart > 0 && isQuoteBoundary(description[expandedStart - 1])) {
      expandedStart -= 1;
    }
    while (expandedStart > 0 && !isQuoteBoundary(description[expandedStart - 1])) {
      expandedStart -= 1;
    }
  };

  while (
    best &&
    best.quote_text.length < MIN_QUOTE_LENGTH &&
    (expandedStart > 0 || expandedEnd < description.length)
  ) {
    const beforeStart = expandedStart;
    const beforeEnd = expandedEnd;

    consumeRightToken();
    best = trimMatch(description, expandedStart, expandedEnd);
    if (best && best.quote_text.length >= MIN_QUOTE_LENGTH) {
      break;
    }

    consumeLeftToken();
    best = trimMatch(description, expandedStart, expandedEnd);
    if (beforeStart === expandedStart && beforeEnd === expandedEnd) {
      break;
    }
  }

  return best;
}

function findFirstMatch(description: string, patterns: RegExp[]): MatchInfo | null {
  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (!match || typeof match.index !== 'number') {
      continue;
    }

    const start = match.index;
    const end = start + match[0].length;
    const matchInfo =
      match[0].trim().length < MIN_QUOTE_LENGTH
        ? expandShortMatch(description, start, end)
        : trimMatch(description, start, end);
    if (!matchInfo || matchInfo.quote_text.length < MIN_QUOTE_LENGTH) {
      continue;
    }

    return matchInfo;
  }

  return null;
}

function isContractEmploymentFalsePositive(description: string, match: MatchInfo): boolean {
  const start = Math.max(0, match.quote_start_offset - 24);
  const end = Math.min(description.length, match.quote_end_offset + 48);
  const window = description.slice(start, end).toLowerCase();

  // Domain terms that often contain the token "contract" but do not imply contract employment.
  const nonEmploymentPhrases = [
    "smart contract",
    "smart contracts",
    "contract analysis",
    "contract analytics",
    "contract management",
    "contract automation",
    "contract intelligence",
    "contract lifecycle",
    "contracts analysis",
    "contracts analytics",
    "contract review",
  ];

  return nonEmploymentPhrases.some((p) => window.includes(p));
}

function findEmploymentTypeMatch(description: string): { match: MatchInfo; employmentType: string } | null {
  const contractStrong = findFirstMatch(description, [
    /\bcontract[- ]to[- ]hire\b/i,
    /\b(\d{1,2})\s*(?:month|months|mo|week|weeks|wk|day|days)\s+contract\b/i,
    /\bcontract\s+(?:role|position|assignment|opportunity)\b/i,
    /\bfixed[- ]term\b/i,
    /\btemporary\b/i,
  ]);
  if (contractStrong && !isContractEmploymentFalsePositive(description, contractStrong)) {
    return { match: contractStrong, employmentType: "CONTRACT" };
  }

  const fullTime = findFirstMatch(description, [
    /\bfull[- ]?time\b/i,
    /\bpermanent\b/i,
    /\bfte\b/i,
  ]);
  if (fullTime) {
    return { match: fullTime, employmentType: "FULL_TIME" };
  }

  const partTime = findFirstMatch(description, [
    /\bpart[- ]?time\b/i,
  ]);
  if (partTime) {
    return { match: partTime, employmentType: "PART_TIME" };
  }

  const contractWeak = findFirstMatch(description, [
    /\bcontractor\b/i,
    /\bcontract\b/i,
  ]);
  if (contractWeak && !isContractEmploymentFalsePositive(description, contractWeak)) {
    return { match: contractWeak, employmentType: "CONTRACT" };
  }

  return null;
}

function normalizeQuoteEvidence(quote: MatchInfo): {
  quote_text: string | null;
  quote_start_offset: number | null;
  quote_end_offset: number | null;
} {
  if (quote.quote_text.trim().length < MIN_QUOTE_LENGTH) {
    return { quote_text: null, quote_start_offset: null, quote_end_offset: null };
  }
  return {
    quote_text: quote.quote_text,
    quote_start_offset: quote.quote_start_offset,
    quote_end_offset: quote.quote_end_offset,
  };
}

function buildRequirement(
  input: DeterministicExtractorInput,
  sequence: number,
  type: z.infer<typeof RequirementTypeSchema>,
  requirementText: string,
  quote: MatchInfo,
  structuredValue: Record<string, unknown>,
  confidence = 0.98
): DeterministicRequirement {
  const evidence = normalizeQuoteEvidence(quote);
  const importance = inferClauseImportance(
    input.description_text,
    quote.quote_start_offset,
    quote.quote_end_offset
  );
  return JobRequirementSchema.parse({
    canonical_job_id: input.canonical_job_id,
    job_version_id: input.job_version_id,
    requirement_key: `R-${String(sequence).padStart(3, '0')}`,
    requirement_type: type,
    importance,
    requirement_text: requirementText,
    quote_text: evidence.quote_text,
    quote_start_offset: evidence.quote_start_offset,
    quote_end_offset: evidence.quote_end_offset,
    structured_value: structuredValue,
    extractor_type: 'DETERMINISTIC',
    extractor_version: EXTRACTOR_VERSION,
    confidence,
  });
}

const EXPERIENCE_NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};
const EXPERIENCE_NUMBER = `(?:\\d{1,2}(?:\\.\\d+)?|${Object.keys(EXPERIENCE_NUMBER_WORDS).join('|')})`;
const EXPERIENCE_PATTERNS = [
  new RegExp(String.raw`\b${EXPERIENCE_NUMBER}(?:\s*[-–]\s*${EXPERIENCE_NUMBER})?\+?\s*(?:additional\s+)?(?:years?|yrs?)\s+(?:of\s+)?(?:[^.;\n]{0,100}?\s+)?experience\b`, 'gi'),
  new RegExp(String.raw`\b${EXPERIENCE_NUMBER}(?:\s*[-–]\s*${EXPERIENCE_NUMBER})?\+?\s*(?:additional\s+)?(?:years?|yrs?)\s+of\s+experience\s+(?:in|with|as|at)\s+[^.;\n]{1,100}`, 'gi'),
  new RegExp(String.raw`\b${EXPERIENCE_NUMBER}(?:\s*[-–]\s*${EXPERIENCE_NUMBER})?\+?\s*(?:additional\s+)?(?:years?|yrs?)\s+(?:in|at)\s+(?:the\s+)?(?:architecture|engineering|software|coding|programming|data|ai|machine learning|research|staff|principal|technical delivery)[^.;\n]{0,100}`, 'gi'),
];

function parseExperienceNumber(value: string): number | null {
  const normalized = value.toLowerCase().trim();
  return /^\d+(?:\.\d+)?$/.test(normalized)
    ? Number(normalized)
    : EXPERIENCE_NUMBER_WORDS[normalized] ?? null;
}

function experienceScopeFromQuote(quote: string): string | null {
  const afterExperience = quote.match(/\bexperience\s+(?:in|with|as|at)\s+(.+)$/i)?.[1];
  const withoutDuration = quote.replace(
    new RegExp(String.raw`^\s*${EXPERIENCE_NUMBER}(?:\s*[-–]\s*${EXPERIENCE_NUMBER})?\+?\s*(?:additional\s+)?(?:years?|yrs?)\s*`, 'i'),
    '',
  );
  const scope = (afterExperience ?? withoutDuration)
    .replace(/^\s*(?:of\s+)?/, '')
    .replace(/\b(?:professional|production)\s+experience\b.*$/i, '')
    .replace(/\b(?:experience|expertise)\b.*$/i, '')
    .replace(/^\s*(?:in|at|as|with)\s+/, '')
    .replace(/[,:;.]\s*$/, '')
    .trim();
  return scope || null;
}

function experienceScopeFamilies(scope: string | null): {
  roleFamilies: string[];
  domainFamilies: string[];
  seniorityScope: string | null;
  durationBasis: string;
  operator: 'ANY' | 'ALL';
} {
  const value = (scope ?? '').toLowerCase();
  const roleFamilies = new Set<string>();
  const domainFamilies = new Set<string>();
  if (/\barchitect(?:ure)?\b/i.test(value)) roleFamilies.add('ARCHITECTURE');
  if (/\b(ai|machine learning|ml|llm|artificial intelligence)\b/i.test(value)) {
    roleFamilies.add('AI_ENGINEERING');
    domainFamilies.add('AI');
  }
  if (/\b(data engineering|data engineer|data platform)\b/i.test(value)) {
    roleFamilies.add('DATA_ENGINEERING');
    domainFamilies.add('DATA');
  }
  if (/\b(software\s+(?:engineering|development)|coding|programming|developer|development|engineering|engineer|implementation|hands[- ]on|full[- ]stack|backend|frontend|web development)\b/i.test(value)) {
    roleFamilies.add('HANDS_ON_SOFTWARE_ENGINEERING');
  }
  if (/\b(software|coding|programming|developer|development|full[- ]stack|backend|frontend|web development)\b/i.test(value)) domainFamilies.add('SOFTWARE');
  if (/\b(research software|research engineer|scientific computing|scientific software)\b/i.test(value)) {
    roleFamilies.add('RESEARCH_SOFTWARE');
    domainFamilies.add('UNIVERSITY_AI_RESEARCH');
  }
  if (/\b(technical project|technical programme|technical program|technical delivery)\b/i.test(value)) roleFamilies.add('TECHNICAL_DELIVERY');
  if (/\b(technical product|product management)\b/i.test(value)) roleFamilies.add('TECHNICAL_PRODUCT');
  if (/\b(legal|regtech|regulatory)\b/i.test(value)) domainFamilies.add('LEGAL_REGTECH');
  if (/\b(health|biomedical|biotech|pharma|clinical)\b/i.test(value)) domainFamilies.add('HEALTH_BIO_PHARMA');
  if (/\b(investment|financial|fintech|trading|markets)\b/i.test(value)) domainFamilies.add('INVESTMENT_MARKETS_FINTECH');
  if (/\b(multilateral|humanitarian|social impact|development sector)\b/i.test(value)) domainFamilies.add('SOCIAL_IMPACT_MULTILATERAL');
  if (/\b(university|academic|research)\b/i.test(value)) domainFamilies.add('UNIVERSITY_AI_RESEARCH');

  const seniorityScope = value.match(/\b(staff|senior|principal|lead|director|executive)\s+(?:level|scope|role)\b/i)?.[0] ?? null;
  const durationBasis = /\b(coursework|academic coursework|classroom)\b/i.test(value)
    ? 'COURSEWORK'
    : /\b(deployed open[- ]source|open[- ]source production)\b/i.test(value)
      ? 'DEPLOYED_OPEN_SOURCE'
      : /\b(applied project|project work)\b/i.test(value)
        ? 'APPLIED_PROJECT'
        : 'PROFESSIONAL_PRODUCTION';
  return {
    roleFamilies: [...roleFamilies],
    domainFamilies: [...domainFamilies],
    seniorityScope,
    durationBasis,
    operator: /\bor\b/i.test(value) ? 'ANY' : /\band\b/i.test(value) ? 'ALL' : 'ANY',
  };
}

function extractExperienceRequirements(
  input: DeterministicExtractorInput,
  firstSequence: number,
): { requirements: DeterministicRequirement[]; nextSequence: number } {
  const matches = findAllMatches(input.description_text, EXPERIENCE_PATTERNS)
    .filter((match) => !isOccurrenceNegated(input.description_text, match.quote_start_offset, match.quote_end_offset));
  const matchesByStart = new Map<number, typeof matches[number]>();
  for (const match of matches) {
    const existing = matchesByStart.get(match.quote_start_offset);
    if (!existing || match.quote_end_offset > existing.quote_end_offset) {
      matchesByStart.set(match.quote_start_offset, match);
    }
  }
  const orderedMatches = [...matchesByStart.values()].sort((left, right) => left.quote_start_offset - right.quote_start_offset);
  const requirements: DeterministicRequirement[] = [];
  let sequence = firstSequence;

  for (const match of orderedMatches) {
    const durationMatch = match.quote_text.match(new RegExp(String.raw`^\s*(${EXPERIENCE_NUMBER})(?:\s*[-–]\s*(${EXPERIENCE_NUMBER}))?`, 'i'));
    const minimumYears = durationMatch?.[1] ? parseExperienceNumber(durationMatch[1]) : null;
    if (minimumYears === null) continue;
    const maximumYears = durationMatch?.[2] ? parseExperienceNumber(durationMatch[2]) : null;
    const scope = experienceScopeFromQuote(match.quote_text);
    const families = experienceScopeFamilies(scope);
    const structuredValue: Record<string, unknown> = {
      minimum_years: minimumYears,
      maximum_years: maximumYears,
      scope_schema_version: 'experience_scope_v2',
      role_families: families.roleFamilies,
      domain_families: families.domainFamilies,
      operator: families.operator,
      seniority_scope: families.seniorityScope,
      duration_basis: families.durationBasis,
      alternative_group_id: families.operator === 'ANY' && /\bor\b/i.test(scope ?? '')
        ? `experience-alt-${match.quote_start_offset}`
        : null,
      ...(scope ? { experience_scope: scope } : {}),
    };
    requirements.push(buildRequirement(
      input,
      sequence++,
      'EXPERIENCE_YEARS',
      'Role requires scoped minimum years of experience.',
      match,
      structuredValue,
    ));
  }
  return { requirements, nextSequence: sequence };
}

export function extractDeterministicRequirements(
  input: DeterministicExtractorInput
): DeterministicExtractorResult {
  const description = input.description_text;
  const requirements: DeterministicRequirement[] = [];
  const warnings: string[] = [];
  let sequence = 1;

  const officeDays = findFirstMatch(description, [
    /\b([1-5])\s*days?\s*(?:a|per|\/)?\s*week\s*(?:in|on)?\s*(?:the)?\s*(?:office|on[- ]?site)\b/i,
    /\b(?:office|on[- ]?site)\s*[\w\s]{0,30}?\b([1-5])\s*days?\b/i,
  ]);
  if (officeDays) {
    const dayMatch = officeDays.quote_text.match(/([1-5])/);
    const days = dayMatch ? Number(dayMatch[1]) : null;
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'OFFICE_DAYS',
        'Role requires a specific number of in-office days per week.',
        officeDays,
        { office_days_per_week: days }
      )
    );
  }

  const workMode = findFirstMatch(description, [
    /\b(fully\s+on[- ]?site|100%\s+on[- ]?site|on[- ]?site\s+only|remote\s+first|hybrid)\b/i,
  ]);
  if (workMode) {
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'WORK_MODE',
        'Role specifies a work-mode requirement.',
        workMode,
        { mode: workMode.quote_text.toUpperCase() }
      )
    );
  }

  const extractedExperience = extractExperienceRequirements(input, sequence);
  requirements.push(...extractedExperience.requirements);
  sequence = extractedExperience.nextSequence;

  const degree = findFirstMatch(description, [
    /\b(?:bachelor(?:'s)?|master(?:'s)?|phd|doctorate|doctoral)(?:\s+degree)?(?:\s+in\s+[^.;\n]{1,100})?/i,
    /\bdegree\s+in\s+[^.;\n]{1,100}/i,
  ]);
  if (degree) {
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'DEGREE',
        'Role requires a degree qualification.',
        degree,
        { degree_reference: degree.quote_text }
      )
    );
  }

  const credential = findFirstMatch(description, [
    /\b(CFA|CPA|CISSP|PMP|AWS\s+Certified|certification\s+required|license\s+required)\b/i,
  ]);
  if (credential) {
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'CREDENTIAL',
        'Role requires a credential or certification.',
        credential,
        { credential_reference: credential.quote_text }
      )
    );
  }

  const employmentMatch = findEmploymentTypeMatch(description);
  if (employmentMatch) {
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'EMPLOYMENT_TYPE',
        'Role specifies an employment type.',
        employmentMatch.match,
        { employment_type: employmentMatch.employmentType }
      )
    );
  }

  const travel = findFirstNonNegatedMatch(description, [
    /\bup\s+to\s+(\d{1,2})%\s+travel\b/i,
    /\bfrequent\s+travel\b/i,
  ]);
  if (travel) {
    const pctMatch = travel.quote_text.match(/(\d{1,2})%/);
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'TRAVEL',
        'Role includes travel expectations.',
        travel,
        { max_travel_pct: pctMatch ? Number(pctMatch[1]) : null }
      )
    );
  }

  const workAuth = findFirstMatch(description, [
    /\b(work\s+authorization|work\s+rights|authorized\s+to\s+work|no\s+sponsorship)\b/i,
  ]);
  if (workAuth) {
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'WORK_AUTH',
        'Role requires a specific work authorization status.',
        workAuth,
        { policy: workAuth.quote_text }
      )
    );
  }

  const onCall = findFirstNonNegatedMatch(description, [
    /\b(on[- ]?call\s+rotation|regular\s+on[- ]?call|24\/7\s+support)\b/i,
  ]);
  if (onCall) {
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'ON_CALL',
        'Role includes on-call operations responsibility.',
        onCall,
        { on_call_required: true }
      )
    );
  }

  const shiftWork = findFirstNonNegatedMatch(description, [
    /\b(shift\s+work|rotating\s+shifts|night\s+shift)\b/i,
  ]);
  if (shiftWork) {
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'SHIFT_WORK',
        'Role includes shift-based scheduling requirements.',
        shiftWork,
        { shift_work_required: true }
      )
    );
  }

  const technicalFunctionPatterns = [
    /\b(?:director|head|vp|vice\s+president)\s+of\s+(?:engineering|technology|software|data(?:\s+(?:science|engineering|platform|analytics|architecture))?|analytics?|ai|ml|platform|cloud|systems?|digital|transformation|research|science)\b/i,
    /\b(?:engineering|technology|software|data|analytics?|ai|ml|digital|transformation)\s+(?:program|programme|project|portfolio|delivery|transformation)\s+(?:manager|director|lead|head|officer|vp|vice\s+president)\b/i,
    /\b(?:engineering|technology|software|data(?:\s+(?:science|engineering|platform|analytics|architecture))?|analytics?|ai|ml|platform|cloud|systems?|digital|transformation|research|science)\s+(?:manager|director|lead|head|officer|vp|vice\s+president)\b/i,
    /\b(?:machine\s+learning\s+engineer|ml\s+engineer|data\s+engineer|data\s+(?:pipeline|platform|warehouse|etl)\s+(?:engineer|developer|architect|associate|analyst|specialist)|(?:sql\s+)?etl\s+(?:engineer|developer|associate|analyst|specialist)|data\s+warehouse\s+(?:engineer|developer|associate|analyst|specialist)|platform\s+engineer|software\s+engineer|ai\s+engineer|research\s+scientist|(?:data|ai|ml|lead|principal|chief)\s+scientist|quant(?:itative)?\s+(?:engineer|developer|researcher)|bioinformatics\s+engineer|systems\s+architect|ai\s+architect|software\s+developer|full[\s-]stack\s+developer|backend\s+developer|frontend\s+developer|data\s+scientist|data\s+architect|research\s+engineer|research\s+software\s+engineer)\b/i,
  ];
  let functionRequirement = findFirstMatch(description, technicalFunctionPatterns);
  if (!functionRequirement && /\b(?:project|program|programme|portfolio|delivery)\s+(?:manager|director|lead|head)\b/i.test(description) && /\b(?:software|data|analytics?|ai|ml|machine\s+learning|technology|technical|engineering|platform|cloud|digital|transformation|systems?)\b/i.test(description)) {
    functionRequirement = findFirstMatch(description, [
      /\b(?:project|program|programme|portfolio|delivery)\s+(?:manager|director|lead|head)\b/i,
    ]);
  }
  if (functionRequirement) {
    const normalized = functionRequirement.quote_text.toUpperCase().replace(/\s+/g, '_');
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'FUNCTION',
        'Role includes a technical function requirement.',
        functionRequirement,
        { function_key: normalized }
      )
    );
  }

  const domainRequirement = findFirstMatch(description, [
    /\b(machine\s+learning|artificial\s+intelligence|ai\b|llm|nlp|data\s+platform|data\s+pipeline|data\s+engineering|data\s+warehouse|sql\s+etl|etl|regtech|legaltech|compliance\s+automation|bioinformatics|genomics|biotech|pharma|quant(?:itative)?|trading|fintech|market\s+data)\b/i,
  ]);
  if (domainRequirement) {
    const normalized = domainRequirement.quote_text.toUpperCase().replace(/\s+/g, '_');
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'DOMAIN',
        'Role includes a target technical domain requirement.',
        domainRequirement,
        { domain_key: normalized }
      )
    );
  }

  if (requirements.length === 0) {
    warnings.push('No deterministic requirements identified.');
  }

  return { requirements, warnings };
}
