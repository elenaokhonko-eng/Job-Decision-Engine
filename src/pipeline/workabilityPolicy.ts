import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import pg from "pg";
import { configPath } from "../config/configPaths.js";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

export interface WorkabilityPolicy {
  unknownWorkModeDisposition: "PASS" | "HARD_REJECT" | "NEEDS_VERIFICATION";
  allowedWorkModes: Array<"REMOTE" | "HYBRID" | "ONSITE">;
  onsiteOnlyAllowed: boolean;
  maxOfficeDaysPerWeek: number;
  hardFailOfficeDaysPerWeek: number;
  hybridWithoutOfficeDaysAllowed: boolean;
  authorizedRegions: string[];
  remoteWithoutTerritoryAllowed: boolean;
  rejectExplicitForeignTerritory: boolean;
  unknownWorkAuthorizationNeedsVerification: boolean;
  maxTravelPct: number;
  minimalTravelAllowed: boolean;
  contractAllowed: boolean;
  rejectAgencyContractPlacements: boolean;
  employmentAgencyCompanyNames: string[];
  minimumBuildingResearchPct: number;
  maximumInteractionPct: number;
  preferredBuildingResearchPct?: number;
  preferredInteractionPct?: number;
  regularOnCallAllowed: boolean;
  shiftWorkAllowed: boolean;
  frequentTravelAllowed: boolean;
  externalClientPrimaryAllowed: boolean;
  peopleManagementPrimaryAllowed: boolean;
  blacklistedCompanies: string[];
  /**
   * Public, non-personal research/university on-site exception (repo config).
   * Researchers' "on-site" is effectively hybrid, so these roles are not
   * rejected for on-site attendance alone.
   */
  researchOnsiteExceptions?: ResearchOnsiteExceptionConfig;
  /**
   * Personal on-site exception employers. Supplied only by the user's stage3
   * preference (`mobility.onsite_exception_employers`); empty means no exception.
   */
  onsiteExceptionEmployers?: string[];
}

export interface ResearchOnsiteExceptionConfig {
  /** Universities and research institutes (full names and common abbreviations). */
  employers: string[];
  /** Words in an employer name that mark a university or research institute. */
  employerNameTerms: string[];
  /** Hospital/health bodies whose research units qualify when a research-unit signal is present. */
  healthResearchEmployers: string[];
  /** Words that mark a research unit inside a health employer posting. */
  healthResearchUnitTerms: string[];
  /** Research title words. */
  titleTerms: string[];
  /** Title phrases that never count as a research title (for example "data scientist"). */
  titleExclusions: string[];
  /**
   * When true, a bare "scientist" title is a research exception at any employer.
   * Default false: "scientist" then needs a research employer or qualifier.
   */
  bareScientistTitleCounts?: boolean;
}

/** The five persisted verification answers understood by deterministic gates. */
export const VERIFICATION_ANSWER_KEYS = {
  workplaceOfficeDays: "workplace_hybrid_office_days_allowed",
  degreeSubjects: "profile_degree_subjects",
  workAuthorization: "work_authorization_jurisdictions",
  experienceDomains: "experience_equivalent_domains",
  travelPercentage: "lifestyle_travel_percentage_cap",
} as const;

export interface VerificationAnswerOverrides {
  workplaceOfficeDaysCap: number | null;
  degreeSubjects: string[];
  workAuthorizationRegions: string[];
  experienceDomains: string[];
  travelPercentageCap: number | null;
}

/**
 * Normalized, immutable-input context for one verification-answer revision.
 * A null/empty override means that the payload was absent or not recognized;
 * gates must then retain their ordinary UNKNOWN/NEEDS_VERIFICATION result.
 */
export interface VerificationAnswerContext {
  answerRevisionId: string | null;
  revisionNumber: number | null;
  jobVersionId: string | null;
  /** Keys explicitly present in the immutable revision, including unknown/null answers. */
  providedAnswerKeys?: string[];
  overrides: VerificationAnswerOverrides;
}

export interface VerificationAnswerContextIdentity {
  answerRevisionId?: string | null;
  jobVersionId?: string | null;
}

const defaults: WorkabilityPolicy = {
  // Missing employer evidence remains unresolved; it is not a deterministic conflict.
  unknownWorkModeDisposition: "NEEDS_VERIFICATION",
  allowedWorkModes: ["REMOTE", "HYBRID"],
  onsiteOnlyAllowed: false,
  maxOfficeDaysPerWeek: 3,
  hardFailOfficeDaysPerWeek: 4,
  hybridWithoutOfficeDaysAllowed: true,
  authorizedRegions: ["SINGAPORE"],
  remoteWithoutTerritoryAllowed: true,
  rejectExplicitForeignTerritory: true,
  unknownWorkAuthorizationNeedsVerification: false,
  maxTravelPct: 20,
  minimalTravelAllowed: true,
  contractAllowed: true,
  rejectAgencyContractPlacements: true,
  employmentAgencyCompanyNames: [],
  minimumBuildingResearchPct: 60,
  maximumInteractionPct: 60,
  preferredBuildingResearchPct: 85,
  preferredInteractionPct: 15,
  regularOnCallAllowed: false,
  shiftWorkAllowed: false,
  frequentTravelAllowed: false,
  externalClientPrimaryAllowed: false,
  peopleManagementPrimaryAllowed: false,
  blacklistedCompanies: [],
  researchOnsiteExceptions: {
    employers: [],
    employerNameTerms: [],
    healthResearchEmployers: [],
    healthResearchUnitTerms: [],
    titleTerms: [],
    titleExclusions: [],
  },
  onsiteExceptionEmployers: [],
};

/**
 * Regional terms that include an authorized country. A worker restriction to
 * "Southeast Asia" or "APAC" includes Singapore; it is not a foreign territory.
 */
const REGION_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  SOUTHEAST_ASIA: ["SINGAPORE", "MALAYSIA", "INDONESIA", "THAILAND", "VIETNAM", "PHILIPPINES"],
  ASIA_PACIFIC: [
    "SINGAPORE", "MALAYSIA", "INDONESIA", "THAILAND", "VIETNAM", "PHILIPPINES", "JAPAN", "CHINA",
    "HONG_KONG", "TAIWAN", "SOUTH_KOREA", "INDIA", "AUSTRALIA", "NEW_ZEALAND",
  ],
};

/** True when a territory is authorized directly or is a region that contains an authorized country. */
export function isTerritoryAuthorized(territory: string, authorizedRegions: Iterable<string>): boolean {
  const allowed = new Set(normalizeTerritories([...authorizedRegions]));
  const canonical = normalizeTerritory(territory);
  if (!canonical) return false;
  if (allowed.has(canonical)) return true;
  return (REGION_MEMBERS[canonical] ?? []).some((member) => allowed.has(member));
}

const TERRITORY_ALIASES: Array<[string, string[]]> = [
  ["SINGAPORE", ["singapore", "sg"]],
  ["UNITED_STATES", ["united states", "usa", "u.s.", "us", "new york", "boston", "chicago", "austin", "seattle", "san francisco", "los angeles"]],
  ["CANADA", ["canada", "toronto", "vancouver", "montreal"]],
  ["EUROPEAN_UNION", ["european union", "eu", "europe"]],
  ["UNITED_KINGDOM", ["united kingdom", "uk", "great britain", "england", "london", "manchester", "edinburgh"]],
  ["AUSTRALIA", ["australia", "australian", "sydney", "melbourne", "brisbane", "perth"]],
  ["NEW_ZEALAND", ["new zealand", "auckland", "wellington"]],
  ["ROMANIA", ["romania", "romanian", "bucharest"]],
  ["GERMANY", ["germany", "german", "berlin", "munich", "frankfurt"]],
  ["FRANCE", ["france", "french", "paris"]],
  ["SPAIN", ["spain", "spanish", "madrid", "barcelona"]],
  ["ITALY", ["italy", "italian", "rome", "milan"]],
  ["NETHERLANDS", ["netherlands", "dutch", "amsterdam"]],
  ["BELGIUM", ["belgium", "belgian", "brussels"]],
  ["SWITZERLAND", ["switzerland", "swiss", "zurich", "geneva"]],
  ["AUSTRIA", ["austria", "austrian", "vienna"]],
  ["IRELAND", ["ireland", "irish", "dublin"]],
  ["PORTUGAL", ["portugal", "portuguese", "lisbon"]],
  ["POLAND", ["poland", "polish", "warsaw", "krakow"]],
  ["CZECHIA", ["czechia", "czech republic", "prague"]],
  ["GREECE", ["greece", "greek", "athens"]],
  ["DENMARK", ["denmark", "danish", "copenhagen"]],
  ["SWEDEN", ["sweden", "swedish", "stockholm"]],
  ["NORWAY", ["norway", "norwegian", "oslo"]],
  ["FINLAND", ["finland", "finnish", "helsinki"]],
  ["INDIA", ["india", "indian", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "chennai"]],
  ["MALAYSIA", ["malaysia", "malaysian", "kuala lumpur"]],
  ["PHILIPPINES", ["philippines", "filipino", "manila"]],
  ["INDONESIA", ["indonesia", "indonesian", "jakarta"]],
  ["THAILAND", ["thailand", "thai", "bangkok"]],
  ["VIETNAM", ["vietnam", "vietnamese", "hanoi", "ho chi minh"]],
  ["JAPAN", ["japan", "japanese", "tokyo"]],
  ["CHINA", ["china", "chinese", "beijing", "shanghai", "shenzhen"]],
  ["HONG_KONG", ["hong kong"]],
  ["TAIWAN", ["taiwan", "taiwanese", "taipei"]],
  ["SOUTH_KOREA", ["south korea", "korean", "seoul"]],
  ["ISRAEL", ["israel", "israeli", "tel aviv"]],
  ["UNITED_ARAB_EMIRATES", ["united arab emirates", "uae", "dubai", "abu dhabi"]],
  ["SAUDI_ARABIA", ["saudi arabia", "ksa", "riyadh", "jeddah", "dammam"]],
  ["QATAR", ["qatar", "doha"]],
  ["SOUTH_AFRICA", ["south africa", "south african", "johannesburg", "cape town"]],
  ["BRAZIL", ["brazil", "brazilian", "sao paulo", "rio de janeiro"]],
  ["MEXICO", ["mexico", "mexican", "mexico city"]],
  ["ARGENTINA", ["argentina", "argentinian", "buenos aires"]],
  ["CHILE", ["chile", "chilean", "santiago"]],
  ["COLOMBIA", ["colombia", "colombian", "bogota"]],
  // Regions are listed after countries; isTerritoryAuthorized resolves their members.
  ["SOUTHEAST_ASIA", ["southeast asia", "south east asia", "south-east asia", "asean"]],
  ["ASIA_PACIFIC", ["apac", "asia pacific", "asia-pacific", "apj"]],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize dotted country abbreviations before territory matching. Job
 * boards commonly emit `U.S.`/`U.K.` in location labels; sentence splitting
 * would otherwise turn those into unrelated one-letter fragments and hide an
 * explicit work-territory restriction.
 */
function normalizeTerritorySearchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bu\s*\.\s*s\.?/g, "us")
    .replace(/\bu\s*\.\s*k\.?/g, "uk")
    .replace(/\be\s*\.\s*u\.?/g, "eu");
}

