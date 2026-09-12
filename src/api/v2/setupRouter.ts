import express from "express";
import pg from "pg";
import { isPooledPostgresConnectionString, pgConnectionConfig, pgPoolConfig } from "../../db/pgSsl.js";
import { getMigrationStatus, runMigrations } from "../../db/migrate.js";
import { seedEmbeddingSpaces } from "../../embeddings/spaceRegistry.js";
import {
  ensureModelRouteActiveRevision,
  getActiveModelRouteRevision,
  type ModelRoutePurpose,
} from "../../modelRoutes/registry.js";
import { DEFAULT_USER_KEY, DEFAULT_WORKSPACE_KEY, resolveWorkspaceContext } from "../../workspace/context.js";

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sanitizeErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  // Strip sensitive postgres password or API keys from error message
  return msg
    .replace(/(?:password|pwd)=([^\s;&]+)/gi, "password=[REDACTED]")
    .replace(/key=([a-zA-Z0-9_\-]{8,})/gi, "key=[REDACTED]")
    .replace(/Bearer\s+([a-zA-Z0-9_\-\.]{8,})/gi, "Bearer [REDACTED]");
}

export function deriveDirectConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString.trim());
    if (parsed.hostname.includes("-pooler")) {
      parsed.hostname = parsed.hostname.replace("-pooler", "");
      return parsed.toString();
    }
  } catch {
    // If not a parseable URL, return original
  }
  return connectionString;
}

export interface SetupRouterDeps {
  pool?: pg.Pool;
  getPool?: () => pg.Pool | null;
  onDatabaseInitialized?: (config: { databaseUrl: string; databaseUrlDirect: string }) => void;
}

