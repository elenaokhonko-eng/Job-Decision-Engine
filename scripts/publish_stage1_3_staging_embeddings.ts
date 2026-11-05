/**
 * User-run staging-only publisher. Dry-run is the default; --apply publishes
 * only missing v6 profile-fact and current requirement inputs in Gemini primary space.
 */
import dotenv from 'dotenv';
import pg from 'pg';

import { isPooledPostgresConnectionString, pgPoolConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const EXPECTED_STAGING_BRANCH_ID = 'br-orange-boat-azehba7u';
const EXPECTED_DATABASE_NAME = 'neondb';
const EXPECTED_PROFILE_VERSION = 6;
const EXPECTED_FAILED_JOB_VERSION_COUNT = 499;
const EXPECTED_PROFILE_FACT_COUNT = 164;
const EXPECTED_REQUIREMENT_COUNT = 1865;
const PRIMARY_SPACE = {
  id: 'afe6bd4b-e288-4c6b-89e6-0b4caff7499c',
  provider: 'gemini',
  model: 'gemini-embedding-001',
  dimensions: 768,
} as const;

interface EmbeddingSpaceRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly is_fallback_space: boolean;
  readonly active: boolean;
  readonly normalization: string;
  readonly distance_metric: string;
}

interface ProfileRow {
  readonly id: string;
  readonly version_number: number;
  readonly status: string;
}

interface EmbeddingCounts {
  readonly profile_fact_count: number | string;
  readonly published_profile_fact_count: number | string;
  readonly requirement_count: number | string;
  readonly published_requirement_count: number | string;
}

function isApplyMode(): boolean {
  return process.argv.includes('--apply');
}

function assertDirectStagingUrl(databaseUrl: string): void {
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error('Staging embedding publication requires a direct, unpooled connection.');
  }
}

async function loadCurrentFailedJobVersions(
  client: pg.PoolClient,
  workspaceId: string,
  profileVersionId: string
): Promise<string[]> {
  const { rows } = await client.query<{ job_version_id: string }>(
    `WITH latest_match_runs AS (
       SELECT DISTINCT ON (run.job_version_id)
              run.job_version_id, run.canonical_job_id, run.status, run.error_message,
              run.job_content_hash, run.requirement_set_id, run.context_fingerprint
       FROM match_runs AS run
       WHERE run.workspace_id = $1 AND run.profile_version_id = $2
       ORDER BY run.job_version_id, run.started_at DESC, run.id DESC
     )
     SELECT current_version.id AS job_version_id
     FROM latest_match_runs AS latest
     JOIN canonical_jobs AS job
       ON job.workspace_id = $1
      AND job.id = latest.canonical_job_id
      AND job.latest_job_version_id = latest.job_version_id
     JOIN job_versions AS current_version
       ON current_version.workspace_id = job.workspace_id
      AND current_version.id = latest.job_version_id
      AND current_version.canonical_job_id = job.id
     WHERE latest.job_content_hash = current_version.content_hash
       AND latest.requirement_set_id = current_version.active_requirement_set_id
       AND latest.context_fingerprint IS NOT NULL
       AND latest.status = 'FAILED'
       AND latest.error_message = 'EMBEDDING_DEPENDENCY_INCOMPLETE'
       AND job.is_test_fixture = FALSE
       AND job.gate_decision = 'PASS'
       AND job.primary_lane IS NOT NULL
       AND BTRIM(job.primary_lane) <> ''
       AND job.primary_lane <> 'UNCLASSIFIED'
       AND job.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK')
       AND COALESCE(job.processing_state, job.processing_status) IN (
         'LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
       )
     ORDER BY job.updated_at DESC, job.id ASC`,
    [workspaceId, profileVersionId]
  );
  return rows.map((row) => row.job_version_id);
}

async function readEmbeddingCounts(
  client: pg.PoolClient,
  workspaceId: string,
  profileVersionId: string,
  jobVersionIds: readonly string[]
): Promise<EmbeddingCounts> {
  const { rows } = await client.query<EmbeddingCounts>(
    `WITH active_profile_facts AS (
       SELECT DISTINCT COALESCE(fact.fact_revision_id, fact.id) AS node_id
       FROM profile_facts AS fact
       WHERE fact.workspace_id = $1
         AND fact.profile_version_id = $2
         AND fact.fact_type <> 'CONTACT'
         AND fact.confidentiality IN ('PUBLIC', 'PRIVATE_REUSABLE')
     ),
     current_requirements AS (
       SELECT DISTINCT requirement.id AS node_id
       FROM job_requirements AS requirement
       JOIN job_versions AS version
         ON version.workspace_id = requirement.workspace_id
        AND version.id = requirement.job_version_id
       WHERE requirement.workspace_id = $1
         AND requirement.job_version_id = ANY($3::uuid[])
         AND requirement.status = 'VALIDATED'
         AND (version.active_requirement_set_id IS NULL
              OR requirement.requirement_set_id = version.active_requirement_set_id)
     )
     SELECT
       (SELECT COUNT(*)::INTEGER FROM active_profile_facts) AS profile_fact_count,
       (SELECT COUNT(DISTINCT node.node_id)::INTEGER
        FROM active_profile_facts AS fact
        JOIN v_matchable_nodes AS node
          ON node.workspace_id = $1
         AND node.embedding_space_id = $4
         AND node.node_type = 'PROFILE_FACT'
         AND node.node_id = fact.node_id) AS published_profile_fact_count,
       (SELECT COUNT(*)::INTEGER FROM current_requirements) AS requirement_count,
       (SELECT COUNT(DISTINCT node.node_id)::INTEGER
        FROM current_requirements AS requirement
        JOIN v_matchable_nodes AS node
          ON node.workspace_id = $1
         AND node.embedding_space_id = $4
         AND node.node_type = 'JOB_REQUIREMENT'
         AND node.node_id = requirement.node_id) AS published_requirement_count`,
    [workspaceId, profileVersionId, jobVersionIds, PRIMARY_SPACE.id]
  );
  const counts = rows[0];
  if (!counts) throw new Error('Could not read semantic embedding publication counts.');
  return counts;
}

