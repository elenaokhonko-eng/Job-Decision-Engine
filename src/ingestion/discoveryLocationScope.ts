import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import type { ExtractedJob } from "../contracts/index.js";
import { normalizeWorkMode } from "../pipeline/workModeNormalizer.js";

/**
 * Discovery-scope location pre-filter for employer ATS boards.
 *
 * It narrows which fetched postings are staged; it is not a career decision. A posting is
 * skipped only when its location explicitly names somewhere outside the authorized regions with
 * no authorized-region, regional or unrestricted-remote mention. Unknown or empty locations are
 * always kept so the hard gates can mark them NEEDS_VERIFICATION.
 */

const TermListSchema = z.array(z.string().min(1)).min(1);

export const LocationScopeConfigSchema = z.object({
  applies_to_source_keys: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).min(1),
  region_terms: z.record(z.string().min(1), TermListSchema),
  regional_terms: TermListSchema,
  remote_terms: TermListSchema,
  global_terms: TermListSchema,
  remote_filler_terms: TermListSchema,
  unknown_location_terms: TermListSchema,
  /** ISO 3166-1 alpha-2 codes per authorized region, for ATS payloads that carry only a code. */
  region_country_codes: z.record(z.string().min(1), z.array(z.string().regex(/^[A-Za-z]{2}$/)).min(1)).optional(),
});
export type LocationScopeConfig = z.infer<typeof LocationScopeConfigSchema>;

export interface TerritoryPolicy {
  readonly authorizedRegions: readonly string[];
  readonly rejectExplicitForeignTerritory: boolean;
}

export interface DiscoveryLocationScope {
  readonly active: boolean;
  readonly sourceKeys: ReadonlySet<string>;
  readonly authorizedRegions: readonly string[];
  readonly inScopeTerms: readonly string[];
  readonly remoteTerms: readonly string[];
  readonly globalTerms: readonly string[];
  readonly remoteFillerTerms: readonly string[];
  readonly unknownLocationTerms: readonly string[];
  /** Lower-case ISO alpha-2 codes of the authorized regions (empty when not configured). */
  readonly inScopeCountryCodes: readonly string[];
}

export type LocationScopeReasonCode =
  | "LOCATION_UNKNOWN"
  | "LOCATION_IN_SCOPE"
  | "REMOTE_UNRESTRICTED"
  | "REMOTE_FLAG_WITHOUT_RESTRICTION"
  | "LOCATION_SCOPE_INACTIVE"
  | "LOCATION_OUT_OF_SCOPE"
  | "GEO_FIELD_IN_SCOPE"
  | "GEO_FIELD_OUT_OF_SCOPE";

export interface LocationScopeDecision {
  readonly inScope: boolean;
  readonly reasonCode: LocationScopeReasonCode;
  readonly reason: string;
}

export const LOCATION_OUT_OF_SCOPE = "LOCATION_OUT_OF_SCOPE" as const;

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedTerms(terms: readonly string[]): string[] {
  // Longest first so multi-word terms are removed before their parts.
  return [...new Set(terms.map(normalize).filter(Boolean))].sort((left, right) => right.length - left.length);
}

function containsTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

function removeTerms(text: string, terms: readonly string[]): string {
  let remaining = ` ${text} `;
  for (const term of terms) {
    const needle = ` ${term} `;
    while (remaining.includes(needle)) remaining = remaining.replace(needle, " ");
  }
  return remaining.replace(/\s+/g, " ").trim();
}

