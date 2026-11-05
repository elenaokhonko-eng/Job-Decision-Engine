import { describe, expect, it } from "vitest";
import {
  REQUIRED_MATERIAL_READINESS_CHECK_KEYS,
  assessApplicationReadiness,
} from "../../eligibility/applicationReadiness.js";
import { buildCompensationReadinessCheck } from "../../pipeline/compensationReadiness.js";
import { resolveCompensationEvidence } from "../../pipeline/compensationEvidence.js";
import { evaluateCompensationPolicy } from "../../policy/stage3PolicyEngine.js";
import { CompensationPolicySchema } from "../../policy/stage3Contracts.js";
import type { MaterialReadinessCheck } from "../../contracts/applicationReadiness.js";

const assessedAt = "2026-10-27T08:00:00.000Z";
const compensationPolicy = CompensationPolicySchema.parse({
  target_salary_basis: "GROSS",
  commercial_min_annual_sgd: 250000,
  commercial_target_annual_sgd: 300000,
  disposition_below_floor: "PREVENT_APPLY_NOW",
});

function readyChecksWith(compensation: MaterialReadinessCheck): MaterialReadinessCheck[] {
  return REQUIRED_MATERIAL_READINESS_CHECK_KEYS.map((key) => key === "COMPENSATION"
    ? compensation
    : {
        key,
        status: "MET",
        importance: "MUST",
        reason_code: null,
        rationale: "Supported test evidence satisfies this check.",
        evidence_keys: [],
        policy_reference: null,
        assessed_at: assessedAt,
        expires_at: null,
      });
}

describe("buildCompensationReadinessCheck", () => {
  it("keeps a competitive base with a disclosed bonus informational and ready", () => {
    const resolution = resolveCompensationEvidence(
      "Base salary competitive; annual bonus SGD 50,000",
      null,
    );
    expect(resolution.kind).toBe("UNDISCLOSED");

    const check = buildCompensationReadinessCheck({
      floorConfigured: true,
      resolutionKind: resolution.kind,
      assessment: null,
      basisConfigured: true,
      fxRateFailure: null,
      fxRateObservationId: null,
      preferenceRevisionId: "stage3-revision-2",
      assessedAt,
    });

    expect(check).toMatchObject({
      key: "COMPENSATION",
      status: "NEEDS_VERIFICATION",
      importance: "PREFERRED",
      reason_code: "COMPENSATION_UNDISCLOSED",
      rationale: "Salary undisclosed—confirm with recruiter.",
    });

    const readiness = assessApplicationReadiness({
      canonicalJobId: "10000000-0000-4000-8000-000000000001",
      jobVersionId: "20000000-0000-4000-8000-000000000002",
      profileVersionId: null,
      requirementSetId: null,
      matchRunId: null,
      preferenceContextId: null,
      policySnapshotId: null,
      policyVersion: "test-policy-v1",
      evidenceRevisionHash: "a".repeat(64),
      readinessFingerprint: "b".repeat(64),
      checks: readyChecksWith(check),
      evaluatedAt: assessedAt,
      artifactsCurrent: true,
    });

    expect(readiness.status).toBe("READY");
    expect(readiness.reason_codes).not.toContain("COMPENSATION_UNDISCLOSED");
    expect(readiness.checks.find((item) => item.key === "COMPENSATION")?.rationale)
      .toBe("Salary undisclosed—confirm with recruiter.");
  });

  it("keeps a disclosed salary with unresolved gross/net basis mandatory", () => {
    const assessment = evaluateCompensationPolicy({
      salary_min: 300000,
      salary_max: 300000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "NET",
      component_type: "BASE_CASH",
    }, "COMMERCIAL", compensationPolicy);
    const check = buildCompensationReadinessCheck({
      floorConfigured: true,
      resolutionKind: "SUPPORTED",
      assessment,
      basisConfigured: true,
      fxRateFailure: null,
      fxRateObservationId: null,
      preferenceRevisionId: "stage3-revision-2",
      assessedAt,
    });

    expect(assessment.status).toBe("UNKNOWN");
    expect(check.status).toBe("NEEDS_VERIFICATION");
    expect(check.importance).toBe("MUST");
  });

  it("keeps a salary range crossing the floor dependent on the eventual offer", () => {
    const assessment = evaluateCompensationPolicy({
      salary_min: 240000,
      salary_max: 270000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    }, "COMMERCIAL", compensationPolicy);
    const check = buildCompensationReadinessCheck({
      floorConfigured: true,
      resolutionKind: "SUPPORTED",
      assessment,
      basisConfigured: true,
      fxRateFailure: null,
      fxRateObservationId: null,
      preferenceRevisionId: "stage3-revision-2",
      assessedAt,
    });

    expect(assessment.status).toBe("UNKNOWN");
    expect(assessment.evidence).toContain("eligibility depends on the eventual offer");
    expect(check.status).toBe("NEEDS_VERIFICATION");
    expect(check.importance).toBe("MUST");
  });

  it("keeps a genuinely below-floor salary distinguishable from an undisclosed one", () => {
    const assessment = evaluateCompensationPolicy({
      salary_min: 200000,
      salary_max: 240000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    }, "COMMERCIAL", compensationPolicy);
    const check = buildCompensationReadinessCheck({
      floorConfigured: true,
      resolutionKind: "SUPPORTED",
      assessment,
      basisConfigured: true,
      fxRateFailure: null,
      fxRateObservationId: null,
      preferenceRevisionId: "stage3-revision-2",
      assessedAt,
    });

    expect(check.status).toBe("BLOCKED");
    expect(check.importance).toBe("MUST");
    expect(check.reason_code).toBe("COMPENSATION_BELOW_USER_FLOOR");
  });
});
