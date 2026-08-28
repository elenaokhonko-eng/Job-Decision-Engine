import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { generateEmbedding } from "../services/agent.js";
import { LaneDecision, SCHEMA_VERSION } from "../contracts/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

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

interface LanesConfig {
  lanes: Record<
    string,
    {
      title: string;
      description: string;
      threshold: number;
      keywords: string[];
      prototype_query: string;
    }
  >;
  unclassified_policy: {
    label: string;
    fallback_behavior: string;
    min_similarity_floor: number;
  };
}

export function loadLanesConfig(): LanesConfig {
  const lanesPath = path.resolve(__dirname, "../../lanes.yaml");
  if (!fs.existsSync(lanesPath)) {
    throw new Error(`lanes.yaml not found at ${lanesPath}`);
  }
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(fs.readFileSync(lanesPath, "utf-8")) as LanesConfig;
}

export async function runLaneRouting(): Promise<{ routed: number; deferred: number }> {
  console.log("Starting Semantic Lane Routing from lanes.yaml...");
  const config = loadLanesConfig();

  // Generate prototype embeddings for each lane
  const laneEmbeddings: Record<string, number[]> = {};
  for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
    laneEmbeddings[laneKey] = await generateEmbedding(laneDef.prototype_query);
  }

  const query = `
    SELECT c.*, jv.description_text 
    FROM canonical_jobs c
    JOIN job_versions jv ON jv.canonical_job_id = c.id
    WHERE c.processing_status = 'PREQUALIFIED'
  `;
  
  const { rows: jobs } = await pool.query(query);
  console.log(`Found ${jobs.length} canonical jobs to route.`);
  
  let routedCount = 0;
  let deferredCount = 0;

  const client = await pool.connect();
  try {
    for (const job of jobs) {
      await client.query("BEGIN");
      try {
        const jobText = `${job.normalized_title} ${job.description_text}`;
        const jobEmbedding = await generateEmbedding(jobText);
        
        // Detect zero vector (failed embedding) -> do NOT default to CORE_AI_DATA
        const isZeroVector = jobEmbedding.every((v) => v === 0);
        if (isZeroVector) {
          console.warn(`⚠️ Zero embedding detected for job ${job.id}. Deferring routing (never default to Core AI).`);
          await client.query(
            `UPDATE canonical_jobs 
             SET primary_lane = 'UNCLASSIFIED', semantic_score = 0.0, processing_status = 'ROUTING_DEFERRED', updated_at = NOW()
             WHERE id = $1`,
            [job.id]
          );
          await client.query("COMMIT");
          deferredCount++;
          continue;
        }

        let bestLane: string | null = null;
        let bestScore = -1;
        const secondaryLanes: string[] = [];
        const scoreMap: Record<string, number> = {};

        for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
          const score = cosineSimilarity(jobEmbedding, laneEmbeddings[laneKey]);
          scoreMap[laneKey] = score;

          if (score > bestScore) {
            bestScore = score;
            bestLane = laneKey;
          }
        }

        // Check if top score meets minimum similarity floor
        const minFloor = config.unclassified_policy.min_similarity_floor || 0.20;
        if (bestScore < minFloor || !bestLane) {
          bestLane = "UNCLASSIFIED";
        }

        // Secondary lanes match
        for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
          if (laneKey !== bestLane && (scoreMap[laneKey] || 0) >= laneDef.threshold) {
            secondaryLanes.push(laneKey);
          }
        }

        const processingStatus = bestLane === "UNCLASSIFIED" ? "ROUTING_DEFERRED" : "SEMANTIC_SHORTLISTED";
        if (bestLane === "UNCLASSIFIED") deferredCount++; else routedCount++;

        await client.query(
          `UPDATE canonical_jobs 
           SET primary_lane = $1, semantic_score = $2, processing_status = $3, updated_at = NOW()
           WHERE id = $4`,
          [bestLane, bestScore, processingStatus, job.id]
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
