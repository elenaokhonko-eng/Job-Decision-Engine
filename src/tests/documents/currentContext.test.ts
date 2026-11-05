import { describe, expect, it } from "vitest";
import { validateDocumentCurrentContext } from "../../documents/currentContext.js";

describe("documents/currentContext", () => {
  const currentContext = () => ({
    current_job_version_id: "job-version-current",
    selected_job_version_id: "job-version-current",
    active_profile_version_id: "profile-current",
    selected_profile_version_id: "profile-current",
    latest_match_run_id: "match-current",
    match_run_id: "match-current",
    match_run_job_version_id: "job-version-current",
    match_run_profile_version_id: "profile-current",
    match_run_status: "COMPLETED",
    match_run_requirement_set_id: "requirements-current",
    active_requirement_set_id: "requirements-current",
    match_run_job_content_hash: "job-hash-current",
    current_job_content_hash: "job-hash-current",
    match_run_context_fingerprint: "match-context",
    latest_deterministic_decision_id: "decision-current",
    deterministic_decision_id: "decision-current",
    decision_job_version_id: "job-version-current",
    decision_match_run_id: "match-current",
    decision_context_fingerprint: "decision-context",
    readiness_status: "READY",
    readiness_fingerprint: "readiness-current",
    readiness_expires_at: "2099-01-01T00:00:00.000Z",
    readiness_reason_codes: [],
    decision_recommendation_eligibility: "ELIGIBLE",
    decision_recommendation_outcome: "REVIEW",
    gate_status: "PASS",
    recommendation_eligibility: "ELIGIBLE",
    recommendation_outcome: "REVIEW",
  });

  it("rejects archived jobs before evaluating document readiness", () => {
    expect(validateDocumentCurrentContext({
      ...currentContext(),
      archived_at: "2026-10-01T00:00:00.000Z",
    })).toEqual({ ok: false, reason: "JOB_ARCHIVED" });
  });

  it("rejects a selected job version that is no longer current", () => {
    const context = { ...currentContext(), selected_job_version_id: "job-version-old" };

    expect(validateDocumentCurrentContext(context)).toEqual({ ok: false, reason: "JOB_VERSION_STALE" });
  });

  it("rejects a selected profile version that is no longer active", () => {
    const context = { ...currentContext(), selected_profile_version_id: "profile-old" };

    expect(validateDocumentCurrentContext(context)).toEqual({ ok: false, reason: "PROFILE_STALE" });
  });

  it("rejects a match run that is no longer the current run", () => {
    const context = { ...currentContext(), latest_match_run_id: "match-new" };

    expect(validateDocumentCurrentContext(context)).toEqual({ ok: false, reason: "MATCH_STALE" });
  });

  it.each([
    { active_requirement_set_id: null },
    { match_run_requirement_set_id: null },
    { current_job_content_hash: null },
    { match_run_job_content_hash: null },
  ])("rejects a match without complete requirement and content context", (overrides) => {
    expect(validateDocumentCurrentContext({ ...currentContext(), ...overrides })).toEqual({
      ok: false,
      reason: "MATCH_STALE",
    });
  });

  it("rejects a deterministic decision that no longer matches the current match run", () => {
    const context = { ...currentContext(), decision_match_run_id: "match-old" };

    expect(validateDocumentCurrentContext(context)).toEqual({ ok: false, reason: "DECISION_STALE" });
  });

  it.each([
    { gate_status: "HARD_REJECT", recommendation_eligibility: "ELIGIBLE" },
    { gate_status: "PASS", recommendation_eligibility: "VERIFY" },
    { gate_status: "PASS", decision_recommendation_eligibility: "VERIFY" },
  ])("rejects documents when current deterministic eligibility is not Apply Now", (overrides) => {
    expect(validateDocumentCurrentContext({ ...currentContext(), ...overrides })).toEqual({
      ok: false,
      reason: "DECISION_STALE",
    });
  });

  it("rejects a deterministic decision without its own context fingerprint", () => {
    const context = { ...currentContext(), decision_context_fingerprint: null };

    expect(validateDocumentCurrentContext(context)).toEqual({ ok: false, reason: "DECISION_STALE" });
  });

  it.each([
    { readiness_status: "NEEDS_VERIFICATION" },
    { readiness_status: "PROCESSING" },
    { readiness_status: "BLOCKED" },
    { readiness_fingerprint: null },
    { readiness_expires_at: "2000-01-01T00:00:00.000Z" },
  ])("rejects a document when its application-readiness assessment is not current READY", (overrides) => {
    expect(validateDocumentCurrentContext({ ...currentContext(), ...overrides })).toEqual({
      ok: false,
      reason: "READINESS_NOT_READY",
    });
  });

  it("accepts distinct current match and decision fingerprints when readiness is READY", () => {
    expect(validateDocumentCurrentContext(currentContext())).toEqual({ ok: true });
  });
});
