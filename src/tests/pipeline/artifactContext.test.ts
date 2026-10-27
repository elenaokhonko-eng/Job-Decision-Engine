import { describe, expect, it } from "vitest";
import { buildPipelineTaskContextFingerprint } from "../../pipeline/artifactContext.js";

describe("pipeline artifact context", () => {
  const base = {
    workspaceId: "workspace-1",
    taskType: "MATCH_PROFILE_EVIDENCE",
    taskVersion: "deterministic_matcher_v1",
    payload: {
      canonical_job_id: "job-1",
      job_version_id: "version-1",
      profile_version_id: "profile-a",
      ignored_runtime_note: "does not identify the artifact",
    },
  };

  it("is stable when payload key order changes", () => {
    const first = buildPipelineTaskContextFingerprint(base);
    const second = buildPipelineTaskContextFingerprint({
      ...base,
      payload: {
        profile_version_id: "profile-a",
        job_version_id: "version-1",
        canonical_job_id: "job-1",
        ignored_runtime_note: "another note",
      },
    });

    expect(first).toBe(second);
  });

  it("changes when a currentness dependency changes", () => {
    const first = buildPipelineTaskContextFingerprint(base);
    const second = buildPipelineTaskContextFingerprint({
      ...base,
      payload: { ...base.payload, profile_version_id: "profile-b" },
    });

    expect(first).not.toBe(second);
  });

  it.each([
    ["evidence_revision_hash", "evidence-a", "evidence-b"],
    ["readiness_fingerprint", "readiness-a", "readiness-b"],
    ["availability_evidence_hash", "availability-a", "availability-b"],
    ["fx_rate_observation_id", "fx-observation-a", "fx-observation-b"],
    ["qualification_comparator_version", "comparator-v1", "comparator-v2"],
  ])("changes a decision identity when %s changes", (key, original, updated) => {
    const decision = {
      ...base,
      taskType: "DECIDE_RECOMMENDATION",
      taskVersion: "recommendation_decider_v1",
      payload: { ...base.payload, [key]: original },
    };
    const changedDecision = {
      ...decision,
      payload: { ...decision.payload, [key]: updated },
    };

    expect(buildPipelineTaskContextFingerprint(decision)).not.toBe(
      buildPipelineTaskContextFingerprint(changedDecision),
    );
  });

  it("changes when an explicit reassessment reason changes", () => {
    const first = buildPipelineTaskContextFingerprint({
      ...base,
      payload: { ...base.payload, reassessment_reason: "REASSESSMENT_V1" },
    });
    const second = buildPipelineTaskContextFingerprint({
      ...base,
      payload: { ...base.payload, reassessment_reason: "REASSESSMENT_V2" },
    });
    expect(first).not.toBe(second);
  });

  it("changes when the verification answer revision changes", () => {
    const first = buildPipelineTaskContextFingerprint({
      ...base,
      payload: { ...base.payload, verification_answer_revision_id: "revision-1" },
    });
    const second = buildPipelineTaskContextFingerprint({
      ...base,
      payload: { ...base.payload, verification_answer_revision_id: "revision-2" },
    });
    expect(first).not.toBe(second);
  });

  it("changes when a fresh AI evaluation budget run is requested", () => {
    const first = buildPipelineTaskContextFingerprint({
      ...base,
      taskType: "ENQUEUE_EXPLANATION",
      taskVersion: "explanation_queue_v2",
      payload: { canonical_job_id: "job-1", job_version_id: "version-1", queue_budget_run_id: "budget-1" },
    });
    const second = buildPipelineTaskContextFingerprint({
      ...base,
      taskType: "ENQUEUE_EXPLANATION",
      taskVersion: "explanation_queue_v2",
      payload: { canonical_job_id: "job-1", job_version_id: "version-1", queue_budget_run_id: "budget-2" },
    });

    expect(first).not.toBe(second);
  });

  it.each([
    ["evidence_revision_hash", "evidence-v1", "evidence-v2"],
    ["readiness_fingerprint", "readiness-v1", "readiness-v2"],
    ["availability_evidence_hash", "availability-v1", "availability-v2"],
    ["fx_rate_observation_id", "fx-observation-1", "fx-observation-2"],
    ["qualification_comparator_version", "comparator-v1", "comparator-v2"],
  ] as const)("changes recommendation identity when %s changes", (field, initialValue, changedValue) => {
    const initialFingerprint = buildPipelineTaskContextFingerprint({
      ...base,
      taskType: "DECIDE_RECOMMENDATION",
      taskVersion: "recommendation_decider_v1",
      payload: { ...base.payload, [field]: initialValue },
    });
    const changedFingerprint = buildPipelineTaskContextFingerprint({
      ...base,
      taskType: "DECIDE_RECOMMENDATION",
      taskVersion: "recommendation_decider_v1",
      payload: { ...base.payload, [field]: changedValue },
    });

    expect(changedFingerprint).not.toBe(initialFingerprint);
  });

  it("changes when a semantic repair generation changes", () => {
    const first = buildPipelineTaskContextFingerprint({
      ...base,
      payload: {
        ...base.payload,
        repair_dependency: "REQUIREMENT_EMBEDDING_MISSING",
        repair_generation: "semantic_match_repair_v1",
        repair_match_run_id: "match-1",
      },
    });
    const second = buildPipelineTaskContextFingerprint({
      ...base,
      payload: {
        ...base.payload,
        repair_dependency: "REQUIREMENT_EMBEDDING_MISSING",
        repair_generation: "semantic_match_repair_v2",
        repair_match_run_id: "match-1",
      },
    });
    expect(first).not.toBe(second);
  });
});
