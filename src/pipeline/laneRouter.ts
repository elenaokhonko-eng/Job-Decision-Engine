import pg from "pg";
import dotenv from "dotenv";
import crypto from "crypto";
import {
  generateEmbeddingWithProvider,
  MODEL_REGISTRY,
  type EmbeddingProvider,
} from "../services/agent.js";
import { pgSslConfig } from "../db/pgSsl.js";
import { stripHtmlToText } from "../security/sanitize.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import {
  loadGlobalLanesConfig,
  loadLanesConfig,
  loadWorkspaceLanesConfig,
  type GlobalLanesConfig,
  type LaneDefinition,
} from "./laneConfigLoader.js";
import { sha256Hex, stableStringify } from "../config/structuredLoader.js";

export { loadGlobalLanesConfig, loadLanesConfig };
export type { GlobalLanesConfig, LaneDefinition };

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});


// ── Cosine similarity ─────────────────────────────────────────────────────────

const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// ── Keyword negative-concept exclusion ────────────────────────────────────────

function applyNegativeExclusion(description: string, laneDef: LaneDefinition): boolean {
  if (!laneDef.negative_concepts?.length) return false;

  const d = description.toLowerCase();
  for (const nc of laneDef.negative_concepts) {
    if (containsConcept(d, nc)) {
      return true; // excluded
    }
  }
  return false;
}
function containsConcept(text: string, concept: string): boolean {
  return conceptVariants(concept).some((variant) => {
    const normalized = variant.toLowerCase().replace(/_/g, " ").trim();
    if (!normalized) return false;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
}

const CONCEPT_ALIASES: Record<string, string[]> = {
  "ai engineering": ["ai engineer", "artificial intelligence engineer", "machine learning engineer", "ml engineer", "ai systems engineer"],
  "ml engineering": ["ml engineer", "machine learning engineer", "machine learning engineering", "ml engineering"],
  "data engineering": ["data engineer", "data engineering", "data pipeline", "data pipelines", "etl", "data platform"],
  "ai data architecture": ["ai data architecture", "data architecture", "ai architecture", "data platform architecture"],
  "ai systems architecture": ["ai systems architect", "ai systems architecture", "ai architecture", "ml systems architect"],
  "llm infrastructure": ["llm infrastructure", "llm platform", "llm training", "llm inference", "foundation model infrastructure"],
  "ai research": ["ai research", "machine learning research", "deep learning research", "ai researcher", "ml researcher", "ai scientist"],
  "legal ai": ["legal ai", "legaltech", "legal technology", "legal nlp", "contract analytics"],
  "compliance automation": ["compliance automation", "compliance engineering", "regtech", "regulatory technology"],
  "fraud detection": ["fraud detection", "fraud analytics", "financial crime technology"],
  "document intelligence": ["document intelligence", "document ai", "contract analytics", "intelligent document processing"],
  "scientific ml": ["scientific ml", "scientific machine learning", "machine learning for science"],
  "research engineering": ["research engineering", "research engineer", "research software engineer"],
  "bioinformatics": ["bioinformatics", "bioinformatics scientist", "computational biology"],
  "clinical informatics": ["clinical informatics", "clinical data science", "health data science"],
  "quantitative research": ["quantitative research", "quant researcher", "quantitative researcher", "quant research"],
  "investment data platform": ["investment data platform", "investment data engineering", "market data platform", "portfolio data platform"],
  "time series modelling": ["time series modelling", "time-series modelling", "time series modeling", "time-series modeling", "forecasting"],
  "ai": ["artificial intelligence", "machine learning", "ml", "deep learning", "llm", "nlp"],
  "machine learning": ["machine learning", "ml", "deep learning"],
  "data platform": ["data platform", "data warehouse", "data lake", "lakehouse", "data pipeline"],
  "data science": ["data science", "data scientist", "applied statistics", "predictive modelling", "predictive modeling"],
  "regtech": ["regtech", "regulatory technology", "compliance automation", "aml", "kyc"],
  "legaltech": ["legaltech", "legal technology", "legal ai", "contract analytics"],
  "healthcare": ["healthcare", "health data", "clinical", "medical"],
  "biotech": ["biotech", "biotechnology", "drug discovery", "bioinformatics"],
  "pharmaceutical": ["pharmaceutical", "pharma", "drug discovery"],
  "investment management": ["investment management", "asset management", "fund management", "portfolio management"],
  "asset management": ["asset management", "investment management", "fund management"],
  "market data": ["market data", "financial data", "securities data", "order book"],
  "trading infrastructure": ["trading infrastructure", "trading systems", "execution systems", "market data platform"],
};

function conceptVariants(concept: string): string[] {
  const normalized = concept.toLowerCase().replace(/_/g, " ").trim();
  return [normalized, ...(CONCEPT_ALIASES[normalized] || [])];
}

function conceptScopeScore(description: string, concepts: string[] | undefined): number {
  if (!concepts || concepts.length === 0) return 1;
  return concepts.some((concept) => containsConcept(description, concept)) ? 1 : 0;
}

function extractCoreJobText(title: string, description: string): string {
  const raw = (description || "").trim();

  let mergedText = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as any;
      const parts: string[] = [];
      if (typeof parsed?.job_description === "string") parts.push(parsed.job_description);
      if (Array.isArray(parsed?.key_responsibilities)) parts.push(parsed.key_responsibilities.join("\n"));
      if (Array.isArray(parsed?.technical_skills)) parts.push(parsed.technical_skills.join("\n"));
      if (Array.isArray(parsed?.qualifications_education)) parts.push(parsed.qualifications_education.join("\n"));
      if (Array.isArray(parsed?.nice_to_haves)) parts.push(parsed.nice_to_haves.join("\n"));
      mergedText = parts.filter(Boolean).join("\n");
    } catch {
      mergedText = raw;
    }
  }

  const plain = stripHtmlToText(mergedText);
  const lines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const boilerplateHeadings = new Set([
    "equal opportunity employer",
    "benefits & perks",
    "benefits",
    "about us",
    "diversity & inclusion",
    "diversity and inclusion",
  ]);

  const sections: Array<{ heading: string | null; body: string[] }> = [];
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] };

  const flush = () => {
    if (current.heading || current.body.length) {
      sections.push(current);
      current = { heading: null, body: [] };
    }
  };

  for (const line of lines) {
    const normalizedHeading = line.replace(/:\s*$/, "").toLowerCase();
    const isBoilerplateHeading = boilerplateHeadings.has(normalizedHeading);
    const isHeading = isBoilerplateHeading || (line.endsWith(":") && line.length <= 60);
    if (isHeading) {
      flush();
      current.heading = normalizedHeading;
      continue;
    }
    current.body.push(line);
  }
  flush();

  const kept = sections
    .filter((s) => !s.heading || !boilerplateHeadings.has(s.heading))
    .flatMap((s) => s.body)
    .join(" ")
    .slice(0, 2000);

  return `${title}. ${kept}`.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Export under old name for backward-compat with tests
