import pg from 'pg';
import { stableStringify, sha256Hex } from './structuredLoader.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';

type QueryClient = {
  query: pg.PoolClient['query'];
};

export interface UpsertConfigRevisionInput {
  configKey: string;
  configType: string;
  description?: string | null;
  schemaVersion?: string;
  content: unknown;
}

export interface UpsertConfigRevisionResult {
  configDefinitionId: string;
  configRevisionId: string;
  revisionNumber: number;
  contentHash: string;
  activated: boolean;
}

export interface UpsertConfigRevisionOptions {
  context?: WorkspaceContext;
  activate?: boolean;
  note?: string;
}

export interface ActiveConfigRevision {
  configDefinitionId: string;
  configRevisionId: string;
  revisionNumber: number;
  schemaVersion: string;
  contentHash: string;
  content: unknown;
}

export interface GetActiveConfigRevisionOptions {
  context?: WorkspaceContext;
}

export async function getActiveConfigRevision(
  configKey: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: GetActiveConfigRevisionOptions
): Promise<ActiveConfigRevision | null> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    const { rows } = await (client as QueryClient).query<{
      config_definition_id: string;
      config_revision_id: string;
      revision_number: number;
      schema_version: string;
      content_hash: string;
      content: unknown;
    }>(
      `
        SELECT
          cd.id AS config_definition_id,
          cr.id AS config_revision_id,
          cr.revision_number AS revision_number,
          cr.schema_version AS schema_version,
          cr.content_hash AS content_hash,
          cr.content AS content
        FROM config_definitions cd
        JOIN config_active_revisions car ON car.config_definition_id = cd.id
        JOIN config_revisions cr ON cr.id = car.config_revision_id
        WHERE cd.workspace_id = $1
          AND cd.config_key = $2
        LIMIT 1
      `,
      [ctx.workspaceId, configKey]
    );

    if (rows.length === 0) {
      return null;
    }

    return {
      configDefinitionId: rows[0].config_definition_id,
      configRevisionId: rows[0].config_revision_id,
      revisionNumber: rows[0].revision_number,
      schemaVersion: rows[0].schema_version,
      contentHash: rows[0].content_hash,
      content: rows[0].content,
    };
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

export async function upsertConfigRevision(
  input: UpsertConfigRevisionInput,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: UpsertConfigRevisionOptions
): Promise<UpsertConfigRevisionResult> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  const activate = options?.activate !== false;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    const canonicalJson = stableStringify(input.content);
    const contentHash = sha256Hex(canonicalJson);

    await client.query('BEGIN');

    const defRes = await (client as QueryClient).query<{ id: string }>(
      `INSERT INTO config_definitions (
         workspace_id,
         config_key,
         config_type,
         description,
         created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, config_key)
       DO UPDATE SET
         config_type = EXCLUDED.config_type,
         description = EXCLUDED.description,
         updated_at = NOW()
       RETURNING id`,
      [ctx.workspaceId, input.configKey, input.configType, input.description ?? null, ctx.userId]
    );

    const configDefinitionId = defRes.rows[0].id;

    const existingRevision = await (client as QueryClient).query<{
      id: string;
      revision_number: number;
    }>(
      `SELECT id, revision_number
       FROM config_revisions
       WHERE config_definition_id = $1
         AND content_hash = $2
       LIMIT 1`,
      [configDefinitionId, contentHash]
    );

    let configRevisionId: string;
    let revisionNumber: number;

    if (existingRevision.rows.length > 0) {
      configRevisionId = existingRevision.rows[0].id;
      revisionNumber = existingRevision.rows[0].revision_number;
    } else {
      const nextRes = await (client as QueryClient).query<{ next: number }>(
        `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
         FROM config_revisions
         WHERE config_definition_id = $1`,
        [configDefinitionId]
      );
      revisionNumber = nextRes.rows[0].next;

      const revRes = await (client as QueryClient).query<{ id: string }>(
        `INSERT INTO config_revisions (
           config_definition_id,
           revision_number,
           schema_version,
           content_hash,
           content,
           created_by_user_id
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          configDefinitionId,
          revisionNumber,
          input.schemaVersion ?? '2.2.0',
          contentHash,
          input.content as any,
          ctx.userId,
        ]
      );
      configRevisionId = revRes.rows[0].id;
    }

    let activated = false;

    if (activate) {
      const prev = await (client as QueryClient).query<{ config_revision_id: string }>(
        `SELECT config_revision_id
         FROM config_active_revisions
         WHERE config_definition_id = $1
         LIMIT 1`,
        [configDefinitionId]
      );
      const fromRevisionId = prev.rows[0]?.config_revision_id ?? null;

      await (client as QueryClient).query(
        `INSERT INTO config_active_revisions (
           config_definition_id,
           config_revision_id,
           activated_by_user_id,
           activated_at
         )
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (config_definition_id)
         DO UPDATE SET
           config_revision_id = EXCLUDED.config_revision_id,
           activated_by_user_id = EXCLUDED.activated_by_user_id,
           activated_at = NOW()`,
        [configDefinitionId, configRevisionId, ctx.userId]
      );

      if (fromRevisionId !== configRevisionId) {
        await (client as QueryClient).query(
          `INSERT INTO config_activation_events (
             config_definition_id,
             from_revision_id,
             to_revision_id,
             activated_by_user_id,
             activated_at,
             note
           )
           VALUES ($1, $2, $3, $4, NOW(), $5)`,
          [configDefinitionId, fromRevisionId, configRevisionId, ctx.userId, options?.note ?? null]
        );
      }

      activated = true;
    }

    await client.query('COMMIT');

    return {
      configDefinitionId,
      configRevisionId,
      revisionNumber,
      contentHash,
      activated,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}
