import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { buildPipelineTaskContextFingerprint } from "../src/pipeline/artifactContext.js";
import {
  classifyRepairCategory,
  type RepairCategory,
} from "../src/pipeline/repairClassification.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import { aggregateVerificationQuestions } from "../src/services/verificationQuestionService.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

export interface RepairCandidate {
  canonical_job_id: string;
  job_version_id: string;
  processing_state: string;
  gate_decision: string | null;
  primary_lane: string | null;
  rejection_reason: string | null;
  rejection_reason_codes?: string[] | null;
  evidence_quotes?: string[] | null;
  profile_match_status?: string | null;
  has_missing_embeddings?: boolean;
  has_complete_prior_version?: boolean;
  complete_version_id?: string | null;
  category: RepairCategory;
}

type RepairCandidateRow = Omit<RepairCandidate, "category">;

function parseArgs(argv: string[]): { apply: boolean; workspaceKey?: string; userKey?: string } {
  const args = { apply: false } as { apply: boolean; workspaceKey?: string; userKey?: string };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    if (arg === "--workspace-key" && argv[i + 1]) args.workspaceKey = argv[++i];
    if (arg === "--user-key" && argv[i + 1]) args.userKey = argv[++i];
  }
  return args;
}

export async function loadCandidates(
  client: pg.PoolClient,
  context: WorkspaceContext
): Promise<RepairCandidate[]> {
  const { rows } = await client.query<RepairCandidateRow>(
    `
      WITH authoritative_versions AS (
        SELECT
          c.id AS canonical_job_id,
          jv.id AS job_version_id,
          jv.active_requirement_set_id,
          LENGTH(COALESCE(jv.description_text, '')) AS desc_len
        FROM canonical_jobs c
        JOIN LATERAL (
          SELECT jv.*
          FROM job_versions jv
          WHERE jv.workspace_id = c.workspace_id
            AND jv.canonical_job_id = c.id
            AND (c.latest_job_version_id IS NULL OR jv.id = c.latest_job_version_id)
          ORDER BY
            (jv.id = c.latest_job_version_id) DESC,
            jv.observed_at DESC,
            jv.id DESC
          LIMIT 1
        ) jv ON TRUE
        WHERE c.workspace_id = $1
      ),
      prior_complete_versions AS (
        SELECT DISTINCT ON (jv.canonical_job_id)
               jv.canonical_job_id,
               jv.id AS complete_version_id
        FROM job_versions jv
        JOIN authoritative_versions av
          ON av.canonical_job_id = jv.canonical_job_id
         AND av.job_version_id <> jv.id
        WHERE jv.workspace_id = $1
          AND LENGTH(COALESCE(jv.description_text, '')) >= 1000
        ORDER BY jv.canonical_job_id, jv.observed_at DESC, jv.id DESC
      ),
      active_profile_version AS (
        SELECT pv.id
        FROM profile_versions pv
        WHERE pv.workspace_id = $1
          AND pv.status = 'ACTIVE'
        ORDER BY pv.created_at DESC, pv.id DESC
        LIMIT 1
      ),
      active_profile_inputs AS (
        SELECT DISTINCT COALESCE(pf.fact_revision_id, pf.id) AS source_id
        FROM profile_facts pf
        JOIN active_profile_version apv ON apv.id = pf.profile_version_id
        WHERE pf.workspace_id = $1
      ),
      active_job_requirements AS (
        SELECT av.canonical_job_id, av.job_version_id, jr.id AS source_id
        FROM authoritative_versions av
        JOIN job_requirements jr
          ON jr.workspace_id = $1
         AND jr.job_version_id = av.job_version_id
         AND jr.status = 'VALIDATED'
         AND av.active_requirement_set_id IS NOT NULL
         AND jr.requirement_set_id = av.active_requirement_set_id
      ),
      usable_embedding_spaces AS (
        SELECT es.id, es.dimensions
        FROM embedding_spaces es
        WHERE es.workspace_id = $1
          AND es.active = TRUE
          AND es.dimensions > 0
      ),
      ready_embedding_spaces AS (
        SELECT av.canonical_job_id, av.job_version_id, ues.id AS embedding_space_id
        FROM authoritative_versions av
        CROSS JOIN usable_embedding_spaces ues
        WHERE EXISTS (
          SELECT 1
          FROM active_job_requirements ajr
          WHERE ajr.canonical_job_id = av.canonical_job_id
            AND ajr.job_version_id = av.job_version_id
        )
          AND EXISTS (SELECT 1 FROM active_profile_inputs)
          AND NOT EXISTS (
            SELECT 1
            FROM active_job_requirements ajr
            WHERE ajr.canonical_job_id = av.canonical_job_id
              AND ajr.job_version_id = av.job_version_id
              AND NOT EXISTS (
                SELECT 1
                FROM embedding_inputs ei
                JOIN v_published_semantic_embeddings se
                  ON se.workspace_id = ei.workspace_id
                 AND se.embedding_input_id = ei.id
                 AND se.embedding_space_id = ues.id
                WHERE ei.workspace_id = $1
                  AND ei.is_current = TRUE
                  AND ei.source_type = 'JOB_REQUIREMENT'
                  AND ei.source_id = ajr.source_id
                  AND se.vector_dimensions = ues.dimensions
                  AND cardinality(se.embedding_values) = ues.dimensions
                  AND cardinality(se.embedding_values) > 0
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM active_profile_inputs api
            WHERE NOT EXISTS (
              SELECT 1
              FROM embedding_inputs ei
              JOIN v_published_semantic_embeddings se
                ON se.workspace_id = ei.workspace_id
               AND se.embedding_input_id = ei.id
               AND se.embedding_space_id = ues.id
              WHERE ei.workspace_id = $1
                AND ei.is_current = TRUE
                AND ei.source_type = 'PROFILE_FACT'
                AND ei.source_id = api.source_id
                AND se.vector_dimensions = ues.dimensions
                AND cardinality(se.embedding_values) = ues.dimensions
                AND cardinality(se.embedding_values) > 0
            )
          )
      ),
      latest_gate_decisions AS (
        SELECT DISTINCT ON (gd.canonical_job_id)
               gd.canonical_job_id,
               gd.rejection_codes
        FROM gate_decisions gd
        JOIN canonical_jobs c
          ON c.id = gd.canonical_job_id
         AND c.workspace_id = $1
        ORDER BY gd.canonical_job_id, gd.created_at DESC, gd.id DESC
      )
      SELECT
        c.id AS canonical_job_id,
        av.job_version_id,
        COALESCE(c.processing_state, c.processing_status) AS processing_state,
        c.gate_decision,
        c.primary_lane,
        c.rejection_reason,
        COALESCE(lgd.rejection_codes, '[]'::jsonb) AS rejection_reason_codes,
        c.gate_evidence_quotes AS evidence_quotes,
        c.profile_match_status,
        NOT EXISTS (
          SELECT 1
          FROM ready_embedding_spaces res
          WHERE res.canonical_job_id = av.canonical_job_id
            AND res.job_version_id = av.job_version_id
        ) AS has_missing_embeddings,
        (
          av.desc_len < 1000
          AND pcv.complete_version_id IS NOT NULL
          AND pcv.complete_version_id <> av.job_version_id
        ) AS has_complete_prior_version,
        pcv.complete_version_id
      FROM canonical_jobs c
      JOIN authoritative_versions av ON av.canonical_job_id = c.id
      LEFT JOIN prior_complete_versions pcv ON pcv.canonical_job_id = c.id
      LEFT JOIN latest_gate_decisions lgd ON lgd.canonical_job_id = c.id
      WHERE c.workspace_id = $1
        AND (
          COALESCE(c.processing_state, c.processing_status) IN (
            'NEEDS_MANUAL_REVIEW', 'HARD_REJECTED', 'RAW_STAGED', 'MATCHED', 'DECIDED', 'LANE_ROUTED'
          )
          OR (
            av.desc_len < 1000
            AND pcv.complete_version_id IS NOT NULL
            AND pcv.complete_version_id <> av.job_version_id
          )
        )
      ORDER BY c.created_at, c.id
    `,
    [context.workspaceId]
  );
  return rows
    .map((row): RepairCandidate | null => {
      const category = classifyRepairCategory(row);
      return category ? { ...row, category } : null;
    })
    .filter((row): row is RepairCandidate => row !== null);
}

