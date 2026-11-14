import { describe, expect, it } from "vitest";

import {
  assessHardRejectedArchive,
  isOwnerSavedSource,
  type HardRejectedArchiveFacts,
} from "../../services/jobArchiveHardRejectedPolicy.js";

const gateDecidedAt = new Date("2026-11-10T08:00:00.000Z");
const canonicalUpdatedAt = new Date("2026-11-10T08:00:01.000Z");

function facts(overrides: Partial<HardRejectedArchiveFacts> = {}): HardRejectedArchiveFacts {
  return {
    processing_state: "HARD_REJECTED",
    gate_decision: "HARD_REJECT",
    is_test_fixture: false,
    archived_at: null,
    rejection_reason: "ONSITE_ONLY",
    canonical_updated_at: canonicalUpdatedAt,
    latest_gate_decision_id: "20000000-0000-4000-8000-000000000001",
    latest_gate_decision: "HARD_REJECT",
    latest_gate_decided_at: gateDecidedAt,
    latest_gate_rejection_codes: ["ONSITE_ONLY", "TRAVEL_OVER_LIMIT"],
    has_saved_source_observation: false,
    is_protected: false,
    ...overrides,
  };
}

describe("hard-rejected archive eligibility", () => {
  it("archives a deterministic hard rejection with stored codes, referenced to the latest gate decision", () => {
    expect(assessHardRejectedArchive(facts())).toEqual({
      status: "ELIGIBLE",
      referenceAt: gateDecidedAt,
      referenceSource: "GATE_DECISION",
      gateDecisionId: "20000000-0000-4000-8000-000000000001",
      rejectionCodes: ["ONSITE_ONLY", "TRAVEL_OVER_LIMIT"],
    });
  });

  it("reads gate codes stored as a JSON string", () => {
    const result = assessHardRejectedArchive(facts({ latest_gate_rejection_codes: "[\"SALARY_BELOW_FLOOR\"]" }));
    expect(result).toMatchObject({ status: "ELIGIBLE", rejectionCodes: ["SALARY_BELOW_FLOOR"] });
  });

  it("never archives the owner's saved jobs, even when hard-rejected", () => {
    expect(assessHardRejectedArchive(facts({ has_saved_source_observation: true }))).toEqual({
      status: "EXCLUDED_SAVED_SOURCE",
    });
    // The saved-source exclusion wins over protections and missing codes, so the report counts
    // the owner's jobs under one explicit reason.
    expect(assessHardRejectedArchive(facts({
      has_saved_source_observation: true,
      is_protected: true,
      latest_gate_rejection_codes: [],
      rejection_reason: null,
    }))).toEqual({ status: "EXCLUDED_SAVED_SOURCE" });
  });

  it("respects archive protections", () => {
    expect(assessHardRejectedArchive(facts({ is_protected: true }))).toEqual({ status: "PROTECTED" });
  });

  it.each([
    ["NEEDS_VERIFICATION state", { processing_state: "NEEDS_VERIFICATION", gate_decision: "NEEDS_VERIFICATION" }],
    ["passed gate", { processing_state: "PREQUALIFIED", gate_decision: "PASS" }],
    ["manually removed", { processing_state: "MANUALLY_REMOVED" }],
    ["state without HARD_REJECT gate decision", { gate_decision: "PASS" }],
    ["test fixture", { is_test_fixture: true }],
    ["already archived", { archived_at: new Date("2026-11-11T00:00:00.000Z") }],
  ] as const)("ignores a job that is not an unarchived hard rejection (%s)", (_label, overrides) => {
    expect(assessHardRejectedArchive(facts(overrides as Partial<HardRejectedArchiveFacts>))).toEqual({
      status: "NOT_HARD_REJECTED",
    });
  });

  it("refuses to archive without stored reason codes", () => {
    expect(assessHardRejectedArchive(facts({
      latest_gate_rejection_codes: [],
      rejection_reason: null,
    }))).toEqual({ status: "MISSING_REASON_CODES" });
    expect(assessHardRejectedArchive(facts({
      latest_gate_rejection_codes: ["  "],
      rejection_reason: " , ",
    }))).toEqual({ status: "MISSING_REASON_CODES" });
  });

  it("falls back to the canonical rejection_reason codes when the gate row has none", () => {
    expect(assessHardRejectedArchive(facts({
      latest_gate_rejection_codes: [],
      rejection_reason: "ONSITE_ONLY, OFFICE_DAYS_OVER_LIMIT",
    }))).toMatchObject({
      status: "ELIGIBLE",
      referenceSource: "GATE_DECISION",
      rejectionCodes: ["ONSITE_ONLY", "OFFICE_DAYS_OVER_LIMIT"],
    });
  });

  it("does not archive when the latest gate decision disagrees with the canonical outcome", () => {
    expect(assessHardRejectedArchive(facts({ latest_gate_decision: "PASS" }))).toEqual({
      status: "UNVERIFIABLE_DECISION",
    });
    expect(assessHardRejectedArchive(facts({ latest_gate_decided_at: "not a date" }))).toEqual({
      status: "UNVERIFIABLE_DECISION",
    });
  });

  it("uses canonical updated_at only when the job has no gate decision row", () => {
    expect(assessHardRejectedArchive(facts({
      latest_gate_decision_id: null,
      latest_gate_decision: null,
      latest_gate_decided_at: null,
      latest_gate_rejection_codes: null,
    }))).toEqual({
      status: "ELIGIBLE",
      referenceAt: canonicalUpdatedAt,
      referenceSource: "CANONICAL_UPDATED_AT_FALLBACK",
      gateDecisionId: null,
      rejectionCodes: ["ONSITE_ONLY"],
    });
  });

  it("recognises only the owner's saved sources", () => {
    expect(isOwnerSavedSource("LINKEDIN_SAVED")).toBe(true);
    expect(isOwnerSavedSource("MCF_SAVED")).toBe(true);
    expect(isOwnerSavedSource("mcf_saved")).toBe(true);
    expect(isOwnerSavedSource("LINKEDIN")).toBe(false);
    expect(isOwnerSavedSource("GMAIL_ALERT")).toBe(false);
    expect(isOwnerSavedSource(null)).toBe(false);
  });
});
