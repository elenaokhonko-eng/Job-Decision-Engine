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
import { isGeminiConfigured } from "../../services/geminiConfig.js";
import {
  AI_PROVIDERS,
  configuredAiProviderIds,
  listAiProviderIds,
  listProviderModels,
  normalizeAiProviderId,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
} from "../../services/aiProviders.js";

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

      // Provider availability comes from the registry, so configuring an
      // OpenAI-compatible endpoint counts without editing this route.
      const configuredProviders = configuredAiProviderIds();
      const anyProviderConfigured = configuredProviders.length > 0;
      const geminiConfigured = isGeminiConfigured();
      const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

      let modelRoutesConfigured = false;
      let activeRoutes: Array<{ purpose: string; provider: string; model: string }> = [];

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

          }
        } catch {
          // Soft failure if tables not fully migrated yet
        }
      }

      const isComplete =
        dbConnected &&
        Boolean(migrationStatus?.isInitialized) &&
        (migrationStatus?.pendingCount ?? 1) === 0 &&
        anyProviderConfigured &&
        modelRoutesConfigured;

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
          compatible: configuredProviders.includes("openai-compatible"),
          configured: configuredProviders,
        },
        ai: {
          geminiConfigured,
          openaiConfigured,
          configuredProviders,
        },
        modelRoutes: {
          configured: modelRoutesConfigured,
          routes: activeRoutes,
          embedding: activeRoutes.find((r) => r.purpose === "EMBEDDING")?.model ?? null,
          evaluation: activeRoutes.find((r) => r.purpose === "EVALUATION")?.model ?? null,
          document: activeRoutes.find((r) => r.purpose === "DOCUMENT")?.model ?? null,
          extraction: activeRoutes.find((r) => r.purpose === "EXTRACTION")?.model ?? null,
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
      const requested = req.body?.provider;
      const provider = normalizeAiProviderId(requested);

      if (!provider) {
        res.status(400).json({
          ok: false,
          error: `Unsupported AI provider: ${String(requested ?? "")}`,
          supportedProviders: listAiProviderIds(),
        });
        return;
      }

      const definition = AI_PROVIDERS[provider];
      // Fall back to the environment so the wizard can re-test a saved key.
      const apiKey = String(req.body?.apiKey || "").trim() || resolveProviderApiKey(provider);
      if (!apiKey && definition.requiresApiKey) {
        res.status(400).json({ ok: false, error: `${definition.apiKeyEnv} is required for ${definition.label}.` });
        return;
      }

      const baseUrl = String(req.body?.baseUrl || "").trim() || undefined;
      try {
        const models = await listProviderModels({ provider, apiKey, baseUrl });
        res.json({
          ok: true,
          provider,
          label: definition.label,
          baseUrl: resolveProviderBaseUrl(provider, baseUrl),
          models,
        });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: sanitizeErrorMessage(err) });
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

      let routes = req.body?.routes;
      if (!routes || typeof routes !== "object") {
        const provider = String(req.body?.provider || "gemini").toLowerCase();
        const embeddingModel = req.body?.embeddingModel;
        const evaluationModel = req.body?.evaluationModel;
        const documentModel = req.body?.documentModel;
        const extractionModel = req.body?.extractionModel;

        if (embeddingModel || evaluationModel || documentModel || extractionModel) {
          routes = {
            embedding: embeddingModel ? { provider, model: embeddingModel } : undefined,
            evaluation: evaluationModel ? { provider, model: evaluationModel } : undefined,
            document: documentModel ? { provider, model: documentModel } : undefined,
            extraction: extractionModel ? { provider, model: extractionModel } : undefined,
          };
        }
      }

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
          conf?: { provider?: string; model?: string; fallbackProvider?: string; fallbackModel?: string };
        }> = [
          { key: "embedding_default", purpose: "EMBEDDING", conf: routes.embedding },
          { key: "routing_default", purpose: "EVALUATION", conf: routes.routing || routes.evaluation },
          { key: "evaluation_default", purpose: "EVALUATION", conf: routes.evaluation },
          { key: "single_job_evaluation", purpose: "EVALUATION", conf: routes.evaluation },
          { key: "batch_evaluation", purpose: "EVALUATION", conf: routes.evaluation },
          { key: "document_default", purpose: "DOCUMENT", conf: routes.document || routes.evaluation },
          { key: "extraction_default", purpose: "EXTRACTION", conf: routes.extraction || routes.evaluation },
          { key: "requirements_extraction", purpose: "EXTRACTION", conf: routes.extraction || routes.evaluation },
        ];

        const baseUrl = String(req.body?.baseUrl || "").trim() || undefined;
        const validationWarnings: string[] = [];
        const unknownModels: Array<{ route: string; provider: string; model: string; available: string[] }> = [];

        // Reject a model id the provider does not actually serve, instead of
        // writing it and failing later at the first evaluation.
        if (req.body?.validateModels !== false) {
          const modelCache = new Map<string, Set<string> | null>();
          for (const def of routeDefs) {
            if (!def.conf || !def.conf.model) continue;
            const provider = normalizeAiProviderId(def.conf.provider || "gemini");
            if (!provider) continue;
            if (!modelCache.has(provider)) {
              const key = resolveProviderApiKey(provider);
              if (!key && AI_PROVIDERS[provider].requiresApiKey) {
                validationWarnings.push(`Skipped model validation for ${provider}: no API key available.`);
                modelCache.set(provider, null);
              } else {
                try {
                  const models = await listProviderModels({ provider, apiKey: key, baseUrl });
                  modelCache.set(provider, new Set(models));
                } catch (err) {
                  validationWarnings.push(`Could not list ${provider} models: ${sanitizeErrorMessage(err)}`);
                  modelCache.set(provider, null);
                }
              }
            }
            const available = modelCache.get(provider);
            if (available && available.size > 0 && !available.has(def.conf.model)) {
              unknownModels.push({
                route: def.key,
                provider,
                model: def.conf.model,
                available: [...available].slice(0, 25),
              });
            }
          }
        }

        if (unknownModels.length > 0) {
          res.status(400).json({
            ok: false,
            error: "Unknown model id for the configured provider.",
            unknownModels,
            hint: "Call POST /api/v2/setup/ai/test to list the models this key can actually use.",
          });
          return;
        }

        for (const def of routeDefs) {
          if (!def.conf || !def.conf.model) continue;
          const provider = normalizeAiProviderId(def.conf.provider || "gemini") ?? "gemini";
          const fallbackProvider = normalizeAiProviderId(def.conf.fallbackProvider || provider) ?? provider;
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

        res.json({ ok: true, routes: configured, warnings: validationWarnings });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: `Failed to configure routes: ${sanitizeErrorMessage(err)}` });
      } finally {
        client.release();
      }
    })
  );

  return router;
}
