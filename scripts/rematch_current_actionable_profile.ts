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
             'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
           )
         ORDER BY c.updated_at DESC, c.id ASC
         LIMIT $2`,
        [context.workspaceId, limit]
      );
      jobVersionIds = candidates.rows.map((row) => row.job_version_id);
    } finally {
      client.release();
    }

    console.log(JSON.stringify({
      mode: apply ? 'STAGING_BOUNDED_CURRENT_ACTIONABLE_REMATCH' : 'DRY_RUN_BOUNDED_CURRENT_ACTIONABLE_REMATCH',
      workspaceId: context.workspaceId,
      activeProfileVersionId,
      jobCount: jobVersionIds.length,
      limit,
      rerunsHardGates: false,
      rerunsLaneRouting: false,
      jobVersionIds,
    }, null, 2));

    if (!apply || jobVersionIds.length === 0) return;
    const matching = await runDeterministicMatcher(pool, {
      context,
      jobVersionIds,
      limit: jobVersionIds.length,
    });
    if (matching.errors > 0) throw new Error(`Bounded profile matching reported ${matching.errors} error(s).`);

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
