import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface RecommendationDeciderSummary {
  updated: number;
}

function buildDecisionUpdateSql(): string {
  return `
    WITH computed AS (
      SELECT
        c.id AS canonical_job_id,
        CASE
          WHEN c.gate_decision = 'PASS' THEN 'ELIGIBLE'
          WHEN c.gate_decision = 'NEEDS_VERIFICATION' THEN 'VERIFY'
          WHEN c.gate_decision = 'HARD_REJECT' THEN 'INELIGIBLE'
          ELSE 'VERIFY'
        END AS eligibility,
        CASE WHEN c.deterministic_match_score IS NULL THEN NULL ELSE (c.deterministic_match_score / 100.0) END AS requirement_score,
        CASE WHEN c.deterministic_match_coverage IS NULL THEN NULL ELSE (c.deterministic_match_coverage / 100.0) END AS coverage_score,
        (
          (
            CASE WHEN COALESCE(c.workplace_type, 'UNKNOWN') IN ('REMOTE', 'HYBRID', 'ONSITE') THEN 1 ELSE 0 END
            + CASE
                WHEN COALESCE(c.workplace_type, 'UNKNOWN') = 'REMOTE'
                  OR (COALESCE(c.workability_facts, '{}'::jsonb)->>'office_days_max') IS NOT NULL
                THEN 1 ELSE 0
              END
            + CASE
                WHEN (COALESCE(c.workability_facts, '{}'::jsonb)->>'employment_type') IN ('PERMANENT', 'CONTRACT')
                THEN 1 ELSE 0
              END
            + CASE
                WHEN (COALESCE(c.workability_facts, '{}'::jsonb)->>'travel_pct_max') IS NOT NULL
                THEN 1 ELSE 0
              END
          ) / 4.0
        )::numeric(4,3) AS evidence_completeness
      FROM canonical_jobs c
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
    ),
    resolved AS (
      SELECT
        canonical_job_id,
        eligibility,
        requirement_score,
        coverage_score,
        evidence_completeness,
        CASE
          WHEN eligibility = 'INELIGIBLE' THEN 'SKIP'
          WHEN requirement_score IS NULL OR coverage_score IS NULL THEN
            CASE WHEN eligibility = 'VERIFY' THEN 'REVIEW' ELSE 'TRACK' END
          WHEN eligibility = 'ELIGIBLE'
            AND requirement_score >= 0.75
            AND coverage_score >= 0.55
            AND evidence_completeness >= 0.70
            THEN 'PRIORITY'
          WHEN requirement_score >= 0.50 THEN 'REVIEW'
          ELSE 'TRACK'
        END AS outcome
      FROM computed
    )
    UPDATE canonical_jobs c
    SET recommendation_eligibility = resolved.eligibility,
        recommendation_requirement_score = resolved.requirement_score,
        recommendation_coverage_score = resolved.coverage_score,
        recommendation_evidence_completeness = resolved.evidence_completeness,
        recommendation_outcome = resolved.outcome,
        recommendation_decided_at = NOW()
    FROM resolved
    WHERE c.workspace_id = $1
      AND c.id = resolved.canonical_job_id
      AND (
        c.recommendation_eligibility IS DISTINCT FROM resolved.eligibility
        OR c.recommendation_requirement_score IS DISTINCT FROM resolved.requirement_score
        OR c.recommendation_coverage_score IS DISTINCT FROM resolved.coverage_score
        OR c.recommendation_evidence_completeness IS DISTINCT FROM resolved.evidence_completeness
        OR c.recommendation_outcome IS DISTINCT FROM resolved.outcome
        OR c.recommendation_decided_at IS NULL
      )
    RETURNING c.id
  `;
}

export async function runRecommendationDecider(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<RecommendationDeciderSummary> {
  console.log("Starting Deterministic Recommendation Decider...");
  const pool = clientOrPool || defaultPool;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const res = await client.query(buildDecisionUpdateSql(), [ctx.workspaceId]);
    console.log(`Recommendation Decider complete. Updated: ${res.rowCount ?? 0}`);
    return { updated: res.rowCount ?? 0 };
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}

export const runDeterministicDecisions = runRecommendationDecider;