/** Build the scope from the source-plan block and the workability territory policy. */
export function buildDiscoveryLocationScope(config: LocationScopeConfig, policy: TerritoryPolicy): DiscoveryLocationScope {
  const authorizedRegions = policy.authorizedRegions.map((region) => region.trim().toUpperCase()).filter(Boolean);
  const regionTerms = Object.fromEntries(Object.entries(config.region_terms).map(([key, terms]) => [key.trim().toUpperCase(), terms]));
  const missing = authorizedRegions.filter((region) => !regionTerms[region]);
  if (missing.length > 0) {
    throw new Error(`Discovery location scope has no region_terms for authorized region(s): ${missing.join(", ")}.`);
  }
  return {
    active: policy.rejectExplicitForeignTerritory && authorizedRegions.length > 0,
    sourceKeys: new Set(config.applies_to_source_keys),
    authorizedRegions,
    inScopeTerms: normalizedTerms([...authorizedRegions.flatMap((region) => regionTerms[region]), ...config.regional_terms]),
    remoteTerms: normalizedTerms(config.remote_terms),
    globalTerms: normalizedTerms(config.global_terms),
    remoteFillerTerms: normalizedTerms(config.remote_filler_terms),
    unknownLocationTerms: normalizedTerms(config.unknown_location_terms),
    inScopeCountryCodes: Object.entries(config.region_country_codes ?? {})
      .filter(([key]) => authorizedRegions.includes(key.trim().toUpperCase()))
      .flatMap(([, codes]) => codes.map((code) => code.toLowerCase())),
  };
}

function readYaml(filePath: string): unknown {
  return load(fs.readFileSync(filePath, "utf8"));
}

