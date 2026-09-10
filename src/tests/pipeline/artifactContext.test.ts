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
});

