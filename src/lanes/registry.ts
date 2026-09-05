import pg from 'pg';
import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { LaneFileConfigSchema, type LaneFileConfig } from './contracts.js';

type QueryClient = {
  query: pg.PoolClient['query'];
};

export interface ActiveLaneRevision {
  laneIdentityId: string;
  laneRevisionId: string;
  laneKey: string;
  status: 'ACTIVE' | 'INACTIVE';
  revisionNumber: number;
  contentHash: string;
  content: LaneFileConfig;
  activatedAt: string;
}

export async function listActiveLaneRevisions(
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ActiveLaneRevision[]> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    const { rows } = await (client as QueryClient).query<{
      lane_identity_id: string;
      lane_revision_id: string;
      lane_key: string;
      status: 'ACTIVE' | 'INACTIVE';
      revision_number: number;
      content_hash: string;
      content: unknown;
      activated_at: string;
    }>(
      `
        SELECT
          li.id AS lane_identity_id,
          lr.id AS lane_revision_id,
          li.lane_key AS lane_key,
          li.status AS status,
          lr.revision_number AS revision_number,
          lr.content_hash AS content_hash,
          lr.content AS content,
          lar.activated_at AS activated_at
        FROM lane_identities li
        JOIN lane_active_revisions lar ON lar.lane_identity_id = li.id
        JOIN lane_revisions lr ON lr.id = lar.lane_revision_id
        WHERE li.workspace_id = $1
          AND li.status = 'ACTIVE'
        ORDER BY li.lane_key ASC
      `,
      [ctx.workspaceId]
    );

    return rows.map((r) => ({
      laneIdentityId: r.lane_identity_id,
      laneRevisionId: r.lane_revision_id,
      laneKey: r.lane_key,
      status: r.status,
      revisionNumber: r.revision_number,
      contentHash: r.content_hash,
      content: LaneFileConfigSchema.parse(r.content),
      activatedAt: r.activated_at,
    }));
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

export interface UpsertLaneRevisionInput {
  laneKey: string;
  content: unknown;
  schemaVersion?: string;
}

export interface UpsertLaneRevisionOptions {
  context?: WorkspaceContext;
  activate?: boolean;
  note?: string;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface UpsertLaneRevisionResult {
  laneIdentityId: string;
  laneRevisionId: string;
  revisionNumber: number;
  contentHash: string;
  activated: boolean;
  inserted: boolean;
}

export async function upsertLaneRevision(
  input: UpsertLaneRevisionInput,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: UpsertLaneRevisionOptions
): Promise<UpsertLaneRevisionResult> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  const activate = options?.activate !== false;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const parsed = LaneFileConfigSchema.parse(input.content);

    const canonicalJson = stableStringify(parsed);
    const contentHash = sha256Hex(canonicalJson);

    await client.query('BEGIN');

    const identityRes = await (client as QueryClient).query<{ id: string }>(
      `
        INSERT INTO lane_identities (
          workspace_id,
          lane_key,
          status,
          created_by_user_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (workspace_id, lane_key)
        DO UPDATE SET
          status = COALESCE(EXCLUDED.status, lane_identities.status),
          updated_at = NOW()
        RETURNING id
      `,
      [ctx.workspaceId, input.laneKey, options?.status ?? 'ACTIVE', ctx.userId]
    );
    const laneIdentityId = identityRes.rows[0].id;

    const existing = await (client as QueryClient).query<{
      id: string;
      revision_number: number;
    }>(
      `
        SELECT id, revision_number
        FROM lane_revisions
        WHERE lane_identity_id = $1
          AND content_hash = $2
        LIMIT 1
      `,
      [laneIdentityId, contentHash]
    );

    let laneRevisionId: string;
    let revisionNumber: number;
    let inserted = false;

    if (existing.rows.length > 0) {
      laneRevisionId = existing.rows[0].id;
      revisionNumber = existing.rows[0].revision_number;
    } else {
      const nextRes = await (client as QueryClient).query<{ next: number }>(
        `
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
          FROM lane_revisions
          WHERE lane_identity_id = $1
        `,
        [laneIdentityId]
      );
      revisionNumber = nextRes.rows[0].next;

      const revRes = await (client as QueryClient).query<{ id: string }>(
        `
          INSERT INTO lane_revisions (
            lane_identity_id,
            revision_number,
            schema_version,
            content_hash,
            content,
            created_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `,
        [
          laneIdentityId,
          revisionNumber,
          input.schemaVersion ?? '2.2.0',
          contentHash,
          parsed as any,
          ctx.userId,
        ]
      );
      laneRevisionId = revRes.rows[0].id;
      inserted = true;
    }

    let activated = false;

    if (activate) {
      const prev = await (client as QueryClient).query<{ lane_revision_id: string }>(
        `
          SELECT lane_revision_id
          FROM lane_active_revisions
          WHERE lane_identity_id = $1
          LIMIT 1
        `,
        [laneIdentityId]
      );
      const fromRevisionId = prev.rows[0]?.lane_revision_id ?? null;

      await (client as QueryClient).query(
        `
          INSERT INTO lane_active_revisions (
            lane_identity_id,
            lane_revision_id,
            activated_by_user_id,
            activated_at
          )
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (lane_identity_id)
          DO UPDATE SET
            lane_revision_id = EXCLUDED.lane_revision_id,
            activated_by_user_id = EXCLUDED.activated_by_user_id,
            activated_at = NOW()
        `,
        [laneIdentityId, laneRevisionId, ctx.userId]
      );

      if (fromRevisionId !== laneRevisionId) {
        await (client as QueryClient).query(
          `
            INSERT INTO lane_activation_events (
              lane_identity_id,
              from_revision_id,
              to_revision_id,
              activated_by_user_id,
              activated_at,
              note
            )
            VALUES ($1, $2, $3, $4, NOW(), $5)
          `,
          [laneIdentityId, fromRevisionId, laneRevisionId, ctx.userId, options?.note ?? null]
        );
      }

      activated = true;
    }

    await client.query('COMMIT');

    return {
      laneIdentityId,
      laneRevisionId,
      revisionNumber,
      contentHash,
      activated,
      inserted,
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

export async function deactivateLane(
  laneKey: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<boolean> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const res = await (client as QueryClient).query(
      `
        UPDATE lane_identities
        SET status = 'INACTIVE',
            updated_at = NOW()
        WHERE workspace_id = $1
          AND lane_key = $2
          AND status <> 'INACTIVE'
      `,
      [ctx.workspaceId, laneKey]
    );
    return (res.rowCount ?? 0) > 0;
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

export async function cloneLane(
  fromLaneKey: string,
  toLaneKey: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    note?: string;
    displayName?: string;
  }
): Promise<UpsertLaneRevisionResult> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const active = await listActiveLaneRevisions(client as any, { context: ctx });
    const from = active.find((a) => a.laneKey === fromLaneKey);
    if (!from) {
      throw new Error(`Cannot clone lane: no ACTIVE lane found for key ${fromLaneKey}`);
    }

    const content: LaneFileConfig = {
      ...from.content,
      lane_key: toLaneKey,
      display_name: options?.displayName ?? `Copy of ${from.content.display_name}`,
    };

    return await upsertLaneRevision(
      {
        laneKey: toLaneKey,
        content,
      },
      client as any,
      { context: ctx, note: options?.note ?? `cloned_from:${fromLaneKey}` }
    );
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

