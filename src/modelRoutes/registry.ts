import pg from "pg";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

export type ModelRoutePurpose = "EVALUATION" | "EMBEDDING" | "DOCUMENT" | "EXTRACTION";

export type ModelRouteProvider = "gemini" | "openai";

type PgQueryable = pg.Pool | pg.PoolClient | pg.Client;

export interface ModelRouteRevisionContent {
  primary_provider: ModelRouteProvider;
  primary_model: string;
  fallback_provider: ModelRouteProvider;
  fallback_model: string;
}

export interface ActiveModelRouteRevision {
  routeId: string;
  routeKey: string;
  purpose: ModelRoutePurpose;
  revisionId: string;
  revisionNumber: number;
  contentHash: string;
  content: ModelRouteRevisionContent;
  activatedAt: string;
}

function asPurpose(value: string): ModelRoutePurpose {
  const normalized = (value || "").toUpperCase();
  if (
    normalized === "EVALUATION" ||
    normalized === "EMBEDDING" ||
    normalized === "DOCUMENT" ||
    normalized === "EXTRACTION"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported model route purpose: ${value}`);
}

function asProvider(value: string): ModelRouteProvider {
  const normalized = (value || "").toLowerCase();
  if (normalized === "gemini" || normalized === "openai") {
    return normalized;
  }
  throw new Error(`Unsupported model provider: ${value}`);
}

function normalizeRouteContent(input: ModelRouteRevisionContent): ModelRouteRevisionContent {
  return {
    primary_provider: asProvider(input.primary_provider),
    primary_model: String(input.primary_model || "").trim(),
    fallback_provider: asProvider(input.fallback_provider),
    fallback_model: String(input.fallback_model || "").trim(),
  };
}

export async function ensureModelRouteActiveRevision(
  input: {
    routeKey: string;
    purpose: ModelRoutePurpose;
    description?: string;
    content: ModelRouteRevisionContent;
    note?: string;
  },
  clientOrPool: PgQueryable,
  options?: { context?: WorkspaceContext }
): Promise<ActiveModelRouteRevision> {
  const isPool = (value: PgQueryable): value is pg.Pool => {
    const maybe = value as any;
    return (
      value instanceof pg.Pool ||
      (typeof maybe?.connect === "function" &&
        typeof maybe?.query === "function" &&
        "totalCount" in maybe &&
        "idleCount" in maybe &&
        "waitingCount" in maybe) ||
      // Small pool-shaped test doubles expose connect but not query. A pg.Client
      // has query and is therefore deliberately excluded here.
      (typeof maybe?.connect === "function" &&
        typeof maybe?.query !== "function" &&
        typeof maybe?.release !== "function")
    );
  };
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  const routeKey = String(input.routeKey || "").trim();
  if (!routeKey) {
    throw new Error("routeKey is required to ensure a model route revision.");
  }

  const normalizedContent = normalizeRouteContent(input.content);
  if (!normalizedContent.primary_model || !normalizedContent.fallback_model) {
    throw new Error(`Model route ${routeKey} requires both primary_model and fallback_model.`);
  }

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const purpose = asPurpose(input.purpose);

    const contentHash = sha256Hex(stableStringify(normalizedContent));

    await client.query("BEGIN");
    try {
      const routeRes = await client.query<{ id: string }>(
        `
          INSERT INTO model_routes (
            workspace_id,
            route_key,
            purpose,
            status,
            description,
            created_by_user_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'ACTIVE', $4, $5, NOW(), NOW())
          ON CONFLICT (workspace_id, route_key)
          DO UPDATE SET
            purpose = EXCLUDED.purpose,
            status = 'ACTIVE',
            description = COALESCE(EXCLUDED.description, model_routes.description),
            updated_at = NOW()
          RETURNING id
        `,
        [ctx.workspaceId, routeKey, purpose, input.description ?? null, ctx.userId]
      );

      const routeId = routeRes.rows[0].id;

      const existingRev = await client.query<{ id: string; revision_number: number }>(
        `
          SELECT id, revision_number
          FROM model_route_revisions
          WHERE model_route_id = $1
            AND content_hash = $2
          LIMIT 1
        `,
        [routeId, contentHash]
      );

      let revisionId: string;
      let revisionNumber: number;
      if (existingRev.rows.length > 0) {
        revisionId = existingRev.rows[0].id;
        revisionNumber = existingRev.rows[0].revision_number;
      } else {
        const nextRes = await client.query<{ next: number }>(
          `
            SELECT COALESCE(MAX(revision_number), 0)::int + 1 AS next
            FROM model_route_revisions
            WHERE model_route_id = $1
          `,
          [routeId]
        );
        revisionNumber = nextRes.rows[0].next;

        const insertRev = await client.query<{ id: string }>(
          `
            INSERT INTO model_route_revisions (
              model_route_id,
              revision_number,
              schema_version,
              content_hash,
              content,
              created_by_user_id,
              created_at
            )
            VALUES ($1, $2, '2.2.0', $3, $4, $5, NOW())
            RETURNING id
          `,
          [routeId, revisionNumber, contentHash, normalizedContent as any, ctx.userId]
        );
        revisionId = insertRev.rows[0].id;
      }

      const currentActive = await client.query<{ model_route_revision_id: string }>(
        `
          SELECT model_route_revision_id
          FROM model_route_active_revisions
          WHERE model_route_id = $1
          LIMIT 1
        `,
        [routeId]
      );

      const currentRevisionId = currentActive.rows[0]?.model_route_revision_id ?? null;
      const needsActivation = !currentRevisionId || currentRevisionId !== revisionId;

      if (!currentRevisionId) {
        await client.query(
          `
            INSERT INTO model_route_active_revisions (
              model_route_id,
              model_route_revision_id,
              activated_by_user_id,
              activated_at
            )
            VALUES ($1, $2, $3, NOW())
          `,
          [routeId, revisionId, ctx.userId]
        );
      } else if (needsActivation) {
        await client.query(
          `
            UPDATE model_route_active_revisions
            SET model_route_revision_id = $2,
                activated_by_user_id = $3,
                activated_at = NOW()
            WHERE model_route_id = $1
          `,
          [routeId, revisionId, ctx.userId]
        );
      }

      if (needsActivation) {
        await client.query(
          `
            INSERT INTO model_route_activation_events (
              model_route_id,
              from_revision_id,
              to_revision_id,
              activated_by_user_id,
              activated_at,
              note
            )
            VALUES ($1, $2, $3, $4, NOW(), $5)
          `,
          [routeId, currentRevisionId, revisionId, ctx.userId, input.note ?? null]
        );
      }

      await client.query("COMMIT");

      const activatedAt = new Date().toISOString();
      return {
        routeId,
        routeKey,
        purpose,
        revisionId,
        revisionNumber,
        contentHash,
        content: normalizedContent,
        activatedAt,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export async function getActiveModelRouteRevision(
  routeKey: string,
  clientOrPool: PgQueryable,
  options?: { context?: WorkspaceContext }
): Promise<ActiveModelRouteRevision | null> {
  const isPool = (value: PgQueryable): value is pg.Pool => {
    const maybe = value as any;
    return (
      value instanceof pg.Pool ||
      (typeof maybe?.connect === "function" &&
        typeof maybe?.query === "function" &&
        "totalCount" in maybe &&
        "idleCount" in maybe &&
        "waitingCount" in maybe) ||
      (typeof maybe?.connect === "function" &&
        typeof maybe?.query !== "function" &&
        typeof maybe?.release !== "function")
    );
  };
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const res = await client.query<{
      route_id: string;
      route_key: string;
      purpose: string;
      revision_id: string;
      revision_number: number;
      content_hash: string;
      content: any;
      activated_at: string;
    }>(
      `
        SELECT
          mr.id AS route_id,
          mr.route_key,
          mr.purpose,
          mrr.id AS revision_id,
          mrr.revision_number,
          mrr.content_hash,
          mrr.content,
          mar.activated_at
        FROM model_routes mr
        JOIN model_route_active_revisions mar
          ON mar.model_route_id = mr.id
        JOIN model_route_revisions mrr
          ON mrr.id = mar.model_route_revision_id
        WHERE mr.workspace_id = $1
          AND mr.route_key = $2
          AND mr.status = 'ACTIVE'
        LIMIT 1
      `,
      [ctx.workspaceId, routeKey]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return {
      routeId: row.route_id,
      routeKey: row.route_key,
      purpose: asPurpose(row.purpose),
      revisionId: row.revision_id,
      revisionNumber: Number(row.revision_number),
      contentHash: row.content_hash,
      content: normalizeRouteContent(row.content as ModelRouteRevisionContent),
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

export async function recordModelRouteInvocation(
  input: {
    routeId?: string | null;
    revisionId?: string | null;
    purpose: ModelRoutePurpose;
    provider?: string | null;
    model?: string | null;
    status: "COMPLETED" | "FAILED";
    fallbackUsed?: boolean;
    requestHash: string;
    requestMetadata?: Record<string, unknown> | null;
    responseMetadata?: Record<string, unknown> | null;
    latencyMs?: number | null;
    costUsd?: number | null;
    tokensPrompt?: number | null;
    tokensCompletion?: number | null;
    tokensTotal?: number | null;
    errorMessage?: string | null;
  },
  clientOrPool: PgQueryable,
  options?: { context?: WorkspaceContext }
): Promise<string | null> {
  const isPool = (value: PgQueryable): value is pg.Pool => {
    const maybe = value as any;
    return (
      value instanceof pg.Pool ||
      (typeof maybe?.connect === "function" &&
        typeof maybe?.query === "function" &&
        "totalCount" in maybe &&
        "idleCount" in maybe &&
        "waitingCount" in maybe) ||
      (typeof maybe?.connect === "function" &&
        typeof maybe?.query !== "function" &&
        typeof maybe?.release !== "function")
    );
  };
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const res = await client.query<{ id: string }>(
      `
        INSERT INTO model_route_invocations (
          workspace_id,
          model_route_id,
          model_route_revision_id,
          purpose,
          provider,
          model,
          status,
          fallback_used,
          request_hash,
          request_metadata,
          response_metadata,
          latency_ms,
          cost_usd,
          tokens_prompt,
          tokens_completion,
          tokens_total,
          error_message,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
        RETURNING id
      `,
      [
        ctx.workspaceId,
        input.routeId ?? null,
        input.revisionId ?? null,
        input.purpose,
        input.provider ?? null,
        input.model ?? null,
        input.status,
        input.fallbackUsed === true,
        input.requestHash,
        input.requestMetadata ?? null,
        input.responseMetadata ?? null,
        input.latencyMs ?? null,
        input.costUsd ?? null,
        input.tokensPrompt ?? null,
        input.tokensCompletion ?? null,
        input.tokensTotal ?? null,
        input.errorMessage ?? null,
      ]
    );
    return res.rows[0].id;
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
