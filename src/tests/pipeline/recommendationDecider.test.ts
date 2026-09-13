import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRecommendationDecider } from "../../pipeline/recommendationDecider.js";
import pg from "pg";

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

describe("Recommendation Decider: Exact-only and Semantic Matching (R01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not downgrade PRIORITY to REVIEW when exact match is 100% satisfied even if semantic embeddings are pending (R01)", async () => {
    const canonicalJobId = "11111111-1111-4111-8111-111111111111";
    const jobVersionId = "22222222-2222-4222-8222-222222222222";
    const profileVersionId = "33333333-3333-4333-8333-333333333333";
    const reqSetId = "44444444-4444-4444-8444-444444444444";
    const matchRunId = "55555555-5555-4555-8555-555555555555";
    const contentHash = "hash1234";

    let insertedDecision: any = null;

    (mPool.query as any).mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM workspaces w")) {
        return {
          rows: [
            {
              workspace_id: "00000000-0000-0000-0000-000000000001",
              user_id: "00000000-0000-0000-0000-000000000002",
              role: "OWNER",
            },
          ],
        };
      }
      if (sql.includes("FROM workspace_policy_snapshots")) {
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO workspace_policy_snapshots")) {
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
            },
          ],
        };
      }
      if (sql.includes("FROM canonical_jobs c")) {
        return {
          rows: [
            {
              canonical_job_id: canonicalJobId,
              job_version_id: jobVersionId,
              job_content_hash: contentHash,
              gate_decision: "PASS",
              processing_state: "LANE_ROUTED",
              routing_disposition: "MATCHED",
              workplace_type: "REMOTE",
              workability_facts: { employment_type: "PERMANENT" },
              active_profile_version_id: profileVersionId,
              active_requirement_set_id: reqSetId,
              match_status: "COMPLETED",
              match_canonical_job_id: canonicalJobId,
              match_profile_version_id: profileVersionId,
              match_requirement_set_id: reqSetId,
              match_job_content_hash: contentHash,
              match_context_fingerprint: "ctx_fp_123",
              latest_match_run_id: matchRunId,
              deterministic_match_score: "100.00",
              deterministic_match_coverage: "100.00",
              profile_match_status: "POSITIVE_MATCH",
              match_matched_count: 5,
              match_embedding_space_id: null, // Semantic embedding pending / exact-only mode
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO deterministic_decisions")) {
        insertedDecision = params;
        return { rows: [{ id: "dec_123", inserted: true }] };
      }
      if (sql.includes("UPDATE canonical_jobs")) {
        return { rows: [{ id: canonicalJobId }] };
      }
      return { rows: [] };
    });

    const summary = await runRecommendationDecider(mPool as any);
    expect(summary.errors).toBe(0);
    expect(summary.decisionsInserted).toBe(1);

    expect(insertedDecision).not.toBeNull();
    const decisionJson = JSON.parse(insertedDecision[7]); // decision_json param ($8)
    expect(decisionJson.outputs.outcome).toBe("PRIORITY");
    expect(decisionJson.trace.notes).not.toContain("priority_downgraded_semantic_pending");
  });

  it("downgrades PRIORITY to REVIEW when exact match is only partial and semantic embeddings are pending", async () => {
    const canonicalJobId = "11111111-1111-4111-8111-111111111112";
    const jobVersionId = "22222222-2222-4222-8222-222222222223";
    const profileVersionId = "33333333-3333-4333-8333-333333333334";
    const reqSetId = "44444444-4444-4444-8444-444444444445";
    const matchRunId = "55555555-5555-4555-8555-555555555556";
    const contentHash = "hash12345";

    let insertedDecision: any = null;

    (mPool.query as any).mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM workspaces w")) {
        return {
          rows: [
            {
              workspace_id: "00000000-0000-0000-0000-000000000001",
              user_id: "00000000-0000-0000-0000-000000000002",
              role: "OWNER",
            },
          ],
        };
      }
      if (sql.includes("FROM workspace_policy_snapshots") || sql.includes("INSERT INTO workspace_policy_snapshots")) {
        return {
          rows: [{ id: "00000000-0000-0000-0000-000000000003" }],
        };
      }
      if (sql.includes("FROM canonical_jobs c")) {
        return {
          rows: [
            {
              canonical_job_id: canonicalJobId,
              job_version_id: jobVersionId,
              job_content_hash: contentHash,
              gate_decision: "PASS",
              processing_state: "LANE_ROUTED",
              routing_disposition: "MATCHED",
              workplace_type: "REMOTE",
              workability_facts: { employment_type: "PERMANENT" },
              active_profile_version_id: profileVersionId,
              active_requirement_set_id: reqSetId,
              match_status: "COMPLETED",
              match_canonical_job_id: canonicalJobId,
              match_profile_version_id: profileVersionId,
              match_requirement_set_id: reqSetId,
              match_job_content_hash: contentHash,
              match_context_fingerprint: "ctx_fp_124",
              latest_match_run_id: matchRunId,
              deterministic_match_score: "80.00",
              deterministic_match_coverage: "60.00",
              profile_match_status: "POSITIVE_MATCH",
              match_matched_count: 3,
              match_embedding_space_id: null, // Semantic embedding pending
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO deterministic_decisions")) {
        insertedDecision = params;
        return { rows: [{ id: "dec_124", inserted: true }] };
      }
      if (sql.includes("UPDATE canonical_jobs")) {
        return { rows: [{ id: canonicalJobId }] };
      }
      return { rows: [] };
    });

    const summary = await runRecommendationDecider(mPool as any);
    expect(summary.errors).toBe(0);
    expect(summary.decisionsInserted).toBe(1);

    expect(insertedDecision).not.toBeNull();
    const decisionJson = JSON.parse(insertedDecision[7]);
    expect(decisionJson.outputs.outcome).toBe("REVIEW");
    expect(decisionJson.trace.notes).toContain("priority_downgraded_semantic_pending");
  });
});
