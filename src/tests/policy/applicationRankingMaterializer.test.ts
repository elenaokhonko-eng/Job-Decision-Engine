import { describe, expect, it, vi } from "vitest";

import { materializeApplicationRankings } from "../../services/applicationRankingMaterializer.js";
import { Stage3WorkPreferencesSchema } from "../../policy/stage3Contracts.js";

const POLICY_WEIGHTS = {
  requirementFit: 37.5,
  requirementCoverage: 15,
  evidenceCompleteness: 10,
  laneConfidence: 10,
  autonomy: 10,
  politicsRisk: 7.5,
  sensoryWorkloadRisk: 5,
  strategicValue: 5,
};

function currentApplyNowRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "workspace-1",
    canonical_job_id: "job-1",
    job_version_id: "job-version-1",
    profile_version_id: "profile-1",
    match_run_id: "match-1",
    deterministic_decision_id: "decision-1",
    deterministic_context_fingerprint: "context-1",
    application_readiness_status: "READY",
    application_readiness_fingerprint: "readiness-fingerprint-1",
    decision_readiness_fingerprint: "readiness-fingerprint-1",
    decision_evidence_revision_hash: "evidence-hash-1",
    current_evidence_revision_hash: "evidence-hash-1",
    culture_source_name: "GREENHOUSE",
    culture_source_url: "https://jobs.example.test/role",
    culture_source_observed_at: "2026-10-18T00:00:00.000Z",
    match_job_content_hash: "job-hash-1",
    current_job_content_hash: "job-hash-1",
    current_job_description: "Work independently with minimal supervision.",
    company_name: "Example Co",
    location: "Singapore",
    workplace_type: "REMOTE",
    posted_at: "2026-10-18T00:00:00.000Z",
    reposted_at: null,
    source_updated_at: null,
    freshness_basis: "POSTED_AT",
    first_seen_at: "2026-10-18T00:00:00.000Z",
    last_seen_at: "2026-10-18T00:00:00.000Z",
    current_artifact_status: "CURRENT_OR_NOT_APPLICABLE",
    version_mismatch: false,
    gate_status: "PASS",
    primary_lane: "CORE_AI_DATA",
    lane_confidence: "High",
    recommendation_outcome: "REVIEW",
    recommendation_requirement_score: 0.8,
    recommendation_coverage_score: 0.9,
    recommendation_evidence_completeness: 0.95,
    deterministic_match_score: 80,
    deterministic_match_coverage: 90,
    evaluation_id: "evaluation-1",
    evaluation_context_fingerprint: "context-1",
    evaluation_job_content_hash: "job-hash-1",
    evaluation_payload: {
      nd_friendly_score: 5,
      politics_stress_score: 99,
      sensory_overload_index: 99,
      strategic_value_score: 99,
      focus_protection_score: 75,
      building_research_ratio: 80,
      interaction_load: 25,
      culture_evidence: [{
        signal: "AUTONOMY",
        score: 1,
        quote: "Work independently with minimal supervision.",
      }],
    },
    ranking_policy_version: 1,
    ranking_weights: POLICY_WEIGHTS,
    minimum_ranking_confidence: 90,
    policy_recheck_required: false,
    ...overrides,
  };
}

function createPool(rows: unknown[], insertRowCounts: number[] = [1]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("FROM v_apply_now_jobs_scoped")) return { rows };
      if (sql.includes("INSERT INTO job_ranking_snapshots")) {
        return { rows: [], rowCount: insertRowCounts.shift() ?? 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) } as never, client, calls };
}

