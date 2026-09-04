import pg from "pg";
import dotenv from "dotenv";
import crypto from "crypto";
import { EvaluationRequest } from "../src/pipeline/types.js";
import { EvaluationResultSchema, EvaluationResult, SCHEMA_VERSION, toEvaluationWorkabilityFacts } from "../src/contracts/index.js";
import { GATE_VERSION, PROFILE_SCHEMA_VERSION } from "../src/contracts/version.js";
import { pgSslConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

/** Exponential backoff: 30s, 60s, 120s, … capped at 30 minutes */
function nextAvailableAt(attemptCount: number): string {
  const backoffSeconds = Math.min(30 * Math.pow(2, attemptCount), 1800);
  return `NOW() + INTERVAL '${backoffSeconds} seconds'`;
}

export async function evaluateQueue(): Promise<{ processed: number; failed: number; manualReview: number }> {
  console.log("====================================================");
  console.log("         STAGE 0: AI EVALUATION PROCESSOR           ");
  console.log("====================================================");

  const { evaluateSingleCanonicalJob, checkModelRegistryPreflight } = await import("../src/services/agent.js");

  const pipelineRunId = crypto.randomUUID();
  const client = await pool.connect();
  let processedCount = 0;
  let failedCount = 0;
  let manualReviewCount = 0;

  try {
    const preflight = checkModelRegistryPreflight();
    if (!preflight.ok) {
      throw new Error(`Model registry preflight failed: ${preflight.warnings.join(" | ")}`);
    }

    const ctx: WorkspaceContext = await resolveWorkspaceContext(client as any);

    // 1. Fetch eligible items: PENDING, RETRY_WAIT where available_at has elapsed, or expired leases
    // Join strictly to evaluation_queue.job_version_id and gate_decisions for the same job_version_id (invariant: never substitute latest version during retry)
    const { rows: queueItems } = await client.query(
      `SELECT eq.*, c.normalized_title, c.company_name, c.canonical_url,
              c.gate_decision, c.workability_facts,
              jv.description_text, eq.job_version_id AS resolved_job_version_id,
              gd.id AS resolved_gate_decision_id
       FROM evaluation_queue eq
       JOIN canonical_jobs c
         ON c.id = eq.canonical_job_id
        AND c.workspace_id = eq.workspace_id
       JOIN job_versions jv
         ON jv.id = eq.job_version_id
        AND jv.workspace_id = eq.workspace_id
       LEFT JOIN gate_decisions gd
         ON gd.workspace_id = eq.workspace_id
        AND gd.canonical_job_id = eq.canonical_job_id
        AND gd.job_version_id = eq.job_version_id
       WHERE eq.workspace_id = $1
         AND (
           (eq.status = 'PENDING')
           OR (eq.status = 'RETRY_WAIT' AND (eq.available_at IS NULL OR eq.available_at <= NOW()))
           OR (eq.status = 'EVALUATING' AND eq.lease_expires_at < NOW())
         )
       ORDER BY eq.priority_score DESC`,
      [ctx.workspaceId]
    );

    console.log(`Found ${queueItems.length} items eligible for AI evaluation. Pipeline run: ${pipelineRunId}`);

    for (const item of queueItems) {
      console.log(`\nEvaluating: [${item.lane}] ${item.normalized_title} at ${item.company_name}`);

      // Check max attempts → NEEDS_MANUAL_REVIEW
      if (item.attempt_count >= (item.max_attempts || 3)) {
        console.warn(`⚠️ Maximum attempts (${item.max_attempts || 3}) exhausted for job ${item.canonical_job_id}. Moving to NEEDS_MANUAL_REVIEW.`);
        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE evaluation_queue
             SET status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2`,
            [ctx.workspaceId, item.id]
          );
          await client.query(
            `UPDATE canonical_jobs
             SET processing_state = 'NEEDS_MANUAL_REVIEW',
                 processing_status = 'NEEDS_MANUAL_REVIEW',
                 updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2`,
            [ctx.workspaceId, item.canonical_job_id]
          );
          await client.query("COMMIT");
          manualReviewCount++;
        } catch (mErr) {
          await client.query("ROLLBACK");
          throw mErr;
        }
        continue;
      }

      // Acquire exclusive 5-minute worker lease
      const { rows: leaseRows } = await client.query(
        `UPDATE evaluation_queue
         SET status = 'EVALUATING',
             lease_id = gen_random_uuid(),
             lease_expires_at = NOW() + INTERVAL '5 minutes',
             attempt_count = attempt_count + 1,
             updated_at = NOW()
         WHERE id = $1
           AND workspace_id = $2
           AND (status IN ('PENDING', 'RETRY_WAIT') OR (status = 'EVALUATING' AND lease_expires_at < NOW()))
         RETURNING *`,
        [item.id, ctx.workspaceId]
      );

      if (leaseRows.length === 0) {
        console.log(`Item ${item.id} already leased by another worker. Skipping.`);
        continue;
      }

      const activeLease = leaseRows[0];
      const attemptNum = activeLease.attempt_count;

      // Strictly bound to the queue item's job_version_id
      const jobVersionId: string = item.job_version_id;
      if (!jobVersionId) {
        console.warn(`⚠️ No job_version_id found for canonical job ${item.canonical_job_id}. Moving to RETRY_WAIT.`);
        failedCount++;
        await client.query(
          `UPDATE evaluation_queue SET status = 'RETRY_WAIT', last_error = $1,
           available_at = ${nextAvailableAt(attemptNum)}, lease_id = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE workspace_id = $2 AND id = $3`,
          ["No job_version found", ctx.workspaceId, item.id]
        );
        continue;
      }

      // Resolve gate decision ID for the same job version
      const gateDecisionId: string | null = item.resolved_gate_decision_id || null;

      const evalReq: EvaluationRequest = {
        canonicalJobId: item.canonical_job_id,
        jobVersionId,
        gateDecisionId: gateDecisionId || "LEGACY_NO_GATE_RECORD",
        gateVersion: GATE_VERSION,
        candidateLanes: [{ lane: item.lane, semanticScore: item.priority_score, evidence: [] }],
        workabilityFacts: toEvaluationWorkabilityFacts(item.workability_facts || {
          office_days_min: null,
          office_days_max: null,
          travel_pct_max: null,
          employment_type: "UNKNOWN",
          location_restriction: null
        }),
        unknownFields: [],
        profileVersion: PROFILE_SCHEMA_VERSION,
        evaluationSchemaVersion: SCHEMA_VERSION
      };

      try {
        const evalExecution = await evaluateSingleCanonicalJob(
          {
            canonicalJobId: item.canonical_job_id,
            jobVersionId,
            normalizedTitle: item.normalized_title,
            companyName: item.company_name,
            canonicalUrl: item.canonical_url,
            descriptionText: item.description_text || "No description provided.",
            gateDecisionId,
            gateDecision: item.gate_decision || "PASS",
            candidateLane: item.lane,
            priorityScore: item.priority_score,
            workabilityFacts: evalReq.workabilityFacts
          },
          pipelineRunId,
          attemptNum
        );

        const validatedResult: EvaluationResult = EvaluationResultSchema.parse(evalExecution.evaluatedJob);

        console.log(`  -> AI Evaluation complete: Provider = ${validatedResult.provider} (${validatedResult.model}), Confidence = ${validatedResult.lane_confidence}, Action = ${validatedResult.next_action}, Fallback = ${validatedResult.is_fallback}`);

        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE canonical_jobs
             SET processing_state = 'AI_EVALUATED',
                 processing_status = 'AI_EVALUATED',
                 updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2`,
            [ctx.workspaceId, item.canonical_job_id]
          );

          await client.query(
            `INSERT INTO ai_evaluations (
              workspace_id,
              canonical_job_id, job_version_id, gate_decision, gate_version,
              lane_matches, workability_facts, unknown_fields, profile_version, evaluation_schema_version,
              provider, model, attempt, is_fallback, degraded_state, full_evaluation_payload, evaluated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())`,
            [
              ctx.workspaceId,
              item.canonical_job_id,
              jobVersionId,
              item.gate_decision || "PASS",
              GATE_VERSION,
              JSON.stringify([{ lane: item.lane, semanticScore: item.priority_score, evidence: validatedResult.lane_evidence }]),
              JSON.stringify(item.workability_facts || {}),
              JSON.stringify([]),
              PROFILE_SCHEMA_VERSION,
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
            `INSERT INTO evaluation_attempts (
               workspace_id, canonical_job_id, job_version_id, attempt_number, provider, model, status, error_message, latency_ms
             ) VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', NULL, NULL)`,
            [
              ctx.workspaceId,
              item.canonical_job_id,
              jobVersionId,
              attemptNum,
              validatedResult.provider,
              validatedResult.model
            ]
          );

          await client.query(
            `UPDATE evaluation_queue
             SET status = 'COMPLETED', lease_id = NULL, lease_expires_at = NULL, available_at = NULL, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2`,
            [ctx.workspaceId, item.id]
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

        await client.query(
          `INSERT INTO evaluation_attempts (
             workspace_id, canonical_job_id, job_version_id, attempt_number, provider, model, status, error_message, latency_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED', $7, NULL)`,
          [
            ctx.workspaceId,
            item.canonical_job_id,
            jobVersionId,
            attemptNum,
            item.attempt_count > 0 ? "fallback-chain" : "primary-chain",
            "unknown",
            err.message || String(err)
          ]
        );

        // Transition to RETRY_WAIT with exponential backoff (never career-rejects)
        const availableAtExpr = nextAvailableAt(attemptNum);
        await client.query(
          `UPDATE evaluation_queue
           SET status = 'RETRY_WAIT',
               last_error = $1,
               available_at = ${availableAtExpr},
               lease_id = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE workspace_id = $2 AND id = $3`,
          [err.message || String(err), ctx.workspaceId, item.id]
        );
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  const summary = `\n✅ Queue evaluation complete. Processed: ${processedCount}, Retrying: ${failedCount}, Manual Review: ${manualReviewCount}`;
  console.log(summary);
  return { processed: processedCount, failed: failedCount, manualReview: manualReviewCount };
}

if (process.argv[1] && process.argv[1].includes("evaluate_queue")) {
  evaluateQueue()
    .then((stats) => {
      const strictExitOnRetryWait = process.env.EVALUATION_EXIT_ON_RETRY_WAIT !== "false";
      if (stats.failed > 0 && strictExitOnRetryWait) {
        // Invariant 7: exit non-zero when any required stage fails
        console.error(`❌ ${stats.failed} evaluation(s) failed and were moved to RETRY_WAIT. Exiting non-zero.`);
        process.exit(1);
      }
      if (stats.failed > 0 && !strictExitOnRetryWait) {
        console.warn(`⚠️ ${stats.failed} evaluation(s) moved to RETRY_WAIT; exiting zero for retry-drain worker mode.`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal queue evaluation error:", err);
      process.exit(1);
    });
}