const PROTECTED_ABBREVIATION_PERIOD = "\uE000";

function protectTerritoryAbbreviationPeriods(value: string): string {
  const protect = (match: string, offset: number, source: string): string => {
    const nextText = source.slice(offset + match.length);
    const hasSentenceBoundaryAfterAbbreviation = match.endsWith(".") && /^\s+[A-Z]/.test(nextText);
    const abbreviation = hasSentenceBoundaryAfterAbbreviation ? match.slice(0, -1) : match;
    return abbreviation.replace(/\./g, PROTECTED_ABBREVIATION_PERIOD) + match.slice(abbreviation.length);
  };
  return value
    .replace(/\bu\s*\.\s*s\.?/gi, protect)
    .replace(/\bu\s*\.\s*k\.?/gi, protect)
    .replace(/\be\s*\.\s*u\.?/gi, protect);
}

export function splitWorkabilityClauses(value: unknown): string[] {
  return String(value ?? "")
    .split(/(?:[.!?;]+\s*|\r?\n+|,\s*(?=(?:but|however|although|yet)\b))/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

export function normalizeTerritory(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return null;
  const match = TERRITORY_ALIASES.find(([, aliases]) => aliases.includes(normalized));
  return match?.[0] ?? normalized.toUpperCase().replace(/\s+/g, "_");
}

export function normalizeTerritories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeTerritory).filter((item): item is string => Boolean(item)))];
}

export function extractTerritories(value: unknown): string[] {
  const text = normalizeTerritorySearchText(value);
  const found: string[] = [];
  for (const [territory, aliases] of TERRITORY_ALIASES) {
    if (aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(text))) {
      found.push(territory);
    }
  }
  return found;
}

export function inferTerritoryOperator(value: unknown): "ANY" | "ALL" | "UNKNOWN" {
  const text = normalizeTerritorySearchText(value);
  const mentions = TERRITORY_ALIASES.flatMap(([territory, aliases]) => aliases.flatMap((alias) => {
    const matches = [...text.matchAll(new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi"))];
    return matches.map((match) => ({ territory, index: match.index ?? -1, end: (match.index ?? -1) + match[0].length }));
  })).filter((mention) => mention.index >= 0)
    .sort((left, right) => left.index - right.index || right.end - left.end);
  const distinctMentions = mentions.filter((mention, index) =>
    index === 0 || mention.index >= (mentions[index - 1]?.end ?? -1)
  );
  const countries = [...new Set(distinctMentions.map((mention) => mention.territory))];
  if (countries.length === 0) return "UNKNOWN";
  if (countries.length === 1) return "ANY";

  const joins: Array<"ANY" | "ALL" | "UNKNOWN"> = [];
  for (let index = 1; index < distinctMentions.length; index++) {
    const previous = distinctMentions[index - 1];
    const current = distinctMentions[index];
    if (!previous || !current || previous.territory === current.territory) continue;
    const between = text.slice(previous.end, current.index).trim();
    if (/\b(?:or|either)\b|\//i.test(between)) joins.push("ANY");
    else if (/^and$/i.test(between)) joins.push("ALL");
    else joins.push("UNKNOWN");
  }
  if (joins.length === 0 || joins.includes("UNKNOWN") || new Set(joins).size !== 1) return "UNKNOWN";
  return joins[0] ?? "UNKNOWN";
}

const KNOWN_TERRITORIES = new Set(TERRITORY_ALIASES.map(([territory]) => territory));

function answerObject(content: unknown): Record<string, unknown> {
  let parsed = content;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const nested = [root.answers, root.verification_answers, root.content]
    .find((value) => value && typeof value === "object" && !Array.isArray(value));
  return nested ? nested as Record<string, unknown> : root;
}

function answerValue(root: Record<string, unknown>, key: string, ordinal: number): unknown {
  const aliases = [key, `Q0${ordinal}`, `q0${ordinal}`];
  for (const candidate of [root, root.answers, root.verification_answers]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(record, alias)) return record[alias];
    }
  }
  return undefined;
}

function flattenAnswerValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenAnswerValues);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(flattenAnswerValues);
  return value === null || value === undefined ? [] : [value];
}

function answerKeyProvided(root: Record<string, unknown>, key: string, ordinal: number): boolean {
  const aliases = [key, `Q0${ordinal}`, `q0${ordinal}`];
  for (const candidate of [root, root.answers, root.verification_answers]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (aliases.some((alias) => Object.prototype.hasOwnProperty.call(record, alias))) return true;
  }
  return false;
}

