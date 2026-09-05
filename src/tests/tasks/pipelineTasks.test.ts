import { describe, expect, it, vi } from "vitest";
import { claimPipelineTasks, enqueuePipelineTask } from "../../tasks/pipelineTasks.js";

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
    expect(calls.some((c) => c.includes("INSERT INTO pipeline_task_attempts"))).toBe(true);
  });
});