export function createSetupRouter(deps: SetupRouterDeps = {}): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  function getActivePool(): pg.Pool | null {
    if (deps.getPool) return deps.getPool();
    if (deps.pool) return deps.pool;
    const dbUrl = (process.env.DATABASE_URL || "").trim();
    if (!dbUrl) return null;
    return new pg.Pool(pgPoolConfig(dbUrl));
  }

  // GET /api/v2/setup/status
  router.get(
    "/status",
    asyncHandler(async (_req, res) => {
      const dbUrl = (process.env.DATABASE_URL || "").trim();
      const hasDb = Boolean(dbUrl);
      let dbConnected = false;
      let migrationStatus: Awaited<ReturnType<typeof getMigrationStatus>> | null = null;
      let dbError: string | null = null;

      if (hasDb) {
        try {
          const testPool = getActivePool();
          if (testPool) {
            const client = await testPool.connect();
            try {
              await client.query("SELECT 1");
              dbConnected = true;
              migrationStatus = await getMigrationStatus(client);
            } finally {
              client.release();
            }
          }
        } catch (err: any) {
          dbConnected = false;
          dbError = sanitizeErrorMessage(err);
        }
      }

      const geminiConfigured = Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY);
      const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

      let modelRoutesConfigured = false;
      let activeRoutes: Array<{ purpose: string; provider: string; model: string }> = [];
      let consents = { allowAiEvaluation: false, allowDocuments: false };

      if (dbConnected && migrationStatus?.isInitialized) {
        try {
          const pool = getActivePool();
          if (pool) {
            const ctx = await resolveWorkspaceContext(pool as any, {
              workspaceKey: DEFAULT_WORKSPACE_KEY,
              userKey: DEFAULT_USER_KEY,
            });

            // Check active routes
            const routeKeys: Array<{ routeKey: string; purpose: ModelRoutePurpose }> = [
              { routeKey: "embedding_default", purpose: "EMBEDDING" },
              { routeKey: "routing_default", purpose: "EVALUATION" },
              { routeKey: "evaluation_default", purpose: "EVALUATION" },
              { routeKey: "document_default", purpose: "DOCUMENT" },
              { routeKey: "extraction_default", purpose: "EXTRACTION" },
            ];
            for (const { routeKey } of routeKeys) {
              const active = await getActiveModelRouteRevision(routeKey, pool, { context: ctx }).catch(() => null);
              if (active) {
                activeRoutes.push({
                  purpose: active.purpose,
                  provider: active.content.primary_provider,
                  model: active.content.primary_model,
                });
              }
            }
            const configuredPurposes = new Set(activeRoutes.map((route) => route.purpose));
            modelRoutesConfigured = configuredPurposes.has("EMBEDDING") && configuredPurposes.has("EVALUATION");

            // Check consents
            const consentRes = await pool.query<{ consent_key: string; granted: boolean }>(
              `SELECT consent_key, granted
               FROM workspace_user_consents
               WHERE workspace_id = $1
                 AND user_id = $2
                 AND consent_key IN ('allow_ai_evaluation', 'allow_documents')`,
              [ctx.workspaceId, ctx.userId]
            );
            consents = {
              allowAiEvaluation: consentRes.rows.some(
                (row) => row.consent_key === "allow_ai_evaluation" && row.granted === true
              ),
              allowDocuments: consentRes.rows.some(
                (row) => row.consent_key === "allow_documents" && row.granted === true
              ),
            };
          }
        } catch {
          // Soft failure if tables not fully migrated yet
        }
      }

      const isComplete =
        dbConnected &&
        Boolean(migrationStatus?.isInitialized) &&
        (migrationStatus?.pendingCount ?? 1) === 0 &&
        (geminiConfigured || openaiConfigured) &&
        modelRoutesConfigured &&
        consents.allowAiEvaluation;

      res.json({
        ok: true,
        database: {
          configured: hasDb,
          connected: dbConnected,
          isInitialized: migrationStatus?.isInitialized ?? false,
          appliedCount: migrationStatus?.appliedCount ?? 0,
          pendingCount: migrationStatus?.pendingCount ?? 0,
          appliedMigrations: migrationStatus?.appliedCount ?? 0,
          pendingMigrations: migrationStatus?.pendingCount ?? 0,
          totalCount: migrationStatus?.total ?? 0,
          error: dbError,
        },
        aiProviders: {
          gemini: geminiConfigured,
          openai: openaiConfigured,
        },
        ai: {
          geminiConfigured,
          openaiConfigured,
        },
        modelRoutes: {
          configured: modelRoutesConfigured,
          routes: activeRoutes,
        },
        consents: {
          allow_ai_evaluation: consents.allowAiEvaluation,
          allow_documents: consents.allowDocuments,
          allowAiEvaluation: consents.allowAiEvaluation,
          allowDocuments: consents.allowDocuments,
        },
        isComplete,
      });
    })
  );

  // POST /api/v2/setup/database/test
  router.post(
    "/database/test",
    asyncHandler(async (req, res) => {
      const rawUrl = String(req.body?.databaseUrl || "").trim();
      const rawDirectUrl = String(req.body?.databaseUrlDirect || "").trim();

      if (!rawUrl) {
        res.status(400).json({ ok: false, error: "Database connection URL is required." });
        return;
      }

      const isPooled = isPooledPostgresConnectionString(rawUrl);
      const directUrl = rawDirectUrl || (isPooled ? deriveDirectConnectionString(rawUrl) : rawUrl);

      let client: pg.Client | null = null;
      try {
        const config = pgConnectionConfig(directUrl);
        client = new pg.Client({
          ...config,
          connectionTimeoutMillis: 10000,
        });

        await client.connect();
        const testRes = await client.query(`
          SELECT 
            version() as pg_version,
            current_database() as db_name,
            current_user as db_user
        `);

        // Check for schema_migrations
        const status = await getMigrationStatus(client);

        res.json({
          ok: true,
          isPooled,
          directUrlDerived: isPooled && !rawDirectUrl ? directUrl : undefined,
          databaseName: testRes.rows[0]?.db_name,
          databaseUser: testRes.rows[0]?.db_user,
          postgresVersion: (testRes.rows[0]?.pg_version || "").split(" ")[0] || "PostgreSQL",
          schemaStatus: {
            isInitialized: status.isInitialized,
            appliedCount: status.appliedCount,
            totalCount: status.total,
            pendingCount: status.pendingCount,
          },
        });
      } catch (err: any) {
        res.status(400).json({
          ok: false,
          error: `Database connection test failed: ${sanitizeErrorMessage(err)}`,
          hint: isPooled && !rawDirectUrl
            ? "When using a pooled connection string, please also provide the direct unpooled connection string (without -pooler in the hostname)."
            : undefined,
        });
      } finally {
        if (client) {
          await client.end().catch(() => undefined);
        }
      }
    })
  );

  // POST /api/v2/setup/database/initialize
  router.post(
    "/database/initialize",
    asyncHandler(async (req, res) => {
      const rawUrl = String(req.body?.databaseUrl || process.env.DATABASE_URL || "").trim();
      const rawDirectUrl = String(
        req.body?.databaseUrlDirect || process.env.DATABASE_URL_UNPOOLED || ""
      ).trim();

      const isPooled = isPooledPostgresConnectionString(rawUrl);
      const directUrl = rawDirectUrl || (isPooled ? deriveDirectConnectionString(rawUrl) : rawUrl);

      if (!directUrl) {
        res.status(400).json({ ok: false, error: "No direct database connection URL available." });
        return;
      }

      let client: pg.Client | null = null;
      try {
        const config = pgConnectionConfig(directUrl);
        client = new pg.Client({
          ...config,
          connectionTimeoutMillis: 15000,
        });
        await client.connect();

        // 1. Run canonical migrations
        const applied = await runMigrations(client);

        // 2. Seed embedding spaces
        await seedEmbeddingSpaces(client);

        // 3. Resolve and seed default workspace context
        const ctx = await resolveWorkspaceContext(client as any, {
          workspaceKey: DEFAULT_WORKSPACE_KEY,
          userKey: DEFAULT_USER_KEY,
        });

        deps.onDatabaseInitialized?.({
          databaseUrl: rawUrl || directUrl,
          databaseUrlDirect: directUrl,
        });

        res.json({
          ok: true,
          applied,
          appliedCount: applied.length,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        });
      } catch (err: any) {
        res.status(500).json({
          ok: false,
          error: `Database initialization failed: ${sanitizeErrorMessage(err)}`,
        });
      } finally {
        if (client) {
          await client.end().catch(() => undefined);
        }
      }
    })
  );

  // POST /api/v2/setup/ai/test
  router.post(
    "/ai/test",
    asyncHandler(async (req, res) => {
      const provider = String(req.body?.provider || "").trim().toLowerCase();
      const apiKey = String(req.body?.apiKey || "").trim();

      if (!apiKey) {
        res.status(400).json({ ok: false, error: "API key is required." });
        return;
      }

      if (provider === "gemini") {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            const msg = (body as any)?.error?.message || `HTTP ${resp.status}`;
            res.status(400).json({
              ok: false,
              error: `Google Gemini verification failed: ${msg}`,
            });
            return;
          }
          const data: any = await resp.json();
          const models = Array.isArray(data.models)
            ? data.models.map((m: any) => m.name.replace(/^models\//, ""))
            : [];
          res.json({ ok: true, provider: "gemini", models });
        } catch (err: any) {
          res.status(400).json({
            ok: false,
            error: `Failed to connect to Google Gemini API: ${sanitizeErrorMessage(err)}`,
          });
        }
      } else if (provider === "openai") {
        try {
          const resp = await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            const msg = (body as any)?.error?.message || `HTTP ${resp.status}`;
            res.status(400).json({
              ok: false,
              error: `OpenAI verification failed: ${msg}`,
            });
            return;
          }
          const data: any = await resp.json();
          const models = Array.isArray(data.data) ? data.data.map((m: any) => m.id) : [];
          res.json({ ok: true, provider: "openai", models });
        } catch (err: any) {
          res.status(400).json({
            ok: false,
            error: `Failed to connect to OpenAI API: ${sanitizeErrorMessage(err)}`,
          });
        }
      } else {
        res.status(400).json({ ok: false, error: `Unsupported AI provider: ${provider}` });
      }
    })
  );

  // POST /api/v2/setup/routes
  router.post(
    "/routes",
    asyncHandler(async (req, res) => {
      const pool = getActivePool();
      if (!pool) {
        res.status(400).json({ ok: false, error: "Database is not connected." });
        return;
      }

      const routes = req.body?.routes;
      if (!routes || typeof routes !== "object") {
        res.status(400).json({ ok: false, error: "Invalid routes configuration." });
        return;
      }

      const configured: any[] = [];
      const client = await pool.connect();
      try {
        const ctx = await resolveWorkspaceContext(client as any, {
          workspaceKey: DEFAULT_WORKSPACE_KEY,
          userKey: DEFAULT_USER_KEY,
        });

        const routeDefs: Array<{
          key: string;
          purpose: ModelRoutePurpose;
          conf: { provider: string; model: string; fallbackProvider?: string; fallbackModel?: string };
        }> = [
          { key: "embedding_default", purpose: "EMBEDDING", conf: routes.embedding },
          { key: "routing_default", purpose: "EVALUATION", conf: routes.routing || routes.evaluation },
          { key: "evaluation_default", purpose: "EVALUATION", conf: routes.evaluation },
          { key: "document_default", purpose: "DOCUMENT", conf: routes.document || routes.evaluation },
        ];

        for (const def of routeDefs) {
          if (!def.conf || !def.conf.model) continue;
          const provider = (def.conf.provider || "gemini").toLowerCase() as "gemini" | "openai";
          const fallbackProvider = (def.conf.fallbackProvider || provider) as "gemini" | "openai";
          const fallbackModel = def.conf.fallbackModel || def.conf.model;

          const revision = await ensureModelRouteActiveRevision(
            {
              routeKey: def.key,
              purpose: def.purpose,
              content: {
                primary_provider: provider,
                primary_model: def.conf.model,
                fallback_provider: fallbackProvider,
                fallback_model: fallbackModel,
              },
            },
            client,
            { context: ctx }
          );
          configured.push(revision);
        }

        res.json({ ok: true, routes: configured });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: `Failed to configure routes: ${sanitizeErrorMessage(err)}` });
      } finally {
        client.release();
      }
    })
  );

  // POST /api/v2/setup/consents
  router.post(
    "/consents",
    asyncHandler(async (req, res) => {
      const pool = getActivePool();
      if (!pool) {
        res.status(400).json({ ok: false, error: "Database is not connected." });
        return;
      }

      const allowAiEvaluation = Boolean(req.body?.allowAiEvaluation);
      const allowDocuments = Boolean(req.body?.allowDocuments);

      const client = await pool.connect();
      try {
        const ctx = await resolveWorkspaceContext(client as any, {
          workspaceKey: DEFAULT_WORKSPACE_KEY,
          userKey: DEFAULT_USER_KEY,
        });

        await client.query(
          `
            INSERT INTO workspace_user_consents (
              workspace_id,
              user_id,
              consent_key,
              granted,
              granted_at,
              revoked_at,
              updated_at
            )
            VALUES
              ($1, $2, 'allow_ai_evaluation', $3, CASE WHEN $3 THEN NOW() ELSE NULL END, CASE WHEN $3 THEN NULL ELSE NOW() END, NOW()),
              ($1, $2, 'allow_documents', $4, CASE WHEN $4 THEN NOW() ELSE NULL END, CASE WHEN $4 THEN NULL ELSE NOW() END, NOW())
            ON CONFLICT (workspace_id, user_id, consent_key)
            DO UPDATE SET
              granted = EXCLUDED.granted,
              granted_at = EXCLUDED.granted_at,
              revoked_at = EXCLUDED.revoked_at,
              updated_at = NOW()
          `,
          [ctx.workspaceId, ctx.userId, allowAiEvaluation, allowDocuments]
        );

        res.json({
          ok: true,
          consents: { allowAiEvaluation, allowDocuments },
        });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: `Failed to save consents: ${sanitizeErrorMessage(err)}` });
      } finally {
        client.release();
      }
    })
  );

  return router;
}
