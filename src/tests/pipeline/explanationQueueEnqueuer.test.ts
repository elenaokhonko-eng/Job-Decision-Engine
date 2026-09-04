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

  it("enqueues without per-lane business quotas and never writes DEFERRED_BUDGET", async () => {
    const context: WorkspaceContext = {
      workspaceId: "workspace-id-1",
      workspaceKey: "default",
      userId: "user-id-1",
      userKey: "local_user",
      role: "OWNER",
    };

    (mPool.query as any).mockResolvedValueOnce({
      rows: [{ enqueued: 100, updated: 100 }],
    });

    const summary = await runExplanationQueueEnqueuer(undefined, { context });
    expect(summary.enqueued).toBe(100);
    expect(summary.updated).toBe(100);

    const queryText = String((mPool.query as any).mock.calls[0]?.[0] || "");
    expect(queryText).toContain("INSERT INTO evaluation_queue");
    expect(queryText).not.toContain("DEFERRED_BUDGET");
    expect(queryText).not.toContain("ai_evaluation_limit");
  });
});
