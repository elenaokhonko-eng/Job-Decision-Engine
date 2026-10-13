import { describe, it, expect, vi, beforeEach } from "vitest";
import { runExplanationQueueEnqueuer } from "../../pipeline/explanationQueueEnqueuer.js";
import pg from "pg";
import type { WorkspaceContext } from "../../workspace/context.js";

vi.mock("pg", () => {
  const mPool: any = {
    query: vi.fn(),
    end: vi.fn(),
    release: vi.fn(),
  };
  mPool.connect = vi.fn().mockResolvedValue(mPool);
  return {
    default: {
      Pool: class {
        constructor() {
          return mPool;
        }
      },
    },
  };
});

const mPool = new pg.Pool();

describe("Pipeline Stage: Explanation Queue Enqueuer (P1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reserves one durable budget run and records queue overflow as a deferral", async () => {
    const context: WorkspaceContext = {
      workspaceId: "cd3f21ff-11b7-440f-b708-1a32b2a0c9f8",
      workspaceKey: "default",
      userId: "7d96e708-dde3-4fd2-8f72-1e22f6607c74",
      userKey: "local_user",
      role: "OWNER",
    };
    const budgetRunId = "11111111-1111-4111-8111-111111111111";

    (mPool.query as any).mockResolvedValue({ rows: [] });
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // BEGIN
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // budget run
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // lane usage
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // row locks
    (mPool.query as any).mockResolvedValueOnce({
      rows: [{
        enqueued: 1,
        updated: 1,
        deferred: 2,
        queue_contract_items: [{
          schema_version: "2.2.0",
          id: "c232e006-0277-40a5-8559-f1aca5c3b75b",
          workspace_id: context.workspaceId,
          canonical_job_id: "1b58ad5d-5806-4245-8ee9-8a9f8705d499",
          job_version_id: "aeb6feb4-aaed-4602-bb58-5efff54e5bcf",
          profile_version_id: context.userId,
          match_run_id: "1350fc3b-f10e-47b6-b0b6-74b5e9590d1c",
          deterministic_decision_id: "92698c84-854c-4ce2-bb12-9da2f4034ba7",
          job_content_hash: "budget-integration-content-1",
          context_fingerprint: "budget-integration-context-1",
          lane: "CORE_AI_DATA",
          priority_score: 80,
          status: "PENDING",
          budget_run_id: budgetRunId,
          available_at: "2026-09-20T13:12:06.171931Z",
          lease_id: null,
          lease_expires_at: null,
          attempt_count: 0,
          max_attempts: 3,
          last_error: null,
          enqueued_at: "2026-09-20T13:12:06.171931Z",
          updated_at: "2026-09-20T13:12:06.171931Z",
        }],
      }],
    });

    const summary = await runExplanationQueueEnqueuer(undefined, {
      context,
      budgetRunId,
      limit: 1,
    });
    expect(summary).toEqual({ enqueued: 1, updated: 1, deferred: 2 });

    const calls = (mPool.query as any).mock.calls as Array<[string, unknown[]?]>;
    const mainQuery = calls.find(([sql]) => sql.includes("INSERT INTO evaluation_queue"));
    expect(mainQuery?.[0]).toContain("evaluation_budget_deferrals");
    expect(mainQuery?.[0]).toContain("DEFERRED_BUDGET");
    expect(mainQuery?.[0]).toContain("LEFT JOIN lane_budgets lb");
    expect(mainQuery?.[0]).toContain("'TRACK'");
    expect(mainQuery?.[0]).toContain("AI_BUDGET_UNCONFIGURED_LANE");
    expect(mainQuery?.[0]).toContain("budget_configured");
    expect(mainQuery?.[0]).toContain("ON CONFLICT DO NOTHING");
    expect(mainQuery?.[1]?.[0]).toBe(context.workspaceId);
    expect(mainQuery?.[1]?.[1]).toBe(budgetRunId);
    expect(mainQuery?.[1]?.[3]).toBe(1);
    expect(calls.some(([sql]) => sql.includes("UPDATE ai_evaluation_budget_usage"))).toBe(true);
    expect(calls.some(([sql]) => sql === "COMMIT")).toBe(true);
  });
});
