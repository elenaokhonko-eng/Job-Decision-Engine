import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { generateEmbedding } from "../services/agent.js";
import { MULTI_LANE_SCORECARDS, LANE_VOCABULARIES } from "../services/criteria.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

const cosineSimilarity = (vecA: number[], vecB: number[]) => {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

export async function runLaneRouting() {
  console.log("Starting Semantic Lane Routing...");
  
  // In a real app we'd load this from config/lanes/*.yml
  const lanePrototypes: Record<string, string> = {
    CORE_AI_DATA: MULTI_LANE_SCORECARDS.CORE_AI_DATA.description + " " + LANE_VOCABULARIES.CORE_AI_DATA.positive.join(" "),
    LEGAL_REGTECH: MULTI_LANE_SCORECARDS.LEGAL_REGTECH.description + " " + LANE_VOCABULARIES.LEGAL_REGTECH.positive.join(" "),
    HEALTH_BIO_PHARMA: MULTI_LANE_SCORECARDS.HEALTH_BIO_PHARMA.description + " " + LANE_VOCABULARIES.HEALTH_BIO_PHARMA.positive.join(" "),
    INVESTMENT_MARKETS_FINTECH: MULTI_LANE_SCORECARDS.INVESTMENT_MARKETS_FINTECH.description + " " + LANE_VOCABULARIES.INVESTMENT_MARKETS_FINTECH.positive.join(" ")
  };
  
  const laneEmbeddings: Record<string, number[]> = {};
  for (const lane of Object.keys(lanePrototypes)) {
    laneEmbeddings[lane] = await generateEmbedding(lanePrototypes[lane]);
  }

  const query = `
    SELECT c.*, jv.description_text 
    FROM canonical_jobs c
    JOIN job_versions jv ON jv.canonical_job_id = c.id
    WHERE c.processing_status = 'PREQUALIFIED'
  `;
  
  const { rows: jobs } = await pool.query(query);
  console.log(`Found ${jobs.length} canonical jobs to route.`);
  
  for (const job of jobs) {
    const jobText = `${job.normalized_title} ${job.description_text}`;
    const jobEmbedding = await generateEmbedding(jobText);
    
    let bestLane = "CORE_AI_DATA";
    let bestScore = -1;
    for (const lane of Object.keys(laneEmbeddings)) {
      const score = cosineSimilarity(jobEmbedding, laneEmbeddings[lane]);
      if (score > bestScore) {
        bestScore = score;
        bestLane = lane;
      }
    }
    
    await pool.query(
      `UPDATE canonical_jobs 
       SET primary_lane = $1, semantic_score = $2, processing_status = 'SEMANTIC_SHORTLISTED'
       WHERE id = $3`,
      [bestLane, bestScore, job.id]
    );
    
    console.log(`-> Routed ${job.normalized_title} to ${bestLane} (Score: ${bestScore.toFixed(3)})`);
  }
  
  console.log(`Lane Routing complete.`);
}
