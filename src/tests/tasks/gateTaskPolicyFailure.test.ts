import { describe, expect, it, vi } from "vitest";
import { enforcePipelineWorkerExitPolicy, type PipelineWorkerExitPolicyInput } from "../../tasks/pipelineWorkerExitPolicy.js";
import { isRateLimitedFailure } from "../../platform/llm/index.js";
import {
  runPipelineStageTaskWorker,
  type PipelineStageWorkerDependencies,
} from "../../tasks/stageTaskWorker.js";

const ctx = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceKey: "default",
  userKey: "local_user",
  role: "OWNER" as const,
};

const POLICY_ERROR = "Workability policy not found at /nowhere/policies/workability.yml. Restore config/policies/workability.yml.";

/** A fake database that claims one APPLY_HARD_GATES task on its given attempt and records every statement. */
function fakeDatabase(attemptCount: number, maxAttempts: number) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes("WITH claimable AS")) {
      return {
        rows: [{
          id: "task-gate", workspace_id: ctx.workspaceId, task_type: "APPLY_HARD_GATES", task_key: "gate:job-1",
          payload: { canonical_job_id: "job-1", job_version_id: "version-1" },
          status: "RUNNING", available_at: new Date().toISOString(),
          lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          lease_expires_at: new Date(Date.now() + 300000).toISOString(), heartbeat_at: new Date().toISOString(),
          claimed_by: "worker:test", attempt_count: attemptCount, max_attempts: maxAttempts,
          last_error: null, dead_letter_reason: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null,
        }],
      };
    }
    if (sql.includes("SELECT canonical.latest_job_version_id::text AS latest_job_version_id")) {
      return {
        rows: [{
          latest_job_version_id: "version-1",
          description_text: "Responsibilities include leading delivery, coordinating teams, documenting decisions, resolving risks, and maintaining reliable services. Requirements include relevant experience, strong communication skills, technical judgment, and the ability to manage cross-functional work in a regulated environment. The role supports partner teams and improves service quality.",
          has_source_content_evidence: true,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO pipeline_task_attempts")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM job_versions jv") && sql.includes("JOIN canonical_jobs c")) {
      return {
        rows: [{
          canonical_job_id: "job-1", processing_state: "RAW_STAGED", latest_job_version_id: "version-1",
          primary_lane: null, lane_evidence: null, gate_decision: null,
          recommendation_eligibility: null, recommendation_outcome: null,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE pipeline_task_attempts") || sql.includes("UPDATE pipeline_tasks")) {
      return { rows: [{ id: "task-gate" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { calls, client: { query } as never };
}

function dependencies(runHardGates: PipelineStageWorkerDependencies["runHardGates"]): PipelineStageWorkerDependencies {
  return { runHardGates } as unknown as PipelineStageWorkerDependencies;
}

async function runGateTask(attemptCount: number, maxAttempts: number) {
  const { calls, client } = fakeDatabase(attemptCount, maxAttempts);
  const runHardGates = vi.fn(async () => {
    throw new Error(POLICY_ERROR);
  });
  const summary = await runPipelineStageTaskWorker(
    client,
    {
      context: ctx, seed: false, reconcileStalePending: false, taskTypes: ["APPLY_HARD_GATES"],
      maxTasks: 1, claimBatchSize: 1, leaseSeconds: 300, heartbeatSeconds: 0, claimedBy: "worker:test",
    },
    dependencies(runHardGates as never),
  );
  return { calls, summary, runHardGates };
}

describe("a gate task whose workability policy cannot be loaded", () => {
  it("is not treated as a rate limit, so it takes the normal retry path", () => {
    expect(isRateLimitedFailure(new Error(POLICY_ERROR))).toBe(false);
  });

  it("fails the task into RETRY_WAIT: no pass, no rejection, no gate decision, no job state change", async () => {
    const { calls, summary, runHardGates } = await runGateTask(1, 8);

    expect(runHardGates).toHaveBeenCalledTimes(1);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(summary.errors[0]?.error).toContain("Workability policy not found");

    const taskUpdate = calls.find((call) => /UPDATE\s+pipeline_tasks/i.test(call.sql) && call.params?.includes("RETRY_WAIT"));
    expect(taskUpdate).toBeDefined();
    expect(calls.some((call) => /gate_decisions/i.test(call.sql))).toBe(false);
    expect(calls.some((call) => /UPDATE\s+canonical_jobs/i.test(call.sql))).toBe(false);
    expect(JSON.stringify(calls.map((call) => call.params))).not.toContain("HARD_REJECTED");
  });

  it("after the retry budget: the task is dead-lettered and the job is marked PROCESSING_ERROR with an ENGINE_ERROR reason, never HARD_REJECTED", async () => {
    const { calls, summary } = await runGateTask(8, 8);

    expect(summary.deadLettered).toBe(1);
    const update = calls.find((call) => /UPDATE\s+canonical_jobs/i.test(call.sql));
    expect(update?.sql).toContain("PROCESSING_ERROR");
    expect(update?.sql).not.toContain("HARD_REJECTED");
    expect(String(update?.params?.[2])).toMatch(/^ENGINE_ERROR:/);
    expect(JSON.stringify(calls.map((call) => call.params))).not.toContain("HARD_REJECTED");
  });

  it("makes process_pipeline_tasks exit non-zero: a failed task and a dead letter each make the exit policy throw", () => {
    const base: PipelineWorkerExitPolicyInput = {
      claimedThisRun: 1, completedThisRun: 0, failedThisRun: 0, exitReason: "MAX_TASKS_REACHED", deadLetteredThisRun: 0,
      actionableCurrentDeadLetterCount: 0, staleHistoricalDeadLetterCount: 0, retryWaitCount: 0,
      oldestRetryWaitAgeSeconds: 0, activePendingCountBefore: 1, activePendingCount: 1, activeDuePendingCount: 1,
      oldestActivePendingAgeSecondsBefore: 0, oldestActivePendingAgeSeconds: 0, oldestActivePendingTaskType: null,
      oldestPendingTaskSameRuns: 0, pendingAgeTrendRuns: 3, failOnRetryWait: true, maxRetryWaitCount: 100,
      maxRetryWaitAgeSeconds: 86400, maxPendingAgeSeconds: 86400, noProgressPendingThreshold: 1,
    };
    expect(() => enforcePipelineWorkerExitPolicy({ ...base, failedThisRun: 1, retryWaitCount: 1 })).toThrow(/RETRY_WAIT/);
    expect(() => enforcePipelineWorkerExitPolicy({ ...base, failedThisRun: 1, deadLetteredThisRun: 1 })).toThrow(/DEAD_LETTER/);
  });
});