export async function runLaneRouting(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<{ routed: number; deferred: number }> {
  return runLaneRouter(clientOrPool, options);
}

export async function runLaneRouter(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<{ routed: number; deferred: number }> {
  const pool = clientOrPool || defaultPool;
  const ctx = options?.context ?? (await resolveWorkspaceContext(pool as any));
  const configResult = await loadWorkspaceLanesConfig(pool, {
    context: ctx,
    seedIfEmpty: true,
  });
  const config = configResult.config;
  const configSourceLabel =
    configResult.source === "FILES" ? "config/lanes (FILES)" : "workspace lanes (DB)";
  console.log(
    `Starting Semantic Lane Routing from ${configSourceLabel}. Lanes version: ${
      config.version || "unknown"
    }`
  );

  // Use LATERAL join to get only the latest version's description
  const { rows: jobs } = await pool.query(
    `
      SELECT c.*, jv.description_text, jv.id AS latest_version_id
      FROM canonical_jobs c
      JOIN LATERAL (
        SELECT id, description_text
        FROM job_versions
        WHERE workspace_id = $1
          AND canonical_job_id = c.id
        ORDER BY observed_at DESC
        LIMIT 1
      ) jv ON TRUE
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
    `,
    [ctx.workspaceId]
  );

  console.log(`Found ${jobs.length} canonical jobs to route.`);

  if (jobs.length === 0) {
    return { routed: 0, deferred: 0 };
  }

  if (process.env.PIPELINE_TASKS_SHADOW_ENQUEUE === "true") {
    let enqueued = 0;
    for (const job of jobs) {
      const taskKey = `lane_route:${job.latest_version_id}:${config.version || "unknown"}`;
      try {
        const res = await enqueuePipelineTask(
          {
            taskType: "LANE_ROUTE_JOB_VERSION",
            taskKey,
            payload: {
              canonical_job_id: job.id,
              job_version_id: job.latest_version_id,
              lanes_version: config.version ?? null,
            },
          },
          pool as any,
          { context: ctx }
        );
        if (res.inserted) {
          enqueued += 1;
        }
      } catch (err: any) {
        if (err?.code === "42P01") {
          console.warn("⚠️ pipeline_tasks table missing; skipping shadow enqueue for lane routing.");
          break;
        }
        throw err;
      }
    }
    console.log(`Shadow-enqueued ${enqueued} lane routing task(s).`);
  }

  class EmbeddingRunError extends Error {
    provider: EmbeddingProvider;
    jobId?: string;

    constructor(provider: EmbeddingProvider, message: string, jobId?: string) {
      super(message);
      this.name = "EmbeddingRunError";
      this.provider = provider;
      this.jobId = jobId;
    }
  }

  const primaryProviderRaw = (process.env.EMBEDDING_PRIMARY_PROVIDER || "").trim().toLowerCase();
  const primaryProvider: EmbeddingProvider =
    primaryProviderRaw === "openai" || process.env.FORCE_OPENAI === "true" ? "openai" : "gemini";
  const providerOrder: EmbeddingProvider[] =
    primaryProvider === "openai" ? ["openai", "gemini"] : ["gemini", "openai"];

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;
  try {
    type PublishedEmbeddingSet = {
      laneEmbeddings: Record<string, number[]>;
      jobEmbeddings: Map<string, number[]>;
      dimensions: number;
      model: string;
    };
    const publishedEmbeddingSets = new Map<EmbeddingProvider, PublishedEmbeddingSet>();
    const laneNodeIds = (configResult.activeLaneRevisions || [])
      .map((revision) => ({ laneKey: revision.laneKey, nodeId: revision.laneRevisionId }));
    if (laneNodeIds.length === Object.keys(config.lanes).length && laneNodeIds.length > 0) {
      try {
        const published = await client.query<{
          embedding_space_id: string;
          provider: EmbeddingProvider;
          model: string;
          node_type: string;
          node_id: string;
          vector_dimensions: number;
          embedding_values: number[] | string;
        }>(
          `SELECT v.embedding_space_id,
                  es.provider,
                  es.model,
                  v.node_type,
                  v.node_id,
                  v.vector_dimensions,
                  v.embedding_values
           FROM v_matchable_nodes v
           JOIN embedding_spaces es ON es.id = v.embedding_space_id
           WHERE v.workspace_id = $1
             AND es.active = TRUE
             AND ((v.node_type = 'JOB_VERSION' AND v.node_id = ANY($2::uuid[]))
               OR (v.node_type = 'LANE_PROTOTYPE' AND v.node_id = ANY($3::uuid[])))
           ORDER BY es.created_at DESC`,
          [
            ctx.workspaceId,
            jobs.map((job) => job.latest_version_id),
            laneNodeIds.map((revision) => revision.nodeId),
          ]
        );
        const grouped = new Map<string, typeof published.rows>();
        for (const row of published.rows) {
          const rows = grouped.get(row.embedding_space_id) || [];
          rows.push(row);
          grouped.set(row.embedding_space_id, rows);
        }
        for (const rows of grouped.values()) {
          const provider = rows[0]?.provider;
          if (!provider) continue;
          const parseVector = (value: number[] | string): number[] => {
            if (Array.isArray(value)) return value.map(Number);
            return String(value).replace(/[{}]/g, "").split(",").map(Number).filter(Number.isFinite);
          };
          const byNode = new Map(rows.map((row) => [`${row.node_type}:${row.node_id}`, parseVector(row.embedding_values)]));
          const dimensions = Number(rows[0]?.vector_dimensions || 0);
          const laneEmbeddings: Record<string, number[]> = {};
          let complete = dimensions > 0;
          for (const revision of laneNodeIds) {
            const vector = byNode.get(`LANE_PROTOTYPE:${revision.nodeId}`);
            if (!vector || vector.length !== dimensions) complete = false;
            else laneEmbeddings[revision.laneKey] = vector;
          }
          const jobEmbeddings = new Map<string, number[]>();
          for (const job of jobs) {
            const vector = byNode.get(`JOB_VERSION:${job.latest_version_id}`);
            if (!vector || vector.length !== dimensions) complete = false;
            else jobEmbeddings.set(job.id, vector);
          }
          if (complete && Object.keys(laneEmbeddings).length === laneNodeIds.length && jobEmbeddings.size === jobs.length) {
            publishedEmbeddingSets.set(provider, {
              laneEmbeddings,
              jobEmbeddings,
              dimensions,
              model: String(rows[0]?.model || "unknown"),
            });
          }
        }
      } catch (error: any) {
        if (error?.code !== "42P01") throw error;
      }
    }

    const useWorkspaceLaneTables = configResult.source === "LANE_REGISTRY_DB";
    const pipelineRunId = crypto.randomUUID();
    const laneSnapshot = {
      source: configResult.source,
      lanes_version: config.version ?? null,
      active_lane_revisions:
        configResult.activeLaneRevisions?.map((lane) => ({
          lane_key: lane.laneKey,
          lane_identity_id: lane.laneIdentityId,
          lane_revision_id: lane.laneRevisionId,
          revision_number: lane.revisionNumber,
          content_hash: lane.contentHash,
          activated_at: lane.activatedAt,
        })) ?? [],
    };

    const loadPreferenceOrdering = async (): Promise<{
      laneRankByKey: Record<string, number>;
      laneEnabledByKey: Record<string, boolean>;
    }> => {
      if (!useWorkspaceLaneTables) {
        return { laneRankByKey: {}, laneEnabledByKey: {} };
      }
      try {
        const { rows } = await client.query<{
          lane_key: string;
          enabled: boolean;
          priority_rank: number;
        }>(
          `
            SELECT li.lane_key, wlp.enabled, wlp.priority_rank
            FROM workspace_lane_preferences wlp
            JOIN lane_identities li ON li.id = wlp.lane_identity_id
            WHERE wlp.workspace_id = $1
              AND wlp.workspace_user_id = $2
          `,
          [ctx.workspaceId, ctx.userId]
        );

        const laneRankByKey: Record<string, number> = {};
        const laneEnabledByKey: Record<string, boolean> = {};

        for (const row of rows) {
          laneRankByKey[row.lane_key] = row.priority_rank ?? 1000;
          laneEnabledByKey[row.lane_key] = row.enabled !== false;
        }

        return { laneRankByKey, laneEnabledByKey };
      } catch (error: any) {
        // Allow running without preferences table (pre-migration).
        if (error?.code === "42P01") {
          return { laneRankByKey: {}, laneEnabledByKey: {} };
        }
        throw error;
      }
    };

    const preferences = await loadPreferenceOrdering();
    const preferenceRank = (laneKey: string): number => preferences.laneRankByKey[laneKey] ?? 1000;
    const preferenceEnabled = (laneKey: string): boolean => {
      if (laneKey in preferences.laneEnabledByKey) {
        return preferences.laneEnabledByKey[laneKey];
      }
      return true;
    };

    const persistLaneDecision = async (params: {
      canonicalJobId: string;
      jobVersionId: string;
      embeddingProvider: EmbeddingProvider;
      embeddingModel?: string;
      embeddingDimensions: number;
      primaryLane: string;
      secondaryLanes: string[];
      laneConfidence: string;
      semanticScores: Record<string, number>;
      laneEvidence: string[];
      evaluatedAt: string;
    }): Promise<string | null> => {
      if (!useWorkspaceLaneTables) {
        return null;
      }
      const embeddingModel = params.embeddingModel || (
        params.embeddingProvider === "gemini"
          ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL
          : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL
      );
      const modelVersion = [
        "lane_router_v2.2.0",
        config.version ?? "lanes_unknown",
        `${params.embeddingProvider}:${embeddingModel}:${params.embeddingDimensions}`,
      ].join("|");

      const decisionJson = {
        schema_version: "2.2.0",
        canonical_job_id: params.canonicalJobId,
        job_version_id: params.jobVersionId,
        pipeline_run_id: pipelineRunId,
        model_version: modelVersion,
        primary_lane: params.primaryLane,
        secondary_lanes: params.secondaryLanes,
        lane_confidence: params.laneConfidence,
        semantic_scores: params.semanticScores,
        lane_evidence: params.laneEvidence,
        evaluated_at: params.evaluatedAt,
      };

      const decisionHash = sha256Hex(stableStringify(decisionJson));

      try {
        const inserted = await client.query<{ id: string }>(
          `
            INSERT INTO lane_decisions (
              workspace_id,
              canonical_job_id,
              job_version_id,
              decision_hash,
              schema_version,
              model_version,
              lane_snapshot,
              decision_json,
              created_by_user_id,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (workspace_id, decision_hash)
            DO NOTHING
            RETURNING id
          `,
          [
            ctx.workspaceId,
            params.canonicalJobId,
            params.jobVersionId,
            decisionHash,
            "2.2.0",
            modelVersion,
            laneSnapshot,
            decisionJson,
            ctx.userId,
          ]
        );

        if (inserted.rows.length > 0) {
          return inserted.rows[0].id;
        }

        const existing = await client.query<{ id: string }>(
          `
            SELECT id
            FROM lane_decisions
            WHERE workspace_id = $1
              AND decision_hash = $2
            LIMIT 1
          `,
          [ctx.workspaceId, decisionHash]
        );
        return existing.rows[0]?.id ?? null;
      } catch (error: any) {
        // Allow running against pre-migration databases.
        if (error?.code === "42P01") {
          return null;
        }
        throw error;
      }
    };

    const routeWithProvider = async (
      provider: EmbeddingProvider
    ): Promise<{ routed: number; deferred: number }> => {
      console.log(`Lane routing embedding provider: ${provider}`);

      const laneEmbeddings: Record<string, number[]> = {};
      let prototypeDimensions: number | null = null;
      const publishedSet = publishedEmbeddingSets.get(provider);
      if (publishedSet) {
        Object.assign(laneEmbeddings, publishedSet.laneEmbeddings);
        prototypeDimensions = publishedSet.dimensions;
      }

      for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
        if (publishedSet) break;
        let vector: number[];
        try {
          vector = await generateEmbeddingWithProvider(laneDef.prototype_query, provider);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new EmbeddingRunError(
            provider,
            `prototype embedding failed for lane ${laneKey}: ${message}`
          );
        }

        if (vector.length === 0) {
          throw new EmbeddingRunError(provider, `prototype embedding was empty for lane ${laneKey}`);
        }

        if (prototypeDimensions == null) {
          prototypeDimensions = vector.length;
        } else if (vector.length !== prototypeDimensions) {
          throw new EmbeddingRunError(
            provider,
            `prototype embedding dimension mismatch for lane ${laneKey}: expected ${prototypeDimensions} got ${vector.length}`
          );
        }

        laneEmbeddings[laneKey] = vector;
      }

      const jobEmbeddings = new Map<string, number[]>(publishedSet?.jobEmbeddings || []);
      if (publishedSet) {
        console.log(`Using published ${provider} embedding batch for lane routing.`);
      }
      for (const job of jobs) {
        if (publishedSet) break;
        const coreText = extractCoreJobText(job.normalized_title, job.description_text || "");
        let jobEmbedding: number[];
        try {
          jobEmbedding = await generateEmbeddingWithProvider(coreText, provider);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new EmbeddingRunError(provider, `job embedding failed: ${message}`, job.id);
        }
        if (jobEmbedding.length === 0 || jobEmbedding.every((value) => value === 0)) {
          throw new EmbeddingRunError(provider, "job embedding was empty or zero-valued", job.id);
        }
        if (prototypeDimensions !== null && jobEmbedding.length !== prototypeDimensions) {
          throw new EmbeddingRunError(
            provider,
            `job embedding dimension mismatch: expected ${prototypeDimensions} got ${jobEmbedding.length}`,
            job.id
          );
        }
        jobEmbeddings.set(job.id, jobEmbedding);
      }

      let routedCount = 0;
      let deferredCount = 0;

      for (const job of jobs) {
        await client.query("BEGIN");
        try {
          const jobEmbedding = jobEmbeddings.get(job.id);
          if (!jobEmbedding) {
            throw new EmbeddingRunError(provider, "job embedding was not prepared", job.id);
          }

          // Strict zero-vector check — embedding failure must not produce a default lane
          const isZeroVector = jobEmbedding.every((v) => v === 0);
          if (isZeroVector) {
            console.warn(`⚠️ Zero embedding for job ${job.id}. Deferring (never default lane).`);
            const evaluatedAt = new Date().toISOString();
            const laneDecisionId = await persistLaneDecision({
              canonicalJobId: job.id,
              jobVersionId: job.latest_version_id,
              embeddingProvider: provider,
              embeddingModel: publishedSet?.model,
              embeddingDimensions: jobEmbedding.length,
              primaryLane: "UNCLASSIFIED",
              secondaryLanes: [],
              laneConfidence: "None",
              semanticScores: {},
              laneEvidence: ["ZERO_VECTOR_EMBEDDING"],
              evaluatedAt,
            });
            await client.query(
              `UPDATE canonical_jobs
               SET primary_lane = 'UNCLASSIFIED',
                   semantic_score = 0.0,
                   lane_confidence = 'None',
                   secondary_lanes = $3,
                   lane_evidence = $4,
                   processing_state = 'ROUTING_DEFERRED',
                   processing_status = 'ROUTING_DEFERRED',
                   updated_at = NOW()
               WHERE workspace_id = $1 AND id = $2`,
              [ctx.workspaceId, job.id, JSON.stringify([]), JSON.stringify(["ZERO_VECTOR_EMBEDDING"])]
            );
            if (laneDecisionId) {
              await client.query(
                `UPDATE canonical_jobs
                 SET latest_lane_decision_id = $3,
                     updated_at = NOW()
                 WHERE workspace_id = $1 AND id = $2`,
                [ctx.workspaceId, job.id, laneDecisionId]
              );
            }
            await client.query("COMMIT");
            deferredCount++;
            continue;
          }

          if (prototypeDimensions != null && jobEmbedding.length !== prototypeDimensions) {
            console.warn(
              `⚠️ Embedding dimension mismatch for job ${job.id}: expected ${prototypeDimensions} got ${jobEmbedding.length}. Deferring.`
            );
            const evaluatedAt = new Date().toISOString();
            const laneDecisionId = await persistLaneDecision({
              canonicalJobId: job.id,
              jobVersionId: job.latest_version_id,
              embeddingProvider: provider,
              embeddingModel: publishedSet?.model,
              embeddingDimensions: jobEmbedding.length,
              primaryLane: "UNCLASSIFIED",
              secondaryLanes: [],
              laneConfidence: "None",
              semanticScores: {},
              laneEvidence: [`EMBEDDING_DIM_MISMATCH:${jobEmbedding.length}!=${prototypeDimensions}`],
              evaluatedAt,
            });
            await client.query(
              `UPDATE canonical_jobs
               SET primary_lane = 'UNCLASSIFIED',
                   semantic_score = 0.0,
                   lane_confidence = 'None',
                   secondary_lanes = $3,
                   lane_evidence = $4,
                   processing_state = 'ROUTING_DEFERRED',
                   processing_status = 'ROUTING_DEFERRED',
                   updated_at = NOW()
               WHERE workspace_id = $1 AND id = $2`,
              [
                ctx.workspaceId,
                job.id,
                JSON.stringify([]),
                JSON.stringify([`EMBEDDING_DIM_MISMATCH:${jobEmbedding.length}!=${prototypeDimensions}`]),
              ]
            );
            if (laneDecisionId) {
              await client.query(
                `UPDATE canonical_jobs
                 SET latest_lane_decision_id = $3,
                     updated_at = NOW()
                 WHERE workspace_id = $1 AND id = $2`,
                [ctx.workspaceId, job.id, laneDecisionId]
              );
            }
            await client.query("COMMIT");
            deferredCount++;
            continue;
          }

          let bestLane: string | null = null;
          let bestScore = -1;
          const scoreMap: Record<string, number> = {};
          const domainScoreMap: Record<string, number> = {};
          const functionScoreMap: Record<string, number> = {};
          const laneEvidence: string[] = [];
          const descText = extractCoreJobText(
            job.normalized_title || "",
            job.description_text || ""
          ).toLowerCase();

          for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
            if (!preferenceEnabled(laneKey)) {
              scoreMap[laneKey] = -1;
              continue;
            }
            // If excluded by lane's negative concepts, skip
            if (applyNegativeExclusion(descText, laneDef)) {
              scoreMap[laneKey] = -1;
              continue;
            }
            const score = cosineSimilarity(jobEmbedding, laneEmbeddings[laneKey]);
            scoreMap[laneKey] = score;
            domainScoreMap[laneKey] = conceptScopeScore(descText, laneDef.included_domain_concepts);
            functionScoreMap[laneKey] = conceptScopeScore(descText, laneDef.required_function_concepts);
            if (score > bestScore) {
              bestScore = score;
              bestLane = laneKey;
            }
          }

          const minSimilarityFloor = config.unclassified_policy.min_similarity_floor || 0.25;
          const qualifyingPrimary = Object.entries(config.lanes)
            .map(([laneKey, laneDef]) => {
              const threshold = laneDef.semantic_threshold ?? laneDef.threshold ?? minSimilarityFloor;
              const score = scoreMap[laneKey] ?? -1;
              const domainScore = domainScoreMap[laneKey] ?? 0;
              const functionScore = functionScoreMap[laneKey] ?? 0;
              return {
                laneKey,
                laneDef,
                threshold,
                score,
                domainScore,
                functionScore,
                rank: preferenceRank(laneKey),
              };
            })
            .filter((c) => preferenceEnabled(c.laneKey))
            .filter((c) => c.score >= c.threshold)
            .filter((c) => c.domainScore >= (c.laneDef.minimum_domain_score ?? 0))
            .filter((c) => c.functionScore >= (c.laneDef.minimum_function_score ?? 0))
            .filter((c) => !applyNegativeExclusion(descText, c.laneDef));

          if (qualifyingPrimary.length === 0) {
            bestLane = "UNCLASSIFIED";
            bestScore = 0;
          } else {
            qualifyingPrimary.sort((a, b) => {
              if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
              return a.rank - b.rank;
            });
            bestLane = qualifyingPrimary[0].laneKey;
            bestScore = qualifyingPrimary[0].score;
          }

          const selectedLaneDef = bestLane === "UNCLASSIFIED" ? null : config.lanes[bestLane];
          const selectedThreshold =
            selectedLaneDef?.semantic_threshold ?? selectedLaneDef?.threshold ?? minSimilarityFloor;

          const laneConfidence =
            bestLane === "UNCLASSIFIED"
              ? "None"
              : bestScore >= selectedThreshold + 0.2
                ? "High"
                : bestScore >= selectedThreshold + 0.1
                  ? "Medium"
                  : "Low";

          // Secondary lanes: must meet per-lane threshold, have positive concept evidence, and not be excluded.
          // Preference rank is applied as a stable ordering (not a classifier).
          const secondaryCandidates: Array<{ laneKey: string; score: number; rank: number }> = [];
          for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
            if (laneKey === bestLane) continue;
            if (!preferenceEnabled(laneKey)) continue;
            const threshold = laneDef.secondary_lane_threshold
              ?? laneDef.semantic_threshold
              ?? laneDef.threshold
              ?? minSimilarityFloor;
            const score = scoreMap[laneKey] || 0;
            const domainScore = domainScoreMap[laneKey] ?? 0;
            const functionScore = functionScoreMap[laneKey] ?? 0;
            if (
              score >= threshold
              && domainScore >= (laneDef.minimum_domain_score ?? 0)
              && functionScore >= (laneDef.minimum_function_score ?? 0)
              && !applyNegativeExclusion(descText, laneDef)
            ) {
              // Require at least one positive concept match for secondary lane qualification
              const hasPositiveEvidence = laneDef.positive_concepts?.some((pc) => containsConcept(descText, pc));
              if (hasPositiveEvidence) {
                secondaryCandidates.push({ laneKey, score, rank: preferenceRank(laneKey) });
                if (laneDef.positive_concepts) {
                  for (const pc of laneDef.positive_concepts) {
                    if (containsConcept(descText, pc)) {
                      laneEvidence.push(`${laneKey}: "${pc}"`);
                      break;
                    }
                  }
                }
              }
            }
          }
          secondaryCandidates.sort((a, b) => {
            if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
            return a.rank - b.rank;
          });
          const secondaryLanes = secondaryCandidates.map((c) => c.laneKey);

          const processingStatus =
            bestLane === "UNCLASSIFIED" ? "ROUTING_DEFERRED" : "LANE_ROUTED";
          if (bestLane === "UNCLASSIFIED") deferredCount++; else routedCount++;

          const evaluatedAt = new Date().toISOString();
          const laneDecisionId = await persistLaneDecision({
            canonicalJobId: job.id,
            jobVersionId: job.latest_version_id,
            embeddingProvider: provider,
            embeddingModel: publishedSet?.model,
            embeddingDimensions: jobEmbedding.length,
            primaryLane: bestLane,
            secondaryLanes,
            laneConfidence,
            semanticScores: scoreMap,
            laneEvidence: [
              ...laneEvidence,
              `${bestLane}:domain_score=${(domainScoreMap[bestLane] ?? 0).toFixed(3)}`,
              `${bestLane}:function_score=${(functionScoreMap[bestLane] ?? 0).toFixed(3)}`,
            ],
            evaluatedAt,
          });

          await client.query(
            `UPDATE canonical_jobs
             SET primary_lane       = $1,
                 semantic_score     = $2,
                 processing_state   = $3,
                 processing_status  = $3,
                 lane_confidence    = $4,
                 secondary_lanes    = $5,
                 lane_evidence      = $6,
                 updated_at         = NOW()
             WHERE workspace_id = $7 AND id = $8`,
            [
              bestLane,
              bestScore,
              processingStatus,
              laneConfidence,
              JSON.stringify(secondaryLanes),
              JSON.stringify(laneEvidence),
              ctx.workspaceId,
              job.id,
            ]
          );

          if (laneDecisionId) {
            await client.query(
              `UPDATE canonical_jobs
               SET latest_lane_decision_id = $3,
                   updated_at = NOW()
               WHERE workspace_id = $1 AND id = $2`,
              [ctx.workspaceId, job.id, laneDecisionId]
            );
          }

          await client.query("COMMIT");
          console.log(
            `  -> Job ${job.id} ("${job.normalized_title}"): ${bestLane} (Score: ${bestScore.toFixed(3)}, Status: ${processingStatus})`
          );
        } catch (jobErr) {
          await client.query("ROLLBACK");
          if (jobErr instanceof EmbeddingRunError) {
            throw jobErr;
          }

          const message = jobErr instanceof Error ? jobErr.message : String(jobErr);
          const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
          console.error(`❌ Failed to route job ${job.id}:`, jobErr);
          const evaluatedAt = new Date().toISOString();
          const laneDecisionId = await persistLaneDecision({
            canonicalJobId: job.id,
            jobVersionId: job.latest_version_id,
            embeddingProvider: provider,
            embeddingModel: publishedSet?.model,
            embeddingDimensions: prototypeDimensions ?? 0,
            primaryLane: "UNCLASSIFIED",
            secondaryLanes: [],
            laneConfidence: "None",
            semanticScores: {},
            laneEvidence: [`ROUTING_ERROR:${trimmed}`],
            evaluatedAt,
          });
          await client.query(
            `UPDATE canonical_jobs
             SET primary_lane = 'UNCLASSIFIED',
                 semantic_score = 0.0,
                 lane_confidence = 'None',
                 secondary_lanes = $3,
                 lane_evidence = $4,
                 processing_state = 'ROUTING_DEFERRED',
                 processing_status = 'ROUTING_DEFERRED',
                 updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2`,
            [
              ctx.workspaceId,
              job.id,
              JSON.stringify([]),
              JSON.stringify([`ROUTING_ERROR:${trimmed}`]),
            ]
          );
          if (laneDecisionId) {
            await client.query(
              `UPDATE canonical_jobs
               SET latest_lane_decision_id = $3,
                   updated_at = NOW()
               WHERE workspace_id = $1 AND id = $2`,
              [ctx.workspaceId, job.id, laneDecisionId]
            );
          }
          deferredCount += 1;
        }
      }

      return { routed: routedCount, deferred: deferredCount };
    };

    let lastError: unknown = null;
    const publishedProviderOrder = providerOrder.filter((provider) => publishedEmbeddingSets.has(provider));
    const routingProviderOrder = publishedProviderOrder.length > 0 ? publishedProviderOrder : providerOrder;
    if (publishedProviderOrder.length > 0) {
      console.log(
        `Using complete published embedding space(s) for lane routing: ${publishedProviderOrder.join(", ")}`
      );
    }
    for (const provider of routingProviderOrder) {
      try {
        const result = await routeWithProvider(provider);
        console.log(
          `Semantic Lane Routing complete. Routed: ${result.routed}, Deferred: ${result.deferred}`
        );
        return result;
      } catch (error: unknown) {
        lastError = error;
        if (error instanceof EmbeddingRunError) {
          const where = error.jobId ? `job ${error.jobId}` : "prototype embeddings";
          console.warn(
            `⚠️ Embedding provider ${provider} failed during ${where}: ${error.message}. Trying fallback...`
          );
          continue;
        }
        throw error;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError || "unknown");
    const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
    let deferredCount = 0;

    for (const job of jobs) {
      await client.query(
        `UPDATE canonical_jobs
         SET primary_lane = 'UNCLASSIFIED',
             semantic_score = 0.0,
             lane_confidence = 'None',
             secondary_lanes = $3,
             lane_evidence = $4,
             processing_state = 'ROUTING_DEFERRED',
             processing_status = 'ROUTING_DEFERRED',
             updated_at = NOW()
         WHERE workspace_id = $1 AND id = $2`,
        [
          ctx.workspaceId,
          job.id,
          JSON.stringify([]),
          JSON.stringify([`EMBEDDING_UNAVAILABLE:${trimmed}`]),
        ]
      );
      deferredCount += 1;
    }

    console.warn(
      `⚠️ Semantic Lane Routing deferred all jobs due to embedding failure: ${trimmed}`
    );

    return { routed: 0, deferred: deferredCount };
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}
