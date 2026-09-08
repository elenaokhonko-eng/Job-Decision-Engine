import pg from 'pg';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { pgPoolConfig } from '../db/pgSsl.js';
import { extractDeterministicRequirements } from '../requirements/deterministicExtractors.js';
import { validateQuotedRequirements } from '../requirements/quotedRequirementExtractor.js';
import { runQuotedRequirementProvider } from '../requirements/quotedProvider.js';
import { JobRequirementSchema, REQUIREMENTS_SCHEMA_VERSION } from '../requirements/contracts.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

interface RequirementStageJob {
  workspace_id: string;
  canonical_job_id: string;
  job_version_id: string;
  content_hash: string;
  description_text: string;
}

export interface QuotedExtractorInvocation {
  canonicalJobId: string;
  jobVersionId: string;
  descriptionText: string;
}

export interface QuotedExtractorResult {
  payload: unknown;
  provider: string;
  model: string;
  extractorVersion?: string;
  attempts?: number;
  fallbackUsed?: boolean;
  errors?: Array<{ provider: string; model: string; error: string }>;
}

export interface RequirementExtractionStageOptions {
  quotedExtractor?: (input: QuotedExtractorInvocation) => Promise<QuotedExtractorResult | null>;
  context?: WorkspaceContext;
  failFastOnQuotedProviderFailure?: boolean;
  quotedProviderFailureLimit?: number;
  jobVersionIds?: string[];
  limit?: number;
  quotedMode?: 'env' | 'deterministic_only' | 'with_quoted';
}

export interface RequirementExtractionSummary {
  discovered: number;
  processed: number;
  deterministicInserted: number;
  quotedInserted: number;
  quotedFailed: number;
  errors: number;
  metrics: {
    quotedAttempted: number;
    quotedSucceeded: number;
    quotedValidationFailures: number;
    quotedProviderFailures: number;
    retryWaitTransitions: number;
    quotedPassRate: number;
    byProviderModel: Record<
      string,
      {
        attempts: number;
        successes: number;
        validationFailures: number;
        providerFailures: number;
        retries: number;
      }
    >;
  };
  details: Array<{
    canonicalJobId: string;
    jobVersionId: string;
    deterministicInserted: number;
    quotedInserted: number;
    warning?: string;
    error?: string;
  }>;
}

const DETERMINISTIC_VERSION = 'deterministic_v1';
const QUOTED_VERSION = 'quoted_v1';
const NORMALIZER_HASH = crypto
  .createHash('sha256')
  .update('requirements_normalizer_v1')
  .digest('hex');
const QUOTED_PROMPT_HASH = crypto
  .createHash('sha256')
  .update(`quoted_prompt_v1|schema_version:${REQUIREMENTS_SCHEMA_VERSION}`)
  .digest('hex');

function shouldRunQuotedExtractor(): boolean {
  return process.env.REQUIREMENTS_ENABLE_QUOTED === 'true';
}

function providerModelKey(provider: string, model: string): string {
  return `${provider || 'unknown'}:${model || 'unknown'}`;
}

function ensureMetricBucket(
  summary: RequirementExtractionSummary,
  provider: string,
  model: string
): {
  attempts: number;
  successes: number;
  validationFailures: number;
  providerFailures: number;
  retries: number;
} {
  const key = providerModelKey(provider, model);
  if (!summary.metrics.byProviderModel[key]) {
    summary.metrics.byProviderModel[key] = {
      attempts: 0,
      successes: 0,
      validationFailures: 0,
      providerFailures: 0,
      retries: 0,
    };
  }
  return summary.metrics.byProviderModel[key];
}

function parseProviderFailuresFromError(errorMessage: string): Array<{ provider: string; model: string }> {
  const marker = 'All model providers failed:';
  const idx = errorMessage.indexOf(marker);
  if (idx < 0) {
    return [];
  }

  const jsonPart = errorMessage.slice(idx + marker.length).trim();
  try {
    const parsed = JSON.parse(jsonPart) as Array<{ provider?: string; model?: string }>;
    return parsed.map((item) => ({
      provider: item.provider || 'unknown',
      model: item.model || 'unknown',
    }));
  } catch {
    return [];
  }
}

