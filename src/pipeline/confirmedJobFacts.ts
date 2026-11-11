/**
 * Employer-confirmed job facts as gate and readiness evidence.
 *
 * The user records what the employer told them about one exact job version (migration 110,
 * `job_confirmed_facts`). This module reads the current fact per type for that version and merges it
 * into the inputs of the deterministic hard gate:
 *
 * - A confirmed fact is applied only when the posting leaves that fact unknown in every kind of
 *   posting evidence (`assessPostingFacts`: structured fields, extracted requirements, the
 *   description through the gate's own extraction, and the latest normalized source evidence) at
 *   gate time AND the assessment stored when the fact was recorded says it fills an unknown. A fact the
 *   posting states always wins; a contradicting confirmation is reported as a conflict, not applied.
 * - Every applied fact adds "User-confirmed (source: <source>): <fact>" to the gate evidence; every
 *   conflict adds "User confirmation not applied ...: the posting states ...". The gate rules decide,
 *   so a confirmed on-site role without an exception is a deterministic rejection.
 * - The gate records the ids it applied in `workability_facts.confirmed_fact_ids`; readiness uses
 *   exactly those facts, and still defers to SUPPORTED or CONFLICTING source evidence.
 *
 * The gate integration is one provider call (`applyConfirmedFactsToGateInput`) and one result merge
 * (`withConfirmedFactEvidence`), so gate rule changes stay independent of it.
 */
import crypto from "node:crypto";
import type pg from "pg";

import {
  CONFIRMED_FACT_SOURCE_LABELS,
  ConfirmedFactValueSchemas,
  type ConfirmedFactSourceType,
  type ConfirmedFactType,
} from "../contracts/jobConfirmedFacts.js";
import type { GateResult } from "../services/criteria.js";
import type { WorkabilityReadinessResult } from "../eligibility/workabilityReadiness.js";
import { extractTerritories, type WorkabilityPolicy } from "./workabilityPolicy.js";
import {
  assessConfirmedValue,
  assessPostingFacts,
  describePostingValue,
  type ConfirmedFactAssessmentOutcome,
  type PostingFactEvidence,
  type PostingRequirementRow,
  type PostingSourceEvidence,
} from "./postingStatedFacts.js";

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
  /** The comparison with the posting stored when the fact was recorded. */
  readonly postingAssessment: ConfirmedFactAssessmentOutcome;
  readonly recordedAt: string;
}

interface ConfirmedFactRow {
  confirmed_fact_id: string;
  fact_type: string;
  fact_value: unknown;
  source_type: string | null;
  posting_assessment: string | null;
  recorded_at: Date | string;
}

const ASSESSMENTS = new Set<string>(["FILLS_UNKNOWN", "MATCHES_POSTING", "CONFLICTS_WITH_POSTING"]);

/** Validate a stored row. A row that does not match its type's schema is an error, not a skip. */
export function parseConfirmedFactRow(row: ConfirmedFactRow): ConfirmedJobFact {
  const factType = row.fact_type as ConfirmedFactType;
  const schema = ConfirmedFactValueSchemas[factType];
  if (!schema) throw new Error(`Confirmed fact ${row.confirmed_fact_id} has unsupported fact_type ${row.fact_type}.`);
  const parsed = schema.safeParse(row.fact_value);
  if (!parsed.success) {
    throw new Error(`Confirmed fact ${row.confirmed_fact_id} has an invalid ${row.fact_type} value.`);
  }
  if (!row.source_type || !(row.source_type in CONFIRMED_FACT_SOURCE_LABELS)) {
    throw new Error(`Confirmed fact ${row.confirmed_fact_id} has unsupported source_type ${row.source_type}.`);
  }
  if (!row.posting_assessment || !ASSESSMENTS.has(row.posting_assessment)) {
    throw new Error(`Confirmed fact ${row.confirmed_fact_id} has unsupported posting_assessment ${row.posting_assessment}.`);
  }
  const recordedAt = row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at);
  return {
    id: row.confirmed_fact_id,
    factType,
    value: parsed.data,
    sourceType: row.source_type as ConfirmedFactSourceType,
    postingAssessment: row.posting_assessment as ConfirmedFactAssessmentOutcome,
    recordedAt,
  } as ConfirmedJobFact;
}

