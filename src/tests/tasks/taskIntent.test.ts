import { describe, expect, it } from "vitest";

import { buildPipelineTaskContextFingerprint } from "../../pipeline/artifactContext.js";
import { createTaskIntentV2, TaskIntentV2Schema } from "../../tasks/taskIntent.js";

describe("TaskIntentV2", () => {
  it("creates a stable force-recompute intent pinned to its target and trigger", () => {
    const payload = {
      canonical_job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      job_version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      force_policy_recalculation: true,
      preference_mode_key: "focused",
      preference_mode_updated_at: "2026-10-24T00:00:00.000Z",
    };
    const intent = createTaskIntentV2({
      workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      taskType: "APPLY_HARD_GATES",
      stageVersion: "hard_gate_v1",
      producer: "api.preference_mode_change",
      requestId: "stable-request-1",
      triggerRevisionId: "revision-1",
      payload,
    });

    expect(intent).toMatchObject({
      schemaVersion: "task_intent_v2",
      taskType: "APPLY_HARD_GATES",
      stageVersion: "hard_gate_v1",
      producer: "api.preference_mode_change",
      requestId: "stable-request-1",
      mode: "FORCE_RECOMPUTE",
      triggerRevisionId: "revision-1",
      target: {
        workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        canonicalJobId: payload.canonical_job_id,
        jobVersionId: payload.job_version_id,
        observationId: null,
      },
    });

    expect(TaskIntentV2Schema.safeParse(intent).success).toBe(true);
    expect(buildPipelineTaskContextFingerprint({
      workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      taskType: "APPLY_HARD_GATES",
      taskVersion: "hard_gate_v1",
      payload: { ...payload, task_intent: intent },
    })).toBe(intent.contextFingerprint);
    expect(createTaskIntentV2({
      workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      taskType: "APPLY_HARD_GATES",
      stageVersion: "hard_gate_v1",
      producer: "api.preference_mode_change",
      requestId: "stable-request-1",
      triggerRevisionId: "revision-1",
      payload,
    }).contextFingerprint).toBe(intent.contextFingerprint);
    expect(createTaskIntentV2({
      workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      taskType: "APPLY_HARD_GATES",
      stageVersion: "hard_gate_v1",
      producer: "api.preference_mode_change",
      requestId: "new-request-2",
      triggerRevisionId: "revision-2",
      payload,
    }).contextFingerprint).not.toBe(intent.contextFingerprint);
  });

  it("uses ensure-current mode for ordinary stage obligations", () => {
    const intent = createTaskIntentV2({
      workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      taskType: "PUBLISH_EMBEDDING",
      stageVersion: "embedding_publication_v1",
      producer: "stageTaskWorker:PUBLISH_EMBEDDING",
      requestId: "publish-request-1",
      payload: {
        canonical_job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        job_version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });

    expect(intent.mode).toBe("ENSURE_CURRENT");
    expect(intent.triggerRevisionId).toBeNull();
  });
});