async function upsertPipelineState(
  client: { query: pg.PoolClient['query'] },
  job: RequirementStageJob,
  stageStatus: 'IN_PROGRESS' | 'COMPLETED' | 'RETRY_WAIT',
  lastError: string | null = null
): Promise<void> {
  await client.query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id,
       canonical_job_id,
       job_version_id,
       current_stage,
       stage_status,
       attempt_count,
       last_error,
       next_retry_at,
       updated_at
     )
     VALUES (
       $1,
       $2,
       $3,
       'REQUIREMENTS_EXTRACTED',
       $4,
       CASE WHEN $4 = 'RETRY_WAIT' THEN 1 ELSE 0 END,
       $5,
       CASE WHEN $4 = 'RETRY_WAIT' THEN NOW() + INTERVAL '5 minutes' ELSE NULL END,
       NOW()
     )
     ON CONFLICT (job_version_id)
     DO UPDATE SET
       current_stage = EXCLUDED.current_stage,
       stage_status = EXCLUDED.stage_status,
       attempt_count = CASE
         WHEN EXCLUDED.stage_status = 'RETRY_WAIT' THEN job_version_pipeline_state.attempt_count + 1
         ELSE job_version_pipeline_state.attempt_count
       END,
       last_error = EXCLUDED.last_error,
       next_retry_at = EXCLUDED.next_retry_at,
       updated_at = NOW()`,
    [job.workspace_id, job.canonical_job_id, job.job_version_id, stageStatus, lastError]
  );
}

class RequirementsStageAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequirementsStageAbortError';
  }
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function truncateLogValue(value: string, maxLength = 500): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

async function insertStageEvent(
  client: { query: pg.PoolClient['query'] },
  job: RequirementStageJob,
  transitionTo: 'IN_PROGRESS' | 'COMPLETED' | 'RETRY_WAIT',
  eventType: 'STAGE_ENTERED' | 'STAGE_COMPLETED' | 'STAGE_FAILED' | 'RETRY_SCHEDULED',
  errorMessage: string | null,
  payload: Record<string, unknown> | null = null
): Promise<void> {
  await client.query(
    `INSERT INTO pipeline_stage_events (
       workspace_id,
       canonical_job_id,
       job_version_id,
       stage,
       transition_from,
       transition_to,
       event_type,
       error_message,
       payload
     )
     VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', NULL, $4, $5, $6, $7)`,
    [job.workspace_id, job.canonical_job_id, job.job_version_id, transitionTo, eventType, errorMessage, payload]
  );
}

async function persistRequirements(
  client: { query: pg.PoolClient['query'] },
  workspaceId: string,
  requirementSetId: string,
  requirements: Array<ReturnType<typeof JobRequirementSchema.parse>>
): Promise<number> {
  let inserted = 0;
  for (const req of requirements) {
    const res = await client.query(
      `INSERT INTO job_requirements (
         workspace_id,
         canonical_job_id,
         job_version_id,
         requirement_set_id,
         requirement_key,
         requirement_type,
         importance,
         requirement_text,
         quote_text,
         quote_start_offset,
         quote_end_offset,
         structured_value,
         extractor_type,
         extractor_version,
         confidence,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'VALIDATED')
       ON CONFLICT (requirement_set_id, requirement_key)
       DO NOTHING`,
      [
        workspaceId,
        req.canonical_job_id,
        req.job_version_id,
        requirementSetId,
        req.requirement_key,
        req.requirement_type,
        req.importance,
        req.requirement_text,
        req.quote_text ?? null,
        req.quote_start_offset ?? null,
        req.quote_end_offset ?? null,
        req.structured_value ?? null,
        req.extractor_type,
        req.extractor_version,
        req.confidence,
      ]
    );
    inserted += res.rowCount ?? 0;
  }

  return inserted;
}

function nextRequirementKey(index: number): string {
  return `R-${String(index).padStart(3, '0')}`;
}

