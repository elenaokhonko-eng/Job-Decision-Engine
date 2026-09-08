import { describe, expect, it, vi } from "vitest";
import {
  PipelineWorkerCancelledError,
  runPipelineStageTaskWorker,
  type PipelineStageWorkerDependencies,
} from "../../tasks/stageTaskWorker.js";

describe("stageTaskWorker", () => {
  const ctx = {
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceKey: "default",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userKey: "local_user",
    role: "OWNER" as const,
  };

  function dependencies(overrides: Partial<PipelineStageWorkerDependencies> = {}): PipelineStageWorkerDependencies {
    return {
      runNormalization: vi.fn(async () => ({
        totalDiscovered: 0,
        totalProcessed: 0,
        totalErrors: 0,
        details: [],
      })),
      runRequirementsExtraction: vi.fn(async () => ({
        discovered: 0,
        processed: 0,
        deterministicInserted: 0,
        quotedInserted: 0,
        quotedFailed: 0,
        errors: 0,
        metrics: {
          quotedAttempted: 0,
          quotedSucceeded: 0,
          quotedValidationFailures: 0,
          quotedProviderFailures: 0,
          retryWaitTransitions: 0,
          quotedPassRate: 0,
          byProviderModel: {},
        },
        details: [],
      })),
      runHardGates: vi.fn(async () => ({
        passed: 0,
        hardRejected: 0,
        needsVerification: 0,
        errors: 0,
      })),
      runEmbeddingBatchWithFallback: vi.fn(async () => ({
        seededSpaces: {
          primarySpaceId: "primary-space",
          fallbackSpaceId: "fallback-space",
        },
        inputBuild: {
          inserted: 0,
          fromRequirements: 0,
          fromProfileFacts: 0,
          fromJobVersions: 0,
          fromLanePrototypes: 0,
        },
        primary: {
          batchId: null,
          embeddingSpaceId: "primary-space",
          processed: 0,
          processedInputIds: [],
          succeeded: 0,
          failed: 0,
          failedInputIds: [],
          runType: "PRIMARY",
          errors: [],
        },
      })),
      runLaneRouting: vi.fn(async () => ({ routed: 0, deferred: 0 })),
      runDeterministicMatcher: vi.fn(async () => ({ matchedJobs: 0, skippedJobs: 0, errors: 0 })),
      runRecommendationDecider: vi.fn(async () => ({
        updated: 0,
        decisionsInserted: 0,
        errors: 0,
        policySnapshotId: "policy",
        policySnapshotHash: "hash",
      })),
      runExplanationQueueEnqueuer: vi.fn(async () => ({ enqueued: 0, updated: 0 })),
      ...overrides,
    } as PipelineStageWorkerDependencies;
  }

  it("honors cancellation before seeding or claiming tasks", async () => {
    const controller = new AbortController();
    controller.abort(new PipelineWorkerCancelledError("test cancellation before claim"));
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const fakeClient = { query } as any;

    await expect(
      runPipelineStageTaskWorker(
        fakeClient,
        {
          context: ctx,
          seed: false,
          taskTypes: ["NORMALIZE_OBSERVATION"],
          maxTasks: 1,
          heartbeatSeconds: 0,
          abortSignal: controller.signal,
        },
        dependencies()
      )
    ).rejects.toThrow(/test cancellation before claim/);

    expect(query).not.toHaveBeenCalled();
  });

  it("stops before claiming more work when cancellation is requested after a task completes", async () => {
    const controller = new AbortController();
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    let claimCalls = 0;

    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        claimCalls += 1;
        return {
          rows: [
            {
              id: "task-1",
              workspace_id: ctx.workspaceId,
              task_type: "NORMALIZE_OBSERVATION",
              task_key: "NORMALIZE_OBSERVATION:obs-1:normalizer_v1",
              payload: { observation_id: "obs-1" },
              status: "RUNNING",
              available_at: new Date().toISOString(),
              lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              lease_expires_at: new Date(Date.now() + 300000).toISOString(),
              heartbeat_at: new Date().toISOString(),
              claimed_by: "worker:test",
              attempt_count: 1,
              max_attempts: 8,
              last_error: null,
              dead_letter_reason: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completed_at: null,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM raw_job_observations obs")) {
        return {
          rows: [
            {
              canonical_job_id: "job-1",
              job_version_id: "version-1",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [{ id: "task-1" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-next" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies({
      runNormalization: vi.fn(async () => {
        controller.abort(new PipelineWorkerCancelledError("test cancellation after task"));
        return {
          totalDiscovered: 1,
          totalProcessed: 1,
          totalErrors: 0,
          details: [{ observationId: "obs-1", versionId: "version-1", isNewJob: true }],
        };
      }),
    });

    await expect(
      runPipelineStageTaskWorker(
        fakeClient,
        {
          context: ctx,
          seed: false,
          taskTypes: ["NORMALIZE_OBSERVATION"],
          maxTasks: 2,
          claimBatchSize: 1,
          leaseSeconds: 300,
          heartbeatSeconds: 0,
          claimedBy: "worker:test",
          abortSignal: controller.signal,
        },
        deps
      )
    ).rejects.toThrow(/test cancellation after task/);

    expect(claimCalls).toBe(1);
    expect(
      calls.some(
        (call) =>
          call.sql.includes("UPDATE pipeline_tasks") &&
          (call.params?.[3] === "RETRY_WAIT" || call.params?.[3] === "DEAD_LETTER")
      )
    ).toBe(false);
  });

  it("runs a claimed normalization task, completes it, and enqueues the deterministic successor", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        return {
          rows: [
            {
              id: "task-1",
              workspace_id: ctx.workspaceId,
              task_type: "NORMALIZE_OBSERVATION",
              task_key: "NORMALIZE_OBSERVATION:obs-1:normalizer_v1",
              payload: { observation_id: "obs-1" },
              status: "RUNNING",
              available_at: new Date().toISOString(),
              lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              lease_expires_at: new Date(Date.now() + 300000).toISOString(),
              heartbeat_at: new Date().toISOString(),
              claimed_by: "worker:test",
              attempt_count: 1,
              max_attempts: 8,
              last_error: null,
              dead_letter_reason: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completed_at: null,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM raw_job_observations obs")) {
        return {
          rows: [
            {
              canonical_job_id: "job-1",
              job_version_id: "version-1",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [{ id: "task-1" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-next" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies({
      runNormalization: vi.fn(async () => ({
        totalDiscovered: 1,
        totalProcessed: 1,
        totalErrors: 0,
        details: [{ observationId: "obs-1", versionId: "version-1", isNewJob: true }],
      })),
    });

    const summary = await runPipelineStageTaskWorker(
      fakeClient,
      {
        context: ctx,
        seed: false,
        taskTypes: ["NORMALIZE_OBSERVATION"],
        maxTasks: 1,
        claimBatchSize: 1,
        leaseSeconds: 300,
        heartbeatSeconds: 0,
        claimedBy: "worker:test",
      },
      deps
    );

    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(deps.runNormalization).toHaveBeenCalledWith(fakeClient, {
      context: ctx,
      observationIds: ["obs-1"],
      limit: 1,
    });
    expect(
      calls.some(
        (call) =>
          call.sql.includes("INSERT INTO pipeline_tasks") &&
          call.params?.[1] === "EXTRACT_DETERMINISTIC_REQUIREMENTS" &&
          call.params?.[2] === "EXTRACT_DETERMINISTIC_REQUIREMENTS:version-1:deterministic_v1"
      )
    ).toBe(true);
  });

  it("dead-letters exhausted technical routing failures and marks the job for manual review", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        return {
          rows: [
            {
              id: "task-route",
              workspace_id: ctx.workspaceId,
              task_type: "ROUTE_LANE",
              task_key: "ROUTE_LANE:version-1:lane_router_v1",
              payload: { canonical_job_id: "job-1", job_version_id: "version-1" },
              status: "RUNNING",
              available_at: new Date().toISOString(),
              lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              lease_expires_at: new Date(Date.now() + 300000).toISOString(),
              heartbeat_at: new Date().toISOString(),
              claimed_by: "worker:test",
              attempt_count: 1,
              max_attempts: 1,
              last_error: null,
              dead_letter_reason: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completed_at: null,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM job_versions jv") && sql.includes("JOIN canonical_jobs c")) {
        return {
          rows: [
            {
              canonical_job_id: "job-1",
              processing_state: "ROUTING_DEFERRED",
              primary_lane: null,
              lane_evidence: "ROUTING_ERROR: embedding provider unavailable",
              recommendation_eligibility: null,
              recommendation_outcome: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [{ id: "task-route" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE canonical_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies({
      runLaneRouting: vi.fn(async () => ({ routed: 0, deferred: 1 })),
    });

    const summary = await runPipelineStageTaskWorker(
      fakeClient,
      {
        context: ctx,
        seed: false,
        taskTypes: ["ROUTE_LANE"],
        maxTasks: 1,
        claimBatchSize: 1,
        leaseSeconds: 300,
        heartbeatSeconds: 0,
        claimedBy: "worker:test",
      },
      deps
    );

    expect(summary.failed).toBe(1);
    expect(summary.deadLettered).toBe(1);
    expect(summary.errors[0].error).toMatch(/Lane routing deferred due to technical evidence/);
    expect(
      calls.some(
        (call) =>
          call.sql.includes("UPDATE pipeline_tasks") &&
          call.params?.[3] === "DEAD_LETTER"
      )
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.sql.includes("UPDATE canonical_jobs") &&
          call.sql.includes("NEEDS_MANUAL_REVIEW") &&
          call.params?.[1] === "job-1"
      )
    ).toBe(true);
  });
});
