import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { generateEmbedding } from "../services/agent.js";
import { pgSslConfig } from "../db/pgSsl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LaneDefinition {
  title: string;
  description: string;
  threshold: number;
  semantic_threshold?: number;
  ai_evaluation_limit?: number;
  enabled_sources?: string[];
  title_families?: string[];
  keywords: string[];
  positive_concepts?: string[];
  negative_concepts?: string[];
  prototype_query: string;
}

export interface GlobalLanesConfig {
  version?: string;
  description?: string;
  lanes: Record<string, LaneDefinition>;
  unclassified_policy: {
    label: string;
    fallback_behavior: string;
    min_similarity_floor: number;
  };
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// ── Config loader ────────────────────────────────────────────────────────────

/**
 * Load authoritative consolidated lane definitions from lanes.yaml.
 * Single read, all 4 lanes evaluated together on every run.
 */
export function loadGlobalLanesConfig(): GlobalLanesConfig {
  const lanesPath = path.resolve(__dirname, "../../lanes.yaml");
  if (!fs.existsSync(lanesPath)) {
    throw new Error(`lanes.yaml not found at ${lanesPath}`);
  }
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(fs.readFileSync(lanesPath, "utf-8")) as GlobalLanesConfig;
}

export const loadLanesConfig = loadGlobalLanesConfig;

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

// ── Main ──────────────────────────────────────────────────────────────────────

// Export under old name for backward-compat with tests
export async function runLaneRouting(): Promise<{ routed: number; deferred: number }> {
  return runLaneRouter();
}

export async function runLaneRouter(): Promise<{ routed: number; deferred: number }> {
  console.log("Starting Semantic Lane Routing from authoritative lanes.yaml...");
  const config = loadGlobalLanesConfig();

  // Generate prototype embeddings for each lane
  const laneEmbeddings: Record<string, number[]> = {};
  for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
    laneEmbeddings[laneKey] = await generateEmbedding(laneDef.prototype_query);
  }

  // Use LATERAL join to get only the latest version's description
  const { rows: jobs } = await pool.query(`
    SELECT c.*, jv.description_text, jv.id AS latest_version_id
    FROM canonical_jobs c
    JOIN LATERAL (
      SELECT id, description_text
      FROM job_versions
      WHERE canonical_job_id = c.id
      ORDER BY observed_at DESC
      LIMIT 1
    ) jv ON TRUE
    WHERE c.processing_status = 'PREQUALIFIED'
  `);

  console.log(`Found ${jobs.length} canonical jobs to route.`);

  let routedCount = 0;
  let deferredCount = 0;

  const client = await pool.connect();
  try {
    for (const job of jobs) {
      await client.query("BEGIN");
      try {
        const jobText = `${job.normalized_title} ${job.description_text || ""}`;
        const jobEmbedding = await generateEmbedding(jobText);

        // Strict zero-vector check — embedding failure must not produce a default lane
        const isZeroVector = jobEmbedding.every((v) => v === 0);
        if (isZeroVector) {
          console.warn(`⚠️ Zero embedding for job ${job.id}. Deferring (never default lane).`);
          await client.query(
            `UPDATE canonical_jobs SET primary_lane = 'UNCLASSIFIED', semantic_score = 0.0, processing_status = 'ROUTING_DEFERRED', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );
          await client.query("COMMIT");
          deferredCount++;
          continue;
        }

        let bestLane: string | null = null;
        let bestScore = -1;
        const scoreMap: Record<string, number> = {};
        const laneEvidence: string[] = [];

        for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
          const score = cosineSimilarity(jobEmbedding, laneEmbeddings[laneKey]);
          scoreMap[laneKey] = score;
          if (score > bestScore) {
            bestScore = score;
            bestLane = laneKey;
          }
        }

        // Per-lane negative exclusion on best lane (only demotes if excluded in target lane)
        const descText = (job.description_text || "").toLowerCase();
        if (bestLane && config.lanes[bestLane] && applyNegativeExclusion(descText, config.lanes[bestLane])) {
          console.warn(`⚠️ Job ${job.id} excluded from ${bestLane} by negative_concepts. Re-scoring remaining lanes.`);
          scoreMap[bestLane] = -1;
          bestScore = -1;
          bestLane = null;
          for (const [laneKey, score] of Object.entries(scoreMap)) {
            if (score > bestScore) {
              bestScore = score;
              bestLane = laneKey;
            }
          }
        }

        // Per-lane threshold check: must meet the lane's own semantic_threshold or min_similarity_floor
        const bestLaneDef = bestLane ? config.lanes[bestLane] : null;
        const perLaneThreshold = bestLaneDef?.semantic_threshold ?? bestLaneDef?.threshold ?? (config.unclassified_policy.min_similarity_floor || 0.20);
        if (bestScore < perLaneThreshold || !bestLane) {
          bestLane = "UNCLASSIFIED";
        }

        // Secondary lanes: meet per-lane threshold, not negative-excluded, not the primary
        const secondaryLanes: string[] = [];
        for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
          if (laneKey === bestLane) continue;
          const threshold = laneDef.semantic_threshold ?? laneDef.threshold;
          if ((scoreMap[laneKey] || 0) >= threshold && !applyNegativeExclusion(descText, laneDef)) {
            secondaryLanes.push(laneKey);
            // Collect lane evidence from positive concepts
            if (laneDef.positive_concepts) {
              for (const pc of laneDef.positive_concepts) {
                if (descText.includes(pc.toLowerCase())) {
                  laneEvidence.push(`${laneKey}: "${pc}"`);
                  break; // one evidence per secondary lane
                }
              }
            }
          }
        }

        const processingStatus = bestLane === "UNCLASSIFIED" ? "ROUTING_DEFERRED" : "LANE_ROUTED";
        if (bestLane === "UNCLASSIFIED") deferredCount++; else routedCount++;

        await client.query(
          `UPDATE canonical_jobs
           SET primary_lane       = $1,
               semantic_score     = $2,
               processing_status  = $3,
               secondary_lanes    = $4,
               lane_evidence      = $5,
               updated_at         = NOW()
           WHERE id = $6`,
          [
            bestLane,
            bestScore,
            processingStatus,
            JSON.stringify(secondaryLanes),
            laneEvidence.join("; "),
            job.id
          ]
        );

        await client.query("COMMIT");
        console.log(`-> Routed ${job.normalized_title} to ${bestLane} (Score: ${bestScore.toFixed(3)}, Secondary: [${secondaryLanes.join(", ")}])`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`❌ Failed to route job ${job.id}:`, err);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`Lane Routing complete. Routed: ${routedCount}, Deferred: ${deferredCount}`);
  return { routed: routedCount, deferred: deferredCount };
}
