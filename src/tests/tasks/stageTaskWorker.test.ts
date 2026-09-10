import { describe, expect, it, vi } from "vitest";
import {
  PipelineWorkerCancelledError,
  buildPipelineTaskKey,
  parsePipelineTaskTypes,
  runPipelineStageTaskWorker,
  seedRecoverablePipelineTasks,
  type PipelineStageWorkerDependencies,
} from "../../tasks/stageTaskWorker.js";

describe("stageTaskWorker", () => {
  it("parses a validated task allowlist for deterministic recovery", () => {
    expect(parsePipelineTaskTypes("NORMALIZE_OBSERVATION, MATCH_PROFILE_EVIDENCE, NORMALIZE_OBSERVATION")).toEqual([
      "NORMALIZE_OBSERVATION",
      "MATCH_PROFILE_EVIDENCE",
    ]);
    expect(() => parsePipelineTaskTypes("NOT_A_STAGE")).toThrow("Unsupported PIPELINE_TASK_WORKER_TASK_TYPES");
    expect(() => parsePipelineTaskTypes("  , ")).toThrow("must contain at least one task type");
  });

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

  it("versions profile matching task keys by active profile version", () => {
    expect(
      buildPipelineTaskKey("MATCH_PROFILE_EVIDENCE", "version-1", "deterministic_matcher_v1", "profile-2")
    ).toBe("MATCH_PROFILE_EVIDENCE:version-1:deterministic_matcher_v1:profile:profile-2");
    expect(buildPipelineTaskKey("ROUTE_LANE", "version-1", "lane_router_v1")).toBe(
      "ROUTE_LANE:version-1:lane_router_v1"
    );
    expect(
      buildPipelineTaskKey("EXTRACT_DETERMINISTIC_REQUIREMENTS", "version-1", "deterministic_v1", undefined, "repair")
    ).toBe("EXTRACT_DETERMINISTIC_REQUIREMENTS:version-1:deterministic_v1:repair");
    expect(
      buildPipelineTaskKey("MATCH_PROFILE_EVIDENCE", "version-1", "deterministic_matcher_v1", "profile-2", "repair")
    ).toBe("MATCH_PROFILE_EVIDENCE:version-1:deterministic_matcher_v1:repair:profile:profile-2");
    expect(buildPipelineTaskKey("PUBLISH_EMBEDDING", "version-1", "embedding_publication_v1", undefined, "repair")).toBe(
      "PUBLISH_EMBEDDING:version-1:embedding_publication_v1:repair"
    );
    expect(buildPipelineTaskKey("ROUTE_LANE", "version-1", "lane_router_v1", undefined, "repair")).toBe(
      "ROUTE_LANE:version-1:lane_router_v1:repair"
    );
    expect(buildPipelineTaskKey("DECIDE_RECOMMENDATION", "version-1", "recommendation_decider_v1", undefined, "repair")).toBe(
      "DECIDE_RECOMMENDATION:version-1:recommendation_decider_v1:repair"
    );
  });

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

  it("releases a task when cancellation arrives immediately after claim", async () => {
    const controller = new AbortController();
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        controller.abort(new PipelineWorkerCancelledError("test cancellation immediately after claim"));
        return {
          rows: [{
            id: "task-immediate-cancel",
            workspace_id: ctx.workspaceId,
            task_type: "NORMALIZE_OBSERVATION",
            task_key: "NORMALIZE_OBSERVATION:obs-immediate:normalizer_v1",
            payload: { observation_id: "obs-immediate" },
            status: "RUNNING",
            available_at: new Date().toISOString(),
            lease_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
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
          }],
        };
      }
      if (sql.includes("INSERT INTO pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks") && sql.includes("SET status = 'RETRY_WAIT'")) {
        return { rows: [{ id: "task-immediate-cancel" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(
      runPipelineStageTaskWorker(
        { query } as any,
        {
          context: ctx,
          seed: false,
          taskTypes: ["NORMALIZE_OBSERVATION"],
          maxTasks: 1,
          claimBatchSize: 1,
          heartbeatSeconds: 0,
          claimedBy: "worker:test",
          abortSignal: controller.signal,
        },
        dependencies()
      )
    ).rejects.toThrow(/immediately after claim/);

    expect(calls.some((call) => call.sql.includes("SET status = 'RETRY_WAIT'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("metadata = COALESCE(metadata"))).toBe(true);
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

  it("completes deterministic extraction tasks when no deterministic patterns are found", async () => {
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
              id: "task-empty-requirements",
              workspace_id: ctx.workspaceId,
              task_type: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
              task_key: "EXTRACT_DETERMINISTIC_REQUIREMENTS:version-empty:deterministic_v1",
              payload: { canonical_job_id: "job-empty", job_version_id: "version-empty" },
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
      if (sql.includes("FROM job_versions jv") && sql.includes("JOIN job_requirements jr")) {
        return { rows: [{ exists: false }], rowCount: 1 };
      }
      if (sql.includes("FROM job_version_pipeline_state ps") && sql.includes("requirement_extraction_runs rer")) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [{ id: "task-empty-requirements" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-gate" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies({
      runRequirementsExtraction: vi.fn(async () => ({
        discovered: 1,
        processed: 1,
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
        details: [
          {
            canonicalJobId: "job-empty",
            jobVersionId: "version-empty",
            deterministicInserted: 0,
            quotedInserted: 0,
            warning: "No deterministic requirements identified.",
          },
        ],
      })),
    });

    const summary = await runPipelineStageTaskWorker(
      fakeClient,
      {
        context: ctx,
        seed: false,
        taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"],
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
    expect(summary.errors).toEqual([]);
    expect(deps.runRequirementsExtraction).toHaveBeenCalledWith(fakeClient, {
      context: ctx,
      jobVersionIds: ["version-empty"],
      limit: 1,
      quotedMode: "deterministic_only",
      failFastOnQuotedProviderFailure: false,
      ignoreRetryWindow: true,
    });
    expect(
      calls.some(
        (call) =>
          call.sql.includes("INSERT INTO pipeline_tasks") &&
          call.params?.[1] === "APPLY_HARD_GATES" &&
          call.params?.[2] === "APPLY_HARD_GATES:version-empty:hard_gate_v1"
      )
    ).toBe(true);
  });

  it("defers an old match task until deterministic requirements have been repaired", async () => {
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
              id: "task-stale-match",
              workspace_id: ctx.workspaceId,
              task_type: "MATCH_PROFILE_EVIDENCE",
              task_key: "MATCH_PROFILE_EVIDENCE:version-stale:deterministic_matcher_v1:profile:profile-1",
              payload: { canonical_job_id: "job-stale", job_version_id: "version-stale" },
              status: "RUNNING",
              available_at: new Date().toISOString(),
              lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              lease_expires_at: new Date(Date.now() + 300000).toISOString(),
              heartbeat_at: new Date().toISOString(),
              claimed_by: "worker:test",
              attempt_count: 2,
              max_attempts: 8,
              last_error: "previous matcher prerequisite failure",
              dead_letter_reason: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completed_at: null,
            },
          ],
        };
      }
      if (sql.includes("SELECT c.id AS canonical_job_id") && sql.includes("c.latest_job_version_id")) {
        return {
          rows: [{
            canonical_job_id: "job-stale",
            processing_state: "LANE_ROUTED",
            primary_lane: "CORE_AI_DATA",
            lane_evidence: null,
            gate_decision: "PASS",
            recommendation_eligibility: null,
            recommendation_outcome: null,
            latest_job_version_id: "version-stale",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM job_version_pipeline_state ps") && sql.includes("requirement_extraction_runs rer")) {
        return { rows: [{ exists: false }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-repair-requirements" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [{ id: "task-stale-match" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies();

    const summary = await runPipelineStageTaskWorker(
      fakeClient,
      {
        context: ctx,
        seed: false,
        taskTypes: ["MATCH_PROFILE_EVIDENCE"],
        maxTasks: 1,
        claimBatchSize: 1,
        leaseSeconds: 300,
        heartbeatSeconds: 0,
        claimedBy: "worker:test",
      },
      deps
    );

    expect(summary.completed).toBe(0);
    expect(summary.blocked).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(deps.runDeterministicMatcher).not.toHaveBeenCalled();
    expect(
      calls.some(
        (call) =>
          call.sql.includes("INSERT INTO pipeline_tasks") &&
          call.params?.[1] === "EXTRACT_DETERMINISTIC_REQUIREMENTS" &&
          (call.params?.[3] as Record<string, unknown>)?.repair_existing_state === true
      )
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.sql.includes("UPDATE pipeline_tasks") &&
          call.sql.includes("BLOCKED_DEPENDENCY") &&
          call.params?.[4] === "EXTRACT_DETERMINISTIC_REQUIREMENTS:version-stale"
      )
    ).toBe(true);
  });

  it("completes stale pre-lane decision tasks without creating a dependency block", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        return {
          rows: [{
            id: "task-stale-decision",
            workspace_id: ctx.workspaceId,
            task_type: "DECIDE_RECOMMENDATION",
            task_key: "DECIDE_RECOMMENDATION:version-prelane:recommendation_decider_v1",
            payload: { canonical_job_id: "job-prelane", job_version_id: "version-prelane" },
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
          }],
        };
      }
      if (sql.includes("FROM job_versions jv") && sql.includes("JOIN canonical_jobs c")) {
        return {
          rows: [{
            canonical_job_id: "job-prelane",
            processing_state: "PREQUALIFIED",
            primary_lane: null,
            lane_evidence: null,
            gate_decision: "PASS",
            recommendation_eligibility: null,
            recommendation_outcome: null,
            latest_job_version_id: "version-prelane",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO pipeline_task_attempts")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE pipeline_task_attempts")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE pipeline_tasks")) return { rows: [{ id: "task-stale-decision" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies();

    const summary = await runPipelineStageTaskWorker(fakeClient, {
      context: ctx,
      seed: false,
      taskTypes: ["DECIDE_RECOMMENDATION"],
      maxTasks: 1,
      claimBatchSize: 1,
      leaseSeconds: 300,
      heartbeatSeconds: 0,
      claimedBy: "worker:test",
    }, deps);

    expect(summary.completed).toBe(1);
    expect(summary.blocked).toBe(0);
    expect(deps.runRecommendationDecider).not.toHaveBeenCalled();
  });

  it("seeds deterministic repair before matching and requires a completed extraction audit", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (
        sql.includes("SELECT c.id AS canonical_job_id") &&
        sql.includes("AS repair_existing_state")
      ) {
        return {
          rows: [
            {
              canonical_job_id: "job-stale",
              job_version_id: "version-stale",
              repair_existing_state: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT c.id AS canonical_job_id") && sql.includes("active_profile.id AS profile_version_id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-repair" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;

    const summary = await seedRecoverablePipelineTasks(fakeClient, {
      context: ctx,
      maxSeedPerType: 1,
    });

    expect(summary.byType.EXTRACT_DETERMINISTIC_REQUIREMENTS).toEqual({ inserted: 1, existing: 0 });
    expect(summary.byType.MATCH_PROFILE_EVIDENCE ?? { inserted: 0, existing: 0 }).toEqual({
      inserted: 0,
      existing: 0,
    });
    const extractionSeed = calls.find(
      (call) => call.sql.includes("AS repair_existing_state")
    );
    expect(extractionSeed?.sql).toContain("requirement_extraction_runs rer");
    expect(extractionSeed?.sql).toContain("ps.stage_status = 'COMPLETED'");
    const matchSeed = calls.find(
      (call) => call.sql.includes("active_profile.id AS profile_version_id")
    );
    expect(matchSeed?.sql).toContain("target_jv.active_requirement_set_id");
    expect(matchSeed?.sql).toContain("rer.run_type = 'DETERMINISTIC'");

    const decisionSeed = calls.find(
      (call) => call.sql.includes("c.recommendation_outcome IS NULL")
    );
    expect(decisionSeed?.sql).not.toContain("'LANE_ROUTED', 'MATCHED'");
    expect(decisionSeed?.sql).toContain("current_match.canonical_job_id = c.id");
    expect(decisionSeed?.sql).toContain("current_match.context_fingerprint IS NOT NULL");
  });

  it("passes forced preference recalculation through hard-gate tasks", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        return {
          rows: [
            {
              id: "task-gate",
              workspace_id: ctx.workspaceId,
              task_type: "APPLY_HARD_GATES",
              task_key: "APPLY_HARD_GATES:version-1:preference:focused:1",
              payload: {
                canonical_job_id: "job-1",
                job_version_id: "version-1",
                force_policy_recalculation: true,
              },
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
      if (sql.includes("FROM job_versions jv") && sql.includes("JOIN canonical_jobs c")) {
        return {
          rows: [
            {
              canonical_job_id: "job-1",
              processing_state: "PREQUALIFIED",
              primary_lane: null,
              lane_evidence: null,
              gate_decision: null,
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
        return { rows: [{ id: "task-gate" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-next" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies();

    const summary = await runPipelineStageTaskWorker(
      fakeClient,
      {
        context: ctx,
        seed: false,
        taskTypes: ["APPLY_HARD_GATES"],
        maxTasks: 1,
        claimBatchSize: 1,
        leaseSeconds: 300,
        heartbeatSeconds: 0,
        claimedBy: "worker:test",
      },
      deps
    );

    expect(summary.completed).toBe(1);
    expect(deps.runHardGates).toHaveBeenCalledWith(fakeClient, {
      context: ctx,
      jobVersionIds: ["version-1"],
      limit: 1,
      reprocess: true,
    });
  });

  it("completes stale hard-gate tasks after the job has advanced", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        return {
          rows: [
            {
              id: "task-stale-gate",
              workspace_id: ctx.workspaceId,
              task_type: "APPLY_HARD_GATES",
              task_key: "APPLY_HARD_GATES:version-routed:hard_gate_v1",
              payload: { canonical_job_id: "job-routed", job_version_id: "version-routed" },
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
      if (sql.includes("FROM job_versions jv") && sql.includes("JOIN canonical_jobs c")) {
        return {
          rows: [
            {
              canonical_job_id: "job-routed",
              processing_state: "ROUTING_DEFERRED",
              primary_lane: "UNCLASSIFIED",
              lane_evidence: "ROUTING_ERROR: embedding provider unavailable",
              gate_decision: null,
              recommendation_eligibility: "VERIFY",
              recommendation_outcome: "TRACK",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [{ id: "task-stale-gate" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies();

    const summary = await runPipelineStageTaskWorker(
      fakeClient,
      {
        context: ctx,
        seed: false,
        taskTypes: ["APPLY_HARD_GATES"],
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
    expect(deps.runHardGates).not.toHaveBeenCalled();
  });

  it("runs embedding publication with a job-version scope", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS")) {
        return {
          rows: [
            {
              id: "task-embed",
              workspace_id: ctx.workspaceId,
              task_type: "PUBLISH_EMBEDDING",
              task_key: "PUBLISH_EMBEDDING:version-1:embedding_publication_v1",
              payload: { canonical_job_id: "job-1", job_version_id: "version-1" },
              status: "RUNNING",
              available_at: new Date().toISOString(),
              lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              lease_expires_at: new Date(Date.now() + 300000).toISOString(),
              heartbeat_at: new Date().toISOString(),
              claimed_by: "worker:test",
              attempt_count: 1,
              max_attempts: 3,
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
      if (sql.includes("SELECT EXISTS")) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      if (sql.includes("FROM job_versions jv") && sql.includes("JOIN canonical_jobs c")) {
        return {
          rows: [
            {
              canonical_job_id: "job-1",
              processing_state: "PREQUALIFIED",
              primary_lane: null,
              lane_evidence: null,
              gate_decision: null,
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
        return { rows: [{ id: "task-embed" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-next" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query } as any;
    const deps = dependencies();

    const summary = await runPipelineStageTaskWorker(
      fakeClient,
      {
        context: ctx,
        seed: false,
        taskTypes: ["PUBLISH_EMBEDDING"],
        maxTasks: 1,
        claimBatchSize: 1,
        leaseSeconds: 300,
        heartbeatSeconds: 0,
        claimedBy: "worker:test",
      },
      deps
    );

    expect(summary.completed).toBe(1);
    expect(deps.runEmbeddingBatchWithFallback).toHaveBeenCalledWith(500, fakeClient, {
      context: ctx,
      jobVersionIds: ["version-1"],
      includeProfileFacts: false,
      includeLanePrototypes: true,
    });
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
              gate_decision: null,
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
    expect(deps.runLaneRouting).toHaveBeenCalledWith(fakeClient, {
      context: ctx,
      jobVersionIds: ["version-1"],
      limit: 1,
    });
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
