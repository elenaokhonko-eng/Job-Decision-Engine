import {
  JobRequirementSchema,
  RequirementImportanceSchema,
  RequirementTypeSchema,
} from './contracts.js';
import { z } from 'zod';

const EXTRACTOR_VERSION = 'deterministic_v1';

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

function findFirstMatch(description: string, patterns: RegExp[]): MatchInfo | null {
  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (!match || typeof match.index !== 'number') {
      continue;
    }

    const quote = match[0].trim();
    if (!quote) {
      continue;
    }

    const start = match.index;
    return {
      quote_text: quote,
      quote_start_offset: start,
      quote_end_offset: start + quote.length,
    };
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

function inferImportance(quoteText: string): z.infer<typeof RequirementImportanceSchema> {
  const lower = quoteText.toLowerCase();
  if (lower.includes('must') || lower.includes('mandatory') || lower.includes('required')) {
    return 'MUST';
  }
  if (lower.includes('preferred') || lower.includes('nice to have')) {
    return 'PREFERRED';
  }
  return 'NICE_TO_HAVE';
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
  return JobRequirementSchema.parse({
    canonical_job_id: input.canonical_job_id,
    job_version_id: input.job_version_id,
    requirement_key: `R-${String(sequence).padStart(3, '0')}`,
    requirement_type: type,
    importance: inferImportance(quote.quote_text),
    requirement_text: requirementText,
    quote_text: quote.quote_text,
    quote_start_offset: quote.quote_start_offset,
    quote_end_offset: quote.quote_end_offset,
    structured_value: structuredValue,
    extractor_type: 'DETERMINISTIC',
    extractor_version: EXTRACTOR_VERSION,
    confidence,
  });
}

export function extractDeterministicRequirements(
  input: DeterministicExtractorInput
): DeterministicExtractorResult {
  const description = input.description_text;
  const requirements: DeterministicRequirement[] = [];
  const warnings: string[] = [];
  let sequence = 1;

  const officeDays = findFirstMatch(description, [
    /\b([1-5])\s*days?\s*(?:a|per)?\s*week\s*(?:in|on)?\s*(?:the)?\s*(?:office|on[- ]?site)\b/i,
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

  const experienceYears = findFirstMatch(description, [
    /\b(?:at\s+least\s+)?(\d{1,2})\+?\s*(?:years|yrs)\s+(?:of\s+)?experience\b/i,
  ]);
  if (experienceYears) {
    const yearsMatch = experienceYears.quote_text.match(/(\d{1,2})/);
    const years = yearsMatch ? Number(yearsMatch[1]) : null;
    requirements.push(
      buildRequirement(
        input,
        sequence++,
        'EXPERIENCE_YEARS',
        'Role requires minimum years of experience.',
        experienceYears,
        { minimum_years: years }
      )
    );
  }

  const degree = findFirstMatch(description, [
    /\b(bachelor(?:'s)?\s+degree|master(?:'s)?\s+degree|phd|doctorate)\b/i,
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

  const travel = findFirstMatch(description, [
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

  const onCall = findFirstMatch(description, [
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

  const shiftWork = findFirstMatch(description, [
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

  const functionRequirement = findFirstMatch(description, [
    /\b(machine\s+learning\s+engineer|ml\s+engineer|data\s+engineer|platform\s+engineer|software\s+engineer|ai\s+engineer|research\s+scientist|quant(?:itative)?\s+(?:engineer|developer)|bioinformatics\s+engineer|systems\s+architect|ai\s+architect)\b/i,
  ]);
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
    /\b(machine\s+learning|artificial\s+intelligence|ai\b|llm|nlp|data\s+platform|regtech|legaltech|compliance\s+automation|bioinformatics|genomics|biotech|pharma|quant(?:itative)?|trading|fintech|market\s+data)\b/i,
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
