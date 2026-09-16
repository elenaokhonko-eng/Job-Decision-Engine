import { describe, expect, it, vi } from "vitest";
import {
  applyRepair,
  loadCandidates,
  type RepairCandidate,
} from "../../../scripts/repair_pipeline_funnel.js";
import type { WorkspaceContext } from "../../workspace/context.js";

const context: WorkspaceContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceKey: "default",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userKey: "local_user",
  role: "OWNER",
};

describe("repair pipeline funnel", () => {
  it("keeps a complete NO_PROFILE_MATCH out of embedding-pending repair", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          canonical_job_id: "job-ready",
          job_version_id: "version-authoritative",
          processing_state: "LANE_ROUTED",
          gate_decision: "PASS",
          primary_lane: "CORE_AI_DATA",
          rejection_reason: null,
          profile_match_status: "NO_PROFILE_MATCH",
          has_missing_embeddings: false,
          has_complete_prior_version: false,
          complete_version_id: null,
        },
        {
          canonical_job_id: "job-pending",
          job_version_id: "version-authoritative-2",
          processing_state: "LANE_ROUTED",
          gate_decision: "PASS",
          primary_lane: "CORE_AI_DATA",
          rejection_reason: null,
          profile_match_status: "NO_PROFILE_MATCH",
          has_missing_embeddings: true,
          has_complete_prior_version: false,
          complete_version_id: null,
        },
      ],
    }));
    const client = { query } as any;

    const candidates = await loadCandidates(client, context);

    expect(candidates.map((candidate) => candidate.canonical_job_id)).toEqual(["job-pending"]);
    expect(candidates[0].category).toBe("UNPROVABLE_MATCH_EMBEDDING_PENDING");
    const readinessSql = String((query.mock.calls as unknown[][])[0]?.[0] ?? "");
    expect(readinessSql).toContain("authoritative_versions");
    expect(readinessSql).toContain("active_job_requirements");
    expect(readinessSql).toContain("active_profile_inputs");
    expect(readinessSql).toContain("embedding_inputs");
    expect(readinessSql).toContain("v_published_semantic_embeddings");
    expect(readinessSql).toContain("embedding_spaces");
    expect(readinessSql).not.toContain("job_version_embeddings");
  });

  it("supports apply and repeat without duplicating durable repair tasks", async () => {
    const taskKeys = new Set<string>();
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("FROM profile_versions")) {
        return { rows: [{ id: "profile-version-1" }] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        const taskKey = String(params?.[2]);
        if (taskKeys.has(taskKey)) return { rows: [] };
        taskKeys.add(taskKey);
        return { rows: [{ id: `task-${taskKeys.size}` }] };
      }
      if (sql.includes("SELECT id, status") && sql.includes("FROM pipeline_tasks")) {
        return { rows: [{ id: "existing-task", status: "PENDING" }] };
      }
      if (sql.includes("UPDATE canonical_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query } as any;
    const candidate: RepairCandidate = {
      canonical_job_id: "job-pending",
      job_version_id: "version-authoritative-2",
      processing_state: "LANE_ROUTED",
      gate_decision: "PASS",
      primary_lane: "CORE_AI_DATA",
      rejection_reason: null,
      profile_match_status: "NO_PROFILE_MATCH",
      has_missing_embeddings: true,
      category: "UNPROVABLE_MATCH_EMBEDDING_PENDING",
    };

    const dryRunCandidates = [candidate];
    expect(dryRunCandidates).toHaveLength(1);
    expect(calls).toHaveLength(0);

    const firstApply = await applyRepair(client, context, [candidate]);
    const secondApply = await applyRepair(client, context, [candidate]);

    expect(firstApply).toEqual({ UNPROVABLE_MATCH_EMBEDDING_PENDING: 1 });
    expect(secondApply).toEqual({ UNPROVABLE_MATCH_EMBEDDING_PENDING: 1 });
    expect(taskKeys.size).toBe(2);
    expect(calls.filter((sql) => sql === "BEGIN")).toHaveLength(2);
    expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(2);
  });
});