async function activeProfileVersionId(client: pg.PoolClient, context: WorkspaceContext): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
     FROM profile_versions
     WHERE workspace_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT 1`,
    [context.workspaceId]
  );
  if (!rows[0]?.id) throw new Error(`No ACTIVE profile version found for workspace_id=${context.workspaceId}.`);
  return rows[0].id;
}

async function insertRepairEvent(
  client: pg.PoolClient,
  context: WorkspaceContext,
  candidate: RepairCandidate,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO pipeline_stage_events (
       workspace_id, canonical_job_id, job_version_id, stage,
       transition_from, transition_to, event_type, error_message, payload
     )
     VALUES ($1, $2, $3, 'GATE_EVALUATED', NULL, 'COMPLETED', 'STAGE_COMPLETED', NULL, $4::jsonb)`,
    [context.workspaceId, candidate.canonical_job_id, candidate.job_version_id, JSON.stringify(payload)]
  );
}

async function enqueueRepairTask(
  client: pg.PoolClient,
  context: WorkspaceContext,
  candidate: RepairCandidate,
  taskType: "APPLY_HARD_GATES" | "EXTRACT_DETERMINISTIC_REQUIREMENTS" | "EXTRACT_QUOTED_REQUIREMENTS" | "PUBLISH_EMBEDDING" | "ROUTE_LANE" | "MATCH_PROFILE_EVIDENCE",
  taskVersion: string,
  payload: Record<string, unknown>,
  variant: string
): Promise<boolean> {
  const taskKey = `${taskType}:${candidate.job_version_id}:${taskVersion}:repair:${variant}`;
  const contextFingerprint = buildPipelineTaskContextFingerprint({
    workspaceId: context.workspaceId,
    taskType,
    taskVersion,
    payload,
  });
  const result = await enqueuePipelineTask(
    {
      taskType,
      taskKey,
      payload,
      maxAttempts: taskType === "APPLY_HARD_GATES" || taskType === "MATCH_PROFILE_EVIDENCE" ? 8 : 3,
      contextFingerprint,
    },
    client,
    { context }
  );
  return result.inserted || Boolean(result.reactivated);
}

