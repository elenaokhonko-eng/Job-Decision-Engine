import pg from 'pg';
import dotenv from 'dotenv';
import { pgPoolConfig } from '../db/pgSsl.js';
import {
  generateEmbeddingWithProviderAndModel,
  type EmbeddingProvider,
} from '../services/agent.js';
import { validateEmbeddingVector } from './batchValidator.js';
import { buildEmbeddingInputs } from './inputBuilder.js';
import { seedEmbeddingSpaces } from './spaceRegistry.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { recordModelRouteInvocation } from '../modelRoutes/registry.js';
import { sha256Hex, stableStringify } from '../config/structuredLoader.js';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface EmbeddingBatchSummary {
  batchId: string | null;
  batchIds?: string[];
  embeddingSpaceId: string;
  processed: number;
  processedInputIds: string[];
  succeeded: number;
  failed: number;
  failedInputIds: string[];
  runType: 'PRIMARY' | 'FALLBACK';
  errors: string[];
  publicationComplete?: boolean;
}

export interface EmbeddingFallbackSummary {
  seededSpaces: {
    primarySpaceId: string;
    fallbackSpaceId: string;
  };
  inputBuild: {
    inserted: number;
    fromRequirements: number;
    fromProfileFacts: number;
    fromJobVersions?: number;
    fromLanePrototypes?: number;
  };
  primary: EmbeddingBatchSummary;
  fallback?: EmbeddingBatchSummary;
}

export interface EmbeddingBatchCoordinatorOptions {
  context?: WorkspaceContext;
  jobVersionIds?: string[];
  includeProfileFacts?: boolean;
  includeLanePrototypes?: boolean;
}

interface InputRow {
  id: string;
  content_text: string;
}

interface SpaceRow {
  id: string;
  workspace_id: string;
  provider: string;
  model: string;
  dimensions: number;
}

interface EmbeddingInvocationRecord {
  status: 'COMPLETED' | 'FAILED';
  workspaceId: string;
  embeddingSpaceId: string;
  embeddingBatchId: string;
  embeddingInputId: string;
  provider: EmbeddingProvider;
  model: string;
  runType: 'PRIMARY' | 'FALLBACK';
  contentText: string;
  latencyMs: number;
  vectorDimensions?: number | null;
  vectorChecksum?: string | null;
  errorMessage?: string | null;
  validationIssues?: string[];
}

function describeEmbeddingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

async function recordEmbeddingInvocation(
  client: pg.PoolClient,
  context: WorkspaceContext | undefined,
  input: EmbeddingInvocationRecord
): Promise<void> {
  const contentHash = sha256Hex(input.contentText);
  const requestHash = sha256Hex(
    stableStringify({
      purpose: 'EMBEDDING',
      provider: input.provider,
      model: input.model,
      embedding_space_id: input.embeddingSpaceId,
      embedding_input_id: input.embeddingInputId,
      content_sha256: contentHash,
    })
  );

  await recordModelRouteInvocation(
    {
      purpose: 'EMBEDDING',
      provider: input.provider,
      model: input.model,
      status: input.status,
      fallbackUsed: input.runType === 'FALLBACK',
      requestHash,
      requestMetadata: {
        embedding_space_id: input.embeddingSpaceId,
        embedding_batch_id: input.embeddingBatchId,
        embedding_input_id: input.embeddingInputId,
        run_type: input.runType,
        content_sha256: contentHash,
        content_length: input.contentText.length,
      },
      responseMetadata: {
        provider_attempts: [
          {
            provider: input.provider,
            model: input.model,
            attempt: 1,
            maxAttempts: 1,
            status: input.status,
            latencyMs: input.latencyMs,
            error: input.errorMessage ?? undefined,
          },
        ],
        internal_http_attempts: 1,
        vector_dimensions: input.vectorDimensions ?? null,
        vector_checksum: input.vectorChecksum ?? null,
        validation_issues: input.validationIssues ?? [],
      },
      latencyMs: input.latencyMs,
      errorMessage: input.errorMessage ?? null,
    },
    client,
    context ? { context } : undefined
  );
}

