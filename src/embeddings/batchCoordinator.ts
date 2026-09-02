import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';
import { generateEmbedding } from '../services/agent.js';
import { validateEmbeddingVector } from './batchValidator.js';

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
  errors: string[];
}

interface InputRow {
  id: string;
  content_text: string;
}

interface SpaceRow {
  id: string;
  dimensions: number;
}

export async function runEmbeddingBatch(
  embeddingSpaceId: string,
  batchKey: string,
  runType: 'PRIMARY' | 'FALLBACK' = 'PRIMARY',
  maxItems = 50,
  clientOrPool?: pg.Pool | pg.PoolClient
): Promise<EmbeddingBatchSummary> {
  const pool = clientOrPool || defaultPool;
  const client = 'connect' in pool ? await pool.connect() : pool;

  const errors: string[] = [];

  try {
    await client.query('BEGIN');

    const spaceRes = await client.query<SpaceRow>(
      `SELECT id, dimensions
       FROM embedding_spaces
       WHERE id = $1 AND active = TRUE
       LIMIT 1`,
      [embeddingSpaceId]
    );
    if (spaceRes.rows.length === 0) {
      throw new Error(`Embedding space not found or inactive: ${embeddingSpaceId}`);
    }
    const space = spaceRes.rows[0];

    const batchRes = await client.query<{ id: string }>(
      `INSERT INTO embedding_batches (
         embedding_space_id,
         batch_key,
         run_type,
         status,
         item_count,
         success_count,
         failure_count
       )
       VALUES ($1, $2, $3, 'RUNNING', 0, 0, 0)
       RETURNING id`,
      [space.id, batchKey, runType]
    );
    const batchId = batchRes.rows[0].id;

    const inputRes = await client.query<InputRow>(
      `SELECT ei.id, ei.content_text
       FROM embedding_inputs ei
       WHERE NOT EXISTS (
         SELECT 1
         FROM semantic_embeddings se
         WHERE se.embedding_space_id = $1
           AND se.embedding_input_id = ei.id
       )
       ORDER BY ei.created_at ASC
       LIMIT $2`,
      [space.id, maxItems]
    );

    let succeeded = 0;
    let failed = 0;

    for (const input of inputRes.rows) {
      try {
        const vector = await generateEmbedding(input.content_text);
        const validation = validateEmbeddingVector(vector, space.dimensions);
        if (!validation.valid) {
          failed += 1;
          errors.push(`input ${input.id}: ${validation.issues.join('; ')}`);
          continue;
        }

        await client.query(
          `INSERT INTO semantic_embeddings (
             embedding_space_id,
             embedding_input_id,
             embedding_batch_id,
             vector_dimensions,
             embedding_values,
             vector_checksum
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (embedding_space_id, embedding_input_id)
           DO NOTHING`,
          [
            space.id,
            input.id,
            batchId,
            validation.dimensions,
            vector,
            validation.checksum,
          ]
        );

        succeeded += 1;
      } catch (error) {
        failed += 1;
        errors.push(`input ${input.id}: ${error instanceof Error ? error.message : String(error)}`);
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
       WHERE id = $1`,
      [
        batchId,
        failed > 0 ? 'FAILED' : 'COMPLETED',
        inputRes.rows.length,
        succeeded,
        failed,
        errors.length > 0 ? errors.join(' | ') : null,
      ]
    );

    await client.query('COMMIT');

    return {
      batchId,
      embeddingSpaceId: space.id,
      processed: inputRes.rows.length,
      succeeded,
      failed,
      errors,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if ('release' in client && typeof client.release === 'function') {
      client.release();
    }
  }
}
