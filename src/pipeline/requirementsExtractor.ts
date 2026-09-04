import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';
import { extractDeterministicRequirements } from '../requirements/deterministicExtractors.js';
import { validateQuotedRequirements } from '../requirements/quotedRequirementExtractor.js';
import { runQuotedRequirementProvider } from '../requirements/quotedProvider.js';
import { JobRequirementSchema } from '../requirements/contracts.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

interface RequirementStageJob {
  canonical_job_id: string;
  job_version_id: string;
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
       'REQUIREMENTS_EXTRACTED',
       $3,
       CASE WHEN $3 = 'RETRY_WAIT' THEN 1 ELSE 0 END,
       $4,
       CASE WHEN $3 = 'RETRY_WAIT' THEN NOW() + INTERVAL '5 minutes' ELSE NULL END,
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
    [job.canonical_job_id, job.job_version_id, stageStatus, lastError]
  );
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
       canonical_job_id,
       job_version_id,
       stage,
       transition_from,
       transition_to,
       event_type,
       error_message,
       payload
     )
     VALUES ($1, $2, 'REQUIREMENTS_EXTRACTED', NULL, $3, $4, $5, $6)`,
    [job.canonical_job_id, job.job_version_id, transitionTo, eventType, errorMessage, payload]
  );
}

async function persistRequirements(
  client: { query: pg.PoolClient['query'] },
  requirements: Array<ReturnType<typeof JobRequirementSchema.parse>>
): Promise<number> {
  for (const req of requirements) {
    await client.query(
      `INSERT INTO job_requirements (
         canonical_job_id,
         job_version_id,
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'VALIDATED')
       ON CONFLICT (job_version_id, requirement_key)
       DO UPDATE SET
         requirement_type = EXCLUDED.requirement_type,
         importance = EXCLUDED.importance,
         requirement_text = EXCLUDED.requirement_text,
         quote_text = EXCLUDED.quote_text,
         quote_start_offset = EXCLUDED.quote_start_offset,
         quote_end_offset = EXCLUDED.quote_end_offset,
         structured_value = EXCLUDED.structured_value,
         extractor_type = EXCLUDED.extractor_type,
         extractor_version = EXCLUDED.extractor_version,
         confidence = EXCLUDED.confidence,
         status = EXCLUDED.status`,
      [
        req.canonical_job_id,
        req.job_version_id,
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
  }

  return requirements.length;
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

  const queryTargetJobs = `
    SELECT
      c.id AS canonical_job_id,
      jv.id AS job_version_id,
      jv.description_text
    FROM canonical_jobs c
    JOIN job_versions jv
      ON jv.id = c.latest_job_version_id
    WHERE COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
      AND NOT EXISTS (
        SELECT 1
        FROM job_version_pipeline_state ps
        WHERE ps.job_version_id = jv.id
          AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
          AND ps.stage_status = 'COMPLETED'
      )
  `;

  const { rows } = await pool.query(queryTargetJobs);
  const jobs = rows as RequirementStageJob[];

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

  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;
  const quotedExtractor = options.quotedExtractor
    ? options.quotedExtractor
    : shouldRunQuotedExtractor()
      ? async (input: QuotedExtractorInvocation) => runQuotedRequirementProvider(input)
      : undefined;

  try {
    for (const job of jobs) {
      await client.query('BEGIN');
      try {
        await upsertPipelineState(client, job, 'IN_PROGRESS');
        await insertStageEvent(client, job, 'IN_PROGRESS', 'STAGE_ENTERED', null, {
          run_type: 'DETERMINISTIC',
        });

        const detRunStart = await client.query<{ id: string }>(
          `INSERT INTO requirement_extraction_runs (
             canonical_job_id,
             job_version_id,
             run_type,
             provider,
             model,
             status,
             started_at
           )
           VALUES ($1, $2, 'DETERMINISTIC', NULL, NULL, 'STARTED', NOW())
           RETURNING id`,
          [job.canonical_job_id, job.job_version_id]
        );

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

        const detInserted = await persistRequirements(client, deterministicRequirements);
        summary.deterministicInserted += detInserted;

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
              warnings: deterministic.warnings,
            },
          ]
        );

        let quotedInserted = 0;
        let warning: string | undefined;

        if (quotedExtractor) {
          summary.metrics.quotedAttempted += 1;
          const quotedRunStart = await client.query<{ id: string }>(
            `INSERT INTO requirement_extraction_runs (
               canonical_job_id,
               job_version_id,
               run_type,
               provider,
               model,
               status,
               started_at
             )
             VALUES ($1, $2, 'LLM_QUOTED', NULL, NULL, 'STARTED', NOW())
             RETURNING id`,
            [job.canonical_job_id, job.job_version_id]
          );

          try {
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

                quotedInserted = await persistRequirements(client, quotedRequirements);
                summary.quotedInserted += quotedInserted;
                summary.metrics.quotedSucceeded += 1;
                bucket.successes += 1;

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
          }
        }

        await upsertPipelineState(client, job, 'COMPLETED', null);
        await insertStageEvent(client, job, 'COMPLETED', 'STAGE_COMPLETED', null, {
          deterministic_inserted: detInserted,
          quoted_inserted: quotedInserted,
          warning,
        });

        await client.query('COMMIT');

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