export async function runEmbeddingBatch(
  embeddingSpaceId: string,
  batchKey: string,
  runType: 'PRIMARY' | 'FALLBACK' = 'PRIMARY',
  maxItems = 50,
  inputIds?: string[],
  fallbackFromBatchId?: string,
  rerunOfBatchId?: string,
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext },
  excludeInputIds: string[] = []
): Promise<EmbeddingBatchSummary> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  const errors: string[] = [];

  try {
    const spaceRes = await client.query<SpaceRow>(
      `SELECT id, workspace_id, provider, model, dimensions
       FROM embedding_spaces
       WHERE id = $1 AND active = TRUE
       LIMIT 1`,
      [embeddingSpaceId]
    );
    if (spaceRes.rows.length === 0) {
      throw new Error(`Embedding space not found or inactive: ${embeddingSpaceId}`);
    }
    const space = spaceRes.rows[0];
    const workspaceId = space.workspace_id;
    const provider = (space.provider || '').toLowerCase() as EmbeddingProvider;
    if (provider !== 'gemini' && provider !== 'openai') {
      throw new Error(`Unsupported embedding provider for space ${space.id}: ${space.provider}`);
    }

    const spaceModel = (space.model || '').trim();
    if (!spaceModel) {
      throw new Error(`Embedding space ${space.id} has empty model; cannot run batch.`);
    }
    if (options?.context && options.context.workspaceId !== workspaceId) {
      throw new Error(
        `Embedding space ${space.id} is in workspace_id=${workspaceId} but context.workspaceId=${options.context.workspaceId}`
      );
    }

    if (Array.isArray(inputIds) && inputIds.length === 0) {
      console.log(
        `[embeddings:${runType}] provider=${provider} model=${spaceModel} space=${space.id} no pending scoped inputs`
      );
      return {
        batchId: null,
        embeddingSpaceId: space.id,
        processed: 0,
        processedInputIds: [],
        succeeded: 0,
        failed: 0,
        failedInputIds: [],
        runType,
        errors: [],
      };
    }

    const excludedInputIds = excludeInputIds.length > 0 ? excludeInputIds : null;
    const inputRes = Array.isArray(inputIds)
      ? await client.query<InputRow>(
          `SELECT ei.id, ei.content_text
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND ei.is_current = TRUE
             AND ei.id = ANY($2::uuid[])
             AND ($5::uuid[] IS NULL OR ei.id <> ALL($5::uuid[]))
             AND NOT EXISTS (
               SELECT 1
               FROM v_published_semantic_embeddings se
               WHERE se.workspace_id = $1
                 AND se.embedding_space_id = $3
                 AND se.embedding_input_id = ei.id
             )
           ORDER BY ei.created_at ASC
           LIMIT $4`,
          [workspaceId, inputIds, space.id, maxItems, excludedInputIds]
        )
      : await client.query<InputRow>(
          `SELECT ei.id, ei.content_text
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND ei.is_current = TRUE
             AND ($4::uuid[] IS NULL OR ei.id <> ALL($4::uuid[]))
             AND NOT EXISTS (
             SELECT 1
             FROM v_published_semantic_embeddings se
             WHERE se.workspace_id = $1
               AND se.embedding_space_id = $2
               AND se.embedding_input_id = ei.id
           )
           ORDER BY ei.created_at ASC
           LIMIT $3`,
          [workspaceId, space.id, maxItems, excludedInputIds]
        );

    if (inputRes.rows.length === 0) {
      console.log(
        `[embeddings:${runType}] provider=${provider} model=${spaceModel} space=${space.id} no pending inputs`
      );
      return {
        batchId: null,
        embeddingSpaceId: space.id,
        processed: 0,
        processedInputIds: [],
        succeeded: 0,
        failed: 0,
        failedInputIds: [],
        runType,
        errors: [],
      };
    }

    const processedInputIds = inputRes.rows.map((row) => row.id);
    console.log(
      `[embeddings:${runType}] provider=${provider} model=${spaceModel} space=${space.id} dimensions=${space.dimensions} selected=${inputRes.rows.length} max_items=${maxItems} input_filter=${inputIds && inputIds.length > 0 ? inputIds.length : 'none'}`
    );

    let batchId: string;

    // Keep the transaction window small: do not hold a DB transaction while waiting on
    // external embedding providers, otherwise a single SQL error will abort the entire
    // transaction and prevent fallback writes.
    await client.query('BEGIN');
    try {
      const batchRes = await client.query<{ id: string }>(
        `INSERT INTO embedding_batches (
           workspace_id,
           embedding_space_id,
           batch_key,
           run_type,
           fallback_from_batch_id,
           rerun_of_batch_id,
           status,
           item_count,
           success_count,
           failure_count
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING', 0, 0, 0)
         RETURNING id`,
        [workspaceId, space.id, batchKey, runType, fallbackFromBatchId || null, rerunOfBatchId || null]
      );
      batchId = batchRes.rows[0].id;
      console.log(
        `[embeddings:${runType}] batch_id=${batchId} creating ${inputRes.rows.length} batch item(s)`
      );

      for (const input of inputRes.rows) {
        await client.query(
          `INSERT INTO embedding_batch_items (
             workspace_id,
             embedding_batch_id,
             embedding_input_id,
             status,
             attempt_count,
             error_message,
             updated_at
           )
           VALUES ($1, $2, $3, 'PENDING', 1, NULL, NOW())
           ON CONFLICT (embedding_batch_id, embedding_input_id)
           DO NOTHING`,
          [workspaceId, batchId, input.id]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    let succeeded = 0;
    let failed = 0;
    const failedInputIds: string[] = [];

    for (let inputIndex = 0; inputIndex < inputRes.rows.length; inputIndex += 1) {
      const input = inputRes.rows[inputIndex];
      const itemStartedAt = Date.now();
      const progressPrefix = `[embeddings:${runType}] ${inputIndex + 1}/${inputRes.rows.length} input_id=${input.id} provider=${provider} model=${spaceModel}`;
      console.log(`${progressPrefix} starting chars=${input.content_text.length}`);
      try {
        const vector = await generateEmbeddingWithProviderAndModel(
          input.content_text,
          provider,
          spaceModel
        );
        const validation = validateEmbeddingVector(vector, space.dimensions);
        if (!validation.valid) {
          failed += 1;
          failedInputIds.push(input.id);
          errors.push(`input ${input.id}: ${validation.issues.join('; ')}`);
          console.warn(
            `${progressPrefix} validation_failed issues=${validation.issues.join('; ')} elapsed_ms=${Date.now() - itemStartedAt}`
          );
          await recordEmbeddingInvocation(client as pg.PoolClient, options?.context, {
            status: 'FAILED',
            workspaceId,
            embeddingSpaceId: space.id,
            embeddingBatchId: batchId,
            embeddingInputId: input.id,
            provider,
            model: spaceModel,
            runType,
            contentText: input.content_text,
            latencyMs: Date.now() - itemStartedAt,
            vectorDimensions: validation.dimensions,
            vectorChecksum: validation.checksum,
            errorMessage: validation.issues.join('; '),
            validationIssues: validation.issues,
          });
          await client.query(
            `UPDATE embedding_batch_items
             SET status = 'FAILED',
                 error_message = $4,
                 updated_at = NOW()
             WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`,
            [workspaceId, batchId, input.id, validation.issues.join('; ')]
          );
          continue;
        }

        try {
          await client.query(
            `INSERT INTO semantic_embeddings (
               workspace_id,
               embedding_space_id,
               embedding_input_id,
               embedding_batch_id,
               vector_dimensions,
               embedding_values,
               embedding_vector,
               vector_checksum
             )
             VALUES ($1, $2, $3, $4, $5, $6, ($6::float8[])::vector, $7)
             ON CONFLICT (embedding_space_id, embedding_input_id)
             DO NOTHING`,
            [
              workspaceId,
              space.id,
              input.id,
              batchId,
              validation.dimensions,
              vector,
              validation.checksum,
            ]
          );
        } catch (writeErr: any) {
          if (
            writeErr?.code !== '42703' && // undefined_column
            writeErr?.code !== '42704' && // undefined_object
            writeErr?.code !== '42883' && // undefined_function
            writeErr?.code !== '42846' && // cannot_coerce
            writeErr?.code !== '22P02' // invalid_text_representation
          ) {
            throw writeErr;
          }
          await client.query(
            `INSERT INTO semantic_embeddings (
               workspace_id,
               embedding_space_id,
               embedding_input_id,
               embedding_batch_id,
               vector_dimensions,
               embedding_values,
               vector_checksum
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (embedding_space_id, embedding_input_id)
             DO NOTHING`,
            [
              workspaceId,
              space.id,
              input.id,
              batchId,
              validation.dimensions,
              vector,
              validation.checksum,
            ]
          );
        }

        succeeded += 1;
        console.log(
          `${progressPrefix} completed dimensions=${validation.dimensions} elapsed_ms=${Date.now() - itemStartedAt}`
        );
        await recordEmbeddingInvocation(client as pg.PoolClient, options?.context, {
          status: 'COMPLETED',
          workspaceId,
          embeddingSpaceId: space.id,
          embeddingBatchId: batchId,
          embeddingInputId: input.id,
          provider,
          model: spaceModel,
          runType,
          contentText: input.content_text,
          latencyMs: Date.now() - itemStartedAt,
          vectorDimensions: validation.dimensions,
          vectorChecksum: validation.checksum,
        });
        await client.query(
          `UPDATE embedding_batch_items
           SET status = 'COMPLETED',
               error_message = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`,
          [workspaceId, batchId, input.id]
        );
      } catch (error) {
        const message = describeEmbeddingError(error);
        failed += 1;
        failedInputIds.push(input.id);
        errors.push(`input ${input.id}: ${message}`);
        console.warn(`${progressPrefix} failed elapsed_ms=${Date.now() - itemStartedAt} error=${message}`);
        await recordEmbeddingInvocation(client as pg.PoolClient, options?.context, {
          status: 'FAILED',
          workspaceId,
          embeddingSpaceId: space.id,
          embeddingBatchId: batchId,
          embeddingInputId: input.id,
          provider,
          model: spaceModel,
          runType,
          contentText: input.content_text,
          latencyMs: Date.now() - itemStartedAt,
          errorMessage: message,
        });
        await client.query(
          `UPDATE embedding_batch_items
           SET status = 'FAILED',
               error_message = $4,
               updated_at = NOW()
           WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`,
          [workspaceId, batchId, input.id, message]
        );
      }
    }

    await client.query(
      `UPDATE embedding_batches
       SET status = $2,
           item_count = $3,
           success_count = $4,
           failure_count = $5,
           error_message = $6,
           completed_at = NOW()
       WHERE workspace_id = $7 AND id = $1`,
      [
        batchId,
        failed > 0 ? 'FAILED' : 'COMPLETED',
        inputRes.rows.length,
        succeeded,
        failed,
        errors.length > 0 ? errors.join(' | ') : null,
        workspaceId,
      ]
    );

    let publicationComplete = false;
    if (failed === 0 && succeeded === inputRes.rows.length) {
      try {
        const publicationRes = await client.query(
          `UPDATE embedding_batches eb
           SET published_at = NOW(),
               publication_note = NULL
           WHERE eb.workspace_id = $1
             AND eb.id = $2
             AND eb.status = 'COMPLETED'
             AND eb.item_count > 0
             AND eb.item_count = (
               SELECT COUNT(*)
               FROM embedding_batch_items ebi
               WHERE ebi.workspace_id = eb.workspace_id
                 AND ebi.embedding_batch_id = eb.id
                 AND ebi.status = 'COMPLETED'
             )`,
          [workspaceId, batchId]
        );
        publicationComplete = (publicationRes.rowCount ?? 0) === 1;
      } catch (publishErr: unknown) {
        const code =
          typeof publishErr === 'object' && publishErr !== null && 'code' in publishErr
            ? String((publishErr as { code?: unknown }).code)
            : undefined;
        // Allow running against pre-migration databases; the completed batch
        // remains auditable even when publication metadata is unavailable.
        if (code !== '42703') {
          throw publishErr;
        }
        publicationComplete = true;
      }
    }

    if (failed === 0 && inputRes.rows.length === 0) {
      publicationComplete = true;
    }

    console.log(
      `[embeddings:${runType}] batch_id=${batchId} completed processed=${inputRes.rows.length} succeeded=${succeeded} failed=${failed}`
    );

    return {
      batchId,
      batchIds: [batchId],
      embeddingSpaceId: space.id,
      processed: inputRes.rows.length,
      processedInputIds,
      succeeded,
      failed,
      failedInputIds,
      runType,
      errors,
      publicationComplete,
    };
  } catch (error) {
    throw error;
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}

interface EmbeddingBatchDrainResult {
  summary: EmbeddingBatchSummary;
  batches: EmbeddingBatchSummary[];
}

function emptyBatchSummary(embeddingSpaceId: string, runType: 'PRIMARY' | 'FALLBACK'): EmbeddingBatchSummary {
  return {
    batchId: null,
    batchIds: [],
    embeddingSpaceId,
    processed: 0,
    processedInputIds: [],
    succeeded: 0,
    failed: 0,
    failedInputIds: [],
    runType,
    errors: [],
    publicationComplete: true,
  };
}

function mergeBatchSummaries(
  summaries: EmbeddingBatchSummary[],
  embeddingSpaceId: string,
  runType: 'PRIMARY' | 'FALLBACK'
): EmbeddingBatchSummary {
  if (summaries.length === 0) {
    return emptyBatchSummary(embeddingSpaceId, runType);
  }

  const processedInputIds = [...new Set(summaries.flatMap((summary) => summary.processedInputIds))];
  const failedInputIds = [...new Set(summaries.flatMap((summary) => summary.failedInputIds))];
  const batchIds = summaries.flatMap((summary) => summary.batchIds ?? (summary.batchId ? [summary.batchId] : []));
  return {
    batchId: batchIds[0] ?? null,
    batchIds,
    embeddingSpaceId,
    processed: summaries.reduce((total, summary) => total + summary.processed, 0),
    processedInputIds,
    succeeded: summaries.reduce((total, summary) => total + summary.succeeded, 0),
    failed: summaries.reduce((total, summary) => total + summary.failed, 0),
    failedInputIds,
    runType,
    errors: summaries.flatMap((summary) => summary.errors),
    publicationComplete: summaries.every(
      (summary) => summary.publicationComplete !== false && summary.failed === 0
    ),
  };
}

async function drainEmbeddingBatches(
  embeddingSpaceId: string,
  runType: 'PRIMARY' | 'FALLBACK',
  maxItems: number,
  inputIds: string[] | undefined,
  fallbackFromBatchId: string | undefined,
  rerunOfBatchId: string | undefined,
  client: pg.PoolClient,
  context: WorkspaceContext
): Promise<EmbeddingBatchDrainResult> {
  const requestedInputIds = inputIds ? [...new Set(inputIds)] : undefined;
  const attemptedInputIds = new Set<string>();
  const batches: EmbeddingBatchSummary[] = [];

  while (true) {
    const batch = await runEmbeddingBatch(
      embeddingSpaceId,
      `${runType.toLowerCase()}-${Date.now()}-${batches.length}`,
      runType,
      maxItems,
      requestedInputIds,
      fallbackFromBatchId,
      rerunOfBatchId,
      client,
      { context },
      [...attemptedInputIds]
    );

    if (batch.processed === 0) {
      break;
    }
    if (
      batch.processedInputIds.length === 0 ||
      !batch.processedInputIds.some((inputId) => !attemptedInputIds.has(inputId))
    ) {
      // Protect the coordinator from a broken or stale provider/query adapter
      // returning the same batch repeatedly.
      break;
    }

    batches.push(batch);
    for (const inputId of batch.processedInputIds) {
      attemptedInputIds.add(inputId);
    }

    // A provider failure is intentionally attempted once per coordinator run.
    // Keeping it in the attempted set prevents an unbounded retry loop while
    // still leaving the failed input durably available for a later run.
    if (batch.processedInputIds.length === 0) {
      break;
    }
    if (requestedInputIds && attemptedInputIds.size >= requestedInputIds.length) {
      break;
    }
  }

  return {
    summary: mergeBatchSummaries(batches, embeddingSpaceId, runType),
    batches,
  };
}

export async function runEmbeddingBatchWithFallback(
  maxItems = 100,
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: EmbeddingBatchCoordinatorOptions
): Promise<EmbeddingFallbackSummary> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as pg.PoolClient));
    const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
    const scopedToJobVersions = jobVersionIds.length > 0;
    console.log(`[embeddings] seeding embedding spaces`);
    const seeded = await seedEmbeddingSpaces(client as pg.PoolClient, { context: ctx });
    console.log(
      `[embeddings] spaces primary=${seeded.primarySpaceId} fallback=${seeded.fallbackSpaceId}`
    );
    console.log(`[embeddings] building embedding inputs max_per_source=${maxItems}`);
    const inputBuild = await buildEmbeddingInputs(client as pg.PoolClient, maxItems, {
      context: ctx,
      jobVersionIds,
      includeProfileFacts: options?.includeProfileFacts,
      includeLanePrototypes: options?.includeLanePrototypes,
    });
    console.log(
      `[embeddings] input_build inserted=${inputBuild.inserted} requirements=${inputBuild.fromRequirements} profile_facts=${inputBuild.fromProfileFacts} job_versions=${inputBuild.fromJobVersions ?? 0} lane_prototypes=${inputBuild.fromLanePrototypes ?? 0}`
    );

    let scopedInputIds: string[] | undefined;
    if (scopedToJobVersions) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT DISTINCT ei.id
         FROM embedding_inputs ei
         WHERE ei.workspace_id = $1
           AND ei.is_current = TRUE
           AND (
             (ei.source_type = 'JOB_VERSION' AND ei.source_id = ANY($2::uuid[]))
             OR (ei.source_type = 'JOB_REQUIREMENT' AND EXISTS (
               SELECT 1
               FROM job_requirements jr
               WHERE jr.workspace_id = ei.workspace_id
                 AND jr.id = ei.source_id
                 AND jr.job_version_id = ANY($2::uuid[])
                 AND jr.status = 'VALIDATED'
             ))
             OR (
               $3::boolean = TRUE
               AND ei.source_type = 'LANE_PROTOTYPE'
             )
             OR (
               $4::boolean = TRUE
               AND ei.source_type = 'PROFILE_FACT'
               AND EXISTS (
                 SELECT 1
                 FROM profile_facts pf
                 JOIN profile_versions pv
                   ON pv.workspace_id = pf.workspace_id
                  AND pv.id = pf.profile_version_id
                  AND pv.status = 'ACTIVE'
                 WHERE pf.workspace_id = ei.workspace_id
                   AND COALESCE(pf.fact_revision_id, pf.id) = ei.source_id
               )
             )
           )
         ORDER BY ei.id`,
        [
          ctx.workspaceId,
          jobVersionIds,
          options?.includeLanePrototypes ?? true,
          options?.includeProfileFacts ?? false,
        ]
      );
      scopedInputIds = rows.map((row) => row.id);
      console.log(
        `[embeddings] scoped input selection job_versions=${jobVersionIds.length} inputs=${scopedInputIds.length}`
      );
    }

    console.log(`[embeddings] draining primary batches max_items=${maxItems}`);
    const primaryDrain = await drainEmbeddingBatches(
      seeded.primarySpaceId,
      'PRIMARY',
      maxItems,
      scopedInputIds,
      undefined,
      undefined,
      client as pg.PoolClient,
      ctx
    );
    const primary = primaryDrain.summary;
    console.log(
      `[embeddings] primary batches finished batches=${primaryDrain.batches.length} processed=${primary.processed} succeeded=${primary.succeeded} failed=${primary.failed}`
    );

    let fallback: EmbeddingBatchSummary | undefined;
    if (primary.failedInputIds.length > 0) {
      const fallbackBatches: EmbeddingBatchSummary[] = [];
      const failedByPrimaryBatch = new Map<string, string[]>();
      for (const batch of primaryDrain.batches) {
        if (!batch.batchId || batch.failedInputIds.length === 0) {
          continue;
        }
        failedByPrimaryBatch.set(batch.batchId, batch.failedInputIds);
      }

      // Fallback is deliberately restricted to the inputs that failed in the
      // corresponding primary batch. It must never widen to the active corpus.
      for (const [primaryBatchId, failedInputIds] of failedByPrimaryBatch) {
        console.log(
          `[embeddings] draining fallback batches primary_batch_id=${primaryBatchId} input_count=${failedInputIds.length}`
        );
        const fallbackDrain = await drainEmbeddingBatches(
          seeded.fallbackSpaceId,
          'FALLBACK',
          maxItems,
          failedInputIds,
          primaryBatchId,
          primaryBatchId,
          client as pg.PoolClient,
          ctx
        );
        fallbackBatches.push(...fallbackDrain.batches);
        if (fallbackDrain.batches.length === 0) {
          // Preserve the fact that fallback was required even when all failed
          // inputs were already published by an earlier fallback run.
          fallbackBatches.push(emptyBatchSummary(seeded.fallbackSpaceId, 'FALLBACK'));
        }
      }
      fallback = mergeBatchSummaries(fallbackBatches, seeded.fallbackSpaceId, 'FALLBACK');
      console.log(
        `[embeddings] fallback batches finished batches=${fallbackBatches.length} processed=${fallback.processed} succeeded=${fallback.succeeded} failed=${fallback.failed}`
      );
    }

    return {
      seededSpaces: seeded,
      inputBuild,
      primary,
      fallback,
    };
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}