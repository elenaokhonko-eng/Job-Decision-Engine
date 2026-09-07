import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

export interface WorkabilityPolicy {
  onsiteOnlyAllowed: boolean;
  maxOfficeDaysPerWeek: number;
  hardFailOfficeDaysPerWeek: number;
  maxTravelPct: number;
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
    hardFailOfficeDaysPerWeek: Math.max(configuredMaxOffice + 1, configuredHardFail),
    maxTravelPct: finiteNumber(document?.global_workability_gates?.travel?.max_travel_pct, defaults.maxTravelPct),
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
