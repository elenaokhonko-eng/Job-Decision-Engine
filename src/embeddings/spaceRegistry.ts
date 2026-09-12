import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { pgPoolConfig } from '../db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface SeedEmbeddingSpacesResult {
  primarySpaceId: string;
  fallbackSpaceId: string;
}

type PgQueryable = pg.Pool | pg.PoolClient | pg.Client;

function stableSpaceKey(prefix: string, parts: string[]): string {
  const fingerprint = crypto
    .createHash('sha256')
    .update(parts.map((p) => p.trim()).join('|'))
    .digest('hex')
    .slice(0, 12);
  return `${prefix}_${fingerprint}`;
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
  const normalizedProvider = params.provider.trim().toLowerCase();
  const normalizedModel = params.model.trim();

  const inserted = await client.query<{ id: string }>(
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
     DO NOTHING
     RETURNING id`,
    [
      params.workspaceId,
      params.spaceKey,
      normalizedProvider,
      normalizedModel,
      params.dimensions,
      params.normalization,
      params.distanceMetric,
      params.isFallback,
    ]
  );

  if (inserted.rows.length > 0) {
    return inserted.rows[0].id;
  }

  const existing = await client.query<{
    id: string;
    provider: string;
    model: string;
    dimensions: number;
    normalization: string;
    distance_metric: string;
    is_fallback_space: boolean;
    active: boolean;
  }>(
    `SELECT id, provider, model, dimensions, normalization, distance_metric, is_fallback_space, active
     FROM embedding_spaces
     WHERE workspace_id = $1
       AND space_key = $2
     LIMIT 1`,
    [params.workspaceId, params.spaceKey]
  );

  if (existing.rows.length === 0) {
    throw new Error(`Embedding space insert unexpectedly conflicted but no row found for key ${params.spaceKey}.`);
  }

  const row = existing.rows[0];
  const mismatches: string[] = [];
  if ((row.provider || '').trim().toLowerCase() !== normalizedProvider) {
    mismatches.push(`provider=${row.provider} expected=${normalizedProvider}`);
  }
  if ((row.model || '').trim() !== normalizedModel) {
    mismatches.push(`model=${row.model} expected=${normalizedModel}`);
  }
  if (Number(row.dimensions) !== Number(params.dimensions)) {
    mismatches.push(`dimensions=${row.dimensions} expected=${params.dimensions}`);
  }
  if ((row.normalization || '').trim() !== params.normalization) {
    mismatches.push(`normalization=${row.normalization} expected=${params.normalization}`);
  }
  if ((row.distance_metric || '').trim() !== params.distanceMetric) {
    mismatches.push(`distance_metric=${row.distance_metric} expected=${params.distanceMetric}`);
  }
  if (Boolean(row.is_fallback_space) !== Boolean(params.isFallback)) {
    mismatches.push(`is_fallback_space=${row.is_fallback_space} expected=${params.isFallback}`);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Embedding space ${params.spaceKey} already exists with different configuration (${mismatches.join(
        ' | '
      )}). Create a new space_key to change embedding model/provider/dimensions; do not mutate an existing space.`
    );
  }

  if (!row.active) {
    await client.query(
      `UPDATE embedding_spaces
       SET active = TRUE
       WHERE workspace_id = $1 AND id = $2`,
      [params.workspaceId, row.id]
    );
  }

  return row.id;
}

export async function seedEmbeddingSpaces(
  clientOrPool?: PgQueryable,
  options?: { context?: WorkspaceContext }
): Promise<SeedEmbeddingSpacesResult> {
  const pool = clientOrPool || defaultPool;
  const maybe = pool as any;
  const ownsClient =
    pool instanceof pg.Pool ||
    (typeof maybe?.connect === 'function' &&
      typeof maybe?.query === 'function' &&
      'totalCount' in maybe &&
      'idleCount' in maybe &&
      'waitingCount' in maybe) ||
    (typeof maybe?.connect === 'function' &&
      typeof maybe?.query !== 'function' &&
      typeof maybe?.release !== 'function');
  const client = ownsClient ? await pool.connect() : pool;

  const primaryProvider = process.env.EMBEDDING_PRIMARY_PROVIDER || 'gemini';
  const fallbackProvider = process.env.EMBEDDING_FALLBACK_PROVIDER || 'openai';
  const primaryModel = process.env.EMBEDDING_PRIMARY_MODEL || 'gemini-embedding-001';
  const fallbackModel = process.env.EMBEDDING_FALLBACK_MODEL || 'text-embedding-3-small';
  const primaryDimensions = Number(process.env.EMBEDDING_PRIMARY_DIMENSIONS || 768);
  const fallbackDimensions = Number(process.env.EMBEDDING_FALLBACK_DIMENSIONS || 1536);
  const normalization = 'L2';
  const distanceMetric = 'COSINE';

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    await client.query('BEGIN');

    const primarySpaceKey = stableSpaceKey('primary', [
      primaryProvider,
      primaryModel,
      String(primaryDimensions),
      normalization,
      distanceMetric,
    ]);
    const fallbackSpaceKey = stableSpaceKey('fallback', [
      fallbackProvider,
      fallbackModel,
      String(fallbackDimensions),
      normalization,
      distanceMetric,
    ]);

    const primarySpaceId = await upsertSpace(client, {
      workspaceId: ctx.workspaceId,
      spaceKey: primarySpaceKey,
      provider: primaryProvider,
      model: primaryModel,
      dimensions: primaryDimensions,
      normalization,
      distanceMetric,
      isFallback: false,
    });

    const fallbackSpaceId = await upsertSpace(client, {
      workspaceId: ctx.workspaceId,
      spaceKey: fallbackSpaceKey,
      provider: fallbackProvider,
      model: fallbackModel,
      dimensions: fallbackDimensions,
      normalization,
      distanceMetric,
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
    if (ownsClient && typeof (client as pg.PoolClient).release === 'function') {
      (client as pg.PoolClient).release();
    }
  }
}