export async function applyRepair(
  client: pg.PoolClient,
  context: WorkspaceContext,
  candidates: RepairCandidate[]
): Promise<Record<string, number>> {
  const profileVersionId = await activeProfileVersionId(client, context);
  const counts: Record<string, number> = {};

  await client.query("BEGIN");
  try {
    for (const candidate of candidates) {
      const category = candidate.category;
      counts[category] = (counts[category] || 0) + 1;
      const basePayload = {
        canonical_job_id: candidate.canonical_job_id,
        job_version_id: candidate.job_version_id,
        repair_reason: category,
      };

      if (
        category === "LEGACY_BUDGET_CAP" ||
        category === "QUOTED_PROVIDER_FAILURE" ||
        category === "ROUTING_TASK_IDEMPOTENCY_RACE"
      ) {
        const nextState =
          (category === "LEGACY_BUDGET_CAP" || category === "ROUTING_TASK_IDEMPOTENCY_RACE") &&
          candidate.primary_lane &&
          candidate.primary_lane !== "UNCLASSIFIED"
          ? "LANE_ROUTED"
          : "PREQUALIFIED";
        await client.query(
          `UPDATE canonical_jobs
           SET processing_state = $3,
               processing_status = $3,
               rejection_reason = NULL,
               latest_match_run_id = NULL,
               latest_deterministic_decision_id = NULL,
               deterministic_match_score = NULL,
               deterministic_match_coverage = NULL,
               recommendation_eligibility = NULL,
               recommendation_outcome = NULL,
               recommendation_requirement_score = NULL,
               recommendation_coverage_score = NULL,
               recommendation_evidence_completeness = NULL,
               recommendation_decided_at = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, candidate.canonical_job_id, nextState]
        );
        await insertRepairEvent(client, context, candidate, {
          repair: category,
          prior_state: candidate.processing_state,
          prior_rejection_reason: candidate.rejection_reason,
          next_state: nextState,
        });

        if (category === "QUOTED_PROVIDER_FAILURE") {
          await enqueueRepairTask(
            client,
            context,
            candidate,
            "EXTRACT_QUOTED_REQUIREMENTS",
            "quoted_requirements_v1",
            basePayload,
            "provider-failure"
          );
        } else if (nextState === "LANE_ROUTED") {
          await enqueueRepairTask(
            client,
            context,
            candidate,
            "MATCH_PROFILE_EVIDENCE",
            "deterministic_matcher_v1",
            { ...basePayload, profile_version_id: profileVersionId },
            "budget-cap"
          );
        } else {
          await enqueueRepairTask(
            client,
            context,
            candidate,
            "PUBLISH_EMBEDDING",
            "embedding_publication_v1",
            basePayload,
            "budget-cap"
          );
        }
        continue;
      }

      if (category === "GATE_NULL" || category === "RAW_STAGED_HARD_REJECT") {
        await enqueueRepairTask(
          client,
          context,
          candidate,
          "APPLY_HARD_GATES",
          "hard_gate_v1",
          { ...basePayload, force_policy_recalculation: true, reprocess: true },
          category === "GATE_NULL" ? "gate-null" : "raw-hard-reject"
        );
        continue;
      }

      if (category === "FALSE_NEGATIVE_NEGATED_LIFESTYLE") {
        await client.query(
          `UPDATE canonical_jobs
           SET gate_decision = NULL,
               rejection_reason = NULL,
               gate_evidence_quotes = NULL,
               processing_state = 'RAW_STAGED',
               processing_status = 'RAW_STAGED',
               updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, candidate.canonical_job_id]
        );
        await insertRepairEvent(client, context, candidate, {
          repair: category,
          prior_state: candidate.processing_state,
          prior_rejection_reason: candidate.rejection_reason,
          next_state: "RAW_STAGED",
        });
        await enqueueRepairTask(
          client,
          context,
          candidate,
          "EXTRACT_DETERMINISTIC_REQUIREMENTS",
          "deterministic_v3",
          { ...basePayload, reprocess: true },
          "negated-lifestyle-reextract"
        );
        await enqueueRepairTask(
          client,
          context,
          candidate,
          "APPLY_HARD_GATES",
          "hard_gate_v1",
          { ...basePayload, force_policy_recalculation: true, reprocess: true },
          "negated-lifestyle-gate"
        );
        continue;
      }

      if (category === "UNPROVABLE_MATCH_EMBEDDING_PENDING") {
        await client.query(
          `UPDATE canonical_jobs
           SET profile_match_status = 'UNKNOWN',
               latest_match_run_id = NULL,
               latest_deterministic_decision_id = NULL,
               recommendation_eligibility = NULL,
               recommendation_outcome = NULL,
               processing_state = 'LANE_ROUTED',
               processing_status = 'LANE_ROUTED',
               updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, candidate.canonical_job_id]
        );
        await insertRepairEvent(client, context, candidate, {
          repair: category,
          prior_state: candidate.processing_state,
          prior_match_status: candidate.profile_match_status,
          next_state: "LANE_ROUTED",
        });
        await enqueueRepairTask(
          client,
          context,
          candidate,
          "PUBLISH_EMBEDDING",
          "embedding_publication_v1",
          basePayload,
          "unprovable-match-publish"
        );
        await enqueueRepairTask(
          client,
          context,
          candidate,
          "MATCH_PROFILE_EVIDENCE",
          "deterministic_matcher_v1",
          { ...basePayload, profile_version_id: profileVersionId },
          "unprovable-match"
        );
        continue;
      }

      if (category === "TRUNCATED_VERSION_MASKING" && candidate.complete_version_id) {
        await client.query(
          `UPDATE canonical_jobs
           SET latest_job_version_id = $3,
               gate_decision = NULL,
               rejection_reason = NULL,
               gate_evidence_quotes = NULL,
               processing_state = 'RAW_STAGED',
               processing_status = 'RAW_STAGED',
               updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2`,
          [context.workspaceId, candidate.canonical_job_id, candidate.complete_version_id]
        );
        await insertRepairEvent(client, context, candidate, {
          repair: category,
          restored_version_id: candidate.complete_version_id,
          next_state: "RAW_STAGED",
        });
        await enqueueRepairTask(
          client,
          context,
          { ...candidate, job_version_id: candidate.complete_version_id },
          "EXTRACT_DETERMINISTIC_REQUIREMENTS",
          "deterministic_v3",
          { ...basePayload, job_version_id: candidate.complete_version_id, reprocess: true },
          "truncated-masking"
        );
        continue;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return counts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    const context = await resolveWorkspaceContext(client, {
      workspaceKey: args.workspaceKey || undefined,
      userKey: args.userKey || undefined,
    });
    const candidates = await loadCandidates(client, context);
    const grouped = candidates.reduce<Record<string, string[]>>((acc, row) => {
      (acc[row.category] ||= []).push(row.canonical_job_id);
      return acc;
    }, {});

    console.log(JSON.stringify({
      mode: args.apply ? "apply" : "dry_run",
      workspace_id: context.workspaceId,
      candidate_counts: Object.fromEntries(Object.entries(grouped).map(([key, value]) => [key, value.length])),
      candidate_ids: grouped,
    }, null, 2));

    if (!args.apply) {
      console.log("No rows changed. Re-run with --apply to enqueue the idempotent repairs.");
      return;
    }

    const applied = await applyRepair(client, context, candidates);
    let questionSummary: any = null;
    let questionAggregationError: string | null = null;
    try {
      questionSummary = await aggregateVerificationQuestions(client, { context });
    } catch (aggError) {
      questionAggregationError = aggError instanceof Error ? aggError.message : String(aggError);
      console.warn("Verification question aggregation encountered an issue:", questionAggregationError);
    }
    console.log(JSON.stringify({ applied, questionSummary, questionAggregationError }, null, 2));
    if (questionAggregationError) {
      console.error(`Repair completed pipeline tasks but verification question aggregation failed: ${questionAggregationError}`);
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Pipeline funnel repair failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