/** The current confirmed fact per type for exactly this job version (withdrawn facts excluded). */
export async function loadCurrentConfirmedJobFacts(
  client: QueryClient,
  workspaceId: string,
  jobVersionId: string,
): Promise<ConfirmedJobFact[]> {
  const { rows } = await client.query<ConfirmedFactRow>(
    `SELECT confirmed_fact_id, fact_type, fact_value, source_type, posting_assessment, recorded_at
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

/** The gate evidence line for a confirmation that contradicts the posting and was not applied. */
export function confirmedFactConflictQuote(fact: ConfirmedJobFact, posting: PostingFactEvidence): string {
  const where = posting.source ? posting.source.toLowerCase().replaceAll("_", " ") : "posting";
  return `User confirmation not applied (source: ${CONFIRMED_FACT_SOURCE_LABELS[fact.sourceType]}): ${describeConfirmedFact(fact)}; the posting states ${describePostingValue(posting)} (${where})`;
}

export function confirmedFactEvidenceKey(fact: ConfirmedJobFact): string {
  return `user_confirmed:${fact.factType}:${fact.id}`;
}

/** Same shape as the hard gate's persisted requirement rows. */
export interface GateRequirementRow extends PostingRequirementRow {
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
  readonly companyName?: string | null | undefined;
  /** Latest normalized source evidence of the version, as readiness and the record-time check read it. */
  readonly sourceEvidence?: PostingSourceEvidence | null;
}

export interface ConfirmedFactConflict {
  readonly fact: ConfirmedJobFact;
  readonly posting: PostingFactEvidence;
}

export interface ConfirmedGateInput {
  /** Effective work mode, or the posting value when no confirmed fact applies. */
  readonly workplaceType: string | null | undefined;
  readonly employmentType: string | null | undefined;
  readonly location: string | null | undefined;
  readonly sourceLocation: string | null | undefined;
  /** Posting requirements plus one requirement row per applied office-days, travel, on-call or work-mode fact. */
  readonly requirements: GateRequirementRow[];
  /** Facts that filled an unknown, in fact-type order. */
  readonly applied: ConfirmedJobFact[];
  /** Confirmations that contradict the posting; never applied. */
  readonly conflicts: ConfirmedFactConflict[];
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
 * Merge the current confirmed facts into the hard-gate inputs. A fact is applied only when it fills
 * a fact the posting leaves unknown, both now and when it was recorded.
 */
export function applyConfirmedFactsToGateInput(
  job: GateJobInput,
  requirements: readonly GateRequirementRow[],
  facts: readonly ConfirmedJobFact[],
  policy: WorkabilityPolicy,
): ConfirmedGateInput {
  let workplaceType = job.workplaceType;
  let employmentType = job.employmentType;
  let location = job.location;
  let sourceLocation = job.sourceLocation;
  const merged = [...requirements];
  const applied: ConfirmedJobFact[] = [];
  const conflicts: ConfirmedFactConflict[] = [];
  if (facts.length === 0) {
    return { workplaceType, employmentType, location, sourceLocation, requirements: merged, applied, conflicts };
  }

  const posting = assessPostingFacts({
    workplaceType: job.workplaceType,
    employmentType: job.employmentType,
    location: job.location,
    sourceLocation: job.sourceLocation,
    description: job.description,
    companyName: job.companyName,
    requirements,
    sourceEvidence: job.sourceEvidence ?? null,
    policy,
  });

  for (const fact of [...facts].sort((left, right) => left.factType.localeCompare(right.factType))) {
    const now = assessConfirmedValue(fact.factType, fact.value as Record<string, unknown>, posting[fact.factType]);
    if (now === "CONFLICTS_WITH_POSTING" || fact.postingAssessment === "CONFLICTS_WITH_POSTING") {
      conflicts.push({ fact, posting: posting[fact.factType] });
      continue;
    }
    if (now !== "FILLS_UNKNOWN" || fact.postingAssessment !== "FILLS_UNKNOWN") continue;

    switch (fact.factType) {
      case "WORK_MODE":
        workplaceType = fact.value.work_mode;
        merged.push(syntheticRequirement(fact, "WORK_MODE", { work_mode: fact.value.work_mode }));
        break;
      case "OFFICE_DAYS":
        merged.push(syntheticRequirement(fact, "OFFICE_DAYS", {
          office_days_per_week: fact.value.office_days_max,
          office_days_min: fact.value.office_days_min,
          office_days_max: fact.value.office_days_max,
        }));
        break;
      case "TRAVEL_PCT":
        merged.push(syntheticRequirement(fact, "TRAVEL", { max_travel_pct: fact.value.travel_pct_max }));
        break;
      case "ON_CALL":
        // Only a required on-call is a gate input; "no on-call" is recorded evidence.
        if (fact.value.on_call_required) merged.push(syntheticRequirement(fact, "ON_CALL", { on_call_required: true }));
        break;
      case "EMPLOYMENT_TYPE":
        employmentType = fact.value.employment_type;
        break;
      case "LOCATION":
        if (fact.value.territories.length === 0) continue;
        if (extractTerritories(job.location ?? "").length === 0) location = fact.value.location;
        if (extractTerritories(job.sourceLocation ?? "").length === 0) sourceLocation = fact.value.location;
        break;
    }
    applied.push(fact);
  }

  return { workplaceType, employmentType, location, sourceLocation, requirements: merged, applied, conflicts };
}

export type ConfirmedGateResult = GateResult & {
  workability_facts: GateResult["workability_facts"] & { confirmed_fact_ids?: string[] };
};

/**
 * Add one evidence line per applied fact and per conflict to the combined gate result, and record
 * the applied ids for readiness. Without confirmed facts the result is returned unchanged.
 */
export function withConfirmedFactEvidence(
  result: GateResult,
  input: Pick<ConfirmedGateInput, "applied" | "conflicts">,
): ConfirmedGateResult {
  if (input.applied.length === 0 && input.conflicts.length === 0) return result;
  const evidence = [...result.evidence_quotes];
  for (const fact of input.applied) {
    const quote = confirmedFactEvidenceQuote(fact);
    if (!evidence.includes(quote)) evidence.push(quote);
  }
  for (const conflict of input.conflicts) {
    const quote = confirmedFactConflictQuote(conflict.fact, conflict.posting);
    if (!evidence.includes(quote)) evidence.push(quote);
  }
  return {
    ...result,
    evidence_quotes: evidence,
    workability_facts: {
      ...result.workability_facts,
      ...(input.applied.length > 0 ? { confirmed_fact_ids: input.applied.map((fact) => fact.id) } : {}),
    },
  };
}

// --- Readiness overlay -------------------------------------------------------------------------

/** The current facts the latest gate decision applied (ids stored in its workability facts). */
export function gateAppliedConfirmedFacts(
  facts: readonly ConfirmedJobFact[],
  workabilityFacts: Record<string, unknown>,
): ConfirmedJobFact[] {
  const ids = Array.isArray(workabilityFacts.confirmed_fact_ids)
    ? new Set(workabilityFacts.confirmed_fact_ids.map(String))
    : new Set<string>();
  return facts.filter((fact) => ids.has(fact.id) && fact.postingAssessment === "FILLS_UNKNOWN");
}

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

function sourceStates(status: string | undefined): boolean {
  return status === "SUPPORTED" || status === "CONFLICTING";
}

/** Work-mode readiness evidence: SUPPORTED or CONFLICTING source evidence wins; otherwise the applied fact. */
export function confirmedWorkModeEvidence<T extends ConfirmedWorkModeEvidence>(
  sourceEvidence: T | null,
  applied: readonly ConfirmedJobFact[],
): T | ConfirmedWorkModeEvidence | null {
  if (sourceStates(sourceEvidence?.status)) return sourceEvidence;
  const workMode = factOf(applied, "WORK_MODE");
  if (!workMode) return sourceEvidence;
  const officeDays = factOf(applied, "OFFICE_DAYS");
  const mode = workMode.value.work_mode;
  return {
    status: "SUPPORTED",
    value: mode,
    office_days_max: officeDays?.value.office_days_max ?? (mode === "REMOTE" ? 0 : mode === "ONSITE" ? 5 : null),
    evidence: [workMode, ...(officeDays ? [officeDays] : [])].map((fact) => ({ evidence_key: confirmedFactEvidenceKey(fact) })),
  };
}

/** Travel readiness evidence: SUPPORTED or CONFLICTING source evidence wins; otherwise the applied maximum. */
export function confirmedTravelEvidence<T extends ConfirmedTravelEvidence>(
  sourceEvidence: T | null,
  applied: readonly ConfirmedJobFact[],
): T | ConfirmedTravelEvidence | null {
  if (sourceStates(sourceEvidence?.status)) return sourceEvidence;
  const travel = factOf(applied, "TRAVEL_PCT");
  if (!travel) return sourceEvidence;
  return {
    status: "SUPPORTED",
    minimum: null,
    maximum: travel.value.travel_pct_max,
    evidence: [{ evidence_key: confirmedFactEvidenceKey(travel) }],
  };
}

/**
 * The employment type readiness should assess. Only an empty or UNKNOWN value is filled; a stated
 * non-standard type (for example INTERNSHIP) stays as it is.
 */
export function confirmedEmploymentType(
  current: string,
  applied: readonly ConfirmedJobFact[],
): { readonly employmentType: string; readonly fact: ConfirmedJobFact | null } {
  const employment = factOf(applied, "EMPLOYMENT_TYPE");
  if (!employment) return { employmentType: current, fact: null };
  if (current === employment.value.employment_type) return { employmentType: current, fact: employment };
  if (current === "" || current === "UNKNOWN") return { employmentType: employment.value.employment_type, fact: employment };
  return { employmentType: current, fact: null };
}

/**
 * Work-authorization readiness: an unresolved hiring territory (no posting evidence) is settled by an
 * applied location. Territories inside the authorized regions are MET; any other is BLOCKED.
 */
export function withConfirmedTerritory(
  result: WorkabilityReadinessResult,
  applied: readonly ConfirmedJobFact[],
  authorizedRegions: readonly string[],
): WorkabilityReadinessResult {
  if (result.status !== "NEEDS_VERIFICATION" || result.reasonCode !== "WORK_AUTHORIZATION_UNKNOWN") return result;
  const location = factOf(applied, "LOCATION");
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
  applied: readonly ConfirmedJobFact[],
): string | null | undefined {
  const workMode = factOf(applied, "WORK_MODE");
  return workMode ? workMode.value.work_mode : workplaceType;
}
