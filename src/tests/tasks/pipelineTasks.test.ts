import { describe, expect, it, vi } from "vitest";
import {
  blockPipelineTask,
  claimPipelineTasks,
  completePipelineTask,
  completePipelineTaskAndRun,
  enqueuePipelineTask,
  failPipelineTask,
  replayDeadLetterPipelineTask,
  releasePipelineTaskForRetry,
} from "../../tasks/pipelineTasks.js";

describe("pipelineTasks", () => {
  const ctx = {
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceKey: "default",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userKey: "local_user",
    role: "OWNER" as const,
  };

  it("enqueuePipelineTask inserts idempotently", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [{ id: "task-1" }] };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const res = await enqueuePipelineTask(
      { taskType: "LANE_ROUTE", taskKey: "lane_route:1", payload: { job_version_id: "x" } },
      fakePool,
      { context: ctx }
    );

    expect(res.taskId).toBe("task-1");
    expect(res.inserted).toBe(true);
  });

  it("enqueuePipelineTask returns existing id when already enqueued", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        return { rows: [] };
      }
      if (sql.includes("FROM pipeline_tasks") && sql.includes("WHERE workspace_id")) {
        return { rows: [{ id: "task-existing" }] };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const res = await enqueuePipelineTask(
      { taskType: "LANE_ROUTE", taskKey: "lane_route:1", payload: { job_version_id: "x" } },
      fakePool,
      { context: ctx }
    );

    expect(res.taskId).toBe("task-existing");
    expect(res.inserted).toBe(false);
  });

  it("reactivates a dependency-blocked task when its prerequisite is re-enqueued", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("INSERT INTO pipeline_tasks")) return { rows: [] };
      if (sql.includes("SELECT id, status")) {
        return { rows: [{ id: "task-blocked", status: "BLOCKED_DEPENDENCY" }] };
      }
      if (sql.includes("status = 'BLOCKED_DEPENDENCY'")) {
        return { rows: [{ id: "task-blocked" }] };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const result = await enqueuePipelineTask(
      {
        taskType: "MATCH_PROFILE_EVIDENCE",
        taskKey: "match:version-1:profile-a",
        payload: { job_version_id: "version-1" },
      },
      fakePool,
      { context: ctx }
    );

    expect(result).toEqual({ taskId: "task-blocked", inserted: false, reactivated: true });
    expect(calls.some((sql) => sql.includes("SET status = 'PENDING'") && sql.includes("blocked_on = NULL"))).toBe(true);
  });

  it("records dependency blocking without marking the task completed", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("UPDATE pipeline_task_attempts")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE pipeline_tasks") && sql.includes("BLOCKED_DEPENDENCY")) {
        return { rows: [{ id: "task-blocked" }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    await blockPipelineTask(
      {
        taskId: "task-blocked",
        taskKey: "match:version-1:profile-a",
        taskType: "MATCH_PROFILE_EVIDENCE",
        payload: { job_version_id: "version-1" },
        leaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        leaseExpiresAt: new Date().toISOString(),
        attemptNumber: 2,
        maxAttempts: 8,
      },
      {
        blockedOn: "EXTRACT_DETERMINISTIC_REQUIREMENTS:version-1",
        reason: "requirements are missing",
        repairAction: "extract requirements and resume matching",
      },
      fakePool,
      { context: ctx }
    );

    expect(calls).toContain("COMMIT");
    expect(calls.some((sql) => sql.includes("status = 'BLOCKED'") && sql.includes("pipeline_task_attempts"))).toBe(true);
    expect(calls.some((sql) => sql.includes("status = 'BLOCKED_DEPENDENCY'") && sql.includes("available_at = NOW()") && sql.includes("completed_at = NULL"))).toBe(true);
  });

  it("claimPipelineTasks claims tasks and records attempt starts", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("WITH claimable AS")) {
        return {
          rows: [
            {
              id: "task-claimed",
              workspace_id: ctx.workspaceId,
              task_type: "LANE_ROUTE",
              task_key: "lane_route:1",
              payload: { job_version_id: "x" },
              status: "RUNNING",
              available_at: new Date().toISOString(),
              lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              lease_expires_at: new Date(Date.now() + 120000).toISOString(),
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
      return { rows: [], rowCount: 1 };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const claimed = await claimPipelineTasks(
      { taskType: "LANE_ROUTE", limit: 1, leaseSeconds: 120, claimedBy: "worker:test" },
      fakePool,
      { context: ctx }
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0].taskId).toBe("task-claimed");
    expect(claimed[0].attemptNumber).toBe(1);
    expect(calls.some((c) => c.includes("status = 'RUNNING'"))).toBe(true);
    expect(calls.some((c) => c.includes("lease_expires_at <= NOW()"))).toBe(true);
    expect(calls.some((c) => c.includes("INSERT INTO pipeline_task_attempts"))).toBe(true);
  });

  it("completePipelineTask rolls back when the lease is lost", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    await expect(
      completePipelineTask(
        {
          taskId: "task-claimed",
          taskKey: "lane_route:1",
          taskType: "LANE_ROUTE",
          payload: {},
          leaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          leaseExpiresAt: new Date().toISOString(),
          attemptNumber: 1,
          maxAttempts: 8,
        },
        fakePool,
        { context: ctx }
      )
    ).rejects.toThrow(/Lost lease while completing pipeline task/);

    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("completePipelineTaskAndRun rolls back completion when successor enqueue fails", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [{ id: "task-claimed" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        throw new Error("successor enqueue failed");
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    await expect(
      completePipelineTaskAndRun(
        {
          taskId: "task-claimed",
          taskKey: "lane_route:1",
          taskType: "LANE_ROUTE",
          payload: {},
          leaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          leaseExpiresAt: new Date().toISOString(),
          attemptNumber: 1,
          maxAttempts: 8,
        },
        fakePool,
        {
          context: ctx,
          afterComplete: async (transactionClient) => {
            await (transactionClient as any).query("INSERT INTO pipeline_tasks", []);
          },
        }
      )
    ).rejects.toThrow(/successor enqueue failed/);

    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(calls.indexOf("INSERT INTO pipeline_tasks")).toBeGreaterThan(
      calls.findIndex((sql) => sql.includes("UPDATE pipeline_tasks"))
    );
  });

  it("failPipelineTask rolls back when the lease is lost", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_tasks")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    await expect(
      failPipelineTask(
        {
          taskId: "task-claimed",
          taskKey: "lane_route:1",
          taskType: "LANE_ROUTE",
          payload: {},
          leaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          leaseExpiresAt: new Date().toISOString(),
          attemptNumber: 1,
          maxAttempts: 8,
        },
        "boom",
        fakePool,
        { context: ctx }
      )
    ).rejects.toThrow(/Lost lease while failing pipeline task/);

    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("releases a cancelled task lease for immediate retry without dead-lettering", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("UPDATE pipeline_tasks") && sql.includes("status = 'RETRY_WAIT'")) {
        return { rows: [{ id: "task-cancelled" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE pipeline_task_attempts")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const released = await releasePipelineTaskForRetry(
      {
        taskId: "task-cancelled",
        taskKey: "lane_route:cancelled",
        taskType: "LANE_ROUTE",
        payload: {},
        leaseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        leaseExpiresAt: new Date().toISOString(),
        attemptNumber: 1,
        maxAttempts: 8,
      },
      "worker cancelled before completion",
      fakePool,
      { context: ctx }
    );

    expect(released).toBe(true);
    expect(calls.some((sql) => sql.includes("status = 'RETRY_WAIT'") && sql.includes("lease_id = NULL"))).toBe(true);
    expect(calls.some((sql) => sql.includes("jsonb_build_object('cancelled', true)"))).toBe(true);
    expect(calls).toContain("COMMIT");
  });

  it("replayDeadLetterPipelineTask moves a dead-letter task back to pending", async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("UPDATE pipeline_tasks") && sql.includes("status = 'DEAD_LETTER'")) {
        expect(params).toEqual([
          ctx.workspaceId,
          "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          null,
          true,
          5,
        ]);
        return { rows: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const res = await replayDeadLetterPipelineTask(
      {
        taskId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        resetAttempts: true,
        maxAttempts: 5,
      },
      fakePool,
      { context: ctx }
    );

    expect(res).toEqual({ taskId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", replayed: true });
    expect(query.mock.calls[0][0]).toContain("attempt_count = CASE WHEN $4::boolean THEN 0");
    expect(query.mock.calls[0][0]).toContain("last_error = NULL");
    expect(query.mock.calls[0][0]).toContain("dead_letter_reason = NULL");
  });

  it("replayDeadLetterPipelineTask requires a task id or key", async () => {
    const fakeClient = { query: vi.fn(), release: vi.fn() } as any;

    await expect(
      replayDeadLetterPipelineTask({}, fakeClient, { context: ctx })
    ).rejects.toThrow(/Provide taskId or taskKey/);
  });
});
