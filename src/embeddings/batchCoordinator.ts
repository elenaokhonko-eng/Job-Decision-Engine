import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';
import { generateEmbedding } from '../services/agent.js';
import { validateEmbeddingVector } from './batchValidator.js';
import { buildEmbeddingInputs } from './inputBuilder.js';
import { seedEmbeddingSpaces } from './spaceRegistry.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface EmbeddingBatchSummary {
  batchId: string;
  embeddingSpaceId: string;
  processed: number;
  succeeded: number;
  failed: number;
  failedInputIds: string[];
  runType: 'PRIMARY' | 'FALLBACK';
  errors: string[];
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
  };
  primary: EmbeddingBatchSummary;
  fallback?: EmbeddingBatchSummary;
}

interface InputRow {
  id: string;
  content_text: string;
}

interface SpaceRow {
  id: string;
  workspace_id: string;
  dimensions: number;
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
  options?: { context?: WorkspaceContext }
): Promise<EmbeddingBatchSummary> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  const errors: string[] = [];

  try {
    await client.query('BEGIN');

    const spaceRes = await client.query<SpaceRow>(
      `SELECT id, workspace_id, dimensions
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
    if (options?.context && options.context.workspaceId !== workspaceId) {
      throw new Error(
        `Embedding space ${space.id} is in workspace_id=${workspaceId} but context.workspaceId=${options.context.workspaceId}`
      );
    }

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
    const batchId = batchRes.rows[0].id;

    const inputRes = inputIds && inputIds.length > 0
      ? await client.query<InputRow>(
          `SELECT ei.id, ei.content_text
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND ei.id = ANY($2::uuid[])
           ORDER BY ei.created_at ASC`,
          [workspaceId, inputIds]
        )
      : await client.query<InputRow>(
          `SELECT ei.id, ei.content_text
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND NOT EXISTS (
             SELECT 1
             FROM semantic_embeddings se
             WHERE se.workspace_id = $1
               AND se.embedding_space_id = $2
               AND se.embedding_input_id = ei.id
           )
           ORDER BY ei.created_at ASC
           LIMIT $3`,
          [workspaceId, space.id, maxItems]
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

    let succeeded = 0;
    let failed = 0;
    const failedInputIds: string[] = [];

    for (const input of inputRes.rows) {
      try {
        const vector = await generateEmbedding(input.content_text);
        const validation = validateEmbeddingVector(vector, space.dimensions);
        if (!validation.valid) {
          failed += 1;
          failedInputIds.push(input.id);
          errors.push(`input ${input.id}: ${validation.issues.join('; ')}`);
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

        succeeded += 1;
        await client.query(
          `UPDATE embedding_batch_items
           SET status = 'COMPLETED',
               error_message = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`,
          [workspaceId, batchId, input.id]
        );
      } catch (error) {
        failed += 1;
        failedInputIds.push(input.id);
        errors.push(`input ${input.id}: ${error instanceof Error ? error.message : String(error)}`);
        await client.query(
          `UPDATE embedding_batch_items
           SET status = 'FAILED',
               error_message = $4,
               updated_at = NOW()
           WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`,
          [workspaceId, batchId, input.id, error instanceof Error ? error.message : String(error)]
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

    await client.query('COMMIT');

    return {
      batchId,
      embeddingSpaceId: space.id,
      processed: inputRes.rows.length,
      succeeded,
      failed,
      failedInputIds,
      runType,
      errors,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}

export async function runEmbeddingBatchWithFallback(
  maxItems = 100,
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<EmbeddingFallbackSummary> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const seeded = await seedEmbeddingSpaces(client as pg.PoolClient, { context: ctx });
    const inputBuild = await buildEmbeddingInputs(client as pg.PoolClient, maxItems, { context: ctx });

    const primary = await runEmbeddingBatch(
      seeded.primarySpaceId,
      `primary-${Date.now()}`,
      'PRIMARY',
      maxItems,
      undefined,
      undefined,
      undefined,
      client as pg.PoolClient,
      { context: ctx }
    );

    let fallback: EmbeddingBatchSummary | undefined;
    if (primary.failedInputIds.length > 0) {
      fallback = await runEmbeddingBatch(
        seeded.fallbackSpaceId,
        `fallback-${Date.now()}`,
        'FALLBACK',
        maxItems,
        primary.failedInputIds,
        primary.batchId,
        undefined,
        client as pg.PoolClient,
        { context: ctx }
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
