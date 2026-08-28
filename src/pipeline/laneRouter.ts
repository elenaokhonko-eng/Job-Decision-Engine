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

interface LaneConfig {
  lane: string;
  description: string;
  positive_concepts: string[];
  negative_concepts: string[];
  semantic_threshold: number;
  prototype_query?: string;
}

interface GlobalLanesConfig {
  lanes: Record<string, {
    title: string;
    description: string;
    threshold: number;
    keywords: string[];
    prototype_query: string;
  }>;
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

// ── Config loaders ────────────────────────────────────────────────────────────

export function loadGlobalLanesConfig(): GlobalLanesConfig {
  const lanesPath = path.resolve(__dirname, "../../lanes.yaml");
  if (!fs.existsSync(lanesPath)) {
    throw new Error(`lanes.yaml not found at ${lanesPath}`);
  }
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(fs.readFileSync(lanesPath, "utf-8")) as GlobalLanesConfig;
}

/**
 * Load per-lane YAML configs from config/lanes/.
 * Each file contains positive_concepts, negative_concepts, and a semantic_threshold.
 * Falls back to empty lists if directory does not exist.
 */
export function loadPerLaneConfigs(): Map<string, LaneConfig> {
  const laneConfigDir = path.resolve(__dirname, "../../config/lanes");
  const configs = new Map<string, LaneConfig>();

  if (!fs.existsSync(laneConfigDir)) {
    console.warn(`⚠️ config/lanes/ directory not found at ${laneConfigDir}. Per-lane exclusions not applied.`);
    return configs;
  }

  for (const file of fs.readdirSync(laneConfigDir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const raw = fs.readFileSync(path.join(laneConfigDir, file), "utf-8");
    const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
    const parsed = loadFn(raw) as LaneConfig;
    if (parsed?.lane) {
      configs.set(parsed.lane, parsed);
    }
  }

  return configs;
}

// ── Keyword negative-concept exclusion ────────────────────────────────────────

function applyNegativeExclusion(description: string, laneKey: string, perLaneConfigs: Map<string, LaneConfig>): boolean {
  const laneConfig = perLaneConfigs.get(laneKey);
  if (!laneConfig?.negative_concepts?.length) return false;

  const d = description.toLowerCase();
  for (const nc of laneConfig.negative_concepts) {
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
  console.log("Starting Semantic Lane Routing from lanes.yaml + config/lanes/...");
  const config = loadGlobalLanesConfig();
  const perLaneConfigs = loadPerLaneConfigs();

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

        // Strict zero-vector check — embedding failure must not produce a CORE_AI_DATA default
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
        if (bestLane && applyNegativeExclusion(descText, bestLane, perLaneConfigs)) {
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

        // Per-lane threshold check: must meet the lane's own semantic_threshold
        const laneCfg = perLaneConfigs.get(bestLane || "");
        const perLaneThreshold = laneCfg?.semantic_threshold ?? (config.unclassified_policy.min_similarity_floor || 0.20);
        if (bestScore < perLaneThreshold || !bestLane) {
          bestLane = "UNCLASSIFIED";
        }

        // Secondary lanes: meet per-lane threshold, not negative-excluded, not the primary
        const secondaryLanes: string[] = [];
        for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
          if (laneKey === bestLane) continue;
          const lc = perLaneConfigs.get(laneKey);
          const threshold = lc?.semantic_threshold ?? laneDef.threshold;
          if ((scoreMap[laneKey] || 0) >= threshold && !applyNegativeExclusion(descText, laneKey, perLaneConfigs)) {
            secondaryLanes.push(laneKey);
            // Collect lane evidence from positive concepts
            if (lc?.positive_concepts) {
              for (const pc of lc.positive_concepts) {
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

// Backward-compat alias used by calibration.test.ts and other callers
export const loadLanesConfig = loadGlobalLanesConfig;
