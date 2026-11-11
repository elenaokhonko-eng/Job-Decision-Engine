/**
 * Employer-confirmed job facts as gate and readiness evidence.
 *
 * The user records what the employer told them about one exact job version (migration 110,
 * `job_confirmed_facts`). This module reads the current fact per type for that version and merges it
 * into the inputs of the deterministic hard gate and the readiness assessment:
 *
 * - A confirmed fact fills a fact the posting leaves unknown. It never replaces a fact the posting
 *   states (structured field, extracted requirement or description), and it is never inferred.
 * - Every applied fact adds an evidence line "User-confirmed (source: <source>): <fact>", so a pass or
 *   a rejection that rests on it is explained by it.
 * - A confirmed fact can lead to a rejection (for example a confirmed on-site role without an
 *   exception); the gate rules decide, exactly as for posting evidence.
 *
 * The gate integration is one provider call (`applyConfirmedFactsToGateInput`) and one evidence merge
 * (`withConfirmedFactEvidence`) in `runHardGates`, so gate rule changes stay independent of it.
 */
import crypto from "node:crypto";
import type pg from "pg";

import {
  CONFIRMED_FACT_SOURCE_LABELS,
  ConfirmedFactValueSchemas,
  type ConfirmedFactSourceType,
  type ConfirmedFactType,
} from "../contracts/jobConfirmedFacts.js";
import { extractHybridAttendance, extractTravelRequirement, type GateResult } from "../services/criteria.js";
import type { WorkabilityReadinessResult } from "../eligibility/workabilityReadiness.js";
import { normalizeWorkMode } from "./workModeNormalizer.js";
import { extractTerritories } from "./workabilityPolicy.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export type ConfirmedWorkMode = "ONSITE" | "HYBRID" | "REMOTE";

/** A current confirmed fact whose value has been validated for its type. */
export type ConfirmedJobFact =
  | ConfirmedFactBase<"WORK_MODE", { work_mode: ConfirmedWorkMode }>
  | ConfirmedFactBase<"OFFICE_DAYS", { office_days_min: number; office_days_max: number }>
  | ConfirmedFactBase<"TRAVEL_PCT", { travel_pct_max: number }>
  | ConfirmedFactBase<"ON_CALL", { on_call_required: boolean }>
  | ConfirmedFactBase<"EMPLOYMENT_TYPE", { employment_type: "PERMANENT" | "CONTRACT" }>
  | ConfirmedFactBase<"LOCATION", { location: string; territories: string[] }>;

interface ConfirmedFactBase<T extends ConfirmedFactType, V> {
  readonly id: string;
  readonly factType: T;
  readonly value: V;
  readonly sourceType: ConfirmedFactSourceType;
  readonly recordedAt: string;
}

interface ConfirmedFactRow {
  confirmed_fact_id: string;
  fact_type: string;
  fact_value: unknown;
  source_type: string;
  recorded_at: Date | string;
}

/** Validate a stored row. A row that does not match its type's schema is an error, not a skip. */
export function parseConfirmedFactRow(row: ConfirmedFactRow): ConfirmedJobFact {
  const factType = row.fact_type as ConfirmedFactType;
  const schema = ConfirmedFactValueSchemas[factType];
  if (!schema) throw new Error(`Confirmed fact ${row.confirmed_fact_id} has unsupported fact_type ${row.fact_type}.`);
  const parsed = schema.safeParse(row.fact_value);
  if (!parsed.success) {
    throw new Error(`Confirmed fact ${row.confirmed_fact_id} has an invalid ${row.fact_type} value.`);
  }
  if (!(row.source_type in CONFIRMED_FACT_SOURCE_LABELS)) {
    throw new Error(`Confirmed fact ${row.confirmed_fact_id} has unsupported source_type ${row.source_type}.`);
  }
  const recordedAt = row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at);
  return {
    id: row.confirmed_fact_id,
    factType,
    value: parsed.data,
    sourceType: row.source_type as ConfirmedFactSourceType,
    recordedAt,
  } as ConfirmedJobFact;
}

