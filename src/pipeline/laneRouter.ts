import pg from "pg";
import dotenv from "dotenv";
import { generateEmbeddingWithProvider, type EmbeddingProvider } from "../services/agent.js";
import { pgSslConfig } from "../db/pgSsl.js";
import { stripHtmlToText } from "../security/sanitize.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import {
  loadGlobalLanesConfig,
  loadLanesConfig,
  type GlobalLanesConfig,
  type LaneDefinition,
} from "./laneConfigLoader.js";

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
    if (d.includes(nc.toLowerCase())) {
      return true; // excluded
    }
  }
  return false;
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
  console.log("Starting Semantic Lane Routing from config/lanes registry...");
  const config = loadGlobalLanesConfig();
  const pool = clientOrPool || defaultPool;
  const ctx = options?.context ?? (await resolveWorkspaceContext(pool as any));

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
    const routeWithProvider = async (
      provider: EmbeddingProvider
    ): Promise<{ routed: number; deferred: number }> => {
      console.log(`Lane routing embedding provider: ${provider}`);

      const laneEmbeddings: Record<string, number[]> = {};
      let prototypeDimensions: number | null = null;

      for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
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

      let routedCount = 0;
      let deferredCount = 0;

      for (const job of jobs) {
        await client.query("BEGIN");
        try {
          const coreText = extractCoreJobText(job.normalized_title, job.description_text || "");
          let jobEmbedding: number[];
          try {
            jobEmbedding = await generateEmbeddingWithProvider(coreText, provider);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new EmbeddingRunError(provider, `job embedding failed: ${message}`, job.id);
          }

          // Strict zero-vector check — embedding failure must not produce a default lane
          const isZeroVector = jobEmbedding.every((v) => v === 0);
          if (isZeroVector) {
            console.warn(`⚠️ Zero embedding for job ${job.id}. Deferring (never default lane).`);
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
            await client.query("COMMIT");
            deferredCount++;
            continue;
          }

          if (prototypeDimensions != null && jobEmbedding.length !== prototypeDimensions) {
            console.warn(
              `⚠️ Embedding dimension mismatch for job ${job.id}: expected ${prototypeDimensions} got ${jobEmbedding.length}. Deferring.`
            );
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
            await client.query("COMMIT");
            deferredCount++;
            continue;
          }

          let bestLane: string | null = null;
          let bestScore = -1;
          const scoreMap: Record<string, number> = {};
          const laneEvidence: string[] = [];
          const descText = (job.description_text || "").toLowerCase();

          for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
            // If excluded by lane's negative concepts, skip
            if (applyNegativeExclusion(descText, laneDef)) {
              scoreMap[laneKey] = -1;
              continue;
            }
            const score = cosineSimilarity(jobEmbedding, laneEmbeddings[laneKey]);
            scoreMap[laneKey] = score;
            if (score > bestScore) {
              bestScore = score;
              bestLane = laneKey;
            }
          }

          // Per-lane threshold check: must meet the lane's own semantic_threshold or min_similarity_floor
          const bestLaneDef = bestLane ? config.lanes[bestLane] : null;
          const perLaneThreshold =
            bestLaneDef?.semantic_threshold ??
            bestLaneDef?.threshold ??
            (config.unclassified_policy.min_similarity_floor || 0.25);
          if (bestScore < perLaneThreshold || !bestLane) {
            bestLane = "UNCLASSIFIED";
          }

          const laneConfidence =
            bestLane === "UNCLASSIFIED"
              ? "None"
              : bestScore >= perLaneThreshold + 0.2
                ? "High"
                : bestScore >= perLaneThreshold + 0.1
                  ? "Medium"
                  : "Low";

          // Secondary lanes: must meet per-lane threshold, have positive concept evidence, and not be excluded
          const secondaryLanes: string[] = [];
          for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
            if (laneKey === bestLane) continue;
            const threshold = laneDef.semantic_threshold ?? laneDef.threshold;
            const score = scoreMap[laneKey] || 0;
            if (score >= threshold && !applyNegativeExclusion(descText, laneDef)) {
              // Require at least one positive concept match for secondary lane qualification
              const hasPositiveEvidence = laneDef.positive_concepts?.some(pc =>
                descText.includes(pc.toLowerCase())
              );
              if (hasPositiveEvidence) {
                secondaryLanes.push(laneKey);
                if (laneDef.positive_concepts) {
                  for (const pc of laneDef.positive_concepts) {
                    if (descText.includes(pc.toLowerCase())) {
                      laneEvidence.push(`${laneKey}: "${pc}"`);
                      break;
                    }
                  }
                }
              }
            }
          }

          const processingStatus =
            bestLane === "UNCLASSIFIED" ? "ROUTING_DEFERRED" : "LANE_ROUTED";
          if (bestLane === "UNCLASSIFIED") deferredCount++; else routedCount++;

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
          deferredCount += 1;
        }
      }

      return { routed: routedCount, deferred: deferredCount };
    };

    let lastError: unknown = null;
    for (const provider of providerOrder) {
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

// ====================================================================
// NEW: INDEPENDENT DOMAIN SCORING (Eliminates disproportionate clustering)
// ====================================================================

export type TargetLane = 'CORE_AI_DATA' | 'LEGAL_REGTECH' | 'HEALTH_BIO_PHARMA' | 'INVESTMENT_MARKETS_FINTECH';

const DOMAIN_PATTERNS: Record<TargetLane, { positive: RegExp[]; negative: RegExp[] }> = {
  CORE_AI_DATA: {
    positive: [/\b(llm|generative ai|nlp|agentic|vector db|rag|search|data platform|pipeline|etl)\b/i],
    negative: [/\b(wealth advisory|legal practice|clinical medicine)\b/i]
  },
  LEGAL_REGTECH: {
    positive: [/\b(regtech|compliance tech|regulatory intelligence|contract analysis|legaltech|aml|kyc)\b/i],
    negative: [/\b(m&a attorney|paralegal|courtroom|legal counsel)\b/i]
  },
  HEALTH_BIO_PHARMA: {
    positive: [/\b(computational biology|bioinformatics|health data|biotech software|genomics|clinical data)\b/i],
    negative: [/\b(wet lab|pipetting|nurse|clinical trial coordinator)\b/i]
  },
  INVESTMENT_MARKETS_FINTECH: {
    positive: [/\b(quantitative|algorithmic trading|market microstructure|order book|risk engine|fintech|settlement|derivatives engine)\b/i],
    negative: [/\b(wealth management advisor|private banking sales|financial advisor|hr manager)\b/i]
  }
};

export function routeToLane(title: string, description: string): { primaryLane: TargetLane | null; secondaryLanes: TargetLane[] } {
  const scores: Record<TargetLane, number> = {
    CORE_AI_DATA: 0,
    LEGAL_REGTECH: 0,
    HEALTH_BIO_PHARMA: 0,
    INVESTMENT_MARKETS_FINTECH: 0
  };

  const text = `${title} ${description}`;

  for (const lane of Object.keys(DOMAIN_PATTERNS) as TargetLane[]) {
    const { positive, negative } = DOMAIN_PATTERNS[lane];
    
    // Check negatives first
    const hasNegative = negative.some(p => p.test(text));
    if (hasNegative) {
      scores[lane] = -100;
      continue;
    }

    for (const pos of positive) {
      const matches = text.match(new RegExp(pos, 'gi'));
      if (matches) {
        scores[lane] += matches.length;
      }
    }
  }

  const sorted = (Object.entries(scores) as [TargetLane, number][])
    .filter(([_, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    return { primaryLane: null, secondaryLanes: [] }; // No matched lane (never default)
  }

  const primaryLane = sorted[0][0];
  const secondaryLanes = sorted.slice(1).map(s => s[0]);

  return { primaryLane, secondaryLanes };
}
