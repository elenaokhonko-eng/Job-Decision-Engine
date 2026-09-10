import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { buildPipelineTaskContextFingerprint } from "../src/pipeline/artifactContext.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

type RepairCategory = "LEGACY_BUDGET_CAP" | "QUOTED_PROVIDER_FAILURE" | "GATE_NULL" | "RAW_STAGED_HARD_REJECT";

interface RepairCandidate {
  canonical_job_id: string;
  job_version_id: string;
  processing_state: string;
  gate_decision: string | null;
  primary_lane: string | null;
  rejection_reason: string | null;
  category: RepairCategory;
}

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

async function loadCandidates(client: pg.PoolClient, context: WorkspaceContext): Promise<RepairCandidate[]> {
  const { rows } = await client.query<RepairCandidate>(
    `
      WITH latest_versions AS (
        SELECT DISTINCT ON (jv.canonical_job_id)
               jv.canonical_job_id,
               jv.id AS job_version_id
        FROM job_versions jv
        WHERE jv.workspace_id = $1
        ORDER BY jv.canonical_job_id, jv.observed_at DESC, jv.id DESC
      )
      SELECT
        c.id AS canonical_job_id,
        lv.job_version_id,
        COALESCE(c.processing_state, c.processing_status) AS processing_state,
        c.gate_decision,
        c.primary_lane,
        c.rejection_reason,
        CASE
          WHEN COALESCE(c.processing_state, c.processing_status) = 'NEEDS_MANUAL_REVIEW'
           AND c.gate_decision = 'PASS'
           AND COALESCE(c.rejection_reason, '') ILIKE '%BUDGET_CAP%'
            THEN 'LEGACY_BUDGET_CAP'
          WHEN COALESCE(c.processing_state, c.processing_status) = 'NEEDS_MANUAL_REVIEW'
           AND c.gate_decision = 'PASS'
           AND COALESCE(c.rejection_reason, '') ILIKE '%EXTRACT_QUOTED_REQUIREMENTS%'
            THEN 'QUOTED_PROVIDER_FAILURE'
          WHEN COALESCE(c.processing_state, c.processing_status) = 'HARD_REJECTED'
           AND c.gate_decision IS NULL
            THEN 'GATE_NULL'
          WHEN COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
           AND c.gate_decision = 'HARD_REJECT'
            THEN 'RAW_STAGED_HARD_REJECT'
          ELSE NULL
        END AS category
      FROM canonical_jobs c
      JOIN latest_versions lv ON lv.canonical_job_id = c.id
      WHERE c.workspace_id = $1
        AND (
          (
            COALESCE(c.processing_state, c.processing_status) = 'NEEDS_MANUAL_REVIEW'
            AND c.gate_decision = 'PASS'
            AND (
              COALESCE(c.rejection_reason, '') ILIKE '%BUDGET_CAP%'
              OR COALESCE(c.rejection_reason, '') ILIKE '%EXTRACT_QUOTED_REQUIREMENTS%'
            )
          )
          OR (
            COALESCE(c.processing_state, c.processing_status) = 'HARD_REJECTED'
            AND c.gate_decision IS NULL
          )
          OR (
            COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
            AND c.gate_decision = 'HARD_REJECT'
          )
        )
      ORDER BY category, c.created_at, c.id
    `,
    [context.workspaceId]
  );
  return rows.filter((row) => row.category);
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
  taskType: "APPLY_HARD_GATES" | "EXTRACT_QUOTED_REQUIREMENTS" | "PUBLISH_EMBEDDING" | "ROUTE_LANE" | "MATCH_PROFILE_EVIDENCE",
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

async function applyRepair(client: pg.PoolClient, context: WorkspaceContext, candidates: RepairCandidate[]): Promise<Record<string, number>> {
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

      if (category === "LEGACY_BUDGET_CAP" || category === "QUOTED_PROVIDER_FAILURE") {
        const nextState = category === "LEGACY_BUDGET_CAP" && candidate.primary_lane && candidate.primary_lane !== "UNCLASSIFIED"
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
    console.log(JSON.stringify({ applied }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Pipeline funnel repair failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
