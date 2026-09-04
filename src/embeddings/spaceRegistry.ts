import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface SeedEmbeddingSpacesResult {
  primarySpaceId: string;
  fallbackSpaceId: string;
}

async function upsertSpace(
  client: { query: pg.PoolClient['query'] },
  params: {
    workspaceId: string;
    spaceKey: string;
    provider: string;
    model: string;
    dimensions: number;
    normalization: string;
    distanceMetric: string;
    isFallback: boolean;
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO embedding_spaces (
       workspace_id,
       space_key,
       provider,
       model,
       dimensions,
       normalization,
       distance_metric,
       is_fallback_space,
       active
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
     ON CONFLICT (workspace_id, space_key)
     DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       dimensions = EXCLUDED.dimensions,
       normalization = EXCLUDED.normalization,
       distance_metric = EXCLUDED.distance_metric,
       is_fallback_space = EXCLUDED.is_fallback_space,
       active = TRUE
     RETURNING id`,
    [
      params.workspaceId,
      params.spaceKey,
      params.provider,
      params.model,
      params.dimensions,
      params.normalization,
      params.distanceMetric,
      params.isFallback,
    ]
  );

  return res.rows[0].id;
}

export async function seedEmbeddingSpaces(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<SeedEmbeddingSpacesResult> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  const primaryProvider = process.env.EMBEDDING_PRIMARY_PROVIDER || 'gemini';
  const fallbackProvider = process.env.EMBEDDING_FALLBACK_PROVIDER || 'openai';
  const primaryModel = process.env.EMBEDDING_PRIMARY_MODEL || 'text-embedding-004';
  const fallbackModel = process.env.EMBEDDING_FALLBACK_MODEL || 'text-embedding-3-small';
  const primaryDimensions = Number(process.env.EMBEDDING_PRIMARY_DIMENSIONS || 768);
  const fallbackDimensions = Number(process.env.EMBEDDING_FALLBACK_DIMENSIONS || 1536);

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    await client.query('BEGIN');

    const primarySpaceId = await upsertSpace(client, {
      workspaceId: ctx.workspaceId,
      spaceKey: 'phase3_primary',
      provider: primaryProvider,
      model: primaryModel,
      dimensions: primaryDimensions,
      normalization: 'L2',
      distanceMetric: 'COSINE',
      isFallback: false,
    });

    const fallbackSpaceId = await upsertSpace(client, {
      workspaceId: ctx.workspaceId,
      spaceKey: 'phase3_fallback',
      provider: fallbackProvider,
      model: fallbackModel,
      dimensions: fallbackDimensions,
      normalization: 'L2',
      distanceMetric: 'COSINE',
      isFallback: true,
    });

    await client.query('COMMIT');

    return {
      primarySpaceId,
      fallbackSpaceId,
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
