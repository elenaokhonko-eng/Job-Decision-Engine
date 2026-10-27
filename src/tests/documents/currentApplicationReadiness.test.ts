import { describe, expect, it } from "vitest";
import {
  isCurrentReadinessAssessment,
  isCurrentReadyApplicationReadiness,
  type CurrentApplicationReadiness,
} from "../../services/currentApplicationReadiness.js";

const fingerprint = "a".repeat(64);
const expiry = "2099-01-01T00:00:00.000Z";

function assessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "application_readiness_v1",
    status: "READY",
    canonical_job_id: "22222222-2222-4222-8222-222222222222",
    job_version_id: "33333333-3333-4333-8333-333333333333",
    profile_version_id: "44444444-4444-4444-8444-444444444444",
    requirement_set_id: "55555555-5555-4555-8555-555555555555",
    match_run_id: "66666666-6666-4666-8666-666666666666",
    evidence_revision_hash: "b".repeat(64),
    readiness_fingerprint: fingerprint,
    evaluated_at: "2098-01-01T00:00:00.000Z",
    expires_at: expiry,
    ...overrides,
  };
}

function readiness(
  overrides: Partial<CurrentApplicationReadiness> = {},
): CurrentApplicationReadiness {
  return {
    application_readiness: assessment(),
    readiness_status: "READY",
    readiness_fingerprint: fingerprint,
    readiness_expires_at: new Date(expiry),
    readiness_reason_codes: [],
    canonical_job_id: "22222222-2222-4222-8222-222222222222",
    job_version_id: "33333333-3333-4333-8333-333333333333",
    profile_version_id: "44444444-4444-4444-8444-444444444444",
    requirement_set_id: "55555555-5555-4555-8555-555555555555",
    match_run_id: "66666666-6666-4666-8666-666666666666",
    evidence_revision_hash: "b".repeat(64),
    ...overrides,
  };
}

describe("current application readiness", () => {
  it("accepts only a current READY assessment with matching lineage and expiry", () => {
    expect(isCurrentReadyApplicationReadiness(readiness(), Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
  });

  it.each([
    { readiness_status: "NEEDS_VERIFICATION" },
    { readiness_fingerprint: null },
    { readiness_reason_codes: ["SALARY_BASIS_UNRESOLVED"] },
    { readiness_expires_at: new Date("2000-01-01T00:00:00.000Z") },
    { evidence_revision_hash: "c".repeat(64) },
  ])("rejects a readiness assessment that is unresolved, stale, or expired", (overrides) => {
    expect(isCurrentReadyApplicationReadiness(readiness(overrides), Date.parse("2026-01-01T00:00:00Z"))).toBe(false);
  });

  it("requires reassessment when readiness evidence expires before it was evaluated", () => {
    const oldAssessment = readiness({
      readiness_status: "NEEDS_VERIFICATION",
      readiness_reason_codes: ["READINESS_EVIDENCE_EXPIRED"],
      readiness_expires_at: new Date("2025-01-01T00:00:00.000Z"),
      application_readiness: assessment({
        status: "NEEDS_VERIFICATION",
        expires_at: "2025-01-01T00:00:00.000Z",
        evaluated_at: "2024-12-01T00:00:00.000Z",
      }),
    });
    expect(isCurrentReadinessAssessment(oldAssessment, Date.parse("2026-01-01T00:00:00Z"))).toBe(false);
  });

  it("accepts a fresh NEEDS_VERIFICATION assessment after availability expiry without repeating work", () => {
    const reassessed = readiness({
      readiness_status: "NEEDS_VERIFICATION",
      readiness_reason_codes: ["READINESS_EVIDENCE_EXPIRED"],
      readiness_expires_at: new Date("2025-01-01T00:00:00.000Z"),
      application_readiness: assessment({
        status: "NEEDS_VERIFICATION",
        expires_at: "2025-01-01T00:00:00.000Z",
        evaluated_at: "2025-01-02T00:00:00.000Z",
      }),
    });
    expect(isCurrentReadinessAssessment(reassessed, Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
  });
});