export async function runRequirementsExtraction(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options: RequirementExtractionStageOptions = {}
): Promise<RequirementExtractionSummary> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);

  const ownsClient = isPool(pool);
  console.log('[requirementsExtractor] acquiring database client');
  const client = ownsClient ? await pool.connect() : pool;
  console.log('[requirementsExtractor] database client acquired');

  const dbStatementTimeoutMs = parsePositiveInt(
    process.env.REQUIREMENTS_DB_STATEMENT_TIMEOUT_MS,
    60000,
    300000
  );
  await client.query(`SELECT set_config('statement_timeout', $1, false)`, [`${dbStatementTimeoutMs}ms`]);
  console.log(`[requirementsExtractor] statement_timeout=${dbStatementTimeoutMs}ms`);

  console.log('[requirementsExtractor] resolving workspace context');
  const ctx = options.context ?? (await resolveWorkspaceContext(client as any));
  console.log(`[requirementsExtractor] workspace_id=${ctx.workspaceId}; loading target job versions`);

  // NOTE: requirements extraction is a *job-version* stage, but canonical job processing_state
  // can advance (e.g. RAW_STAGED -> PREQUALIFIED -> LANE_ROUTED) even when this stage fails.
  // If we only target RAW_STAGED, retries become impossible and LANE_ROUTED jobs can get stuck
  // forever with zero VALIDATED job_requirements (breaking deterministic matching + documents).
  const params: unknown[] = [ctx.workspaceId];
  const jobVersionIds = options.jobVersionIds?.filter(Boolean) ?? [];
  const jobVersionFilter = jobVersionIds.length > 0
    ? `AND jv.id = ANY($${params.push(jobVersionIds)}::uuid[])`
    : "";
  const mode = options.quotedMode ?? 'env';
  const quotedEnabledForSelection = mode === 'with_quoted'
    ? true
    : mode === 'deterministic_only'
      ? false
      : Boolean(options.quotedExtractor) || shouldRunQuotedExtractor();
  const deterministicCompleteClause = `AND (
        ps.stage_status IS DISTINCT FROM 'COMPLETED'
        OR NOT EXISTS (
          SELECT 1
          FROM job_requirements deterministic_jr
          WHERE deterministic_jr.workspace_id = c.workspace_id
            AND deterministic_jr.job_version_id = jv.id
            AND deterministic_jr.extractor_type = 'DETERMINISTIC'
            AND deterministic_jr.status = 'VALIDATED'
            AND (
              jv.active_requirement_set_id IS NULL
              OR deterministic_jr.requirement_set_id = jv.active_requirement_set_id
            )
        )
      )`;
  const completedRequirementClause = quotedEnabledForSelection
    ? `AND (
        ps.stage_status IS DISTINCT FROM 'COMPLETED'
        OR NOT EXISTS (
          SELECT 1
          FROM job_requirements quoted_jr
          WHERE quoted_jr.workspace_id = c.workspace_id
            AND quoted_jr.job_version_id = jv.id
            AND quoted_jr.extractor_type = 'LLM_QUOTED'
            AND quoted_jr.status = 'VALIDATED'
            AND (
              jv.active_requirement_set_id IS NULL
              OR quoted_jr.requirement_set_id = jv.active_requirement_set_id
          )
        )
      )`
    : deterministicCompleteClause;
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0
    ? Number(options.limit)
    : 200;
  const limitPlaceholder = params.push(limit);
  const queryTargetJobs = `
    SELECT
      c.workspace_id,
      c.id AS canonical_job_id,
      jv.id AS job_version_id,
      jv.content_hash,
      jv.description_text
    FROM canonical_jobs c
    JOIN job_versions jv
      ON jv.id = COALESCE(
        c.latest_job_version_id,
        (
          SELECT jv2.id
          FROM job_versions jv2
          WHERE jv2.workspace_id = c.workspace_id
            AND jv2.canonical_job_id = c.id
          ORDER BY jv2.observed_at DESC
          LIMIT 1
        )
      )
     AND jv.workspace_id = c.workspace_id
    LEFT JOIN job_version_pipeline_state ps
      ON ps.workspace_id = c.workspace_id
     AND ps.job_version_id = jv.id
     AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
    WHERE c.workspace_id = $1
      AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
      AND (
        COALESCE(c.processing_state, c.processing_status) IN ('RAW_STAGED', 'PREQUALIFIED')
        OR (
          COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
          AND ps.stage_status IS NOT NULL
          AND ps.stage_status <> 'COMPLETED'
        )
      )
      ${jobVersionFilter}
      ${completedRequirementClause}
      AND (
        ps.stage_status IS NULL
        OR ps.stage_status <> 'RETRY_WAIT'
        OR ps.next_retry_at IS NULL
        OR ps.next_retry_at <= NOW()
      )
    ORDER BY jv.observed_at ASC
    LIMIT $${limitPlaceholder}
  `;

  const { rows } = await client.query(queryTargetJobs, params);
  const jobs = rows as RequirementStageJob[];
  console.log(`[requirementsExtractor] loaded target job versions count=${jobs.length}`);

  const summary: RequirementExtractionSummary = {
    discovered: jobs.length,
    processed: 0,
    deterministicInserted: 0,
    quotedInserted: 0,
    quotedFailed: 0,
    errors: 0,
    metrics: {
      quotedAttempted: 0,
      quotedSucceeded: 0,
      quotedValidationFailures: 0,
      quotedProviderFailures: 0,
      retryWaitTransitions: 0,
      quotedPassRate: 0,
      byProviderModel: {},
    },
    details: [],
  };
  const quotedExtractor = mode === 'deterministic_only'
    ? undefined
    : options.quotedExtractor
      ? options.quotedExtractor
      : (mode === 'with_quoted' || shouldRunQuotedExtractor())
      ? async (input: QuotedExtractorInvocation) => runQuotedRequirementProvider(input)
      : undefined;
  const failFastOnQuotedProviderFailure =
    options.failFastOnQuotedProviderFailure ?? Boolean(quotedExtractor);
  const quotedProviderFailureLimit =
    options.quotedProviderFailureLimit ??
    parsePositiveInt(process.env.REQUIREMENTS_PROVIDER_FAILURE_LIMIT, 1, 10);
  let quotedProviderFailures = 0;

  const quotedExtractorIdentityVersion = quotedExtractor
    ? `quoted_provider_${REQUIREMENTS_SCHEMA_VERSION}`
    : 'none';

  console.log(
    `[requirementsExtractor] discovered=${jobs.length} quoted_enabled=${Boolean(quotedExtractor)} fail_fast=${failFastOnQuotedProviderFailure} provider_failure_limit=${quotedProviderFailureLimit}`
  );

  try {
    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
      const job = jobs[jobIndex] as RequirementStageJob;
      const progress = `[requirementsExtractor] ${jobIndex + 1}/${jobs.length} canonical_job_id=${job.canonical_job_id} job_version_id=${job.job_version_id}`;
      const jobStartedAt = Date.now();
      console.log(`${progress} starting`);

      await client.query('BEGIN');
      try {
        await upsertPipelineState(client, job, 'IN_PROGRESS');
        await insertStageEvent(client, job, 'IN_PROGRESS', 'STAGE_ENTERED', null, {
          run_type: 'DETERMINISTIC',
        });

        const quotedEnabled = Boolean(quotedExtractor);
        const identityHash = crypto
          .createHash('sha256')
          .update(
            [
              job.content_hash || '',
              DETERMINISTIC_VERSION,
              quotedExtractorIdentityVersion,
              QUOTED_PROMPT_HASH,
              NORMALIZER_HASH,
              quotedEnabled ? '1' : '0',
            ].join('|')
          )
          .digest('hex');

        const identityRes = await client.query<{ id: string }>(
          `INSERT INTO requirement_set_identities (
             workspace_id,
             canonical_job_id,
             identity_hash,
             job_content_hash,
             deterministic_extractor_version,
             quoted_extractor_version,
             quoted_prompt_hash,
             normalizer_hash,
             quoted_enabled
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (workspace_id, canonical_job_id, identity_hash)
           DO UPDATE SET identity_hash = EXCLUDED.identity_hash
           RETURNING id`,
          [
            ctx.workspaceId,
            job.canonical_job_id,
            identityHash,
            job.content_hash || '',
            DETERMINISTIC_VERSION,
            quotedExtractorIdentityVersion,
            QUOTED_PROMPT_HASH,
            NORMALIZER_HASH,
            quotedEnabled,
          ]
        );
        const requirementIdentityId = identityRes.rows[0].id;

        // If there's already an active set with the same identity, do nothing.
        const activeSetRes = await client.query<{ active_requirement_set_id: string | null }>(
          `SELECT active_requirement_set_id
           FROM job_versions
           WHERE workspace_id = $1 AND id = $2
           LIMIT 1`,
          [ctx.workspaceId, job.job_version_id]
        );
        const activeSetId = activeSetRes.rows[0]?.active_requirement_set_id ?? null;
        if (activeSetId) {
          const activeOk = await client.query(
            `SELECT 1
             FROM requirement_sets rs
             WHERE rs.workspace_id = $1
               AND rs.id = $2
               AND rs.requirement_identity_id = $3
             LIMIT 1`,
            [ctx.workspaceId, activeSetId, requirementIdentityId]
          );
          let activeSetHasExpectedRows = activeOk.rows.length > 0;
          if (activeSetHasExpectedRows && quotedExtractor) {
            const activeQuotedOk = await client.query(
              `SELECT 1
               FROM job_requirements jr
               WHERE jr.workspace_id = $1
                 AND jr.requirement_set_id = $2
                 AND jr.job_version_id = $3
                 AND jr.extractor_type = 'LLM_QUOTED'
                 AND jr.status = 'VALIDATED'
               LIMIT 1`,
              [ctx.workspaceId, activeSetId, job.job_version_id]
            );
            activeSetHasExpectedRows = activeQuotedOk.rows.length > 0;
            if (!activeSetHasExpectedRows) {
              console.warn(
                `${progress} active requirement set ${activeSetId} has matching identity but no validated quoted rows; rebuilding`
              );
            }
          }

          if (activeSetHasExpectedRows) {
            await upsertPipelineState(client, job, 'COMPLETED', null);
            await insertStageEvent(client, job, 'COMPLETED', 'STAGE_COMPLETED', null, {
              cached: true,
              requirement_set_id: activeSetId,
            });
            await client.query('COMMIT');
            console.log(
              `${progress} completed cached=true requirement_set_id=${activeSetId} elapsed_ms=${Date.now() - jobStartedAt}`
            );
            summary.processed += 1;
            summary.details.push({
              canonicalJobId: job.canonical_job_id,
              jobVersionId: job.job_version_id,
              deterministicInserted: 0,
              quotedInserted: 0,
              warning: 'requirements already active for this job_version (no-op)',
            });
            continue;
          }
        }

        const templateSetRes = await client.query<{ id: string }>(
          `SELECT rs.id
           FROM requirement_sets rs
           WHERE rs.workspace_id = $1
             AND rs.canonical_job_id = $2
             AND rs.requirement_identity_id = $3
             AND rs.job_version_id <> $4
           ORDER BY rs.created_at DESC
           LIMIT 1`,
          [ctx.workspaceId, job.canonical_job_id, requirementIdentityId, job.job_version_id]
        );
        const templateSetId = templateSetRes.rows[0]?.id ?? null;

        const nextRevisionRes = await client.query<{ next_revision: number }>(
          `SELECT (COALESCE(MAX(revision_number), 0) + 1)::int AS next_revision
           FROM requirement_sets
           WHERE workspace_id = $1 AND job_version_id = $2`,
          [ctx.workspaceId, job.job_version_id]
        );
        const revisionNumber = nextRevisionRes.rows[0]?.next_revision ?? 1;

        const setRes = await client.query<{ id: string }>(
          `INSERT INTO requirement_sets (
             workspace_id,
             requirement_identity_id,
             canonical_job_id,
             job_version_id,
             revision_number,
             source_type,
             base_requirement_set_id,
             created_by_user_id
           )
           VALUES ($1, $2, $3, $4, $5, 'EXTRACTED', NULL, NULL)
           RETURNING id`,
          [
            ctx.workspaceId,
            requirementIdentityId,
            job.canonical_job_id,
            job.job_version_id,
            revisionNumber,
          ]
        );
        const requirementSetId = setRes.rows[0].id;

        await client.query(
          `UPDATE job_versions
           SET active_requirement_set_id = $3
           WHERE workspace_id = $1 AND id = $2`,
          [ctx.workspaceId, job.job_version_id, requirementSetId]
        );

        const detRunStart = await client.query<{ id: string }>(
          `INSERT INTO requirement_extraction_runs (
             workspace_id,
             canonical_job_id,
             job_version_id,
             requirement_set_id,
             run_type,
             provider,
             model,
             status,
             started_at
           )
           VALUES ($1, $2, $3, $4, 'DETERMINISTIC', NULL, NULL, 'STARTED', NOW())
           RETURNING id`,
          [ctx.workspaceId, job.canonical_job_id, job.job_version_id, requirementSetId]
        );

        let detInserted = 0;
        let quotedInserted = 0;
        let warning: string | undefined;

        if (templateSetId && templateSetId !== requirementSetId) {
          const countsRes = await client.query<{ extractor_type: string; n: number }>(
            `SELECT extractor_type, COUNT(*)::int AS n
             FROM job_requirements
             WHERE workspace_id = $1
               AND requirement_set_id = $2
               AND status = 'VALIDATED'
             GROUP BY extractor_type`,
            [ctx.workspaceId, templateSetId]
          );
          const counts = new Map<string, number>();
          for (const row of countsRes.rows) {
            counts.set(row.extractor_type, row.n);
          }

          await client.query(
            `INSERT INTO job_requirements (
               workspace_id,
               canonical_job_id,
               job_version_id,
               requirement_set_id,
               requirement_key,
               requirement_type,
               importance,
               requirement_text,
               quote_text,
               quote_start_offset,
               quote_end_offset,
               structured_value,
               extractor_type,
               extractor_version,
               confidence,
               status
             )
             SELECT
               $1,
               $2,
               $3,
               $4,
               jr.requirement_key,
               jr.requirement_type,
               jr.importance,
               jr.requirement_text,
               jr.quote_text,
               jr.quote_start_offset,
               jr.quote_end_offset,
               jr.structured_value,
               jr.extractor_type,
               jr.extractor_version,
               jr.confidence,
               jr.status
             FROM job_requirements jr
             WHERE jr.workspace_id = $1
               AND jr.requirement_set_id = $5
             ON CONFLICT (requirement_set_id, requirement_key) DO NOTHING`,
            [
              ctx.workspaceId,
              job.canonical_job_id,
              job.job_version_id,
              requirementSetId,
              templateSetId,
            ]
          );

          detInserted = counts.get('DETERMINISTIC') || 0;
          quotedInserted = counts.get('LLM_QUOTED') || 0;
          warning = `cached_from_requirement_set:${templateSetId}`;
          console.log(
            `${progress} copied cached requirements deterministic_inserted=${detInserted} quoted_inserted=${quotedInserted} source_requirement_set_id=${templateSetId}`
          );

          if (quotedExtractor && quotedInserted > 0) {
            const quotedRunStart = await client.query<{ id: string }>(
              `INSERT INTO requirement_extraction_runs (
                 workspace_id,
                 canonical_job_id,
                 job_version_id,
                 requirement_set_id,
                 run_type,
                 provider,
                 model,
                 status,
                 started_at
               )
               VALUES ($1, $2, $3, $4, 'LLM_QUOTED', 'CACHE', 'CACHE', 'COMPLETED', NOW())
               RETURNING id`,
              [ctx.workspaceId, job.canonical_job_id, job.job_version_id, requirementSetId]
            );

            await client.query(
              `UPDATE requirement_extraction_runs
               SET requirements_extracted = $2,
                   response_payload = $3,
                   completed_at = NOW()
               WHERE id = $1`,
              [
                quotedRunStart.rows[0].id,
                quotedInserted,
                { cached_from_requirement_set_id: templateSetId },
              ]
            );
          }
        } else {
          const deterministic = extractDeterministicRequirements({
            canonical_job_id: job.canonical_job_id,
            job_version_id: job.job_version_id,
            description_text: job.description_text,
          });

          const deterministicRequirements = deterministic.requirements.map((req) =>
            JobRequirementSchema.parse({
              ...req,
              extractor_type: 'DETERMINISTIC',
              extractor_version: DETERMINISTIC_VERSION,
            })
          );

          detInserted = await persistRequirements(
            client,
            ctx.workspaceId,
            requirementSetId,
            deterministicRequirements
          );
          console.log(`${progress} deterministic_inserted=${detInserted}`);

          if (quotedExtractor) {
            summary.metrics.quotedAttempted += 1;
            const quotedRunStart = await client.query<{ id: string }>(
              `INSERT INTO requirement_extraction_runs (
                 workspace_id,
                 canonical_job_id,
                 job_version_id,
                 requirement_set_id,
                 run_type,
                 provider,
                 model,
                 status,
                 started_at
               )
               VALUES ($1, $2, $3, $4, 'LLM_QUOTED', NULL, NULL, 'STARTED', NOW())
               RETURNING id`,
              [ctx.workspaceId, job.canonical_job_id, job.job_version_id, requirementSetId]
            );

            try {
              console.log(`${progress} quoted provider starting`);
              const quotedResult = await quotedExtractor({
                canonicalJobId: job.canonical_job_id,
                jobVersionId: job.job_version_id,
                descriptionText: job.description_text,
              });

              if (quotedResult?.payload) {
                const bucket = ensureMetricBucket(
                  summary,
                  quotedResult.provider,
                  quotedResult.model
                );
                bucket.attempts += 1;

                const retriesFromAttempts = Math.max(0, (quotedResult.attempts || 1) - 1);
                const retriesFromErrors = quotedResult.errors?.length || 0;
                bucket.retries += Math.max(retriesFromAttempts, retriesFromErrors);

                const validated = validateQuotedRequirements(job.description_text, quotedResult.payload);

                if (!validated.valid) {
                  summary.quotedFailed += 1;
                  summary.metrics.quotedValidationFailures += 1;
                  bucket.validationFailures += 1;
                  warning = validated.issues.map((i) => `${i.requirement_key}: ${i.message}`).join('; ');
                  console.warn(
                    `${progress} quoted validation failed issues=${validated.issues.length} provider=${quotedResult.provider} model=${quotedResult.model}`
                  );

                  await client.query(
                    `UPDATE requirement_extraction_runs
                     SET status = 'FAILED',
                         provider = $2,
                         model = $3,
                         error_message = $4,
                         response_payload = $5,
                         completed_at = NOW()
                     WHERE id = $1`,
                    [
                      quotedRunStart.rows[0].id,
                      quotedResult.provider,
                      quotedResult.model,
                      warning,
                      quotedResult.payload,
                    ]
                  );

                  if (failFastOnQuotedProviderFailure) {
                    throw new RequirementsStageAbortError(
                      `Quoted requirements validation failed; aborting requirements extraction after model output failed strict quote validation. Last error: ${warning}`
                    );
                  }
                } else {
                  const startIndex = deterministicRequirements.length + 1;
                  const quotedRequirements = validated.requirements.map((req, idx) =>
                    JobRequirementSchema.parse({
                      canonical_job_id: job.canonical_job_id,
                      job_version_id: job.job_version_id,
                      requirement_key: nextRequirementKey(startIndex + idx),
                      requirement_type: req.requirement_type,
                      importance: req.importance,
                      requirement_text: req.requirement_text,
                      quote_text: req.quote_text,
                      quote_start_offset: req.quote_start_offset,
                      quote_end_offset: req.quote_end_offset,
                      structured_value: req.structured_value ?? null,
                      extractor_type: 'LLM_QUOTED',
                      extractor_version: quotedResult.extractorVersion || QUOTED_VERSION,
                      confidence: req.confidence,
                    })
                  );

                  quotedInserted = await persistRequirements(
                    client,
                    ctx.workspaceId,
                    requirementSetId,
                    quotedRequirements
                  );
                  summary.metrics.quotedSucceeded += 1;
                  bucket.successes += 1;
                  console.log(
                    `${progress} quoted provider completed provider=${quotedResult.provider} model=${quotedResult.model} inserted=${quotedInserted}`
                  );

                  await client.query(
                    `UPDATE requirement_extraction_runs
                     SET status = 'COMPLETED',
                         provider = $2,
                         model = $3,
                         requirements_extracted = $4,
                         response_payload = $5,
                         completed_at = NOW()
                     WHERE id = $1`,
                    [
                      quotedRunStart.rows[0].id,
                      quotedResult.provider,
                      quotedResult.model,
                      quotedInserted,
                      quotedResult.payload,
                    ]
                  );
                }
              } else {
                console.log(`${progress} quoted provider returned no payload`);
                await client.query(
                  `UPDATE requirement_extraction_runs
                   SET status = 'COMPLETED',
                       requirements_extracted = 0,
                       completed_at = NOW()
                   WHERE id = $1`,
                  [quotedRunStart.rows[0].id]
                );
              }
            } catch (quotedError) {
              if (quotedError instanceof RequirementsStageAbortError) {
                throw quotedError;
              }

              summary.quotedFailed += 1;
              summary.metrics.quotedProviderFailures += 1;
              warning = quotedError instanceof Error ? quotedError.message : String(quotedError);

              const parsedFailures = parseProviderFailuresFromError(warning);
              if (parsedFailures.length > 0) {
                for (const fail of parsedFailures) {
                  const bucket = ensureMetricBucket(summary, fail.provider, fail.model);
                  bucket.providerFailures += 1;
                  bucket.retries += 1;
                }
              } else {
                const bucket = ensureMetricBucket(summary, 'unknown', 'unknown');
                bucket.providerFailures += 1;
                bucket.retries += 1;
              }

              await client.query(
                `UPDATE requirement_extraction_runs
                 SET status = 'FAILED',
                     error_message = $2,
                     completed_at = NOW()
                 WHERE id = $1`,
                [quotedRunStart.rows[0].id, warning]
              );

              quotedProviderFailures += 1;
              console.warn(
                `${progress} quoted provider failed failures=${quotedProviderFailures}/${quotedProviderFailureLimit} error=${truncateLogValue(warning)}`
              );
              if (failFastOnQuotedProviderFailure && quotedProviderFailures >= quotedProviderFailureLimit) {
                throw new RequirementsStageAbortError(
                  `Quoted requirements provider failed ${quotedProviderFailures} time(s); aborting requirements extraction after model retry budget was exhausted. Last error: ${warning}`
                );
              }
            }
          }

          warning = deterministic.warnings.length > 0 ? deterministic.warnings.join('; ') : warning;
        }

        summary.deterministicInserted += detInserted;
        summary.quotedInserted += quotedInserted;

        await client.query(
          `UPDATE requirement_extraction_runs
           SET status = 'COMPLETED',
               requirements_extracted = $2,
               response_payload = $3,
               completed_at = NOW()
           WHERE id = $1`,
          [
            detRunStart.rows[0].id,
            detInserted,
            {
              warning,
            },
          ]
        );

        await upsertPipelineState(client, job, 'COMPLETED', null);
        await insertStageEvent(client, job, 'COMPLETED', 'STAGE_COMPLETED', null, {
          deterministic_inserted: detInserted,
          quoted_inserted: quotedInserted,
          warning,
          requirement_set_id: requirementSetId,
        });

        await client.query('COMMIT');
        console.log(
          `${progress} completed deterministic_inserted=${detInserted} quoted_inserted=${quotedInserted} elapsed_ms=${Date.now() - jobStartedAt}`
        );

        summary.processed += 1;
        summary.details.push({
          canonicalJobId: job.canonical_job_id,
          jobVersionId: job.job_version_id,
          deterministicInserted: detInserted,
          quotedInserted,
          warning,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        summary.errors += 1;
        summary.metrics.retryWaitTransitions += 1;

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(
          `${progress} failed elapsed_ms=${Date.now() - jobStartedAt} error=${truncateLogValue(errorMessage)}`
        );
        // Emit a small amount of context so CI logs show the true root-cause (missing columns,
        // drifted migrations, constraint violations, etc.) instead of only a summary count.
        if (summary.errors <= 5) {
          console.warn(
            `[requirementsExtractor] failed for canonical_job_id=${job.canonical_job_id} job_version_id=${job.job_version_id}: ${errorMessage}`
          );
        }
        summary.details.push({
          canonicalJobId: job.canonical_job_id,
          jobVersionId: job.job_version_id,
          deterministicInserted: 0,
          quotedInserted: 0,
          error: errorMessage,
        });

        // Best effort state update outside failed transaction.
        await upsertPipelineState(client, job, 'RETRY_WAIT', errorMessage);
        await insertStageEvent(client, job, 'RETRY_WAIT', 'RETRY_SCHEDULED', errorMessage, null);

        if (error instanceof RequirementsStageAbortError) {
          throw error;
        }
      }
    }
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }

  summary.metrics.quotedPassRate = summary.metrics.quotedAttempted
    ? Number((summary.metrics.quotedSucceeded / summary.metrics.quotedAttempted).toFixed(4))
    : 0;

  if (summary.errors > 0) {
    const sample = summary.details.filter((d) => d.error).slice(0, 5);
    console.warn(
      `[requirementsExtractor] errors=${summary.errors}. Sample failures: ${JSON.stringify(sample)}`
    );
  }

  console.log('Requirements extraction quoted metrics:', {
    quotedPassRate: summary.metrics.quotedPassRate,
    quotedAttempted: summary.metrics.quotedAttempted,
    quotedSucceeded: summary.metrics.quotedSucceeded,
    quotedValidationFailures: summary.metrics.quotedValidationFailures,
    quotedProviderFailures: summary.metrics.quotedProviderFailures,
    retryWaitTransitions: summary.metrics.retryWaitTransitions,
    byProviderModel: summary.metrics.byProviderModel,
  });

  return summary;
}
