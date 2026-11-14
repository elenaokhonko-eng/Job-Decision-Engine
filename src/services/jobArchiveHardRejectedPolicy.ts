/**
 * Eligibility for the HARD_REJECTED_PERMANENT archive rule.
 *
 * A job is archived the same day it is hard-rejected when the deterministic gate rejected it with
 * stored reason codes, the owner never saved it (LINKEDIN_SAVED / MCF_SAVED observations must
 * always be evaluated), and no archive protection applies. The SQL candidate scan in
 * src/services/jobArchive.ts pre-filters on these facts; this function re-checks every one so the
 * decision is explicit and unit-testable.
 */

export const HARD_REJECTED_ARCHIVE_REASON = "HARD_REJECTED_PERMANENT" as const;
export const HARD_REJECTED_ARCHIVE_BASIS = "HARD_REJECTED_DECISION" as const;

/** Sources that are the owner's own saved jobs; a job with one of these is never auto-archived. */
export const OWNER_SAVED_SOURCE_NAMES = ["LINKEDIN_SAVED", "MCF_SAVED"] as const;

export function isOwnerSavedSource(sourceName: string | null | undefined): boolean {
  return typeof sourceName === "string" &&
    (OWNER_SAVED_SOURCE_NAMES as readonly string[]).includes(sourceName.trim().toUpperCase());
}

export interface HardRejectedArchiveFacts {
  readonly processing_state: string | null;
  readonly gate_decision: string | null;
  readonly is_test_fixture?: boolean | null;
  readonly archived_at?: Date | string | null;
  /** canonical_jobs.rejection_reason: the gate's codes joined with ", ". */
  readonly rejection_reason: string | null;
  readonly canonical_updated_at: Date | string | null;
  /** The job's latest gate_decisions row, if any. */
  readonly latest_gate_decision_id: string | null;
  readonly latest_gate_decision: string | null;
  readonly latest_gate_decided_at: Date | string | null;
  readonly latest_gate_rejection_codes: unknown;
  readonly has_saved_source_observation: boolean;
  readonly is_protected: boolean;
}

export type HardRejectedArchiveAssessment =
  | {
      readonly status: "ELIGIBLE";
      readonly referenceAt: Date;
      readonly referenceSource: "GATE_DECISION" | "CANONICAL_UPDATED_AT_FALLBACK";
      readonly gateDecisionId: string | null;
      readonly rejectionCodes: readonly string[];
    }
  | { readonly status: "NOT_HARD_REJECTED" }
  | { readonly status: "EXCLUDED_SAVED_SOURCE" }
  | { readonly status: "PROTECTED" }
  | { readonly status: "UNVERIFIABLE_DECISION" }
  | { readonly status: "MISSING_REASON_CODES" };

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function codesFromJson(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((code): code is string => typeof code === "string")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

function codesFromRejectionReason(value: string | null): string[] {
  if (value === null) return [];
  return value.split(",").map((code) => code.trim()).filter((code) => code.length > 0);
}

export function assessHardRejectedArchive(facts: HardRejectedArchiveFacts): HardRejectedArchiveAssessment {
  if (
    facts.processing_state !== "HARD_REJECTED" ||
    facts.gate_decision !== "HARD_REJECT" ||
    facts.is_test_fixture === true ||
    (facts.archived_at !== null && facts.archived_at !== undefined)
  ) {
    return { status: "NOT_HARD_REJECTED" };
  }
  if (facts.has_saved_source_observation) return { status: "EXCLUDED_SAVED_SOURCE" };
  if (facts.is_protected) return { status: "PROTECTED" };

  // The latest gate decision must agree with the canonical outcome; a later PASS or
  // NEEDS_VERIFICATION decision means the canonical row is stale, so nothing is archived.
  if (facts.latest_gate_decision_id !== null && facts.latest_gate_decision !== "HARD_REJECT") {
    return { status: "UNVERIFIABLE_DECISION" };
  }

  const gateCodes = facts.latest_gate_decision_id !== null ? codesFromJson(facts.latest_gate_rejection_codes) : [];
  const rejectionCodes = gateCodes.length > 0 ? gateCodes : codesFromRejectionReason(facts.rejection_reason);
  if (rejectionCodes.length === 0) return { status: "MISSING_REASON_CODES" };

  if (facts.latest_gate_decision_id !== null) {
    const decidedAt = toDate(facts.latest_gate_decided_at);
    if (decidedAt === null) return { status: "UNVERIFIABLE_DECISION" };
    return {
      status: "ELIGIBLE",
      referenceAt: decidedAt,
      referenceSource: "GATE_DECISION",
      gateDecisionId: facts.latest_gate_decision_id,
      rejectionCodes,
    };
  }

  // No gate_decisions row at all (legacy data): the canonical row's last update is the only
  // timestamp of the rejection, and the archive event records that the fallback was used.
  const updatedAt = toDate(facts.canonical_updated_at);
  if (updatedAt === null) return { status: "UNVERIFIABLE_DECISION" };
  return {
    status: "ELIGIBLE",
    referenceAt: updatedAt,
    referenceSource: "CANONICAL_UPDATED_AT_FALLBACK",
    gateDecisionId: null,
    rejectionCodes,
  };
}
