import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { selectEligibleEvaluationQueueRows, supersedeStaleEvaluationQueueRows } from "../../pipeline/evaluationQueueLineage.js";

describe("supersedeStaleEvaluationQueueRows scope", () => {
  it("limits stale evaluation reconciliation to the selected job versions", async () => {
    const workspaceId = "10000000-0000-4000-8000-000000000001";
    const profileVersionId = "20000000-0000-4000-8000-000000000002";
    const jobVersionIds = ["30000000-0000-4000-8000-000000000003"];
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
    // The stub implements only the query method used by this PostgreSQL boundary.
    const client = { query } as unknown as pg.PoolClient;

    const superseded = await supersedeStaleEvaluationQueueRows(client, {
      workspaceId,
      profileVersionId,
      jobVersionIds,
    });

    expect(superseded).toBe(0);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("eq.job_version_id = ANY($3::uuid[])");
    expect(query.mock.calls[0]?.[1]).toEqual([workspaceId, profileVersionId, jobVersionIds]);
  });
});

describe("evaluation queue source content gate", () => {
  it("excludes jobs without a complete current description before selecting AI work", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const client = { query } as unknown as pg.PoolClient;

    await selectEligibleEvaluationQueueRows(client, {
      workspaceId: "10000000-0000-4000-8000-000000000001",
    });

    expect(query.mock.calls[0]?.[0]).toContain("c.description_quality_status = 'COMPLETE'");
    expect(query.mock.calls[0]?.[0]).toContain("source_content_observation.source_name <> 'GMAIL_ALERT'");
    expect(query.mock.calls[0]?.[0]).toContain("source_content_observation.raw_payload->>'source_content_status' = 'COMPLETE'");
  });
});
