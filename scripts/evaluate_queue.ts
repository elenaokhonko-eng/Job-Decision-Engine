import pg from "pg";
import dotenv from "dotenv";
import { runAgent } from "../src/services/agent.js";
import { EvaluationRequest } from "../src/pipeline/types.js";
import { EvaluationResultSchema, EvaluationResult, SCHEMA_VERSION } from "../src/contracts/index.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

export async function evaluateQueue(): Promise<{ processed: number; failed: number; manualReview: number }> {
  console.log("====================================================");
  console.log("         STAGE 0: AI EVALUATION PROCESSOR           ");
  console.log("====================================================");

  const client = await pool.connect();
  let processedCount = 0;
  let failedCount = 0;
  let manualReviewCount = 0;

  try {
    // 1. Fetch pending, retry-wait, or expired lease items in evaluation queue
    const { rows: queueItems } = await client.query(
      `SELECT eq.*, c.normalized_title, c.company_name, c.canonical_url, jv.description_text 
       FROM evaluation_queue eq
       JOIN canonical_jobs c ON eq.canonical_job_id = c.id
       LEFT JOIN LATERAL (
         SELECT description_text 
         FROM job_versions 
         WHERE canonical_job_id = c.id 
         ORDER BY observed_at DESC 
         LIMIT 1
       ) jv ON TRUE
       WHERE eq.status IN ('PENDING', 'RETRY_WAIT')
          OR (eq.status = 'EVALUATING' AND eq.lease_expires_at < NOW())
       ORDER BY eq.priority_score DESC`
    );

    console.log(`Found ${queueItems.length} items eligible for AI evaluation.`);

    for (const item of queueItems) {
      console.log(`\nEvaluating: [${item.lane}] ${item.normalized_title} at ${item.company_name}`);

      // Check max attempts limit -> route to NEEDS_MANUAL_REVIEW
      if (item.attempt_count >= (item.max_attempts || 3)) {
        console.warn(`⚠️ Maximum attempts (${item.max_attempts || 3}) exhausted for job ${item.canonical_job_id}. Moving to NEEDS_MANUAL_REVIEW.`);
        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE evaluation_queue 
             SET status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW() 
             WHERE id = $1`,
            [item.id]
          );
          await client.query(
            `UPDATE canonical_jobs 
             SET processing_status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW() 
             WHERE id = $1`,
            [item.canonical_job_id]
          );
          await client.query("COMMIT");
          manualReviewCount++;
        } catch (mErr) {
          await client.query("ROLLBACK");
          throw mErr;
        }
        continue;
      }

      // Acquire exclusive lease for this worker item
      const { rows: leaseRows } = await client.query(
        `UPDATE evaluation_queue 
         SET status = 'EVALUATING',
             lease_id = gen_random_uuid(),
             lease_expires_at = NOW() + INTERVAL '5 minutes',
             attempt_count = attempt_count + 1,
             updated_at = NOW()
         WHERE id = $1 
           AND (status IN ('PENDING', 'RETRY_WAIT') OR (status = 'EVALUATING' AND lease_expires_at < NOW()))
         RETURNING *`,
        [item.id]
      );

      if (leaseRows.length === 0) {
        console.log(`Item ${item.id} already leased by another worker. Skipping.`);
        continue;
      }

      const activeLease = leaseRows[0];
      const attemptNum = activeLease.attempt_count;

      const evalReq: EvaluationRequest = {
        canonicalJobId: item.canonical_job_id,
        jobVersionId: item.job_version_id || "v1",
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
        evaluationSchemaVersion: SCHEMA_VERSION
      };

      const evalQuery = `
        Evaluate the following job according to the structured EvaluationRequest schema.
        Request Metadata: ${JSON.stringify(evalReq)}
        
        Job Title: ${item.normalized_title}
        Company: ${item.company_name}
        URL: ${item.canonical_url}
        Description:
        ${item.description_text || "No description provided."}
      `;

      try {
        const { result, toolsUsed } = await runAgent(evalQuery);
        const evalResult = result.evaluated_jobs?.[0];

        if (!evalResult) {
          throw new Error("Missing evaluated_jobs in AI output");
        }

        // Validate output structure
        const validatedResult: EvaluationResult = EvaluationResultSchema.parse({
          schema_version: SCHEMA_VERSION,
          canonical_job_id: item.canonical_job_id,
          job_version_id: item.job_version_id || "v1",
          pipeline_run_id: "00000000-0000-0000-0000-000000000000",
          provider: process.env.FORCE_OPENAI === "true" ? "openai" : "gemini",
          model: process.env.OPENAI_MODEL || process.env.GEMINI_MODEL || "gemini-1.5-flash",
          attempt: attemptNum,
          is_fallback: false,
          degraded_state: false,
          evaluation_summary: result.evaluation_summary || "Automated multi-lane AI evaluation",
          primary_lane: evalResult.primary_lane,
          secondary_lanes: evalResult.secondary_lanes || [],
          lane_confidence: evalResult.lane_confidence || "Medium",
          lane_evidence: evalResult.lane_evidence || "",
          nd_score: evalResult.nd_score || 50,
          nd_friendly_score: evalResult.nd_friendly_score || 50,
          politics_stress_score: evalResult.politics_stress_score || 50,
          sensory_overload_index: evalResult.sensory_overload_index || 50,
          building_research_ratio: evalResult.building_research_ratio || 50,
          interaction_load: evalResult.interaction_load || 50,
          rejection_codes: evalResult.rejection_codes || [],
          strategic_value: evalResult.strategic_value || "",
          recommended_cv_version: evalResult.recommended_cv_version || "CORE_AI_DATA",
          next_action: evalResult.next_action as any,
          evaluated_at: new Date().toISOString()
        });

        console.log(`  -> AI Evaluation complete: Confidence = ${validatedResult.lane_confidence}, Action = ${validatedResult.next_action}`);

        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE canonical_jobs 
             SET processing_status = 'AI_EVALUATED', updated_at = NOW()
             WHERE id = $1`,
            [item.canonical_job_id]
          );

          await client.query(
            `INSERT INTO ai_evaluations (
              canonical_job_id, job_version_id, gate_decision, gate_version,
              lane_matches, workability_facts, unknown_fields, profile_version, evaluation_schema_version,
              provider, model, attempt, is_fallback, degraded_state, full_evaluation_payload, evaluated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
            [
              item.canonical_job_id,
              item.job_version_id || "v1",
              "PASS",
              "1.0",
              JSON.stringify([{ lane: item.lane, semanticScore: item.priority_score, evidence: validatedResult.lane_evidence }]),
              JSON.stringify(evalReq.workabilityFacts),
              JSON.stringify([]),
              "1.0",
              SCHEMA_VERSION,
              validatedResult.provider,
              validatedResult.model,
              validatedResult.attempt,
              validatedResult.is_fallback,
              validatedResult.degraded_state,
              JSON.stringify(validatedResult)
            ]
          );

          await client.query(
            `UPDATE evaluation_queue 
             SET status = 'COMPLETED', lease_id = NULL, lease_expires_at = NULL, updated_at = NOW() 
             WHERE id = $1`,
            [item.id]
          );

          await client.query("COMMIT");
          processedCount++;
        } catch (txErr) {
          await client.query("ROLLBACK");
          throw txErr;
        }
      } catch (err: any) {
        console.error(`❌ Evaluation failed for queue item ${item.id}:`, err.message || err);
        failedCount++;

        // Transition to RETRY_WAIT for recoverable failure (never career rejection)
        await client.query(
          `UPDATE evaluation_queue 
           SET status = 'RETRY_WAIT', last_error = $1, lease_id = NULL, lease_expires_at = NULL, updated_at = NOW() 
           WHERE id = $2`,
          [err.message || String(err), item.id]
        );
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n✅ Queue evaluation complete. Processed: ${processedCount}, Retrying: ${failedCount}, Manual Review: ${manualReviewCount}`);
  return { processed: processedCount, failed: failedCount, manualReview: manualReviewCount };
}

if (process.argv[1] && process.argv[1].includes("evaluate_queue")) {
  evaluateQueue()
    .then((stats) => {
      if (stats.failed > 0 && stats.processed === 0 && stats.manualReview === 0) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal queue evaluation error:", err);
      process.exit(1);
    });
}