function territoryPolicy(policyPath: string): TerritoryPolicy {
  const document = readYaml(policyPath);
  const territory = z.object({
    global_workability_gates: z.object({
      territory: z.object({
        authorized_regions: z.array(z.string().min(1)),
        reject_explicit_foreign_territory: z.boolean(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough().parse(document).global_workability_gates.territory;
  return {
    authorizedRegions: territory.authorized_regions,
    rejectExplicitForeignTerritory: territory.reject_explicit_foreign_territory,
  };
}

/** The `location_scope` block of the source plan, or null when the plan has none. */
export function loadLocationScopeConfig(
  planPath = path.resolve(process.cwd(), "config/source-plans/six_lane_sources.yml"),
): LocationScopeConfig | null {
  const plan = readYaml(planPath);
  const block = plan !== null && typeof plan === "object" && !Array.isArray(plan)
    ? (plan as Record<string, unknown>).location_scope
    : undefined;
  return block === undefined ? null : LocationScopeConfigSchema.parse(block);
}

/**
 * Load the scope from config. Returns null when the source plan has no `location_scope` block
 * (no pre-filter). A malformed block or policy throws: a misconfigured filter must not silently
 * widen or narrow discovery.
 */
export function loadDiscoveryLocationScope(
  planPath = path.resolve(process.cwd(), "config/source-plans/six_lane_sources.yml"),
  policyPath = path.resolve(process.cwd(), "config/policies/workability.yml"),
): DiscoveryLocationScope | null {
  const config = loadLocationScopeConfig(planPath);
  if (config === null) return null;
  return buildDiscoveryLocationScope(config, territoryPolicy(policyPath));
}

export function locationScopeAppliesTo(scope: DiscoveryLocationScope | null | undefined, sourceKey: string): scope is DiscoveryLocationScope {
  return Boolean(scope && scope.active && scope.sourceKeys.has(sourceKey));
}

const SEGMENT_SEPARATOR = /\s*(?:[|;/\n•·]|\bor\b|\band\b)\s*/i;

export function assessLocationScope(
  job: Pick<ExtractedJob, "title" | "location_raw" | "workplace_type_raw">,
  scope: DiscoveryLocationScope,
): LocationScopeDecision {
  if (!scope.active) {
    return { inScope: true, reasonCode: "LOCATION_SCOPE_INACTIVE", reason: "Workability policy does not reject explicit foreign territory." };
  }
  const rawLocation = String(job.location_raw ?? "");
  const location = normalize(rawLocation);
  if (!location || scope.unknownLocationTerms.includes(location)) {
    return { inScope: true, reasonCode: "LOCATION_UNKNOWN", reason: "Location is not stated; the hard gates decide (NEEDS_VERIFICATION)." };
  }
  const title = normalize(job.title);
  const inScopeTerm = scope.inScopeTerms.find((term) => containsTerm(location, term) || containsTerm(title, term));
  if (inScopeTerm) {
    return { inScope: true, reasonCode: "LOCATION_IN_SCOPE", reason: `Location mentions "${inScopeTerm}".` };
  }

  const restrictedRemote: string[] = [];
  for (const rawSegment of rawLocation.split(SEGMENT_SEPARATOR)) {
    const segment = normalize(rawSegment);
    if (!segment || !scope.remoteTerms.some((term) => containsTerm(segment, term))) continue;
    const remainder = removeTerms(segment, [...scope.remoteTerms, ...scope.globalTerms, ...scope.remoteFillerTerms]);
    if (!remainder) {
      return { inScope: true, reasonCode: "REMOTE_UNRESTRICTED", reason: `Remote location "${rawSegment.trim()}" names no territory.` };
    }
    restrictedRemote.push(rawSegment.trim());
  }
  if (restrictedRemote.length === 0 && normalizeWorkMode(job.workplace_type_raw) === "REMOTE") {
    return {
      inScope: true,
      reasonCode: "REMOTE_FLAG_WITHOUT_RESTRICTION",
      reason: "Posting is flagged remote and its location does not restrict the remote territory.",
    };
  }
  return {
    inScope: false,
    reasonCode: LOCATION_OUT_OF_SCOPE,
    reason: restrictedRemote.length > 0
      ? `Remote territory is restricted outside ${scope.authorizedRegions.join(", ")}: ${restrictedRemote.join("; ")}.`
      : `Location names no ${scope.authorizedRegions.join(", ")}, regional or remote option: ${rawLocation.trim()}.`,
  };
}

/**
 * A source's explicit, structured territory fields (not its free-text location). Only fields
 * that state where the candidate may be (remote boards) or where every listed location is
 * (non-remote ATS postings) may exclude; the others may only keep a posting in scope.
 */
export interface StructuredGeo {
  readonly field: string;
  readonly territories: readonly string[];
  /** Lower-case ISO alpha-2 codes. */
  readonly countryCodes: readonly string[];
  /** False when the field may describe an employer office rather than where the candidate may be. */
  readonly canExclude: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  // Adapter raw payloads are external JSON narrowed at this boundary.
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textList(value: unknown, splitCommas: boolean): string[] | null {
  const parts: unknown[] | null = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!parts || parts.some((part) => typeof part !== "string")) return null;
  const values = parts
    .flatMap((part) => splitCommas ? String(part).split(",") : [String(part)])
    .map((part) => part.trim())
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

function isRemoteFlag(value: unknown): boolean {
  return value === true || (typeof value === "string" && /^\s*remote\s*$/i.test(value));
}

function postalCountry(value: unknown): string | null {
  const holder = asRecord(value);
  const postal = asRecord(asRecord(holder?.address)?.postalAddress) ?? asRecord(holder?.postalAddress);
  const country = postal?.addressCountry;
  return typeof country === "string" && country.trim() ? country.trim() : null;
}

/** Structured territory fields in one source's raw payload, or null when it has none. */
export function structuredGeoFromPayload(sourceKey: string, rawPayload: unknown): StructuredGeo | null {
  const payload = asRecord(rawPayload);
  if (!payload) return null;
  switch (sourceKey) {
    case "himalayas": {
      const territories = textList(payload.locationRestrictions, false);
      return territories ? { field: "locationRestrictions", territories, countryCodes: [], canExclude: true } : null;
    }
    case "jobicy": {
      const territories = textList(payload.jobGeo, true);
      return territories ? { field: "jobGeo", territories, countryCodes: [], canExclude: true } : null;
    }
    case "remotive": {
      const territories = textList(payload.candidate_required_location, true);
      return territories ? { field: "candidate_required_location", territories, countryCodes: [], canExclude: true } : null;
    }
    case "we_work_remotely": {
      // The feed's region line. Its separate country list is ambiguous next to a worldwide region.
      const territories = textList(payload.region, false);
      return territories ? { field: "region", territories, countryCodes: [], canExclude: true } : null;
    }
    case "ashby": {
      const secondary = Array.isArray(payload.secondaryLocations) ? payload.secondaryLocations : [];
      const countries = [postalCountry(payload), ...secondary.map(postalCountry)];
      const known = countries.filter((country): country is string => country !== null);
      if (known.length === 0) return null;
      const remote = isRemoteFlag(payload.isRemote) || isRemoteFlag(payload.workplaceType);
      return {
        field: "address.postalAddress.addressCountry",
        territories: known,
        countryCodes: [],
        canExclude: !remote && known.length === countries.length,
      };
    }
    case "workable": {
      const listed = (Array.isArray(payload.locations) ? payload.locations : [])
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null && item.hidden !== true);
      if (listed.length === 0) return null;
      const territories = listed.map((item) => typeof item.country === "string" ? item.country.trim() : "").filter(Boolean);
      const countryCodes = listed
        .map((item) => typeof item.countryCode === "string" ? item.countryCode.trim().toLowerCase() : "")
        .filter((code) => /^[a-z]{2}$/.test(code));
      const complete = territories.length === listed.length || countryCodes.length === listed.length;
      return { field: "locations", territories, countryCodes, canExclude: complete && payload.telecommuting !== true };
    }
    case "smartrecruiters": {
      const location = asRecord(payload.location);
      const code = typeof location?.country === "string" ? location.country.trim().toLowerCase() : "";
      if (!/^[a-z]{2}$/.test(code)) return null;
      return { field: "location.country", territories: [], countryCodes: [code], canExclude: location?.remote !== true };
    }
    case "lever": {
      const categories = asRecord(payload.categories);
      const territories = textList(categories?.allLocations, false) ?? textList(categories?.location, false) ?? [];
      const rawCode = typeof payload.country === "string" ? payload.country.trim().toLowerCase() : "";
      const countryCodes = /^[a-z]{2}$/.test(rawCode) ? [rawCode] : [];
      if (territories.length === 0 && countryCodes.length === 0) return null;
      // Lever's country belongs to the primary location only, so it never excludes on its own.
      return { field: "categories.allLocations", territories, countryCodes, canExclude: false };
    }
    case "greenhouse": {
      // Offices may be the employer's headquarters for a remote role, so they only keep.
      const territories = (Array.isArray(payload.offices) ? payload.offices : [])
        .map(asRecord)
        .map((office) => typeof office?.location === "string" ? office.location : typeof office?.name === "string" ? office.name : "")
        .map((value) => value.trim())
        .filter(Boolean);
      return territories.length > 0 ? { field: "offices", territories, countryCodes: [], canExclude: false } : null;
    }
    default:
      return null;
  }
}

/**
 * Decide from structured territory fields. Returns null when the fields are absent or unclear,
 * so the free-text location scope decides as before. A posting is kept when any territory names
 * an authorized region, a regional area or a worldwide option; it is out of scope only when every
 * territory is explicit, none is in scope, the field may exclude, and the title names no
 * authorized region.
 */
export function assessStructuredGeoScope(
  job: Pick<ExtractedJob, "title">,
  geo: StructuredGeo | null,
  scope: DiscoveryLocationScope,
): LocationScopeDecision | null {
  if (!geo || !scope.active) return null;
  const inScopeCode = geo.countryCodes.find((code) => scope.inScopeCountryCodes.includes(code));
  if (inScopeCode) {
    return { inScope: true, reasonCode: "GEO_FIELD_IN_SCOPE", reason: `${geo.field} lists country code ${inScopeCode.toUpperCase()}.` };
  }
  let unclear = false;
  for (const raw of geo.territories) {
    const territory = normalize(raw);
    if (!territory || scope.unknownLocationTerms.includes(territory)) {
      unclear = true;
      continue;
    }
    const keep = [...scope.inScopeTerms, ...scope.globalTerms].find((term) => containsTerm(territory, term));
    if (keep) return { inScope: true, reasonCode: "GEO_FIELD_IN_SCOPE", reason: `${geo.field} lists "${raw}".` };
    // A bare "Remote" names no territory.
    if (!removeTerms(territory, [...scope.remoteTerms, ...scope.remoteFillerTerms])) unclear = true;
  }
  if (unclear || !geo.canExclude) return null;
  // A country code alone can only be judged when the authorized regions have codes configured.
  if (geo.territories.length === 0 && (geo.countryCodes.length === 0 || scope.inScopeCountryCodes.length === 0)) return null;
  const title = normalize(job.title);
  if (scope.inScopeTerms.some((term) => containsTerm(title, term))) return null;
  const listed = [...geo.territories, ...geo.countryCodes.map((code) => code.toUpperCase())].join("; ");
  return {
    inScope: false,
    reasonCode: "GEO_FIELD_OUT_OF_SCOPE",
    reason: `${geo.field} restricts the posting to ${listed}, outside ${scope.authorizedRegions.join(", ")}.`,
  };
}
