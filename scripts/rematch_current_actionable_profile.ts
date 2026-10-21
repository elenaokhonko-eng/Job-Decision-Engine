/**
 * Dry-runs by default. Writes require --apply, an explicit --limit=N, and
 * STAGE3_STAGING_DATABASE_URL; hard gates and lane routing are never replayed.
 */
import dotenv from 'dotenv';
import pg from 'pg';

import { isPooledPostgresConnectionString, pgPoolConfig } from '../src/db/pgSsl.js';
import { runDeterministicMatcher } from '../src/pipeline/deterministicMatcher.js';
import { runRecommendationDecider } from '../src/pipeline/recommendationDecider.js';
import { runExplanationQueueEnqueuer } from '../src/pipeline/explanationQueueEnqueuer.js';
import { materializeApplicationRankings } from '../src/services/applicationRankingMaterializer.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

function parseLimit(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--limit='))?.slice('--limit='.length);
  const limit = raw ? Number(raw) : 500;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 5000) {
    throw new Error('--limit must be an integer from 1 to 5000.');
  }
  return limit;
}

async function countEmbeddingReadyJobVersions(
  pool: pg.Pool,
  workspaceId: string,
  profileVersionId: string,
  jobVersionIds: string[]
): Promise<{ versionsWithRequirements: number; readyJobVersions: number }> {
  if (jobVersionIds.length === 0) return { versionsWithRequirements: 0, readyJobVersions: 0 };

  const result = await pool.query<{
    versions_with_requirements: number | string;
    ready_job_versions: number | string;
  }>(
    `WITH active_embedding_spaces AS (
       SELECT id
       FROM embedding_spaces
       WHERE workspace_id = $1 AND active = TRUE
     ),
     active_profile_facts AS (
       SELECT DISTINCT COALESCE(fact.fact_revision_id, fact.id) AS node_id
       FROM profile_facts AS fact
       WHERE fact.workspace_id = $1 AND fact.profile_version_id = $2
     ),
     target_requirements AS (
       SELECT requirement.job_version_id, requirement.id AS node_id
       FROM job_requirements AS requirement
       JOIN job_versions AS version
         ON version.workspace_id = requirement.workspace_id
        AND version.id = requirement.job_version_id
       WHERE requirement.workspace_id = $1
         AND requirement.job_version_id = ANY($3::uuid[])
         AND requirement.status = 'VALIDATED'
         AND (version.active_requirement_set_id IS NULL
              OR requirement.requirement_set_id = version.active_requirement_set_id)
     ),
     ready_job_versions AS (
       SELECT DISTINCT target.job_version_id
       FROM target_requirements AS target
       CROSS JOIN active_embedding_spaces AS space
       WHERE NOT EXISTS (
         SELECT 1
         FROM target_requirements AS required
         WHERE required.job_version_id = target.job_version_id
           AND NOT EXISTS (
             SELECT 1
             FROM v_matchable_nodes AS node
             WHERE node.workspace_id = $1
               AND node.embedding_space_id = space.id
               AND node.node_type = 'JOB_REQUIREMENT'
               AND node.node_id = required.node_id
           )
       )
         AND NOT EXISTS (
           SELECT 1
           FROM active_profile_facts AS fact
           WHERE NOT EXISTS (
             SELECT 1
             FROM v_matchable_nodes AS node
             WHERE node.workspace_id = $1
               AND node.embedding_space_id = space.id
               AND node.node_type = 'PROFILE_FACT'
               AND node.node_id = fact.node_id
           )
         )
     )
     SELECT
       (SELECT COUNT(DISTINCT job_version_id)::INTEGER FROM target_requirements) AS versions_with_requirements,
       (SELECT COUNT(*)::INTEGER FROM ready_job_versions) AS ready_job_versions`,
    [workspaceId, profileVersionId, jobVersionIds]
  );
  return {
    versionsWithRequirements: Number(result.rows[0]?.versions_with_requirements ?? 0),
    readyJobVersions: Number(result.rows[0]?.ready_job_versions ?? 0),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const explicitLimit = process.argv.some((argument) => argument.startsWith('--limit='));
  if (apply && !explicitLimit) throw new Error('--apply requires an explicit --limit=N bound.');

  const databaseUrl = apply
    ? process.env.STAGE3_STAGING_DATABASE_URL
    : process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(apply
      ? 'STAGE3_STAGING_DATABASE_URL is required for rematch writes.'
      : 'DATABASE_URL_UNPOOLED or DATABASE_URL is required for the dry-run.');
  }
  if (apply && isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error('Rematch writes require a direct staging connection, not a pooled URL.');
  }

  const limit = parseLimit();
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    const context = await resolveWorkspaceContext(pool);
    const client = await pool.connect();
    let jobVersionIds: string[];
    let activeProfileVersionId: string;
    try {
      const activeProfile = await client.query<{ id: string; version_number: number }>(
        `SELECT id, version_number
         FROM profile_versions
         WHERE workspace_id = $1 AND status = 'ACTIVE'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [context.workspaceId]
      );
      const profile = activeProfile.rows[0];
      if (!profile) throw new Error('No ACTIVE profile version exists; bounded rematch cannot proceed.');
      activeProfileVersionId = profile.id;

      const candidates = await client.query<{ job_version_id: string }>(
        `SELECT c.latest_job_version_id AS job_version_id
         FROM canonical_jobs AS c
         JOIN job_versions AS version
           ON version.workspace_id = c.workspace_id
          AND version.id = c.latest_job_version_id
         WHERE c.workspace_id = $1
           AND c.is_test_fixture = FALSE
           AND c.gate_decision = 'PASS'
           AND c.primary_lane IS NOT NULL
           AND c.primary_lane <> 'UNCLASSIFIED'
           AND c.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK')
           AND COALESCE(c.processing_state, c.processing_status) IN (
             'LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
           )
         ORDER BY c.updated_at DESC, c.id ASC
         LIMIT $2`,
        [context.workspaceId, limit]
      );
      jobVersionIds = candidates.rows.map((row) => row.job_version_id);
    } finally {
      client.release();
    }

    const embeddingReadiness = await countEmbeddingReadyJobVersions(
      pool,
      context.workspaceId,
      activeProfileVersionId,
      jobVersionIds
    );
    console.log(JSON.stringify({
      mode: apply ? 'STAGING_BOUNDED_CURRENT_ACTIONABLE_REMATCH' : 'DRY_RUN_BOUNDED_CURRENT_ACTIONABLE_REMATCH',
      workspaceId: context.workspaceId,
      activeProfileVersionId,
      jobCount: jobVersionIds.length,
      limit,
      embeddingReadyJobVersions: embeddingReadiness.readyJobVersions,
      versionsWithRequirements: embeddingReadiness.versionsWithRequirements,
      rerunsHardGates: false,
      rerunsLaneRouting: false,
      jobVersionIds,
    }, null, 2));

    if (!apply || jobVersionIds.length === 0) return;
    if (
      embeddingReadiness.versionsWithRequirements !== jobVersionIds.length ||
      embeddingReadiness.readyJobVersions !== jobVersionIds.length
    ) {
      throw new Error(
        `Semantic embedding prerequisites are incomplete (${embeddingReadiness.readyJobVersions}/${jobVersionIds.length} ready); no match, recommendation, or evaluation writes were started.`
      );
    }
    const matching = await runDeterministicMatcher(pool, {
      context,
      jobVersionIds,
      limit: jobVersionIds.length,
    });
    if (matching.errors > 0) throw new Error(`Bounded profile matching reported ${matching.errors} error(s).`);

    const dependencyFailures = await pool.query<{ failed_count: number | string }>(
      `WITH latest_match_runs AS (
         SELECT DISTINCT ON (job_version_id) job_version_id, status, error_message
         FROM match_runs
         WHERE workspace_id = $1
           AND profile_version_id = $2
           AND job_version_id = ANY($3::uuid[])
         ORDER BY job_version_id, started_at DESC, id DESC
       )
       SELECT COUNT(*)::INTEGER AS failed_count
       FROM latest_match_runs
       WHERE status = 'FAILED'
         AND error_message = 'EMBEDDING_DEPENDENCY_INCOMPLETE'`,
      [context.workspaceId, activeProfileVersionId, jobVersionIds]
    );
    const incompleteDependencyCount = Number(dependencyFailures.rows[0]?.failed_count ?? 0);
    if (incompleteDependencyCount > 0) {
      throw new Error(
        `${incompleteDependencyCount} bounded matches have incomplete embedding prerequisites; no recommendation refresh or evaluation enqueue was run.`
      );
    }

    const decisions = await runRecommendationDecider(pool, {
      context,
      jobVersionIds,
      limit: jobVersionIds.length,
    });
    if (decisions.errors > 0) throw new Error(`Bounded recommendation refresh reported ${decisions.errors} error(s).`);

    const evaluations = await runExplanationQueueEnqueuer(pool, {
      context,
      jobVersionIds,
      limit: jobVersionIds.length,
    });

    const rankings = await materializeApplicationRankings(pool, context.workspaceId, { context });
    console.log(JSON.stringify({ matching, decisions, evaluations, rankings }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Bounded current-actionable profile rematch failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
