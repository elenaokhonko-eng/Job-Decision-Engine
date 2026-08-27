import { db } from "../src/db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { runAgent } from "../src/services/agent.js";
import { EvaluationRequest } from "../src/pipeline/types.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

async function evaluateQueue() {
  console.log("====================================================");
  console.log("         STAGE 0: AI EVALUATION PROCESSOR           ");
  console.log("====================================================");

  const { rows: queueItems } = await pool.query(
    `SELECT eq.*, c.normalized_title, c.company_name, c.canonical_url, jv.description_text 
     FROM evaluation_queue eq
     JOIN canonical_jobs c ON eq.canonical_job_id = c.id
     JOIN job_versions jv ON jv.canonical_job_id = c.id
     WHERE eq.status = 'PENDING'
     ORDER BY eq.priority_score DESC`
  );

  console.log(`Found ${queueItems.length} items in the evaluation queue.`);

  for (const item of queueItems) {
    console.log(`\nEvaluating: [${item.lane}] ${item.normalized_title} at ${item.company_name}`);
    
    // Mark as evaluating
    await pool.query(
      `UPDATE evaluation_queue SET status = 'EVALUATING' WHERE id = $1`,
      [item.id]
    );

    const evalReq: EvaluationRequest = {
      canonicalJobId: item.canonical_job_id,
      jobVersionId: "v1", // Simplified for Stage 0
      gateDecisionId: "PASS",
      gateVersion: "1.0",
      candidateLanes: [{ lane: item.lane, semanticScore: item.priority_score, evidence: [] }],
      workabilityFacts: {
        locationEligibility: "PASS",
        officeDays: "UNKNOWN",
        travelPercentage: "UNKNOWN",
        isContract: false
      },
      unknownFields: [],
      profileVersion: "1.0",
      evaluationSchemaVersion: "1.0"
    };

    const evalQuery = `
      Evaluate the following job according to the structured EvaluationRequest schema.
      Request Metadata: ${JSON.stringify(evalReq)}
      
      Job Title: ${item.normalized_title}
      Company: ${item.company_name}
      URL: ${item.canonical_url}
      Description:
      ${item.description_text}
    `;

    try {
      const { result } = await runAgent(evalQuery);
      const evalResult = result.evaluated_jobs?.[0];
      
      if (evalResult) {
        console.log(`  -> AI Evaluation complete: Confidence = ${evalResult.lane_confidence}, Action = ${evalResult.next_action}`);
        
        await pool.query(
          `UPDATE canonical_jobs 
           SET processing_status = 'AI_EVALUATED'
           WHERE id = $1`,
          [item.canonical_job_id]
        );
        
        // We could store the full JSON result in a new ai_evaluations table.
        // For Stage 0, we just mark the queue item completed.
        await pool.query(
          `UPDATE evaluation_queue SET status = 'COMPLETED' WHERE id = $1`,
          [item.id]
        );
      }
    } catch (err: any) {
      console.error(`❌ Evaluation failed for queue item ${item.id}:`, err.message);
      await pool.query(
        `UPDATE evaluation_queue SET status = 'FAILED' WHERE id = $1`,
        [item.id]
      );
    }
  }

  console.log(`\n✅ Queue evaluation complete.`);
  process.exit(0);
}

evaluateQueue();
