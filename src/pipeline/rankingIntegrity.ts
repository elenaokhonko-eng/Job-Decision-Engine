/**
 * Must-be-zero checks on the stored ranking score (read only; the reconciler fails when either count is above zero).
 *
 *  1. A listed job (outcome REVIEW or PRIORITY: the score decides entry) with a decision but no adjusted score:
 *     every list orders by recommendation_requirement_score, so such a job has no place in the order.
 *  2. Listed jobs whose score comes from more than one score policy: the scores are on different scales, so an order
 *     across them is meaningless. The minority policy's jobs are counted (all of them when the split is even).
 */
import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

export interface RankingIntegrityReport {
  readonly listedWithoutAdjustedScore: number;
  readonly listedWithoutScorePolicy: number;
  readonly scorePolicies: Readonly<Record<string, number>>;
  /** Listed jobs outside the majority score policy. */
  readonly mixedScorePolicyJobs: number;
}

export function rankingIntegrityExitCode(report: RankingIntegrityReport): 0 | 1 {
  return report.listedWithoutAdjustedScore > 0 || report.mixedScorePolicyJobs > 0 || report.listedWithoutScorePolicy > 0 ? 1 : 0;
}

export function summarizeScorePolicies(policies: ReadonlyArray<{ policy: string | null; count: number }>): Pick<RankingIntegrityReport, "scorePolicies" | "mixedScorePolicyJobs" | "listedWithoutScorePolicy"> {
  const scorePolicies: Record<string, number> = {};
  let withoutPolicy = 0;
  for (const row of policies) {
    if (row.policy === null) withoutPolicy += row.count;
    else scorePolicies[row.policy] = (scorePolicies[row.policy] ?? 0) + row.count;
  }
  const counts = Object.values(scorePolicies);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const majority = counts.length > 1 && new Set(counts).size === counts.length ? Math.max(...counts) : 0;
  return { scorePolicies, listedWithoutScorePolicy: withoutPolicy, mixedScorePolicyJobs: counts.length > 1 ? total - majority : 0 };
}

export async function reportRankingIntegrity(client: Queryable, workspaceId: string): Promise<RankingIntegrityReport> {
  const missing = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM canonical_jobs job
      WHERE job.workspace_id = $1 AND job.archived_at IS NULL AND job.is_test_fixture IS NOT TRUE
        AND job.recommendation_outcome IN ('REVIEW', 'PRIORITY')
        AND job.latest_deterministic_decision_id IS NOT NULL
        AND job.recommendation_requirement_score IS NULL`,
    [workspaceId],
  );
  const policies = await client.query<{ policy: string | null; count: number }>(
    `SELECT job.recommendation_score_policy AS policy, COUNT(*)::int AS count
       FROM canonical_jobs job
      WHERE job.workspace_id = $1 AND job.archived_at IS NULL AND job.is_test_fixture IS NOT TRUE
        AND job.recommendation_outcome IN ('REVIEW', 'PRIORITY')
        AND job.recommendation_requirement_score IS NOT NULL
      GROUP BY 1`,
    [workspaceId],
  );
  return { listedWithoutAdjustedScore: missing.rows[0]?.n ?? 0, ...summarizeScorePolicies(policies.rows) };
}
