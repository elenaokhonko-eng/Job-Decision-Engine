/**
 * Deterministic role-type and sector classifier for the review lists. It orders and leaves out; it rejects nothing and
 * stores nothing. The role kind comes from the title; status, priority and sector come from the ranking design. The
 * sector is the EMPLOYER's industry, never the job's lane or the posting text. An unknown role keeps the design's
 * unknown status and an unknown sector is neutral. Pure.
 */
import { normalizeJobIdentity } from "../../catalog/index.js";
import type { RankingDesign, RoleKind, RoleStatus } from "./rankingDesign.js";

export type SectorStatus = "PREFERRED" | "NEUTRAL" | "NEVER";
export type KnownWorkMode = "REMOTE" | "HYBRID" | "ONSITE" | null;

export interface ClassifierInput {
  readonly title: string;
  readonly company: string | null;
  readonly description: string;
  /** null when unknown; an assumed work mode counts as unknown. */
  readonly workMode: KnownWorkMode;
  /** Posting-wording flags of the existing role-shape detectors. */
  readonly externalClientFacing: boolean;
  readonly peopleManagementCore: boolean;
  /** Used only when the title names no role kind. */
  readonly fallbackKind: RoleKind | null;
}

/** An industry tag of config/companies.yml, with the names its employer goes by. */
export interface CompanyIndustryTags {
  readonly names: readonly string[];
  readonly tags: readonly string[];
}

export type SectorSource = "EMPLOYER_OVERRIDE" | "EMPLOYER_LIST" | "COMPANY_TAG" | "EMPLOYER_NAME" | "UNKNOWN";

export interface JobClassification {
  readonly kind: RoleKind | "UNKNOWN";
  /** null when the role kind is unknown. */
  readonly roleType: string | null;
  readonly status: RoleStatus;
  readonly sector: SectorStatus;
  readonly industry: string | null;
  readonly sectorSource: SectorSource;
  readonly handsOn: boolean;
  readonly stakeholderHeavy: boolean;
  readonly inHouse: boolean;
  readonly remoteOrHybrid: boolean;
  readonly reasons: readonly string[];
}

const AI = /\b(?:ai|a\.i\.|artificial intelligence|gen ?ai|generative ai|llms?|agentic)(?![\p{L}\p{N}])/iu;
const BUILDER_WORD = /\b(?:engineer(?:ing|s)?|developer|programmer|scientist|architect(?:ure)?)\b/i;

const FORWARD_DEPLOYED = /\bforward[- ]deployed\b/i;
// A grade after the role ("vp") is not management, so only "head" and "director" name a managed function.
const ENGINEERING_MANAGEMENT =
  /\bengineering (?:manager|director|head)\b|\bmanager,? (?:of )?(?:software |platform )?engineering\b|(?<!associate )\b(?:head|director),? (?:of )?(?:[\w&/-]+ )?engineering\b/i;
const PRODUCT = /\bproduct (?:manager|owner|lead|director|management|head)\b|\bhead of product\b|\bchief product(?: officer| owner)\b/i;
const RESEARCH =
  /\bresearch (?:engineer|scientist|fellow|associate|assistant|leader?)\b|\b(?:evals?|evaluations?) (?:engineer|scientist)\b/i;
const ARCHITECTURE = /\barchitect(?:ure)?\b/i;
const DELIVERY =
  /\b(?:program|programme|project|delivery|portfolio|transformation) (?:[&\w]+ )?(?:manager|management|lead|director|head)\b|\bpmo\b|\bscrum master\b|\bhead of (?:delivery|programmes?|programs?|projects?)\b/i;
const AI_LEADERSHIP_WORD =
  /\b(?:strategy|strategist|governance|adoption|risk|compliance|policy|transformation|enablement|coe|cent(?:re|er) of excellence|head|director|chief|vice president|vp|svp|evp)\b/i;
const DATA_ML =
  /\bdata (?:engineer(?:ing)?|scien(?:ce|tist)|platform)\b|\b(?:machine learning|ml|mlops|deep learning|nlp|computer vision)\b|\banalytics engineer\b|\bbig data\b|\bapplied scientist\b/i;
const DATA_SCIENTIST = /\bdata scientist\b/i;
const AI_BUILDER = /\b(?:engineer(?:ing)?|developer|specialist|scientist)\b/i;
const SOFTWARE = /\b(?:software|full[- ]?stack|back[- ]?end|front[- ]?end|developer|engineer|programmer|swe)\b/i;