/** The current confirmed fact per type for exactly this job version. */
export async function loadCurrentConfirmedJobFacts(
  client: QueryClient,
  workspaceId: string,
  jobVersionId: string,
): Promise<ConfirmedJobFact[]> {
  const { rows } = await client.query<ConfirmedFactRow>(
    `SELECT confirmed_fact_id, fact_type, fact_value, source_type, recorded_at
     FROM v_job_confirmed_facts_current
     WHERE workspace_id = $1 AND job_version_id = $2
     ORDER BY fact_type ASC`,
    [workspaceId, jobVersionId],
  );
  return rows.map(parseConfirmedFactRow);
}

/** Stable identity of the facts used, for readiness fingerprints; null when there are none. */
export function confirmedJobFactsHash(facts: readonly ConfirmedJobFact[]): string | null {
  if (facts.length === 0) return null;
  const ids = facts.map((fact) => fact.id).sort();
  return crypto.createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

function factOf<T extends ConfirmedFactType>(
  facts: readonly ConfirmedJobFact[],
  factType: T,
): Extract<ConfirmedJobFact, { factType: T }> | null {
  return (facts.find((fact) => fact.factType === factType) as Extract<ConfirmedJobFact, { factType: T }> | undefined) ?? null;
}

const WORK_MODE_LABELS: Record<ConfirmedWorkMode, string> = {
  ONSITE: "work mode is on-site only",
  HYBRID: "work mode is hybrid",
  REMOTE: "work mode is remote",
};

/** The plain statement of the fact, without its source. */
export function describeConfirmedFact(fact: ConfirmedJobFact): string {
  switch (fact.factType) {
    case "WORK_MODE":
      return WORK_MODE_LABELS[fact.value.work_mode];
    case "OFFICE_DAYS": {
      const { office_days_min: min, office_days_max: max } = fact.value;
      return min === max ? `${max} office days per week` : `${min}-${max} office days per week`;
    }
    case "TRAVEL_PCT":
      return `travel up to ${fact.value.travel_pct_max}%`;
    case "ON_CALL":
      return fact.value.on_call_required ? "regular on-call is required" : "no regular on-call";
    case "EMPLOYMENT_TYPE":
      return fact.value.employment_type === "PERMANENT" ? "permanent employment" : "contract employment";
    case "LOCATION":
      return `location ${fact.value.location}`;
  }
}

/** "User-confirmed (source: recruiter email): work mode is hybrid". */
export function confirmedFactEvidenceQuote(fact: ConfirmedJobFact): string {
  return `User-confirmed (source: ${CONFIRMED_FACT_SOURCE_LABELS[fact.sourceType]}): ${describeConfirmedFact(fact)}`;
}

export function confirmedFactEvidenceKey(fact: ConfirmedJobFact): string {
  return `user_confirmed:${fact.factType}:${fact.id}`;
}

/** Same shape as the hard gate's persisted requirement rows. */
export interface GateRequirementRow {
  requirement_key: string;
  requirement_type: string;
  importance?: string;
  requirement_text: string;
  quote_text: string | null;
  structured_value: Record<string, unknown> | null;
}

export interface GateJobInput {
  readonly workplaceType: string | null | undefined;
  readonly employmentType: string | null | undefined;
  readonly location: string | null | undefined;
  readonly sourceLocation: string | null | undefined;
  readonly description: string | null | undefined;
}

export interface ConfirmedGateInput {
  /** Effective work mode, or the posting value when no confirmed fact applies. */
  readonly workplaceType: string | null | undefined;
  readonly employmentType: string | null | undefined;
  readonly location: string | null | undefined;
  readonly sourceLocation: string | null | undefined;
  /** Posting requirements with unknown-valued rows of a filled type replaced by the confirmed fact. */
  readonly requirements: GateRequirementRow[];
  /** Facts that filled an unknown, in fact-type order. */
  readonly applied: ConfirmedJobFact[];
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function requirementText(requirement: GateRequirementRow): string {
  return requirement.quote_text || requirement.requirement_text || "";
}

function requirementOfficeDays(requirement: GateRequirementRow): number | null {
  for (const key of ["office_days_per_week", "max_office_days_per_week", "office_days_max", "office_days_min"]) {
    const value = numeric(requirement.structured_value?.[key]);
    if (value !== null) return value;
  }
  return extractHybridAttendance(requirementText(requirement))?.office_days_max ?? null;
}

function requirementTravelPct(requirement: GateRequirementRow): number | null {
  for (const key of ["max_travel_pct", "travel_pct_max", "travel_percentage", "maximum_travel_pct"]) {
    const value = numeric(requirement.structured_value?.[key]);
    if (value !== null) return value;
  }
  return extractTravelRequirement(requirementText(requirement))?.max_pct ?? null;
}

/** The posting states a work mode when a structured field or extracted requirement names one. */
export function postingStatesWorkMode(
  workplaceType: string | null | undefined,
  requirements: readonly GateRequirementRow[],
): boolean {
  const raw = String(workplaceType ?? "").trim().toUpperCase();
  // ASSUMED_HYBRID is a policy assumption, not employer evidence.
  if (raw !== "ASSUMED_HYBRID" && normalizeWorkMode(workplaceType) !== "UNKNOWN") return true;
  return requirements.some((requirement) =>
    requirement.requirement_type === "WORK_MODE" && normalizeWorkMode(requirementText(requirement)) !== "UNKNOWN");
}

function syntheticRequirement(
  fact: ConfirmedJobFact,
  requirementType: string,
  structuredValue: Record<string, unknown>,
): GateRequirementRow {
  const quote = confirmedFactEvidenceQuote(fact);
  return {
    requirement_key: `user_confirmed:${fact.factType.toLowerCase()}:${fact.id}`,
    requirement_type: requirementType,
    importance: "MUST",
    requirement_text: quote,
    quote_text: quote,
    structured_value: { ...structuredValue, confirmed_fact_id: fact.id, source_type: fact.sourceType },
  };
}

/**
 * Merge the current confirmed facts into the hard-gate inputs. Facts fill only unknowns; a fact the
 * posting states wins and the confirmed fact is left unapplied.
 */
export function applyConfirmedFactsToGateInput(
  job: GateJobInput,
  requirements: readonly GateRequirementRow[],
  facts: readonly ConfirmedJobFact[],
): ConfirmedGateInput {
  let workplaceType = job.workplaceType;
  let employmentType = job.employmentType;
  let location = job.location;
  let sourceLocation = job.sourceLocation;
  let merged = [...requirements];
  const applied: ConfirmedJobFact[] = [];
  const description = String(job.description ?? "");

  const workMode = factOf(facts, "WORK_MODE");
  if (workMode && !postingStatesWorkMode(job.workplaceType, requirements)) {
    workplaceType = workMode.value.work_mode;
    merged = merged.filter((requirement) => requirement.requirement_type !== "WORK_MODE");
    merged.push(syntheticRequirement(workMode, "WORK_MODE", { work_mode: workMode.value.work_mode }));
    applied.push(workMode);
  }

  const officeDays = factOf(facts, "OFFICE_DAYS");
  const statedOfficeDays = requirements.some((requirement) =>
    requirement.requirement_type === "OFFICE_DAYS" && requirementOfficeDays(requirement) !== null)
    || requirements.some((requirement) =>
      requirement.requirement_type === "WORK_MODE" && extractHybridAttendance(requirementText(requirement)) !== null)
    || extractHybridAttendance(description) !== null;
  if (officeDays && !statedOfficeDays) {
    merged = merged.filter((requirement) => requirement.requirement_type !== "OFFICE_DAYS");
    merged.push(syntheticRequirement(officeDays, "OFFICE_DAYS", {
      office_days_per_week: officeDays.value.office_days_max,
      office_days_min: officeDays.value.office_days_min,
      office_days_max: officeDays.value.office_days_max,
    }));
    applied.push(officeDays);
  }

  const travel = factOf(facts, "TRAVEL_PCT");
  const statedTravel = requirements.some((requirement) =>
    requirement.requirement_type === "TRAVEL" && requirementTravelPct(requirement) !== null)
    || extractTravelRequirement(description) !== null;
  if (travel && !statedTravel) {
    merged = merged.filter((requirement) => requirement.requirement_type !== "TRAVEL");
    merged.push(syntheticRequirement(travel, "TRAVEL", { max_travel_pct: travel.value.travel_pct_max }));
    applied.push(travel);
  }

  // Only a required on-call is a gate input; "no on-call" leaves the posting as it is.
  const onCall = factOf(facts, "ON_CALL");
  if (onCall?.value.on_call_required && !requirements.some((requirement) => requirement.requirement_type === "ON_CALL")) {
    merged.push(syntheticRequirement(onCall, "ON_CALL", { on_call_required: true }));
    applied.push(onCall);
  }

  const employment = factOf(facts, "EMPLOYMENT_TYPE");
  const statedEmployment = ["PERMANENT", "CONTRACT", "FULL_TIME", "FULL-TIME", "FTE"].some((value) =>
    String(job.employmentType ?? "").trim().toUpperCase().includes(value))
    || requirements.some((requirement) => requirement.requirement_type === "EMPLOYMENT_TYPE");
  if (employment && !statedEmployment) {
    employmentType = employment.value.employment_type;
    applied.push(employment);
  }

  const confirmedLocation = factOf(facts, "LOCATION");
  if (confirmedLocation && confirmedLocation.value.territories.length > 0) {
    const fillLocation = extractTerritories(job.location ?? "").length === 0;
    const fillSourceLocation = extractTerritories(job.sourceLocation ?? "").length === 0;
    if (fillLocation) location = confirmedLocation.value.location;
    if (fillSourceLocation) sourceLocation = confirmedLocation.value.location;
    if (fillLocation || fillSourceLocation) applied.push(confirmedLocation);
  }

  return { workplaceType, employmentType, location, sourceLocation, requirements: merged, applied };
}

/** Add one "User-confirmed (source: …)" evidence line per applied fact to the combined gate result. */
export function withConfirmedFactEvidence(result: GateResult, applied: readonly ConfirmedJobFact[]): GateResult {
  if (applied.length === 0) return result;
  const evidence = [...result.evidence_quotes];
  for (const fact of applied) {
    const quote = confirmedFactEvidenceQuote(fact);
    if (!evidence.includes(quote)) evidence.push(quote);
  }
  return { ...result, evidence_quotes: evidence };
}

// --- Readiness overlay -------------------------------------------------------------------------

export interface ConfirmedWorkModeEvidence {
  readonly status: string;
  readonly value: string;
  readonly office_days_max: number | null;
  readonly evidence: readonly { readonly evidence_key: string }[];
}

export interface ConfirmedTravelEvidence {
  readonly status: string;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly evidence: readonly { readonly evidence_key: string }[];
}

/**
 * Work-mode readiness evidence: the source evidence when it is SUPPORTED or the posting states a
 * mode; otherwise the confirmed mode (with confirmed office days when present).
 */
export function confirmedWorkModeEvidence<T extends ConfirmedWorkModeEvidence>(
  sourceEvidence: T | null,
  workplaceType: string | null | undefined,
  facts: readonly ConfirmedJobFact[],
): T | ConfirmedWorkModeEvidence | null {
  if (sourceEvidence?.status === "SUPPORTED") return sourceEvidence;
  const workMode = factOf(facts, "WORK_MODE");
  if (!workMode || postingStatesWorkMode(workplaceType, [])) return sourceEvidence;
  const officeDays = factOf(facts, "OFFICE_DAYS");
  const mode = workMode.value.work_mode;
  return {
    status: "SUPPORTED",
    value: mode,
    office_days_max: officeDays?.value.office_days_max ?? (mode === "REMOTE" ? 0 : mode === "ONSITE" ? 5 : null),
    evidence: [workMode, ...(officeDays ? [officeDays] : [])].map((fact) => ({ evidence_key: confirmedFactEvidenceKey(fact) })),
  };
}

/** Travel readiness evidence: a SUPPORTED source value wins; otherwise the confirmed maximum. */
export function confirmedTravelEvidence<T extends ConfirmedTravelEvidence>(
  sourceEvidence: T | null,
  description: string,
  facts: readonly ConfirmedJobFact[],
): T | ConfirmedTravelEvidence | null {
  if (sourceEvidence?.status === "SUPPORTED") return sourceEvidence;
  const travel = factOf(facts, "TRAVEL_PCT");
  if (!travel || extractTravelRequirement(description) !== null) return sourceEvidence;
  return {
    status: "SUPPORTED",
    minimum: null,
    maximum: travel.value.travel_pct_max,
    evidence: [{ evidence_key: confirmedFactEvidenceKey(travel) }],
  };
}

/** The confirmed employment type when the gate facts leave it unknown. */
export function confirmedEmploymentType(
  current: string,
  facts: readonly ConfirmedJobFact[],
): { readonly employmentType: string; readonly fact: ConfirmedJobFact | null } {
  if (current === "PERMANENT" || current === "CONTRACT") return { employmentType: current, fact: null };
  const employment = factOf(facts, "EMPLOYMENT_TYPE");
  return employment
    ? { employmentType: employment.value.employment_type, fact: employment }
    : { employmentType: current, fact: null };
}

/**
 * Work-authorization readiness: an unresolved hiring territory (no posting evidence) is settled by a
 * confirmed location. Territories inside the authorized regions are MET; any other is BLOCKED.
 */
export function withConfirmedTerritory(
  result: WorkabilityReadinessResult,
  facts: readonly ConfirmedJobFact[],
  authorizedRegions: readonly string[],
): WorkabilityReadinessResult {
  if (result.status !== "NEEDS_VERIFICATION" || result.reasonCode !== "WORK_AUTHORIZATION_UNKNOWN") return result;
  const location = factOf(facts, "LOCATION");
  if (!location || location.value.territories.length === 0) return result;
  const authorized = new Set(authorizedRegions);
  const outside = location.value.territories.filter((territory) => !authorized.has(territory));
  return outside.length === 0
    ? {
        status: "MET",
        reasonCode: null,
        rationale: `${confirmedFactEvidenceQuote(location)}; within the authorized regions.`,
        evidenceKeys: [...result.evidenceKeys, confirmedFactEvidenceKey(location)],
        policyReferenceRequired: false,
      }
    : {
        status: "BLOCKED",
        reasonCode: "WORK_AUTHORIZATION_INCOMPATIBLE",
        rationale: `${confirmedFactEvidenceQuote(location)}; outside the authorized regions: ${outside.join(", ")}.`,
        evidenceKeys: [...result.evidenceKeys, confirmedFactEvidenceKey(location)],
        policyReferenceRequired: false,
      };
}

/** The work mode the decision's evidence-completeness score should see. */
export function confirmedWorkplaceType(
  workplaceType: string | null | undefined,
  facts: readonly ConfirmedJobFact[],
): string | null | undefined {
  const workMode = factOf(facts, "WORK_MODE");
  if (!workMode || postingStatesWorkMode(workplaceType, [])) return workplaceType;
  return workMode.value.work_mode;
}