function answerText(value: unknown): string {
  return flattenAnswerValues(value)
    .map((item) => String(item).trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function parseAnswerNumber(value: unknown, maximum: number, unitPattern: RegExp): number | null {
  const values = flattenAnswerValues(value);
  for (const item of values) {
    if (typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= maximum) {
      return item;
    }
    const text = String(item).trim().toLowerCase();
    if (!text) continue;
    if (/^(?:fully\s+)?remote(?:\s+only)?$|^no\s+(?:office|travel)$/i.test(text)) return 0;
    const match = text.match(unitPattern) || text.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\b`));
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum) return parsed;
  }
  return null;
}

/** Normalize the degree-subject vocabulary used by verification answer options. */
export function normalizeVerificationDegreeSubjects(value: unknown): string[] {
  const text = answerText(value).replace(/[_-]+/g, " ");
  const subjects: string[] = [];
  const add = (subject: string) => {
    if (!subjects.includes(subject)) subjects.push(subject);
  };
  if (/\b(computer\s+science|computing|informatics|software\s+engineering)\b/i.test(text)) add("computer_science");
  if (/\b(data\s+science|analytics?|statistics?)\b/i.test(text)) add("data_science");
  if (/\b(mathematics?|mathematical|quantitative)\b/i.test(text)) add("mathematics");
  if (/\b(electrical|systems?)\s+engineering\b|\bengineering\b/i.test(text) && !/software\s+engineering/i.test(text)) add("engineering");
  if (/\bphysics?|computational\s+science\b/i.test(text)) add("physics");
  if (/\b(biology|biological|biomedical|biochemistry)\b/i.test(text)) add("biology");
  if (/\b(finance|financial|economics?)\b/i.test(text)) add("finance");
  if (/\b(business|management)\b/i.test(text)) add("business");
  if (/\b(law|legal\s+studies|jurisprudence)\b/i.test(text)) add("law");
  return subjects;
}

/** Normalize accepted equivalent experience domains without treating free text as evidence. */
export function normalizeVerificationExperienceDomains(value: unknown): string[] {
  const text = answerText(value);
  const domains: string[] = [];
  const add = (domain: string) => {
    if (!domains.includes(domain)) domains.push(domain);
  };
  if (/\b(ai|artificial\s+intelligence|machine\s+learning|\bml\b|llm|generative\s+ai|computer\s+vision)\b/i.test(text)) add("ai");
  if (/\b(software|full[- ]?stack|backend|frontend|application|coding|web)\b/i.test(text)) add("software");
  if (/\b(data|analytics?|etl|pipeline|warehous(?:e|ing)|business\s+intelligence)\b/i.test(text)) add("data");
  if (/\b(cloud|devops|infrastructure|platform|kubernetes|terraform)\b/i.test(text)) add("cloud_devops");
  return domains;
}

function normalizeVerificationAuthorizationRegions(value: unknown): string[] {
  const regions: string[] = [];
  for (const item of flattenAnswerValues(value)) {
    for (const territory of extractTerritories(String(item))) {
      if (KNOWN_TERRITORIES.has(territory) && !regions.includes(territory)) regions.push(territory);
    }
    const normalized = normalizeTerritory(item);
    if (normalized && KNOWN_TERRITORIES.has(normalized) && !regions.includes(normalized)) {
      regions.push(normalized);
    }
  }
  return regions;
}

/**
 * Convert the immutable `verification_answers` revision payload into the
 * narrow contract consumed by gates. Unrecognized values intentionally yield
 * no override; the caller must not infer a fact from an arbitrary string.
 */
export function createVerificationAnswerContext(
  content: unknown,
  identity: VerificationAnswerContextIdentity & { revisionNumber?: number | null } = {},
): VerificationAnswerContext {
  const root = answerObject(content);
  const officeDays = parseAnswerNumber(
    answerValue(root, VERIFICATION_ANSWER_KEYS.workplaceOfficeDays, 1),
    3,
    /(\d+(?:\.\d+)?)\s*days?/i,
  );
  const travelPct = parseAnswerNumber(
    answerValue(root, VERIFICATION_ANSWER_KEYS.travelPercentage, 5),
    100,
    /(\d+(?:\.\d+)?)\s*%/i,
  );

  return {
    answerRevisionId: identity.answerRevisionId ?? null,
    revisionNumber: identity.revisionNumber ?? null,
    jobVersionId: identity.jobVersionId ?? null,
    providedAnswerKeys: Object.values(VERIFICATION_ANSWER_KEYS).filter((key, index) =>
      answerKeyProvided(root, key, index + 1)
    ),
    overrides: {
      workplaceOfficeDaysCap: officeDays,
      degreeSubjects: normalizeVerificationDegreeSubjects(answerValue(root, VERIFICATION_ANSWER_KEYS.degreeSubjects, 2)),
      workAuthorizationRegions: normalizeVerificationAuthorizationRegions(answerValue(root, VERIFICATION_ANSWER_KEYS.workAuthorization, 3)),
      experienceDomains: normalizeVerificationExperienceDomains(answerValue(root, VERIFICATION_ANSWER_KEYS.experienceDomains, 4)),
      travelPercentageCap: travelPct,
    },
  };
}

/** Map a registry row or revision-shaped object without exposing registry types here. */
export function mapVerificationAnswerRevision(
  revision: { content?: unknown; id?: string | null; configRevisionId?: string | null; revisionNumber?: number | null; answerRevisionId?: string | null },
  identity: VerificationAnswerContextIdentity & { revisionNumber?: number | null } = {},
): VerificationAnswerContext {
  return createVerificationAnswerContext(revision.content, {
    answerRevisionId: identity.answerRevisionId ?? revision.answerRevisionId ?? revision.configRevisionId ?? revision.id ?? null,
    revisionNumber: identity.revisionNumber ?? revision.revisionNumber ?? null,
    jobVersionId: identity.jobVersionId ?? null,
  });
}

/** Return false when a task's answer/job identity does not match its context. */
export function isVerificationAnswerContextApplicable(
  answerContext: VerificationAnswerContext | null | undefined,
  expected: VerificationAnswerContextIdentity = {},
): boolean {
  if (!answerContext) return false;
  if (expected.answerRevisionId !== undefined && expected.answerRevisionId !== null
    && answerContext.answerRevisionId !== expected.answerRevisionId) return false;
  if (expected.jobVersionId !== undefined && expected.jobVersionId !== null
    && answerContext.jobVersionId !== null && answerContext.jobVersionId !== expected.jobVersionId) return false;
  return true;
}

export function isVerificationAnswerProvided(
  answerContext: VerificationAnswerContext | null | undefined,
  key: string,
): boolean {
  return answerContext?.providedAnswerKeys?.includes(key) ?? false;
}

/** Apply only the workability axes represented by recognized answer values. */
export function applyVerificationAnswerOverrides(
  policy: WorkabilityPolicy,
  answerContext?: VerificationAnswerContext | null,
): WorkabilityPolicy {
  if (!answerContext) return policy;
  const overrides = answerContext.overrides;
  const next: WorkabilityPolicy = { ...policy };
  const workplaceAnswerProvided = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.workplaceOfficeDays,
  );
  if (overrides.workplaceOfficeDaysCap !== null || workplaceAnswerProvided) {
    if (overrides.workplaceOfficeDaysCap !== null) {
      next.maxOfficeDaysPerWeek = overrides.workplaceOfficeDaysCap;
    }
    // A known or explicitly unanswered personal cap cannot resolve a posting
    // that omits its office-day count. Require the missing job fact instead of
    // treating it as a pass.
    next.hybridWithoutOfficeDaysAllowed = false;
  }
  const workAuthorizationAnswerProvided = isVerificationAnswerProvided(
    answerContext,
    VERIFICATION_ANSWER_KEYS.workAuthorization,
  );
  if (overrides.workAuthorizationRegions.length > 0) {
    next.authorizedRegions = [...overrides.workAuthorizationRegions];
  }
  if (workAuthorizationAnswerProvided) {
    next.unknownWorkAuthorizationNeedsVerification = true;
  }
  if (overrides.travelPercentageCap !== null) {
    next.maxTravelPct = overrides.travelPercentageCap;
  }
  return next;
}

interface VerificationAnswerRevisionRow {
  id: string;
  revision_number: number;
  content: unknown;
}

/**
 * Load one active or explicitly requested answer revision. Read failures are
 * deliberately converted to `null`: answer persistence is advisory to the
 * gate, and an operational registry outage must never become a career reject.
 */
export async function loadVerificationAnswerContext(
  clientOrPool: pg.Pool | pg.PoolClient,
  options: {
    context?: WorkspaceContext;
    answerRevisionId?: string | null;
    jobVersionId?: string | null;
  } = {},
): Promise<VerificationAnswerContext | null> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  let client: pg.Pool | pg.PoolClient = clientOrPool;

  try {
    if (ownsClient) client = await clientOrPool.connect();
    const ctx = options.context ?? (await resolveWorkspaceContext(client as any));
    const requestedRevisionId = options.answerRevisionId ?? null;
    const query = requestedRevisionId
      ? `SELECT cr.id, cr.revision_number, cr.content
         FROM config_definitions cd
         JOIN config_revisions cr ON cr.config_definition_id = cd.id
         WHERE cd.workspace_id = $1
           AND cd.config_key = 'verification_answers'
           AND cr.id = $2
         LIMIT 1`
      : `SELECT cr.id, cr.revision_number, cr.content
         FROM config_definitions cd
         JOIN config_active_revisions car ON car.config_definition_id = cd.id
         JOIN config_revisions cr ON cr.id = car.config_revision_id
         WHERE cd.workspace_id = $1
           AND cd.config_key = 'verification_answers'
         LIMIT 1`;
    const values = requestedRevisionId ? [ctx.workspaceId, requestedRevisionId] : [ctx.workspaceId];
    const result = await client.query<VerificationAnswerRevisionRow>(query, values);
    const row = result.rows[0];
    if (!row) return null;
    return createVerificationAnswerContext(row.content, {
      answerRevisionId: row.id,
      revisionNumber: row.revision_number,
      jobVersionId: options.jobVersionId ?? null,
    });
  } catch {
    return null;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

/**
 * A territory mention is only a work-location restriction when the source
 * sentence also contains an employment/location qualifier. This prevents
 * references such as "US clients" from becoming false location rejections.
 */
export interface ExplicitWorkerTerritoryRequirement {
  readonly territories: readonly string[];
  readonly operator: "ANY" | "ALL" | "UNKNOWN";
  readonly evidenceText: string;
}

export interface WorkerTerritoryEvaluation {
  readonly status: "ALLOWED" | "INCOMPATIBLE" | "NEEDS_VERIFICATION";
  readonly incompatibleTerritories: readonly string[];
  /** The conditions that exclude the authorized regions; their text is the gate's evidence. */
  readonly incompatibleRequirements: readonly ExplicitWorkerTerritoryRequirement[];
  readonly unresolvedRequirements: readonly ExplicitWorkerTerritoryRequirement[];
}

/**
 * The job facts some worker conditions depend on. Without it (readiness, source evidence,
 * persisted requirement quotes) the location-dependent rules stay off: no "US-based"
 * placement and no U.S. reading of a clearance that names no government.
 */
export interface WorkerTerritoryContext {
  /** The job's own location field. */
  readonly jobLocation?: string | null;
  /** Regions the user may work in; an applicant-addressed opening to one cancels a US placement. */
  readonly authorizedRegions?: readonly string[];
}

export function extractExplicitWorkerTerritoryRequirements(value: unknown, context?: WorkerTerritoryContext): ExplicitWorkerTerritoryRequirement[] {
  const protectedText = protectTerritoryAbbreviationPeriods(String(value ?? ""));
  const requirements: ExplicitWorkerTerritoryRequirement[] = [];
  for (const part of protectedText.split(/[.!?;\n]+/)) {
    const sentence = part.replaceAll(PROTECTED_ABBREVIATION_PERIOD, ".").trim();
    if (!sentence) continue;
    const territories = extractTerritories(sentence).filter((territory) => hasExplicitTerritoryRestriction(sentence, territory));
    if (territories.length === 0) continue;
    requirements.push({
      territories: [...new Set(territories)],
      operator: inferTerritoryOperator(sentence),
      evidenceText: sentence,
    });
  }
  const seen = new Set(requirements.map((requirement) => requirement.evidenceText.toLowerCase()));
  for (const requirement of extractGovernmentEligibilityRequirements(String(value ?? ""), context)) {
    if (seen.has(requirement.evidenceText.toLowerCase())) continue;
    seen.add(requirement.evidenceText.toLowerCase());
    requirements.push(requirement);
  }
  return requirements;
}

// ── Remote jobs located in the United States ──
// A remote posting whose location field is only the United States, a US state or a
// US city hires there unless the posting opens the role wider. "Georgia" is left out
// because it is also a country; ", GA" still matches.
const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma",
  "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
  "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia", "puerto rico",
];
const US_STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me",
  "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa",
  "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc", "pr",
]);
const US_STATE_NAME_PATTERN = new RegExp(`\\b(?:${US_STATE_NAMES.map(escapeRegExp).join("|")})\\b`, "i");

/**
 * True when a location field names the United States (country, state, state code
 * after a comma, or a listed US city) and no other territory.
 */
export function isUnitedStatesOnlyLocation(location: unknown): boolean {
  const text = normalizeTerritorySearchText(location).replace(/\s+/g, " ").trim();
  if (!text) return false;
  const territories = extractTerritories(text);
  if (territories.some((territory) => territory !== "UNITED_STATES")) return false;
  if (territories.includes("UNITED_STATES")) return true;
  if (US_STATE_NAME_PATTERN.test(text)) return true;
  return [...text.matchAll(/,\s*([a-z]{2})\b/g)].some((match) => US_STATE_CODES.has(match[1] ?? ""));
}

// ── Is the role opened beyond the United States? ──
// Only wording addressed to applicants opens a role: "candidates in Singapore are welcome",
// "open to applicants worldwide", "Location: Remote - APAC". Employer facts ("a worldwide
// leader", "clients in Asia", "our APAC team is based in Tokyo") do not, and "anywhere in
// the continental US / in America / the lower 48" is US-only.

const US_LIMITED_SCOPE = /\b(?:(?:continental|contiguous)\s+(?:us|usa|united\s+states)|lower\s+(?:48|forty[- ]eight)|(?:48|50)\s+states|(?:in|within|across|throughout)\s+(?:the\s+)?(?:us|usa|united\s+states|america|americas|north\s+america)|(?:in|within|across|throughout)\s+(?:the\s+)?[a-z]+\s+(?:or|and|\/)\s+(?:the\s+)?(?:us|usa|united\s+states))\b/i;
/** "We are not limited to the US": an opening, and not a negated one. */
const NOT_LIMITED_TO_US = /\bnot\s+(?:limited|restricted)\s+to\s+(?:the\s+)?(?:us|usa|united\s+states)\b/i;
const GLOBAL_OPENING = /\b(?:(?:candidates?|applicants?|talent|people|engineers?)\s+(?:from\s+|based\s+|located\s+)?(?:worldwide|globally|anywhere(?:\s+in\s+the\s+world)?|around\s+the\s+world|(?:from|in)\s+any\s+country)|(?:hire|hires|hiring|recruit|recruiting)\s+(?:\w+\s+){0,2}(?:globally|worldwide|internationally|anywhere(?:\s+in\s+the\s+world)?)|open\s+(?:to\s+(?:\w+\s+){0,3})?(?:worldwide|globally|internationally|anywhere\s+in\s+the\s+world)|(?:work|working|remote|remotely)\s+from\s+anywhere(?:\s+in\s+the\s+world)?|anywhere\s+in\s+the\s+world|global(?:ly)?[\s-]+remote|remote[\s,(-]+(?:global|worldwide)|fully\s+global|from\s+any\s+country)\b/i;
const ASIA_REGION = /\b(?:asian?(?!\s+americans?\b)|south[\s-]?east\s+asian?|apac|asia[\s-]pacific)\b/i;
/** Wording addressed to the applicant. */
const APPLICANT_FRAME = /\b(?:candidates?|applicants?|talent|hir(?:e|es|ed|ing)|recruit(?:ing)?|open\s+to|eligible|welcome[ds]?|considered|consider(?:ing)?|accept(?:ing|ed)?)\b|\blocation\s*:|\bremote\s*[-–—:(]|\byou\s+(?:can|may|could|are|'re|will\s+be)\s+(?:\w+\s+){0,3}(?:based|located|work|working|live|living|reside|residing|remote)\b/i;
/** Where-you-work wording that counts only when the subject is not the employer's own team or office. */
const PLACE_FRAME = /\b(?:based|located|living|residing|reside|work(?:ing)?\s+(?:remotely\s+)?from|remote(?:ly)?\s+(?:from|in|within|across))\b/i;
const EMPLOYER_SUBJECT = /\b(?:our|the|we|company|firm)\s+(?:\w+\s+){0,2}(?:team|teams|office|offices|headquarters|hq|clients?|customers?|partners?|company|business|operations)\b|\bheadquartered\b/i;
const NEGATION = /\b(?:not|no|never|cannot|can['’]t|unable|isn['’]t|aren['’]t|don['’]t|doesn['’]t|won['’]t|wouldn['’]t|ineligible|excluding|except)\b/i;
/** A staff-benefit line: a region with "eligible for" or "hires receive/get" and a benefit noun. */
const STAFF_BENEFIT_FRAME = /\beligible\s+for\b|\bhires?\s+(?:\w+\s+){0,2}(?:receive|get)\b/i;
const BENEFIT_NOUN = /\b(?:benefits?|stipends?|allowances?|plans?|insurance|perks?)\b/i;
const STAFF_SUBJECT = /\b(?:employees|staff|team\s+members|hires)\b/i;
const APPLICANT_WORDING = /\b(?:candidates?|applicants?|you|your|open\s+to|welcome[ds]?|this\s+role)\b/i;

function plainClauses(value: unknown): string[] {
  const text = String(value ?? "").replace(/<[^>]+>/g, "\n");
  return protectTerritoryAbbreviationPeriods(text)
    .split(/[.!?;\n]+/)
    .map((part) => normalizeTerritorySearchText(part.replaceAll(PROTECTED_ABBREVIATION_PERIOD, ".")).trim())
    .filter(Boolean);
}

/**
 * True when the description, anywhere in it, opens the role to applicants worldwide or in
 * an authorized region (Singapore, Southeast Asia, APAC) or Asia. Each sentence or list item
 * is read on its own, so an opening in the next sentence still counts.
 */
export function postingOpensRemoteBeyondUnitedStates(description: unknown, authorizedRegions: readonly string[]): boolean {
  const namesRegion = (text: string) => ASIA_REGION.test(text)
    || (authorizedRegions.length > 0 && extractTerritories(text).some((territory) => isTerritoryAuthorized(territory, authorizedRegions)));
  return plainClauses(description).some((clause) => {
    // A negation cancels the opening only in the part of the clause that names the region or
    // the global scope ("not open to candidates in Singapore", "we cannot hire in APAC");
    // "no relocation needed" or "no visa sponsorship required" beside it does not.
    if (negationGoverns(clause, (part) => namesRegion(part) || GLOBAL_OPENING.test(part))) return false;
    if (NOT_LIMITED_TO_US.test(clause)) return true;
    if (GLOBAL_OPENING.test(clause) && !US_LIMITED_SCOPE.test(clause)) return true;
    if (!namesRegion(clause)) return false;
    // A staff-benefit line ("employees in APAC are eligible for ...", "our APAC hires receive a
    // stipend") describes staff, not applicants; a line that also addresses applicants does not.
    if (STAFF_BENEFIT_FRAME.test(clause) && BENEFIT_NOUN.test(clause)
      && STAFF_SUBJECT.test(clause) && !APPLICANT_WORDING.test(clause)) return false;
    return APPLICANT_FRAME.test(clause) || (PLACE_FRAME.test(clause) && !EMPLOYER_SUBJECT.test(clause));
  });
}

/** The parts of one clause that a negation can govern: split at commas, colons, dashes and conjunctions. */
/**
 * True when a negation governs a part of the clause that `governs` accepts. A negation in a
 * head clause also governs its relative clause ("We are not able to hire candidates who are
 * based in Singapore"); a negation inside a relative clause governs only that relative clause
 * ("Candidates in APAC who cannot relocate are welcome" is still an opening).
 */
function negationGoverns(clause: string, governs: (part: string) => boolean): boolean {
  return clause.split(/\s*[,:–—()]\s*|\s+-\s+|\s+(?:and|but|while|with|so)\s+/i).some((coarse) => {
    const [head = "", ...rest] = coarse.split(/\s+(?:who|which|that)\s+/i);
    const relative = rest.join(" ");
    if (NEGATION.test(head.replace(NOT_LIMITED_TO_US, " ")) && governs(coarse)) return true;
    return relative !== "" && NEGATION.test(relative) && governs(relative);
  });
}

function subClauses(clause: string): string[] {
  // Relative clauses ("who aren't able to relocate") and parentheses ("(no relocation)") are their own parts.
  return clause.split(/\s*[,:–—()]\s*|\s+-\s+|\s+(?:and|but|while|with|so|who|which|that)\s+/i).map((part) => part.trim()).filter(Boolean);
}

// ── Government citizenship and security-clearance requirements ──
// A national security clearance or a citizenship condition restricts who may be hired.
// Its government comes from the requirement clause itself (the sentence or list item):
// "U.S. Government security clearance", "DoD Secret", "Public Trust clearance", "TS/SCI",
// "VA clearance". Nearby text never makes a clearance U.S.: "U.S. GAAP", "USA equities",
// "government agencies" or "federal agencies" in another sentence are not U.S. clearances.
// A clause that names no government is U.S. only when the job itself is located in the US.

/** U.S. government markers read inside the requirement clause. */
const US_GOVERNMENT_MARKER = /\b(?:(?:united\s+states|usa|u\s*\.\s*s\b\.?|us|american)\s+(?:government|federal|citizens?|citizenship|nationals?|persons?|department|army|navy|air\s+force|marine\s+corps|military|security\s+clearance|secret|top\s+secret|clearance|dod|defen[cs]e)|federal\s+(?:background\s+investigation|security\s+clearance)|va\s+clearance|department\s+of\s+(?:defense|war|veterans\s+affairs|homeland\s+security|health\s+and\s+human\s+services|energy|the\s+navy|the\s+army|the\s+air\s+force)|veterans\s+affairs|dod|dow\s+(?:secret|top\s+secret|security|clearance)|dhs|doe\s+[ql]\b|public\s+trust\s+(?:clearance|position|background\s+investigation|suitability|eligibility|level)|ts\s*\/\s*sci|polygraph|e-?qip|sf-?86)\b|\((?:u\s*\.\s*s\.?|us|usa|united\s+states)\)/i;
/** Context that makes a truncated "S. Citizenship" read as U.S.; "federal" or "VA" near it is enough. */
const US_FEDERAL_NEARBY = /\b(?:federal|va|veterans\s+affairs|dod|department\s+of\s+defense|public\s+trust\s+(?:clearance|position)|ts\s*\/\s*sci|polygraph|u\s*\.\s*s\b|united\s+states)\b/i;
/** EEO, benefits, pay and legal boilerplate; it names the USA or "federal" law without describing the work. */
const BOILERPLATE_SENTENCE = /\b(?:equal\s+(?:employment\s+)?opportunity|eeo|affirmative\s+action|protected\s+veteran|veteran\s+status|race|religion|national\s+origin|sexual\s+orientation|gender\s+identity|disabilit(?:y|ies)|federal,?\s+state,?\s+(?:and|or)\s+local|e-?verify|reasonable\s+accommodations?|benefits?|401\s*\(?k\)?|insurance|paid\s+(?:time\s+off|leave)|salar(?:y|ies)|compensation|pay\s+(?:range|transparency)|privacy\s+(?:policy|notice)|applicable\s+laws?)\b/i;
const UK_GOVERNMENT_MARKER = /\b(?:(?:sc|dv|bpss|ctc|nppv\d?)\s*(?:\(|level\b|clearance|cleared|vetting)|security\s+check\s*\(sc\)|developed\s+vetting|uk\s+(?:government|security\s+clearance)|hmg)\b/i;
const AU_GOVERNMENT_MARKER = /\b(?:baseline\s+(?:security\s+)?clearance|nv[12]|negative\s+vetting|positive\s+vetting|agsva)\b/i;
const CA_GOVERNMENT_MARKER = /\b(?:(?:enhanced\s+)?reliability\s+status|government\s+of\s+canada)\b/i;

/** A government security clearance or investigation, never "customs clearance" or a generic background check. */
const GOVERNMENT_CLEARANCE = /\b(?:(?:security|government|federal|secret|top\s+secret|ts\s*\/\s*sci|public\s+trust|va|dod|dow|sc|dv|baseline|nv[12])\s+clearances?|ts\s*\/\s*sci|top\s+secret|public\s+trust\s+(?:position|background\s+investigation|suitability|eligibility|level)|(?:federal|government|suitability)\s+background\s+investigations?|(?:active|current)\s+clearance|developed\s+vetting|negative\s+vetting|(?:enhanced\s+)?reliability\s+status)\b|\bclearance(?:\s+level)?\s*:/i;
const NON_SECURITY_CLEARANCE = /\b(?:customs|medical|trade|import|export|regulatory|tax|financial)\s+clearance\b/i;
const MANDATORY_CUE = /\b(?:requir(?:e|ed|es|ement|ements)|must|mandatory|ability\s+to\s+(?:obtain|maintain|hold|pass)|able\s+to\s+(?:obtain|maintain|hold|pass)|eligib\w*|obtain|maintain|hold|possess|active|current)\b|\bclearance(?:\s+level)?\s*:/i;
const OPTIONAL_CUE = /\b(?:preferred|a\s+plus|nice\s+to\s+have|bonus|desirable|advantageous|not\s+required|no\s+(?:security\s+)?clearance|does\s+not\s+require|not\s+needed|optional)\b/i;
/** Pay-range, pay-factor and benefits boilerplate mentions clearances or locations without requiring them. */
const PAY_OR_BENEFITS_SENTENCE = /\b(?:salar(?:y|ies)|pay\s+(?:range|scale|rate|band)|base\s+pay|compensation|benefits?)\b/i;
/** A conditional licence or approval check ("may be required ... whether any export license, security clearance ... is required"). */
const CONDITIONAL_APPROVAL_SENTENCE = /\b(?:may|might|could)\s+be\s+required\b|\bwhether\b|\bexport\s+(?:licen[cs]e|control|controls|laws?|regulations?)\b/i;

/** The clause's own government, or null when it names none. */
/** A "Clearance:" / "Security clearance:" header field; group 1 is its value. */
const CLEARANCE_HEADER = /\bclearance(?:\s+(?:level|required|requirements?))?\s*:\s*(.*)$/i;
/**
 * A header value that starts by saying there is no clearance is neutral, whatever it names
 * later: "None required (non-government role)", "N/A (commercial, not federal)", "No active
 * clearance needed", "Background check only, no government clearance".
 */
const NEUTRAL_HEADER_VALUE = /^\s*(?:none|n\s*\/\s*a|na|no|not|nil|tbd|unknown|background\s+check\s+only)\b/i;
/** A header value that names a clearance level or type. Anything else (none, n/a, tbd, not specified, ...) is no requirement. */
const CLEARANCE_HEADER_VALUE = /\b(?:top\s+secret|secret|ts(?:\s*\/\s*sci)?|sci|polygraph|public\s+trust|confidential|active|current|eligib\w*\s+(?:to\s+obtain|for)|ability\s+to\s+obtain|able\s+to\s+obtain|[lq](?:\s+clearance)?|dod|dow|doe|dhs|va|government|federal|mindef|sc|dv|bpss|baseline|nv[12]|reliability)\b/i;
/** Singapore government references that are not territory aliases. */
const SG_GOVERNMENT_MARKER = /\b(?:mindef|ministry\s+of\s+defence\s+singapore)\b/i;

function clauseGovernment(clause: string): string | null {
  const own = extractTerritories(clause).filter((territory) => territory !== "UNITED_STATES");
  if (own.length > 0) return own[0] ?? null;
  if (SG_GOVERNMENT_MARKER.test(clause)) return "SINGAPORE";
  if (US_GOVERNMENT_MARKER.test(clause)) return "UNITED_STATES";
  if (UK_GOVERNMENT_MARKER.test(clause)) return "UNITED_KINGDOM";
  if (AU_GOVERNMENT_MARKER.test(clause)) return "AUSTRALIA";
  if (CA_GOVERNMENT_MARKER.test(clause)) return "CANADA";
  return null;
}

/** True when the job's own location names a territory other than the United States (e.g. Singapore). */
function locationNamesNonUsTerritory(location: unknown): boolean {
  return extractTerritories(location).some((territory) => territory !== "UNITED_STATES");
}

// ── "US-based" placements ──
const US_PLACE = `(?:us|usa|united\\s+states|${US_STATE_NAMES.map(escapeRegExp).join("|")})[- ]based(?!\\s+on\\b)`;
const BASED_LIST = `(?:\\s*(?:,|\\/|or|and)\\s*[a-z][a-z ]{0,30}?[- ]based)*`;
/** The role itself is placed in the US: "a remote, US-based role", "This role is US-based". */
const US_BASED_ROLE = new RegExp(
  `\\b${US_PLACE}${BASED_LIST}\\s+(?:remote\\s+|full[- ]time\\s+|part[- ]time\\s+|hybrid\\s+)?(?:role|position|job|opportunity)\\b|\\b(?:role|position|job|opportunity)\\s+is\\s+(?:a\\s+)?(?:remote\\s+|fully\\s+)?${US_PLACE}`,
  "i",
);
/** The applicant must be in the US: "open to US-based candidates", "hiring a U.S.-based data engineer". */
const US_BASED_PEOPLE = new RegExp(
  `\\b${US_PLACE}${BASED_LIST}\\s+(?:\\w+\\s+){0,2}?(?:candidates?|applicants?|talent|hires?|contractors?|consultants?|engineers?|professionals?|developers?|scientists?|analysts?)\\b`,
  "i",
);
const PLACEMENT_FRAME = /\b(?:open\s+to|only|must|hiring|hire|looking\s+for|seeking|accept(?:ing)?|consider(?:ing)?|eligible|restricted\s+to|limited\s+to|welcome)\b/i;
/** "coordinate / onboard / source US-based X": US workers are the object of the work, not the applicant. */
const US_BASED_AS_OBJECT = new RegExp(
  `\\b(?:coordinat\\w*|manag\\w*|onboard\\w*|sourc\\w*|support\\w*|partner\\w*\\s+with|work\\w*\\s+with|lead\\w*|mentor\\w*|train\\w*|serv\\w*|recruit\\w*|engag\\w*|supervis\\w*|oversee\\w*|collaborat\\w*\\s+with)\\s+(?:\\w+\\s+){0,3}${US_PLACE}`,
  "i",
);

/** "You will be hiring / looking for US-based ...": the applicant does the hiring; US workers are not the applicant. */
const APPLICANT_DOES_HIRING = /\byou(?:'ll|\s+will|\s+would)?\s+(?:be\s+)?(?:hiring|looking\s+for|recruiting|sourcing|staffing|interviewing)\b/i;
const US_PLACE_PATTERN = new RegExp(`\\b${US_PLACE}`, "i");

function usBasedPlacement(clause: string): boolean {
  if (OPTIONAL_CUE.test(clause) || PAY_OR_BENEFITS_SENTENCE.test(clause)) return false;
  if (US_BASED_AS_OBJECT.test(clause) || APPLICANT_DOES_HIRING.test(clause)) return false;
  // A negation cancels the placement only in the part of the clause that holds "US-based":
  // "not open to US-based candidates" is no placement, while "This is a US-based role and
  // we are not able to sponsor visas" still is.
  const placed = subClauses(clause).filter((part) => US_PLACE_PATTERN.test(part));
  if (placed.length === 0 || placed.every((part) => NEGATION.test(part))) return false;
  if (US_BASED_ROLE.test(clause)) return true;
  return US_BASED_PEOPLE.test(clause) && PLACEMENT_FRAME.test(clause);
}

/**
 * Citizenship, government-clearance and "US-based" placement conditions that the
 * territory pass cannot see. Each is an ANY requirement with the posting's own words.
 */
export function extractGovernmentEligibilityRequirements(value: unknown, context?: WorkerTerritoryContext): ExplicitWorkerTerritoryRequirement[] {
  const text = String(value ?? "");
  const requirements: ExplicitWorkerTerritoryRequirement[] = [];
  const nonUsLocation = context !== undefined && locationNamesNonUsTerritory(context.jobLocation);
  const usLocation = context !== undefined && isUnitedStatesOnlyLocation(context.jobLocation);

  // "S. Citizenship required": a list or markdown parser dropped "U.". Only U.S. federal
  // context near it makes it a U.S. condition, and never on a job located outside the US.
  if (!nonUsLocation) {
    for (const match of text.matchAll(/(?:^|[^a-z.])(s\s*\.\s*citizen(?:s|ship)?\b[^\n]*)/gi)) {
      const start = (match.index ?? 0) + match[0].length - (match[1] ?? "").length;
      if (/u\s*\.\s*$/i.test(text.slice(Math.max(0, start - 4), start))) continue;
      const line = (match[1] ?? "").trim();
      if (OPTIONAL_CUE.test(line)) continue;
      const window = text.slice(Math.max(0, start - 600), start + line.length + 600);
      const nearby = window.split(/\n+/).find((candidate) => candidate !== line && US_FEDERAL_NEARBY.test(candidate) && !BOILERPLATE_SENTENCE.test(candidate) && !/(?:^|[^a-z.])s\s*\.\s*citizen/i.test(candidate));
      if (!nearby) continue;
      requirements.push({
        territories: ["UNITED_STATES"],
        operator: "ANY",
        evidenceText: `${line} (U.S. federal context: "${nearby.trim().slice(0, 200)}")`,
      });
    }
  }

  // A US placement applies only to a job not located in another territory, and any
  // applicant-addressed opening elsewhere in the posting cancels it.
  const placementApplies = context !== undefined && !nonUsLocation
    && !postingOpensRemoteBeyondUnitedStates(text, context.authorizedRegions ?? []);

  const protectedText = protectTerritoryAbbreviationPeriods(text.replace(/<[^>]+>/g, "\n"));
  for (const part of protectedText.split(/[.!?;\n]+/)) {
    const sentence = part.replaceAll(PROTECTED_ABBREVIATION_PERIOD, ".").trim();
    if (!sentence) continue;
    const clause = normalizeTerritorySearchText(sentence);

    if (placementApplies && usBasedPlacement(clause)) {
      const others = extractTerritories(clause).filter((territory) => territory !== "UNITED_STATES");
      requirements.push({ territories: ["UNITED_STATES", ...others], operator: "ANY", evidenceText: sentence });
      continue;
    }

    if (PAY_OR_BENEFITS_SENTENCE.test(sentence) || NON_SECURITY_CLEARANCE.test(sentence)) continue;
    if (!GOVERNMENT_CLEARANCE.test(sentence) || !MANDATORY_CUE.test(sentence) || OPTIONAL_CUE.test(sentence)) continue;
    // A header field counts only when its value names a clearance ("Clearance: Secret",
    // "Clearance: TS/SCI"); "None at this time", "N/A - remote role", "TBD", "Not specified" do not.
    const header = sentence.match(CLEARANCE_HEADER);
    if (header && (NEUTRAL_HEADER_VALUE.test(header[1] ?? "") || !CLEARANCE_HEADER_VALUE.test(header[1] ?? ""))) continue;
    if (CONDITIONAL_APPROVAL_SENTENCE.test(sentence)) continue;
    // The clause's own government; a clause naming none is U.S. only on a US-located job.
    const government = clauseGovernment(sentence) ?? (usLocation ? "UNITED_STATES" : null);
    if (!government) continue;
    requirements.push({ territories: [government], operator: "ANY", evidenceText: sentence });
  }
  return requirements;
}

export function evaluateWorkerTerritoryRequirements(
  requirements: readonly ExplicitWorkerTerritoryRequirement[],
  authorizedRegions: readonly string[],
  rejectExplicitForeignTerritory = true,
): WorkerTerritoryEvaluation {
  const allowed = new Set(normalizeTerritories([...authorizedRegions]));
  const incompatibleTerritories: string[] = [];
  const incompatibleRequirements: ExplicitWorkerTerritoryRequirement[] = [];
  const unresolvedRequirements: ExplicitWorkerTerritoryRequirement[] = [];
  for (const requirement of requirements) {
    const territories = normalizeTerritories([...requirement.territories]);
    if (territories.length === 0 || requirement.operator === "UNKNOWN") {
      unresolvedRequirements.push(requirement);
      continue;
    }
    const permitted = (territory: string) => allowed.size === 0 || isTerritoryAuthorized(territory, allowed);
    const permittedCount = territories.filter(permitted).length;
    const satisfied = requirement.operator === "ANY"
      ? permittedCount > 0
      : permittedCount === territories.length;
    if (!satisfied && rejectExplicitForeignTerritory && allowed.size > 0) {
      incompatibleTerritories.push(...territories.filter((territory) => !permitted(territory)));
      incompatibleRequirements.push(requirement);
    }
  }
  const uniqueIncompatible = [...new Set(incompatibleTerritories)];
  return {
    status: uniqueIncompatible.length > 0
      ? "INCOMPATIBLE"
      : unresolvedRequirements.length > 0 ? "NEEDS_VERIFICATION" : "ALLOWED",
    incompatibleTerritories: uniqueIncompatible,
    incompatibleRequirements,
    unresolvedRequirements,
  };
}

export function hasExplicitTerritoryRestriction(value: unknown, territory: string): boolean {
  const canonical = normalizeTerritory(territory);
  if (!canonical) return false;
  const aliases = (TERRITORY_ALIASES.find(([key]) => key === canonical)?.[1] ?? [canonical.toLowerCase()])
    .map(normalizeTerritorySearchText);
  const sentences = normalizeTerritorySearchText(value)
    .split(/[.!?;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.some((sentence) => {
    const hasTerritory = aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(sentence));
    if (!hasTerritory) return false;

    // A company HQ, employer background, client mention, or generic display location
    // is not a worker territory restriction.
    const isEmployerOrContext = /\b(?:we\s+are\b|our\s+(?:company|team|office|headquarters|hq|firm|business|clients?|customers?)\b|headquartered|head\s+office|employer\s+based|startup\s+based|company\s+based|firm\s+based|company\s+location|hq\s*[:=-]|headquarters\s*[:=-]|founded\s+in|serve\s+(?:[\w-]+\s+){0,3}clients?|working\s+with\s+(?:[\w-]+\s+){0,3}clients?)\b/i.test(sentence);
    // A language requirement ("proficiency in Chinese is required", "fluency in
    // Mandarin ... with partners across Greater China") or an export-control
    // licence condition names a country without restricting where the worker
    // may live or work. Only an explicit residence, citizenship, permit or
    // work-location condition in the same sentence keeps it a restriction.
    const namesWorkerLocation = /\b(?:citizen(?:s|ship)?|national(?:ity|s)?\s+only|work\s+permit|visa|right\s+to\s+work|eligible\s+to\s+work|authori[sz]ed\s+to\s+work|authori[sz]ation\s+to\s+work|work\s+authori[sz]ation|reside|residing|residen(?:cy|ts?)|(?:must|need\s+to|required\s+to)\s+(?:be\s+)?(?:based|located|living|relocate))\b/i.test(sentence);
    const isLanguageRequirement = /\b(?:fluen(?:t|cy)|proficien(?:t|cy)|speak(?:er|ers|ing)?|spoken|written|language|bilingual|native|mandarin|cantonese|putonghua)\b/i.test(sentence);
    const isExportControlCondition = /\bexport\s+(?:control|controls|laws?|regulations?|licen[cs]e|administration)\b/i.test(sentence)
      && !/\bcitizen(?:s|ship)?\b|\bpermanent\s+resident\b/i.test(sentence);
    if ((isLanguageRequirement && !namesWorkerLocation) || isExportControlCondition) return false;

    const hasExplicitWorkerConstraint = /\b(authorization|authorised|authorized|work\s+permit|visa|citizen(?:ship)?|residen(?:cy|tial|ts?)|right\s+to\s+work|eligible\s+to\s+work)\b/i.test(sentence)
      || /\b(?:must\s+(?:be\s+)?(?:residing|living|based|located|authorized)|must\s+reside|must\s+live)\b/i.test(sentence)
      || /\b(?:only\s+(?:open\s+to|applicants?|candidates?|engineers?|developers?|people|individuals)\s+(?:in|from|based|located|residing))\b/i.test(sentence)
      || /\b(?:remote\s+(?:only\s+in|only\s+from|eligible\s+only\s+in))\b/i.test(sentence)
      || /\b(?:open\s+only\s+to|eligible\s+only\s+in|based\s+in\s+[\w\s]+\s+only)\b/i.test(sentence);

    if (isEmployerOrContext) {
      return hasExplicitWorkerConstraint;
    }

    // Generic location headers or mentions (e.g. "Location: New York", "Remote — United States")
    // must not reject unless there is an explicit worker constraint or residency/only requirement.
    if (/\b(?:location\s*[:=-]|remote\s*[-–—:]\s*)/i.test(sentence) && !/\b(?:only|must|authorized|authorization|permit|visa|citizen|reside)\b/i.test(sentence)) {
      return false;
    }

    return hasExplicitWorkerConstraint
      || /\b(only|required|must|mandatory|work\s+(?:in|from)\s+(?:only\b|exclusively\b)|reside\s+in|living\s+in)\b/i.test(sentence);
  });
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finitePolicyNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = finiteNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "allow", "allowed"].includes(normalized)) return true;
    if (["false", "no", "0", "deny", "blocked"].includes(normalized)) return false;
  }
  return fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeHardFailDays(maxOfficeDays: number, hardFailDays: number): number {
  return Math.min(5, Math.max(maxOfficeDays + 1, hardFailDays));
}

function normalizeUnknownWorkModeDisposition(_value: unknown): WorkabilityPolicy["unknownWorkModeDisposition"] {
  // Read legacy settings for compatibility, but never allow UNKNOWN to be
  // configured as a pass or a career rejection.
  return "NEEDS_VERIFICATION";
}

export function loadWorkabilityPolicy(): WorkabilityPolicy {
  const filePath = configPath("policies", "workability.yml");
  if (!fs.existsSync(filePath)) return defaults;

  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  const document = loadFn(fs.readFileSync(filePath, "utf8")) as any;
  const workMode = document?.global_workability_gates?.work_mode ?? {};
  const territory = document?.global_workability_gates?.territory ?? {};
  const operations = document?.global_workability_gates?.operations ?? {};
  const employment = document?.global_workability_gates?.employment ?? {};
  const composition = document?.global_workability_gates?.work_composition ?? {};
  const configuredHardFail = finiteNumber(workMode.max_office_days_hard_fail, defaults.hardFailOfficeDaysPerWeek);
  const configuredMaxOffice = finiteNumber(workMode.max_office_days_per_week, defaults.maxOfficeDaysPerWeek);
  const configuredModes = stringArray(firstDefined(workMode.allowed_work_modes, workMode.work_modes))
    .map((mode) => mode.toUpperCase().replace(/[-\s]+/g, "_"))
    .filter((mode): mode is "REMOTE" | "HYBRID" | "ONSITE" => ["REMOTE", "HYBRID", "ONSITE"].includes(mode));

  return {
    unknownWorkModeDisposition: normalizeUnknownWorkModeDisposition(
      firstDefined(workMode.unknown_work_mode_policy, workMode.unknownWorkModePolicy)
    ),
    allowedWorkModes: configuredModes.length > 0
      ? configuredModes
      : workMode.onsite_only_allowed === true
        ? ["REMOTE", "HYBRID", "ONSITE"]
        : defaults.allowedWorkModes,
    onsiteOnlyAllowed: workMode.onsite_only_allowed === true,
    maxOfficeDaysPerWeek: configuredMaxOffice,
    hardFailOfficeDaysPerWeek: normalizeHardFailDays(configuredMaxOffice, configuredHardFail),
    hybridWithoutOfficeDaysAllowed: booleanValue(
      firstDefined(workMode.hybrid_without_office_days_allowed),
      defaults.hybridWithoutOfficeDaysAllowed
    ),
    authorizedRegions: normalizeTerritories(
      firstDefined(territory.authorized_regions, document?.authorized_regions) ?? defaults.authorizedRegions
    ),
    remoteWithoutTerritoryAllowed: booleanValue(
      firstDefined(territory.remote_without_territory_allowed),
      defaults.remoteWithoutTerritoryAllowed
    ),
    rejectExplicitForeignTerritory: booleanValue(
      firstDefined(territory.reject_explicit_foreign_territory),
      defaults.rejectExplicitForeignTerritory
    ),
    unknownWorkAuthorizationNeedsVerification: booleanValue(
      firstDefined(territory.unknown_work_authorization_needs_verification),
      defaults.unknownWorkAuthorizationNeedsVerification
    ),
    maxTravelPct: finiteNumber(document?.global_workability_gates?.travel?.max_travel_pct, defaults.maxTravelPct),
    minimalTravelAllowed: booleanValue(
      document?.global_workability_gates?.travel?.minimal_qualitative_travel_allowed,
      defaults.minimalTravelAllowed
    ),
    // Fixed-term employment by the hiring organization is eligible. Agency
    // placements are handled separately by rejectAgencyContractPlacements.
    contractAllowed: true,
    rejectAgencyContractPlacements: booleanValue(
      employment.reject_agency_placement_contracts,
      defaults.rejectAgencyContractPlacements,
    ),
    employmentAgencyCompanyNames: stringArray(employment.employment_agency_company_names)
      .map((name) => name.toLowerCase()),
    minimumBuildingResearchPct: finiteNumber(composition.minimum_building_research_pct, defaults.minimumBuildingResearchPct),
    maximumInteractionPct: finiteNumber(composition.maximum_interaction_pct, defaults.maximumInteractionPct),
    preferredBuildingResearchPct: finiteNumber(composition.preferred_building_research_pct, defaults.preferredBuildingResearchPct ?? 85),
    preferredInteractionPct: finiteNumber(composition.preferred_interaction_pct, defaults.preferredInteractionPct ?? 15),
    regularOnCallAllowed: operations.regular_on_call_allowed === true,
    shiftWorkAllowed: operations.shift_work_allowed === true,
    frequentTravelAllowed: operations.frequent_travel_allowed === true,
    externalClientPrimaryAllowed: composition.external_client_primary_allowed === true,
    peopleManagementPrimaryAllowed: composition.people_management_primary_allowed === true,
    blacklistedCompanies: Array.isArray(document?.blacklisted_companies)
      ? document.blacklisted_companies.map((value: unknown) => String(value).trim().toLowerCase()).filter(Boolean)
      : defaults.blacklistedCompanies,
    researchOnsiteExceptions: researchOnsiteExceptionConfig(workMode.onsite_exceptions),
    // Personal employer exceptions are never read from repo config.
    onsiteExceptionEmployers: [],
  };
}

function lowerStringArray(value: unknown): string[] {
  return stringArray(value).map((item) => item.toLowerCase());
}

function researchOnsiteExceptionConfig(value: unknown): ResearchOnsiteExceptionConfig {
  const config = objectValue(value);
  return {
    employers: lowerStringArray(config.research_employers),
    employerNameTerms: lowerStringArray(config.research_employer_name_terms),
    healthResearchEmployers: lowerStringArray(config.health_research_employers),
    healthResearchUnitTerms: lowerStringArray(config.health_research_unit_terms),
    titleTerms: lowerStringArray(config.research_title_terms),
    titleExclusions: lowerStringArray(config.research_title_exclusions),
    bareScientistTitleCounts: config.bare_scientist_title_counts === true,
  };
}

/**
 * Add the user's on-site exception employers from the stage3 preference
 * (`mobility.onsite_exception_employers`). Absent or empty means no exception.
 */
export function withOnsiteExceptionEmployers(
  policy: WorkabilityPolicy,
  employers: readonly string[] | null | undefined,
): WorkabilityPolicy {
  const names = [...new Set((employers ?? []).map((name) => String(name).trim()).filter(Boolean))];
  if (names.length === 0) return policy;
  return { ...policy, onsiteExceptionEmployers: names };
}

export interface WorkspaceWorkabilityPolicyResolution {
  policy: WorkabilityPolicy;
  source: "FILE" | "ACTIVE_PREFERENCE_MODE";
  modeKey: string | null;
  modeId: string | null;
  policyHash: string;
}

export function mergeWorkabilityPreferenceContent(
  basePolicy: WorkabilityPolicy,
  content: unknown
): WorkabilityPolicy {
  const root = objectValue(content);
  // Streamlit and the API persist the user-facing contract under
  // `hard_constraints`. Older modes use `workability`; both are normalized
  // here so a preference cannot be silently ignored by deterministic gates.
  const workability = objectValue(firstDefined(root.workability, root.hard_constraints));
  const territory = objectValue(firstDefined(workability.territory, root.territory));
  const operations = objectValue(firstDefined(workability.operations, root.operations));
  const travel = objectValue(firstDefined(workability.travel, root.travel));
  const composition = objectValue(firstDefined(workability.work_composition, root.work_composition));

  const allowedWorkModes = stringArray(
    firstDefined(workability.work_modes, workability.allowed_work_modes, root.work_modes)
  ).map((mode) => mode.toUpperCase().replace(/[-\s]+/g, "_").replace("ON_SITE", "ONSITE"));
  const normalizedAllowedWorkModes = allowedWorkModes.filter(
    (mode): mode is "REMOTE" | "HYBRID" | "ONSITE" => ["REMOTE", "HYBRID", "ONSITE"].includes(mode),
  );

  const maxOfficeDays = finitePolicyNumber(
    firstDefined(
      workability.max_office_days_per_week,
      workability.maxOfficeDaysPerWeek,
      root.max_office_days_per_week
    ),
    basePolicy.maxOfficeDaysPerWeek,
    0,
    5
  );
  const hardFailDays = finitePolicyNumber(
    firstDefined(
      workability.max_office_days_hard_fail,
      workability.hard_fail_office_days_per_week,
      root.max_office_days_hard_fail
    ),
    basePolicy.hardFailOfficeDaysPerWeek,
    1,
    5
  );

  const policy: WorkabilityPolicy = {
    ...basePolicy,
    unknownWorkModeDisposition: normalizeUnknownWorkModeDisposition(
      firstDefined(
        workability.unknown_work_mode_policy,
        workability.unknownWorkModePolicy,
        root.unknown_work_mode_policy,
        root.unknownWorkModePolicy
      ) ?? basePolicy.unknownWorkModeDisposition
    ),
    allowedWorkModes: normalizedAllowedWorkModes.length > 0
      ? normalizedAllowedWorkModes
      : booleanValue(
          firstDefined(workability.onsite_only_allowed, workability.onsiteOnlyAllowed, root.onsite_only_allowed),
          basePolicy.onsiteOnlyAllowed,
        )
        ? [...new Set([...basePolicy.allowedWorkModes, "ONSITE" as const])]
        : basePolicy.allowedWorkModes,
    onsiteOnlyAllowed: allowedWorkModes.length > 0
      ? allowedWorkModes.some((mode) => mode === "ONSITE" || mode === "ON_SITE")
      : booleanValue(
          firstDefined(
            workability.onsite_only_allowed,
            workability.onsiteOnlyAllowed,
            root.onsite_only_allowed
          ),
          basePolicy.onsiteOnlyAllowed
        ),
    maxOfficeDaysPerWeek: maxOfficeDays,
    hardFailOfficeDaysPerWeek: normalizeHardFailDays(maxOfficeDays, hardFailDays),
    hybridWithoutOfficeDaysAllowed: booleanValue(
      firstDefined(
        workability.hybrid_without_office_days_allowed,
        workability.hybridWithoutOfficeDaysAllowed,
        root.hybrid_without_office_days_allowed
      ),
      basePolicy.hybridWithoutOfficeDaysAllowed
    ),
    authorizedRegions: normalizeTerritories(
      firstDefined(
        workability.authorized_regions,
        workability.authorizedRegions,
        territory.authorized_regions,
        root.authorized_regions
      ) ?? basePolicy.authorizedRegions
    ),
    remoteWithoutTerritoryAllowed: booleanValue(
      firstDefined(
        workability.remote_without_territory_allowed,
        workability.remoteWithoutTerritoryAllowed,
        territory.remote_without_territory_allowed,
        root.remote_without_territory_allowed
      ),
      basePolicy.remoteWithoutTerritoryAllowed
    ),
    rejectExplicitForeignTerritory: booleanValue(
      firstDefined(
        workability.reject_explicit_foreign_territory,
        workability.rejectExplicitForeignTerritory,
        territory.reject_explicit_foreign_territory,
        root.reject_explicit_foreign_territory
      ),
      basePolicy.rejectExplicitForeignTerritory
    ),
    unknownWorkAuthorizationNeedsVerification: booleanValue(
      firstDefined(
        workability.unknown_work_authorization_needs_verification,
        workability.unknownWorkAuthorizationNeedsVerification,
        territory.unknown_work_authorization_needs_verification,
        root.unknown_work_authorization_needs_verification
      ),
      basePolicy.unknownWorkAuthorizationNeedsVerification
    ),
    maxTravelPct: finitePolicyNumber(
      firstDefined(workability.max_travel_pct, workability.maxTravelPct, root.max_travel_pct),
      basePolicy.maxTravelPct,
      0,
      100
    ),
    minimalTravelAllowed: booleanValue(
      firstDefined(
        travel.minimal_qualitative_travel_allowed,
        workability.minimal_qualitative_travel_allowed,
        root.minimal_qualitative_travel_allowed
      ),
      basePolicy.minimalTravelAllowed
    ),
    // Direct fixed-term employment is eligible. Employment-agency contract
    // placements are rejected separately by the global placement rule.
    contractAllowed: true,
    // Agency placement is a global eligibility rule, not an owner preference.
    rejectAgencyContractPlacements: basePolicy.rejectAgencyContractPlacements,
    employmentAgencyCompanyNames: [...basePolicy.employmentAgencyCompanyNames],
    minimumBuildingResearchPct: finitePolicyNumber(
      firstDefined(
        composition.minimum_building_research_pct,
        workability.minimum_building_research_pct,
        root.minimum_building_research_pct
      ),
      basePolicy.minimumBuildingResearchPct,
      0,
      100
    ),
    maximumInteractionPct: finitePolicyNumber(
      firstDefined(
        composition.maximum_interaction_pct,
        workability.maximum_interaction_pct,
        root.maximum_interaction_pct
      ),
      basePolicy.maximumInteractionPct,
      0,
      100
    ),
    regularOnCallAllowed: booleanValue(
      firstDefined(
        operations.regular_on_call_allowed,
        workability.regular_on_call_allowed,
        workability.on_call_allowed,
        root.on_call_allowed
      ),
      basePolicy.regularOnCallAllowed
    ),
    shiftWorkAllowed: booleanValue(
      firstDefined(
        operations.shift_work_allowed,
        workability.shift_work_allowed,
        root.shift_work_allowed
      ),
      basePolicy.shiftWorkAllowed
    ),
    frequentTravelAllowed: booleanValue(
      firstDefined(
        operations.frequent_travel_allowed,
        workability.frequent_travel_allowed,
        root.frequent_travel_allowed
      ),
      basePolicy.frequentTravelAllowed
    ),
    externalClientPrimaryAllowed: booleanValue(
      firstDefined(
        composition.external_client_primary_allowed,
        workability.external_client_primary_allowed,
        root.external_client_primary_allowed
      ),
      basePolicy.externalClientPrimaryAllowed
    ),
    peopleManagementPrimaryAllowed: booleanValue(
      firstDefined(
        composition.people_management_primary_allowed,
        workability.people_management_primary_allowed,
        root.people_management_primary_allowed
      ),
      basePolicy.peopleManagementPrimaryAllowed
    ),
    blacklistedCompanies: stringArray(firstDefined(root.blacklisted_companies, workability.blacklisted_companies))
      .map((value) => value.toLowerCase())
      .concat(basePolicy.blacklistedCompanies)
      .filter((value, index, all) => value && all.indexOf(value) === index),
  };

  return policy;
}

export async function resolveWorkspaceWorkabilityPolicy(
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<WorkspaceWorkabilityPolicyResolution> {
  const basePolicy = loadWorkabilityPolicy();
  const fallback = {
    policy: basePolicy,
    source: "FILE" as const,
    modeKey: null,
    modeId: null,
    policyHash: sha256Hex(stableStringify(basePolicy)),
  };

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const { rows } = await client.query<{
      id: string;
      mode_key: string;
      content: unknown;
    }>(
      `SELECT id, mode_key, content
       FROM workspace_user_preference_modes
       WHERE workspace_id = $1
         AND user_id = $2
         AND is_active = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`,
      [ctx.workspaceId, ctx.userId]
    );

    const row = rows[0];
    if (!row) return fallback;

    const policy = mergeWorkabilityPreferenceContent(basePolicy, row.content);
    return {
      policy,
      source: "ACTIVE_PREFERENCE_MODE",
      modeKey: row.mode_key,
      modeId: row.id,
      policyHash: sha256Hex(stableStringify({
        source: "ACTIVE_PREFERENCE_MODE",
        mode_id: row.id,
        mode_key: row.mode_key,
        policy,
      })),
    };
  } catch (error: any) {
    if (error?.code === "42P01" || error?.code === "42703") {
      return fallback;
    }
    throw error;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}