/** The role kind a title names, or null. The order matters: the narrower role wins over the general word. */
export function roleKindOfTitle(title: string): RoleKind | null {
  const text = title.replace(/\s+/g, " ").trim();
  const ai = AI.test(text);
  if (FORWARD_DEPLOYED.test(text)) return "FORWARD_DEPLOYED";
  if (ENGINEERING_MANAGEMENT.test(text)) return "ENGINEERING_MANAGEMENT";
  if (PRODUCT.test(text)) return "PRODUCT";
  if (RESEARCH.test(text)) return "RESEARCH_ENGINEERING";
  if (ARCHITECTURE.test(text)) return "ARCHITECTURE";
  if (DELIVERY.test(text)) return "DELIVERY_MANAGEMENT";
  // An AI title about direction or control, with no building word, is leadership work and not engineering.
  if (ai && AI_LEADERSHIP_WORD.test(text) && !BUILDER_WORD.test(text)) return "AI_STRATEGY_LEADERSHIP";
  if (ai && AI_BUILDER.test(text) && !DATA_SCIENTIST.test(text)) return "AI_ENGINEERING";
  if (DATA_ML.test(text)) return "DATA_ML";
  if (SOFTWARE.test(text)) return "SOFTWARE";
  return null;
}

const HANDS_ON =
  /\bhands[- ]on\b|\bcoding\b|\b(?:writ(?:e|ing)|ship(?:ping)?|review(?:ing)?) (?:[\w-]+ )?code\b|\b(?:python|typescript|javascript|java|golang|rust|scala|sql)\b|\bc\+\+|\bbuild(?:ing)? and ship(?:ping)?\b|\bdesign(?:ing)?(?: and|,) (?:build|implement)(?:ing)?\b|\bbuild(?:ing)? (?:[\w-]+ ){0,2}(?:pipelines?|services?|systems?|models?|applications?|apis?|prototypes?|agents?)\b/i;
export const showsHandsOnWork = (title: string, description: string): boolean => HANDS_ON.test(`${title}\n${description}`);

const STAKEHOLDER_WORDS =
  /\b(?:stakeholders?|steering committees?|governance (?:forums?|committees?|boards?)|senior leadership|executive (?:audiences?|committees?|reporting)|c-suite|alignment|escalations?|status reporting|cross-functional)\b/gi;
export const stakeholderMentions = (description: string): number => description.match(STAKEHOLDER_WORDS)?.length ?? 0;

const IN_HOUSE =
  /\bin[- ]house\b|\binternal (?:stakeholders|teams|platforms?|users|customers|systems)\b|\bour (?:own )?(?:internal )?(?:platforms?|systems|technology estate|infrastructure|architecture|products?)\b/i;
export const saysInHouse = (description: string): boolean => IN_HOUSE.test(description);

/** The largest stated travel percentage, or null when the posting states none. */
export function statedTravelPercent(description: string): number | null {
  const found = [
    ...description.matchAll(/(\d{1,3})\s*%\s*(?:of (?:the |your )?(?:time )?)?(?:[\w-]+ )?travel/gi),
    ...description.matchAll(/\btravel(?:l?ing)?\b[^.%\n]{0,40}?(\d{1,3})\s*%/gi),
  ].map((match) => Number(match[1])).filter((value) => value <= 100);
  return found.length ? Math.max(...found) : null;
}

/** An employer name as compared with the design's lists: legal forms, brackets, accents and punctuation do not matter. */
export function employerKey(name: string | null | undefined): string {
  return normalizeJobIdentity({ company: (name ?? "").replace(/\([^)]*\)/g, " "), location: null }).employer;
}

/** A listed name matches itself, and itself followed by the home country ("Acme Singapore" is "Acme"). */
function sameEmployer(employer: string, listed: string): boolean {
  const name = employerKey(listed);
  return name !== "" && (employer === name || employer === `${name} singapore`);
}

const matchesAny = (employer: string, names: readonly string[]) => names.some((name) => sameEmployer(employer, name));
const hasWords = (employer: string, words: readonly string[]) =>
  words.some((word) => {
    const key = employerKey(word);
    return key !== "" && ` ${employer} `.includes(` ${key} `);
  });

