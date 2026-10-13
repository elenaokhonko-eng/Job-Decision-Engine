import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import pg from "pg";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

export interface WorkabilityPolicy {
  unknownWorkModeDisposition: "PASS" | "HARD_REJECT" | "NEEDS_VERIFICATION";
  onsiteOnlyAllowed: boolean;
  maxOfficeDaysPerWeek: number;
  hardFailOfficeDaysPerWeek: number;
  hybridWithoutOfficeDaysAllowed: boolean;
  authorizedRegions: string[];
  remoteWithoutTerritoryAllowed: boolean;
  rejectExplicitForeignTerritory: boolean;
  unknownWorkAuthorizationNeedsVerification: boolean;
  maxTravelPct: number;
  contractAllowed: boolean;
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
  // Funnel V3 treats an unestablished workplace model as a deterministic
  // conflict. It must not be held for manual verification or inferred as
  // onsite from a non-empty location label.
  unknownWorkModeDisposition: "HARD_REJECT",
  onsiteOnlyAllowed: false,
  maxOfficeDaysPerWeek: 3,
  hardFailOfficeDaysPerWeek: 4,
  hybridWithoutOfficeDaysAllowed: true,
  authorizedRegions: ["SINGAPORE"],
  remoteWithoutTerritoryAllowed: true,
  rejectExplicitForeignTerritory: true,
  unknownWorkAuthorizationNeedsVerification: false,
  maxTravelPct: 20,
  contractAllowed: false,
  minimumBuildingResearchPct: 60,
  maximumInteractionPct: 40,
  preferredBuildingResearchPct: 85,
  preferredInteractionPct: 15,
  regularOnCallAllowed: false,
  shiftWorkAllowed: false,
  frequentTravelAllowed: false,
  externalClientPrimaryAllowed: false,
  peopleManagementPrimaryAllowed: false,
  blacklistedCompanies: [],
};

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
  ["SOUTH_AFRICA", ["south africa", "south african", "johannesburg", "cape town"]],
  ["BRAZIL", ["brazil", "brazilian", "sao paulo", "rio de janeiro"]],
  ["MEXICO", ["mexico", "mexican", "mexico city"]],
  ["ARGENTINA", ["argentina", "argentinian", "buenos aires"]],
  ["CHILE", ["chile", "chilean", "santiago"]],
  ["COLOMBIA", ["colombia", "colombian", "bogota"]],
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
    // A company HQ, client reference, or generic "remote" mention is not a
    // work-authorization fact. Require a mandatory or physical-residency
    // qualifier before treating a foreign territory as a gate conflict.
    return hasTerritory && /\b(only|required|must|mandatory|work\s+(?:in|from)|working\s+(?:in|from)|based\s+in|located\s+in|location\s*[:=-]\s*|office\s+in|on[- ]?site\s+in|authorization|authorised|authorized|eligible|rights|citizen(?:ship)?|visa|residen(?:cy|tial))\b/i.test(sentence);
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

function normalizeUnknownWorkModeDisposition(value: unknown): WorkabilityPolicy["unknownWorkModeDisposition"] {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "PASS" || normalized === "HARD_REJECT" || normalized === "NEEDS_VERIFICATION") {
    return normalized;
  }
  return defaults.unknownWorkModeDisposition;
}

export function loadWorkabilityPolicy(): WorkabilityPolicy {
  const filePath = path.resolve(process.cwd(), "config/policies/workability.yml");
  if (!fs.existsSync(filePath)) return defaults;

  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  const document = loadFn(fs.readFileSync(filePath, "utf8")) as any;
  const workMode = document?.global_workability_gates?.work_mode ?? {};
  const territory = document?.global_workability_gates?.territory ?? {};
  const operations = document?.global_workability_gates?.operations ?? {};
  const composition = document?.global_workability_gates?.work_composition ?? {};
  const configuredHardFail = finiteNumber(workMode.max_office_days_hard_fail, defaults.hardFailOfficeDaysPerWeek);
  const configuredMaxOffice = finiteNumber(workMode.max_office_days_per_week, defaults.maxOfficeDaysPerWeek);

  return {
    unknownWorkModeDisposition: normalizeUnknownWorkModeDisposition(
      firstDefined(workMode.unknown_work_mode_policy, workMode.unknownWorkModePolicy)
    ),
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
    contractAllowed: document?.global_workability_gates?.employment?.contract_allowed === true,
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
  };
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
  const composition = objectValue(firstDefined(workability.work_composition, root.work_composition));

  const allowedWorkModes = stringArray(
    firstDefined(workability.work_modes, workability.allowed_work_modes, root.work_modes)
  ).map((mode) => mode.toUpperCase().replace(/[-\s]+/g, "_"));

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

  const employmentTypes = stringArray(
    firstDefined(workability.employment_types, workability.allowed_employment_types, root.employment_types)
  ).map((type) => type.toUpperCase().replace(/[-\s]+/g, "_"));

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
    contractAllowed: employmentTypes.length > 0
      ? employmentTypes.some((type) => type === "CONTRACT" || type === "CONTRACTOR")
      : booleanValue(
          firstDefined(
            workability.contract_allowed,
            workability.contractAllowed,
            workability.contract_roles_allowed,
            root.contract_allowed
          ),
          basePolicy.contractAllowed
        ),
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
