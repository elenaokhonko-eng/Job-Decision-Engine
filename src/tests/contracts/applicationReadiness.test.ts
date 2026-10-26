import { describe, expect, it } from "vitest";
import {
  REQUIRED_MATERIAL_READINESS_CHECK_KEYS,
  assessApplicationReadiness,
  buildApplicationReadinessFingerprint,
} from "../../eligibility/applicationReadiness.js";
import type { MaterialReadinessCheck } from "../../contracts/applicationReadiness.js";

const assessedAt = "2026-10-24T00:00:00.000Z";
const baseIdentity = {
  canonicalJobId: "11111111-1111-4111-8111-111111111111",
  jobVersionId: "22222222-2222-4222-8222-222222222222",
  profileVersionId: "33333333-3333-4333-8333-333333333333",
  requirementSetId: "44444444-4444-4444-8444-444444444444",
  matchRunId: "55555555-5555-4555-8555-555555555555",
  preferenceContextId: "66666666-6666-4666-8666-666666666666",
  policySnapshotId: "77777777-7777-4777-8777-777777777777",
  policyVersion: "decision_policy_v3",
  evidenceRevisionHash: "a".repeat(64),
  readinessFingerprint: "b".repeat(64),
  evaluatedAt: assessedAt,
};

function checks(): MaterialReadinessCheck[] {
  return REQUIRED_MATERIAL_READINESS_CHECK_KEYS.map((key) => ({
    key,
    status: "MET",
    importance: "MUST",
    reason_code: null,
    rationale: "Current authoritative evidence satisfies this material check.",
    evidence_keys: [`evidence:${key}`],
    policy_reference: "policy:test-v1",
    assessed_at: assessedAt,
    expires_at: null,
  }));
}

function assess(inputChecks: MaterialReadinessCheck[], artifactsCurrent = true) {
  return assessApplicationReadiness({ ...baseIdentity, checks: inputChecks, artifactsCurrent });
}

describe("application readiness contract", () => {
  it("requires every material check before declaring READY", () => {
    const result = assess(checks());
    expect(result.status).toBe("READY");
    expect(assess(checks().slice(1)).status).toBe("NEEDS_VERIFICATION");
  });

  it("keeps a mandatory blocker monotonic over positive checks", () => {
    const allChecks = checks();
    allChecks[0] = {
      ...allChecks[0],
      status: "BLOCKED",
      reason_code: "COMPENSATION_BELOW_USER_FLOOR",
      rationale: "Maximum guaranteed base compensation is below the active floor.",
    };
    const result = assess(allChecks);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason_codes).toContain("COMPENSATION_BELOW_USER_FLOOR");
  });

  it("distinguishes processing dependencies from material verification", () => {
    const pending = checks();
    pending[2] = {
      ...pending[2],
      status: "PROCESSING",
      reason_code: "AVAILABILITY_RECHECK_PENDING",
      rationale: "A current availability check has not completed.",
    };
    expect(assess(pending).status).toBe("PROCESSING");
    expect(assess(checks().slice(1), false).status).toBe("PROCESSING");
  });

  it("fingerprints material context but excludes input ordering for FX observations", () => {
    const input = {
      workspace_id: "workspace-1",
      canonical_job_id: baseIdentity.canonicalJobId,
      job_version_id: baseIdentity.jobVersionId,
      job_content_hash: "content-v1",
      evidence_revision_hash: baseIdentity.evidenceRevisionHash,
      profile_version_id: baseIdentity.profileVersionId,
      profile_evidence_hash: "profile-evidence-v1",
      requirement_set_id: baseIdentity.requirementSetId,
      requirements_hash: "requirements-v1",
      match_run_id: baseIdentity.matchRunId,
      match_context_fingerprint: "match-context-v1",
      embedding_space_id: "embedding-space-v1",
      preference_context_id: baseIdentity.preferenceContextId,
      workability_policy_hash: "workability-v1",
      decision_policy_hash: "decision-v3",
      fx_rate_observation_ids: ["fx-b", "fx-a"],
      comparator_version: "experience_scope_v2",
      evidence_schema_version: "job_source_evidence_v1",
      availability_evidence_hash: "availability-v1",
    };
    const first = buildApplicationReadinessFingerprint(input);
    const reordered = buildApplicationReadinessFingerprint({ ...input, fx_rate_observation_ids: ["fx-a", "fx-b"] });
    const changed = buildApplicationReadinessFingerprint({ ...input, availability_evidence_hash: "availability-v2" });
    const reverified = buildApplicationReadinessFingerprint({
      ...input,
      availability_verification_revision: "verified-again-at-t2",
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
    expect(first).not.toBe(reverified);
  });
});