async function main(): Promise<void> {
  const apply = isApplyMode();
  const databaseUrl = process.env.STAGE3_STAGING_DATABASE_URL;
  if (!databaseUrl) throw new Error('STAGE3_STAGING_DATABASE_URL is required.');
  assertDirectStagingUrl(databaseUrl);

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    const identity = await client.query<{ database_name: string; branch_id: string | null }>(
      `SELECT current_database() AS database_name,
              current_setting('neon.branch_id', TRUE) AS branch_id`
    );
    const databaseIdentity = identity.rows[0];
    if (
      databaseIdentity?.database_name !== EXPECTED_DATABASE_NAME ||
      databaseIdentity.branch_id !== EXPECTED_STAGING_BRANCH_ID
    ) {
      throw new Error('Refusing to publish embeddings: connected database is not the approved staging branch.');
    }

    const context = await resolveWorkspaceContext(client);
    const profileResult = await client.query<ProfileRow>(
      `SELECT id, version_number, status
       FROM profile_versions
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [context.workspaceId]
    );
    const activeProfile = profileResult.rows[0];
    if (!activeProfile || activeProfile.version_number !== EXPECTED_PROFILE_VERSION) {
      throw new Error('Refusing to publish embeddings unless profile v6 is ACTIVE on staging.');
    }

    const activePreferences = await client.query<{ preference_domain: string }>(
      `SELECT preference_domain
       FROM workspace_user_preference_active_versions
       WHERE workspace_id = $1 AND user_id = $2
         AND preference_domain IN ('lane_intent', 'stage3')`,
      [context.workspaceId, context.userId]
    );
    const activeDomains = new Set(activePreferences.rows.map((row) => row.preference_domain));
    if (!activeDomains.has('lane_intent') || !activeDomains.has('stage3')) {
      throw new Error('Refusing to publish embeddings until Stage 2 and Stage 3 preferences are active on staging.');
    }

    const primarySpaceResult = await client.query<EmbeddingSpaceRow>(
      `SELECT id, provider, model, dimensions, is_fallback_space, active, normalization, distance_metric
       FROM embedding_spaces
       WHERE workspace_id = $1 AND id = $2`,
      [context.workspaceId, PRIMARY_SPACE.id]
    );
    const primarySpace = primarySpaceResult.rows[0];
    if (
      !primarySpace ||
      primarySpace.provider.toLowerCase() !== PRIMARY_SPACE.provider ||
      primarySpace.model !== PRIMARY_SPACE.model ||
      Number(primarySpace.dimensions) !== PRIMARY_SPACE.dimensions ||
      primarySpace.normalization !== 'L2' ||
      primarySpace.distance_metric !== 'COSINE' ||
      primarySpace.is_fallback_space ||
      !primarySpace.active
    ) {
      throw new Error('The approved Gemini primary embedding space is missing, inactive, or misconfigured.');
    }

    const fallbackSpaceResult = await client.query<EmbeddingSpaceRow>(
      `SELECT id, provider, model, dimensions, is_fallback_space, active, normalization, distance_metric
       FROM embedding_spaces
       WHERE workspace_id = $1 AND is_fallback_space = TRUE AND active = TRUE
       ORDER BY created_at DESC
       LIMIT 1`,
      [context.workspaceId]
    );
    const fallbackSpace = fallbackSpaceResult.rows[0];
    if (
      !fallbackSpace ||
      !fallbackSpace.active ||
      !fallbackSpace.is_fallback_space ||
      fallbackSpace.normalization !== 'L2' ||
      fallbackSpace.distance_metric !== 'COSINE'
    ) {
      throw new Error('The existing fallback-space metadata is unavailable or not canonical.');
    }

    const jobVersionIds = await loadCurrentFailedJobVersions(client, context.workspaceId, activeProfile.id);
    if (jobVersionIds.length !== EXPECTED_FAILED_JOB_VERSION_COUNT) {
      throw new Error(`Expected ${EXPECTED_FAILED_JOB_VERSION_COUNT} current failed job versions; found ${jobVersionIds.length}. No provider calls were made.`);
    }

    const before = await readEmbeddingCounts(client, context.workspaceId, activeProfile.id, jobVersionIds);
    const profileFactCount = Number(before.profile_fact_count);
    const publishedProfileFactCount = Number(before.published_profile_fact_count);
    const requirementCount = Number(before.requirement_count);
    const publishedRequirementCount = Number(before.published_requirement_count);
    if (profileFactCount !== EXPECTED_PROFILE_FACT_COUNT || requirementCount !== EXPECTED_REQUIREMENT_COUNT) {
      throw new Error(`Staging cohort drifted: profile facts=${profileFactCount}, requirements=${requirementCount}. No provider calls were made.`);
    }

    const profileFactsToPublish = profileFactCount - publishedProfileFactCount;
    const requirementsToPublish = requirementCount - publishedRequirementCount;
    console.log(`Profile facts to publish: ${profileFactsToPublish}`);
    console.log(`Job requirements to publish: ${requirementsToPublish}`);
    console.log(`Target embedding space: ${PRIMARY_SPACE.provider}/${PRIMARY_SPACE.model}/${PRIMARY_SPACE.dimensions} (${PRIMARY_SPACE.id})`);
    console.log(JSON.stringify({
      mode: apply ? 'STAGING_EMBEDDING_APPLY' : 'DRY_RUN',
      branchId: EXPECTED_STAGING_BRANCH_ID,
      profileFactsToPublish,
      jobRequirementsToPublish: requirementsToPublish,
      targetEmbeddingSpace: PRIMARY_SPACE,
      targetJobVersionCount: jobVersionIds.length,
      includeProfileFacts: true,
      includeJobVersions: false,
      includeLanePrototypes: false,
      fallbackVectorsAllowed: false,
      profileFactsCurrentlyPublished: `${publishedProfileFactCount}/${profileFactCount}`,
      jobRequirementsCurrentlyPublished: `${publishedRequirementCount}/${requirementCount}`,
    }, null, 2));

    if (!apply) return;
    if (profileFactsToPublish === 0 && requirementsToPublish === 0) {
      console.log('All requested current-context embeddings are already published; no provider call is needed.');
      return;
    }
    if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_FLASH_API_KEY) {
      throw new Error('Gemini API credentials are not configured in the local environment.');
    }

    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_URL_UNPOOLED = databaseUrl;
    process.env.EMBEDDING_PRIMARY_PROVIDER = PRIMARY_SPACE.provider;
    process.env.EMBEDDING_PRIMARY_MODEL = PRIMARY_SPACE.model;
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = String(PRIMARY_SPACE.dimensions);
    process.env.EMBEDDING_FALLBACK_PROVIDER = fallbackSpace.provider;
    process.env.EMBEDDING_FALLBACK_MODEL = fallbackSpace.model;
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = String(fallbackSpace.dimensions);

    const { runEmbeddingBatchWithFallback } = await import('../src/embeddings/batchCoordinator.js');
    const publication = await runEmbeddingBatchWithFallback(2500, pool, {
      context,
      jobVersionIds,
      profileVersionId: activeProfile.id,
      includeProfileFacts: true,
      includeLanePrototypes: false,
      includeJobVersions: false,
      allowFallback: false,
      expectedPrimarySpaceId: PRIMARY_SPACE.id,
    });

    if (publication.primary.embeddingSpaceId !== PRIMARY_SPACE.id) {
      throw new Error('Canonical publisher returned a different primary embedding space.');
    }

    const verifyClient = await pool.connect();
    try {
      const after = await readEmbeddingCounts(verifyClient, context.workspaceId, activeProfile.id, jobVersionIds);
      const finalProfileFacts = Number(after.published_profile_fact_count);
      const finalRequirements = Number(after.published_requirement_count);
      console.log(`PROFILE_FACT ${finalProfileFacts}/${Number(after.profile_fact_count)}`);
      console.log(`JOB_REQUIREMENT ${finalRequirements}/${Number(after.requirement_count)}`);
      console.log(JSON.stringify({
        profileFacts: `${finalProfileFacts}/${Number(after.profile_fact_count)}`,
        jobRequirements: `${finalRequirements}/${Number(after.requirement_count)}`,
        embeddingSpace: PRIMARY_SPACE,
        primaryProcessed: publication.primary.processed,
        primarySucceeded: publication.primary.succeeded,
        primaryFailed: publication.primary.failed,
        fallbackVectorsUsed: publication.fallback !== undefined,
      }, null, 2));
      if (
        publication.fallback ||
        publication.primary.failed > 0 ||
        finalProfileFacts !== EXPECTED_PROFILE_FACT_COUNT ||
        finalRequirements !== EXPECTED_REQUIREMENT_COUNT
      ) {
        throw new Error('Primary-only embedding publication did not reach 100% in the approved Gemini space.');
      }
    } finally {
      verifyClient.release();
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Staging embedding publication failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
