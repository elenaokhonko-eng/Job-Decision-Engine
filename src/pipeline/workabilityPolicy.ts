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
  regularOnCallAllowed: boolean;
  shiftWorkAllowed: boolean;
  frequentTravelAllowed: boolean;
  externalClientPrimaryAllowed: boolean;
  peopleManagementPrimaryAllowed: boolean;
  blacklistedCompanies: string[];
}

const defaults: WorkabilityPolicy = {
  unknownWorkModeDisposition: "NEEDS_VERIFICATION",
  onsiteOnlyAllowed: false,
  maxOfficeDaysPerWeek: 3,
  hardFailOfficeDaysPerWeek: 4,
  hybridWithoutOfficeDaysAllowed: true,
  authorizedRegions: ["SINGAPORE"],
  remoteWithoutTerritoryAllowed: true,
  rejectExplicitForeignTerritory: true,
  unknownWorkAuthorizationNeedsVerification: false,
  maxTravelPct: 10,
  contractAllowed: false,
  minimumBuildingResearchPct: 60,
  maximumInteractionPct: 40,
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

/**
 * A territory mention is only a work-location restriction when the source
 * sentence also contains an employment/location qualifier. This prevents
 * references such as "US clients" from becoming false location rejections.
 */
export function hasExplicitTerritoryRestriction(value: unknown, territory: string): boolean {
  const canonical = normalizeTerritory(territory);
  if (!canonical) return false;
  const aliases = TERRITORY_ALIASES.find(([key]) => key === canonical)?.[1] ?? [canonical.toLowerCase()];
  const sentences = normalizeTerritorySearchText(value)
    .split(/[.!?;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.some((sentence) => {
    const hasTerritory = aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(sentence));
    return hasTerritory && /\b(only|remote|work\s+(?:in|from)|working\s+(?:in|from)|based|located|location|office|on[- ]?site|authorization|authorised|authorized|eligible|rights|territory)\b/i.test(sentence);
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
