import pg from "pg";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

export type DocumentTemplateType = "CV" | "COVER_LETTER";

export interface DocumentTemplatePluginRevisionContent {
  prompt_preamble?: string | null;
  system_instruction?: string | null;
  model_route_key?: string | null;
}

export interface ActiveDocumentTemplatePluginRevision {
  pluginId: string;
  pluginKey: string;
  documentType: DocumentTemplateType;
  revisionId: string;
  revisionNumber: number;
  contentHash: string;
  content: DocumentTemplatePluginRevisionContent;
  activatedAt: string;
}

export async function getActiveDocumentTemplatePluginRevision(
  documentType: DocumentTemplateType,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ActiveDocumentTemplatePluginRevision | null> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    const res = await client.query<{
      plugin_id: string;
      plugin_key: string;
      document_type: string;
      revision_id: string;
      revision_number: number;
      content_hash: string;
      content: any;
      activated_at: string;
    }>(
      `
        SELECT
          p.id AS plugin_id,
          p.plugin_key,
          p.document_type,
          r.id AS revision_id,
          r.revision_number,
          r.content_hash,
          r.content,
          ar.activated_at
        FROM document_template_plugins p
        JOIN document_template_plugin_active_revisions ar
          ON ar.plugin_id = p.id
        JOIN document_template_plugin_revisions r
          ON r.id = ar.plugin_revision_id
        WHERE p.workspace_id = $1
          AND p.document_type = $2
          AND p.status = 'ACTIVE'
        ORDER BY ar.activated_at DESC
        LIMIT 1
      `,
      [ctx.workspaceId, documentType]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return {
      pluginId: row.plugin_id,
      pluginKey: row.plugin_key,
      documentType: row.document_type as DocumentTemplateType,
      revisionId: row.revision_id,
      revisionNumber: Number(row.revision_number),
      contentHash: row.content_hash,
      content: row.content as DocumentTemplatePluginRevisionContent,
      activatedAt: row.activated_at,
    };
  } catch (error: any) {
    if (error?.code === "42P01") {
      return null;
    }
    throw error;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

