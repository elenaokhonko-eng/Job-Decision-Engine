import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import pg from "pg";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

export interface WorkabilityPolicy {
  onsiteOnlyAllowed: boolean;
  maxOfficeDaysPerWeek: number;
  hardFailOfficeDaysPerWeek: number;
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
  onsiteOnlyAllowed: false,
  maxOfficeDaysPerWeek: 3,
  hardFailOfficeDaysPerWeek: 4,
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

export function loadWorkabilityPolicy(): WorkabilityPolicy {
  const filePath = path.resolve(process.cwd(), "config/policies/workability.yml");
  if (!fs.existsSync(filePath)) return defaults;

  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  const document = loadFn(fs.readFileSync(filePath, "utf8")) as any;
  const workMode = document?.global_workability_gates?.work_mode ?? {};
  const operations = document?.global_workability_gates?.operations ?? {};
  const composition = document?.global_workability_gates?.work_composition ?? {};
  const configuredHardFail = finiteNumber(workMode.max_office_days_hard_fail, defaults.hardFailOfficeDaysPerWeek);
  const configuredMaxOffice = finiteNumber(workMode.max_office_days_per_week, defaults.maxOfficeDaysPerWeek);

  return {
    onsiteOnlyAllowed: workMode.onsite_only_allowed === true,
    maxOfficeDaysPerWeek: configuredMaxOffice,
    hardFailOfficeDaysPerWeek: normalizeHardFailDays(configuredMaxOffice, configuredHardFail),
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
