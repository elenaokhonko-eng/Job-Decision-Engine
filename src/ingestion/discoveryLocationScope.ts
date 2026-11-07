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
}

export type LocationScopeReasonCode =
  | "LOCATION_UNKNOWN"
  | "LOCATION_IN_SCOPE"
  | "REMOTE_UNRESTRICTED"
  | "REMOTE_FLAG_WITHOUT_RESTRICTION"
  | "LOCATION_SCOPE_INACTIVE"
  | "LOCATION_OUT_OF_SCOPE";

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

/**
 * Load the scope from config. Returns null when the source plan has no `location_scope` block
 * (no pre-filter). A malformed block or policy throws: a misconfigured filter must not silently
 * widen or narrow discovery.
 */
export function loadDiscoveryLocationScope(
  planPath = path.resolve(process.cwd(), "config/source-plans/six_lane_sources.yml"),
  policyPath = path.resolve(process.cwd(), "config/policies/workability.yml"),
): DiscoveryLocationScope | null {
  const plan = readYaml(planPath);
  const block = plan !== null && typeof plan === "object" && !Array.isArray(plan)
    ? (plan as Record<string, unknown>).location_scope
    : undefined;
  if (block === undefined) return null;
  return buildDiscoveryLocationScope(LocationScopeConfigSchema.parse(block), territoryPolicy(policyPath));
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
