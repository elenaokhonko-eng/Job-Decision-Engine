/**
 * Discovery pre-screen: cheap, deterministic rules applied by the adapter runner before a
 * fetched posting is staged. Like the lane and location pre-filters it only narrows what is
 * staged; a skipped posting gets a FILTERED disposition with a reason code and is never a
 * career rejection. Every rule here is off unless DISCOVERY_PRESCREEN_ENABLED is "true".
 *
 *   Tier 0  title deny-list (clear non-target role families), any lane.
 *   Tier 1  lane role term in the title or the opening of the description, and the lane's
 *           excluded_domain_concepts as negative terms (see assessCandidateLanes).
 *   Geo     explicit structured region/country fields (see assessStructuredGeoScope).
 *   Jobicy  the lane role term must match the title.
 *
 * Seniority is deliberately not judged here; the hard gates and the decider own it.
 */

export const PRESCREEN_TITLE_DENY = "PRESCREEN_TITLE_DENY" as const;

/** Characters of the description, after the title, in which a Tier 1 role term may appear. */
export const PRESCREEN_ROLE_LEAD_CHARS = 300;

/**
 * Tier 1 settings used by the runner (see scripts/replay_discovery_prescreen.ts for the replay
 * that chose them over the literal "title + description" negatives and lane-terms-only lead).
 */
export const PRESCREEN_TIER1_DEFAULTS = {
  negativeScope: "TITLE",
  technicalRoleWords: true,
} as const;

/** Sources whose lane role term must appear in the title itself when the pre-screen is on. */
export const PRESCREEN_TITLE_ROLE_SOURCES: ReadonlySet<string> = new Set(["jobicy"]);

export function discoveryPrescreenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.DISCOVERY_PRESCREEN_ENABLED, "DISCOVERY_PRESCREEN_ENABLED");
}

/** FILTERED dispositions store the raw payload once per posting instead of once per lane. */
export function filteredPayloadDedupeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.DISCOVERY_FILTERED_PAYLOAD_DEDUPE_ENABLED, "DISCOVERY_FILTERED_PAYLOAD_DEDUPE_ENABLED");
}

function parseFlag(raw: string | undefined, name: string): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  // A typo must not silently leave a filter on or off.
  throw new Error(`${name} must be "true" or "false".`);
}

interface DenyRule {
  readonly term: string;
  readonly pattern: RegExp;
  /** Ambiguous words (warehouse, driver, payroll) stay allowed in technical titles. */
  readonly allowTechnicalTitle?: boolean;
  /**
   * Early-career terms stay allowed when the title also offers full-time roles: a combined
   * header such as Hacker News "Full time + Internships" is not an internship-only posting.
   */
  readonly allowFullTimeHeader?: boolean;
}

const FULL_TIME_HEADER = /\bfull[- ]?time\b/i;

const TECHNICAL_TITLE = /\b(?:engineer(?:ing)?|developer|architect|scientist|programmer|software|firmware|platform|data|analytics)\b/i;

const DENY_RULES: readonly DenyRule[] = [
  { term: "intern", pattern: /\binterns?\b|\binternships?\b/i, allowFullTimeHeader: true },
  { term: "apprentice", pattern: /\bapprentice(?:s|ships?)?\b/i, allowFullTimeHeader: true },
  { term: "trainee", pattern: /\btrainees?\b/i, allowFullTimeHeader: true },
  { term: "working student", pattern: /\bworking students?\b/i, allowFullTimeHeader: true },
  { term: "co-op", pattern: /\bco-op\b/i, allowFullTimeHeader: true },
  // "graduate" as a whole word (new/recent/fresh graduate, graduate programme/scheme/trainee are
  // all whole-word uses); postgraduate, undergraduate and post-/under-graduate never match.
  { term: "graduate", pattern: /(?<![a-z])(?<!\bpost[- ])(?<!\bunder[- ])graduates?\b/i, allowFullTimeHeader: true },
  { term: "nurse", pattern: /\bnurses?\b/i },
  { term: "physician", pattern: /\bphysicians?\b/i },
  { term: "pharmacist", pattern: /\bpharmacists?\b/i },
  { term: "clinical research associate", pattern: /\bclinical research associates?\b/i },
  { term: "sales development", pattern: /\bsales development\b/i },
  { term: "SDR", pattern: /\bsdrs?\b/i },
  { term: "BDR", pattern: /\bbdrs?\b/i },
  { term: "account executive", pattern: /\baccount executives?\b/i },
  { term: "customer success", pattern: /\bcustomer success\b/i },
  { term: "support specialist", pattern: /\bsupport specialists?\b/i },
  { term: "customer support", pattern: /\bcustomer support\b/i },
  { term: "recruiter", pattern: /\brecruit(?:er|ers|ing)\b/i },
  { term: "talent acquisition", pattern: /\btalent acquisition\b/i },
  { term: "HR business partner", pattern: /\bhr business partners?\b|\bhrbps?\b/i },
  { term: "office manager", pattern: /\boffice managers?\b/i },
  { term: "executive assistant", pattern: /\bexecutive assistants?\b/i },
  { term: "accountant", pattern: /\baccountants?\b/i },
  { term: "payroll", pattern: /\bpayroll\b/i, allowTechnicalTitle: true },
  { term: "warehouse", pattern: /\bwarehouse\b/i, allowTechnicalTitle: true },
  { term: "driver", pattern: /\bdrivers?\b/i, allowTechnicalTitle: true },
  { term: "field technician", pattern: /\bfield (?:service )?technicians?\b/i },
  // Product designers are not on the list.
  {
    term: "designer",
    pattern: /\b(?:graphic|visual|ux|ui|brand|motion)(?:\s*[/&,]\s*(?:graphic|visual|ux|ui|brand|motion))*\s+designers?\b/i,
  },
];

export interface TitleDenyMatch {
  readonly term: string;
  readonly matchedText: string;
}

/** The first deny-list term in the title, or null. Whole words, case-insensitive. */
export function matchTitleDenyList(title: string | null | undefined): TitleDenyMatch | null {
  const text = String(title ?? "");
  if (!text.trim()) return null;
  const technical = TECHNICAL_TITLE.test(text);
  const fullTimeHeader = FULL_TIME_HEADER.test(text);
  for (const rule of DENY_RULES) {
    if (rule.allowTechnicalTitle && technical) continue;
    if (rule.allowFullTimeHeader && fullTimeHeader) continue;
    const match = text.match(rule.pattern);
    if (match) return { term: rule.term, matchedText: match[0] };
  }
  return null;
}

/**
 * Plain discovery terms for a lane's excluded_domain_concepts. Concept codes become their words
 * (PAYMENTS -> "payments"); a few codes whose words would never appear in a posting get the
 * phrases postings use. Matching is whole-word on the normalized title and description.
 */
const EXCLUDED_CONCEPT_TERMS: Readonly<Record<string, readonly string[]>> = {
  m_and_a: ["m&a", "mergers and acquisitions", "mergers & acquisitions"],
  bnpl: ["bnpl", "buy now pay later", "buy now, pay later"],
  cards: ["card issuing", "card issuer", "credit cards", "debit cards", "card payments"],
  merchant_acquiring: ["merchant acquiring", "merchant acquirer"],
  consumer_lending: ["consumer lending", "consumer loans"],
};

export function excludedConceptTerms(concepts: readonly string[] | undefined): string[] {
  const terms = (concepts ?? []).flatMap((concept) => {
    const key = concept.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return EXCLUDED_CONCEPT_TERMS[key] ?? [concept.replace(/_/g, " ").trim().toLowerCase()];
  });
  return [...new Set(terms.filter(Boolean))];
}
