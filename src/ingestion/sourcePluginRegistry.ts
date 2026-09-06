import pg from "pg";
import type { SourcePlugin } from "../contracts/sourcePlugin.js";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

type QueryClient = {
  query: pg.PoolClient["query"];
};

export interface ActiveSourcePluginRevision {
  sourcePluginId: string;
  sourcePluginRevisionId: string;
  revisionNumber: number;
  schemaVersion: string;
  contentHash: string;
  content: SourcePlugin;
}

export interface GetActiveSourcePluginRevisionOptions {
  context?: WorkspaceContext;
}

export async function getActiveSourcePluginRevision(
  sourceKey: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: GetActiveSourcePluginRevisionOptions
): Promise<ActiveSourcePluginRevision | null> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    const { rows } = await (client as QueryClient).query<{
      source_plugin_id: string;
      source_plugin_revision_id: string;
      revision_number: number;
      schema_version: string;
      content_hash: string;
      content: any;
    }>(
      `
        SELECT
          sp.id AS source_plugin_id,
          spr.id AS source_plugin_revision_id,
          spr.revision_number AS revision_number,
          spr.schema_version AS schema_version,
          spr.content_hash AS content_hash,
          spr.content AS content
        FROM source_plugins sp
        JOIN source_plugin_active_revisions spar ON spar.source_plugin_id = sp.id
        JOIN source_plugin_revisions spr ON spr.id = spar.source_plugin_revision_id
        WHERE sp.workspace_id = $1
          AND sp.source_key = $2
        LIMIT 1
      `,
      [ctx.workspaceId, sourceKey]
    );

    if (rows.length === 0) {
      return null;
    }

    return {
      sourcePluginId: rows[0].source_plugin_id,
      sourcePluginRevisionId: rows[0].source_plugin_revision_id,
      revisionNumber: rows[0].revision_number,
      schemaVersion: rows[0].schema_version,
      contentHash: rows[0].content_hash,
      content: rows[0].content,
    };
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export interface UpsertSourcePluginRevisionResult {
  sourcePluginId: string;
  sourcePluginRevisionId: string;
  revisionNumber: number;
  contentHash: string;
  activated: boolean;
}

export interface UpsertSourcePluginRevisionOptions {
  context?: WorkspaceContext;
  activate?: boolean;
}

export async function upsertSourcePluginRevision(
  plugin: SourcePlugin,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: UpsertSourcePluginRevisionOptions
): Promise<UpsertSourcePluginRevisionResult> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  const activate = options?.activate !== false;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    const canonicalJson = stableStringify(plugin);
    const contentHash = sha256Hex(canonicalJson);

    await client.query("BEGIN");

    const defRes = await (client as QueryClient).query<{ id: string }>(
      `
        INSERT INTO source_plugins (
          workspace_id,
          source_key,
          display_name,
          kind,
          status,
          schema_version,
          created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (workspace_id, source_key)
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          schema_version = EXCLUDED.schema_version,
          updated_at = NOW()
        RETURNING id
      `,
      [
        ctx.workspaceId,
        plugin.source_key,
        plugin.display_name,
        plugin.kind,
        plugin.status,
        plugin.schema_version,
        ctx.userId,
      ]
    );

    const sourcePluginId = defRes.rows[0].id;

    const existing = await (client as QueryClient).query<{ id: string; revision_number: number }>(
      `
        SELECT id, revision_number
        FROM source_plugin_revisions
        WHERE source_plugin_id = $1
          AND content_hash = $2
        LIMIT 1
      `,
      [sourcePluginId, contentHash]
    );

    let sourcePluginRevisionId: string;
    let revisionNumber: number;

    if (existing.rows.length > 0) {
      sourcePluginRevisionId = existing.rows[0].id;
      revisionNumber = existing.rows[0].revision_number;
    } else {
      const nextRes = await (client as QueryClient).query<{ next: number }>(
        `
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
          FROM source_plugin_revisions
          WHERE source_plugin_id = $1
        `,
        [sourcePluginId]
      );
      revisionNumber = nextRes.rows[0].next;

      const revRes = await (client as QueryClient).query<{ id: string }>(
        `
          INSERT INTO source_plugin_revisions (
            source_plugin_id,
            revision_number,
            schema_version,
            content_hash,
            content,
            created_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `,
        [sourcePluginId, revisionNumber, plugin.schema_version, contentHash, plugin as any, ctx.userId]
      );
      sourcePluginRevisionId = revRes.rows[0].id;
    }

    let activated = false;
    if (activate) {
      await (client as QueryClient).query(
        `
          INSERT INTO source_plugin_active_revisions (
            source_plugin_id,
            source_plugin_revision_id,
            activated_by_user_id,
            activated_at
          )
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (source_plugin_id)
          DO UPDATE SET
            source_plugin_revision_id = EXCLUDED.source_plugin_revision_id,
            activated_by_user_id = EXCLUDED.activated_by_user_id,
            activated_at = NOW()
        `,
        [sourcePluginId, sourcePluginRevisionId, ctx.userId]
      );
      activated = true;
    }

    await client.query("COMMIT");

    return {
      sourcePluginId,
      sourcePluginRevisionId,
      revisionNumber,
      contentHash,
      activated,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