export function classifySector(
  design: RankingDesign,
  companyTags: readonly CompanyIndustryTags[],
  company: string | null,
): { sector: SectorStatus; industry: string | null; source: SectorSource } {
  const employer = employerKey(company);
  const statusOf = (industry: string): SectorStatus =>
    design.industries.never.includes(industry) ? "NEVER" : design.industries.preferred.includes(industry) ? "PREFERRED" : "NEUTRAL";
  const decided = (industry: string, source: SectorSource) => ({ sector: statusOf(industry), industry, source });
  const unknown = { sector: "NEUTRAL" as SectorStatus, industry: null, source: "UNKNOWN" as SectorSource };
  if (!employer) return unknown;

  const override = design.employer_override;
  // An override name also covers its longer forms (its local or product companies).
  if (override.employers.some((name) => sameEmployer(employer, name) || employer.startsWith(`${employerKey(name)} `))) {
    return decided(override.industry, "EMPLOYER_OVERRIDE");
  }
  // The private list is the owner's word on an employer, so it wins over a tag or a name.
  const listed = design.employers
    .filter((entry) => matchesAny(employer, entry.names))
    .map((entry) => decided(entry.industry, "EMPLOYER_LIST"));
  const found = listed.length ? listed : [
    ...companyTags
      .filter((entry) => matchesAny(employer, entry.names))
      .flatMap((entry) => entry.tags)
      .flatMap((tag) => (Object.hasOwn(design.company_tag_industries, tag) ? [decided(design.company_tag_industries[tag]!, "COMPANY_TAG")] : [])),
    ...design.employer_name_words
      .filter((entry) => hasWords(employer, entry.words))
      .map((entry) => decided(entry.industry, "EMPLOYER_NAME")),
  ];
  // Never beats preferred, preferred beats neutral.
  return found.find((entry) => entry.sector === "NEVER")
    ?? found.find((entry) => entry.sector === "PREFERRED")
    ?? found[0]
    ?? unknown;
}

function hasTitlePhrase(title: string, phrases: readonly string[]): boolean {
  const spaced = (value: string) => ` ${value.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim()} `;
  const text = spaced(title);
  return phrases.some((phrase) => spaced(phrase).trim() !== "" && text.includes(spaced(phrase)));
}

export function classifyJob(
  design: RankingDesign,
  companyTags: readonly CompanyIndustryTags[],
  input: ClassifierInput,
): JobClassification {
  const reasons: string[] = [];
  const titleKind = roleKindOfTitle(input.title);
  const kind = titleKind ?? input.fallbackKind;
  reasons.push(titleKind ? "ROLE_FROM_TITLE" : kind ? "ROLE_FROM_TITLE_FAMILY" : "ROLE_UNKNOWN");
  const type = kind ? design.role_types.find((entry) => entry.kinds.includes(kind))! : null;
  const sector = classifySector(design, companyTags, input.company);
  const handsOn = showsHandsOnWork(input.title, input.description);
  const stakeholderHeavy = stakeholderMentions(input.description) >= design.stakeholder_heavy_min_mentions;
  const inHouse = saysInHouse(input.description);
  const employer = employerKey(input.company);
  const consulting = matchesAny(employer, design.consulting.employers) || hasWords(employer, design.consulting.employer_name_words);

  let status: RoleStatus = type?.status ?? design.unknown_role_status;
  const when = type?.status_when;
  if (when?.external_client_facing && input.externalClientFacing) {
    status = when.external_client_facing;
    reasons.push("EXTERNAL_CLIENT_FACING");
  } else if (when?.consulting_employer && consulting) {
    status = when.consulting_employer;
    reasons.push("CONSULTING_EMPLOYER");
  } else if (when?.in_house && inHouse) {
    status = when.in_house;
    reasons.push("IN_HOUSE_WORDING");
  }

  if (hasTitlePhrase(input.title, design.never_role_title_phrases)) {
    status = "NEVER";
    reasons.push("NEVER_TITLE_PHRASE");
  }
  if (
    design.management_without_hands_on === "NEVER" && !handsOn &&
    (input.peopleManagementCore || kind === "ENGINEERING_MANAGEMENT")
  ) {
    status = "NEVER";
    reasons.push("MANAGEMENT_WITHOUT_HANDS_ON");
  }

  const requires = type?.requires;
  if (requires) {
    const travel = statedTravelPercent(input.description);
    const failed = [
      requires.work_modes && input.workMode !== null && !requires.work_modes.includes(input.workMode) ? "REQUIRES_WORK_MODE" : null,
      requires.max_travel_percent !== undefined && travel !== null && travel > requires.max_travel_percent ? "REQUIRES_TRAVEL" : null,
      // The list is the definition of such an employer, so absence from it is a known "no".
      requires.top_technology_employer && !matchesAny(employer, design.top_technology_employers) ? "REQUIRES_TOP_TECHNOLOGY_EMPLOYER" : null,
    ].filter((reason): reason is string => reason !== null);
    if (failed.length) {
      status = "NEVER";
      reasons.push(...failed);
    }
  }
  reasons.push(`SECTOR_FROM_${sector.source}`);

  return {
    kind: kind ?? "UNKNOWN",
    roleType: type?.key ?? null,
    status,
    sector: sector.sector,
    industry: sector.industry,
    sectorSource: sector.source,
    handsOn,
    stakeholderHeavy,
    inHouse,
    remoteOrHybrid: input.workMode === "REMOTE" || input.workMode === "HYBRID",
    reasons,
  };
}