describe("application ranking materializer", () => {
  it("persists an immutable current-context snapshot and reports missing current evaluations", async () => {
    const { pool, calls } = createPool([
      currentApplyNowRow(),
      currentApplyNowRow({
        canonical_job_id: "job-2",
        evaluation_id: null,
        evaluation_payload: null,
        evaluation_context_fingerprint: null,
        evaluation_job_content_hash: null,
      }),
    ]);

    const result = await materializeApplicationRankings(pool, "workspace-1");
    const insert = calls.find((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"));

    expect(result).toEqual({
      dryRun: false,
      eligibleApplyNowJobs: 2,
      snapshotsWouldInsert: 0,
      snapshotsInserted: 1,
      snapshotsAlreadyCurrent: 0,
      missingCurrentEvaluations: 1,
      incompleteRequiredInputs: 0,
    });
    expect(insert?.params?.slice(0, 9)).toEqual([
      "workspace-1",
      "job-1",
      "job-version-1",
      "profile-1",
      "match-1",
      "decision-1",
      "evaluation-1",
      1,
      "context-1",
    ]);
    expect(insert?.params?.[13]).toBe(80);
    expect(insert?.params?.[14]).toBeNull();
    expect(insert?.params?.[15]).toBeNull();
    expect(insert?.params?.[16]).toBeNull();
    expect(insert?.params?.[22]).toBe(false);
    expect(JSON.parse(String(insert?.params?.[25]))).toMatchObject({
      culture_score_derivation_version: "quote_phrase_rules_v1",
      culture_evidence: [{
        signal: "AUTONOMY",
        score: 80,
        quote: "Work independently with minimal supervision.",
        score_derivation_version: "quote_phrase_rules_v1",
      }],
    });
  });

  it("does not materialize rankings when readiness is blocked or its evidence fingerprint is stale", async () => {
    const { pool, calls } = createPool([
      currentApplyNowRow({ application_readiness_status: "NEEDS_VERIFICATION" }),
    ]);

    const result = await materializeApplicationRankings(pool, "workspace-1");

    expect(result.incompleteRequiredInputs).toBe(1);
    expect(result.snapshotsInserted).toBe(0);
    expect(calls.some((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"))).toBe(false);
  });

  it("applies versioned culture priorities and persists attributed culture evidence", async () => {
    const { pool, calls } = createPool([
      currentApplyNowRow({
        current_job_description: "Work independently with minimal supervision. No-meeting days protect deep work.",
        evaluation_payload: {
          culture_evidence: [
            { signal: "AUTONOMY", quote: "Work independently with minimal supervision." },
            { signal: "FOCUS_PROTECTION", quote: "No-meeting days protect deep work." },
          ],
        },
      }),
    ]);
    const preferences = Stage3WorkPreferencesSchema.parse({
      culture_priorities: [
        { priority_order: 1, name: "autonomy", configured_weight: 60 },
        { priority_order: 2, name: "low meeting load", configured_weight: 40 },
      ],
    });
    const preferenceContext = {
      workspaceId: "workspace-1",
      userId: "user-1",
      contextId: "preference-context-1",
      contextHash: "preference-hash-1",
      revisionsByDomain: { stage3: "revision-1" },
      laneIntent: null,
      stage3: preferences,
    };

    await materializeApplicationRankings(pool, "workspace-1", { preferenceContext });

    const insert = calls.find((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"));
    const provenance = JSON.parse(String(insert?.params?.[25]));
    expect(insert?.params?.[38]).toBe(80);
    expect(provenance.culture_priority_policy_version).toBe("culture_priority_mapping_v1");
    expect(provenance.effective_ranking_weights).toMatchObject({
      autonomy: 0,
      politicsRisk: 0,
      sensoryWorkloadRisk: 0,
      culturePriorityFit: 22.5,
    });
    expect(provenance.culture_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signal: "AUTONOMY",
        source_name: "GREENHOUSE",
        observed_at: "2026-10-18T00:00:00.000Z",
        scope: "JOB_DESCRIPTION",
      }),
    ]));
  });

  it("does not count one description quote toward multiple culture priorities", async () => {
    const { pool, calls } = createPool([
      currentApplyNowRow({
        evaluation_payload: {
          culture_evidence: [
            { signal: "AUTONOMY", quote: "Work independently with minimal supervision." },
            { signal: "FOCUS_PROTECTION", quote: "Work independently with minimal supervision." },
          ],
        },
      }),
    ]);
    const preferences = Stage3WorkPreferencesSchema.parse({
      culture_priorities: [
        { priority_order: 1, name: "autonomy", configured_weight: 60 },
        { priority_order: 2, name: "focus protection", configured_weight: 40 },
      ],
    });
    const preferenceContext = {
      workspaceId: "workspace-1",
      userId: "user-1",
      contextId: "preference-context-2",
      contextHash: "preference-hash-2",
      revisionsByDomain: { stage3: "revision-1" },
      laneIntent: null,
      stage3: preferences,
    };

    const result = await materializeApplicationRankings(pool, "workspace-1", { preferenceContext });

    const insert = calls.find((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"));
    const provenance = JSON.parse(String(insert?.params?.[25]));
    expect(result.snapshotsInserted).toBe(1);
    expect(insert?.params?.[38]).toBeNull();
    expect(provenance.culture_evidence.filter((item: { score: number | null }) => item.score !== null)).toHaveLength(1);
  });

  it("neutralizes unsupported optional culture quotes without failing ranking materialization", async () => {
    const { pool, calls } = createPool([
      currentApplyNowRow({
        evaluation_payload: {
          culture_evidence: [{
            signal: "AUTONOMY",
            score: 100,
            quote: "This quote is not in the current job description.",
          }],
        },
      }),
    ]);

    const result = await materializeApplicationRankings(pool, "workspace-1");
    const insert = calls.find((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"));
    const availability = JSON.parse(String(insert?.params?.[24]));
    const provenance = JSON.parse(String(insert?.params?.[25]));

    expect(result.snapshotsInserted).toBe(1);
    expect(availability.autonomy).toBe(false);
    expect(provenance.culture_evidence).toEqual([{
      signal: "AUTONOMY",
      score: null,
      quote: null,
      source_name: "GREENHOUSE",
      source_url: "https://jobs.example.test/role",
      observed_at: "2026-10-18T00:00:00.000Z",
      scope: "JOB_DESCRIPTION",
      confidence: "UNKNOWN",
      uncertainty_code: "SOURCE_QUOTE_NOT_VERIFIED",
      score_derivation_version: "quote_phrase_rules_v1",
    }]);
  });

  it("can materialize rankings only for an explicit bounded job-version set", async () => {
    const { pool, calls } = createPool([currentApplyNowRow()]);

    await materializeApplicationRankings(pool, "workspace-1", {
      preferenceContext: null,
      jobVersionIds: ["job-version-1"],
    });

    const select = calls.find((call) => call.sql.includes("FROM v_apply_now_jobs_scoped"));
    expect(select?.sql).toContain("shortlist.job_version_id::uuid = ANY($2::uuid[])");
    expect(select?.params).toEqual(["workspace-1", ["job-version-1"]]);
  });

  it("persists an incomplete rank but never marks it Top 10 when a required deterministic signal is missing", async () => {
    const { pool, calls } = createPool([
      currentApplyNowRow({ deterministic_match_score: null }),
    ]);

    const result = await materializeApplicationRankings(pool, "workspace-1");

    const insert = calls.find((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"));
    expect(result.incompleteRequiredInputs).toBe(1);
    expect(insert?.params?.[22]).toBe(false);
    expect(insert?.params?.[9]).toBeNull();
  });

  it("persists a ranking snapshot with Top 10 disabled when an optional signal is unknown", async () => {
    const { pool, calls } = createPool([
      currentApplyNowRow({
        evaluation_payload: {
          nd_friendly_score: 80,
          politics_stress_score: 20,
          sensory_overload_index: null,
          strategic_value_score: null,
          focus_protection_score: null,
        },
      }),
    ]);

    const result = await materializeApplicationRankings(pool, "workspace-1");
    const insert = calls.find((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"));

    expect(result.snapshotsInserted).toBe(1);
    expect(insert?.params?.[22]).toBe(false);
    expect(insert?.params?.[15]).toBeNull();
    expect(insert?.params?.[23]).toBe(false);
  });

  it("supports a no-write dry run with an explicit transaction rollback", async () => {
    const { pool, calls } = createPool([currentApplyNowRow()]);

    const result = await materializeApplicationRankings(pool, "workspace-1", { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.snapshotsWouldInsert).toBe(1);
    expect(calls.some((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"))).toBe(false);
    expect(calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  it("ranks an otherwise-equivalent one-day posting above a 45-day posting", async () => {
    const dayMilliseconds = 24 * 60 * 60 * 1000;
    const asOf = Date.now();
    const { pool, calls } = createPool([
      currentApplyNowRow({
        canonical_job_id: "fresh-job",
        posted_at: new Date(asOf - dayMilliseconds).toISOString(),
      }),
      currentApplyNowRow({
        canonical_job_id: "older-job",
        posted_at: new Date(asOf - 45 * dayMilliseconds).toISOString(),
      }),
    ], [1, 1]);

    const result = await materializeApplicationRankings(pool, "workspace-1");
    const inserts = calls.filter((call) => call.sql.includes("INSERT INTO job_ranking_snapshots"));
    const freshParams = inserts[0]?.params;
    const olderParams = inserts[1]?.params;

    expect(result.snapshotsInserted).toBe(2);
    expect(freshParams?.[27]).toBe(100);
    expect(olderParams?.[27]).toBe(40);
    expect(Number(freshParams?.[20])).toBeGreaterThan(Number(olderParams?.[20]));
    expect(Number(freshParams?.[20]) - Number(olderParams?.[20])).toBeCloseTo(7.5, 1);
    expect(freshParams?.[28]).toBe(50);
    expect(freshParams?.[29]).toBe(freshParams?.[20]);
  });

  it("uses ON CONFLICT DO NOTHING and counts an already-current immutable artifact", async () => {
    const { pool } = createPool([currentApplyNowRow()], [0]);

    const result = await materializeApplicationRankings(pool, "workspace-1");

    expect(result.snapshotsAlreadyCurrent).toBe(1);
    expect(result.snapshotsInserted).toBe(0);
  });
});
