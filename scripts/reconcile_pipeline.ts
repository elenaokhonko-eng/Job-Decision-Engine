import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

type CountRow = { key: string; count: number };

interface ReconciliationReport {
  mode: "read_only";
  generated_at: string;
  workspace_id: string;
  active_profile_version_id: string | null;
  job_states: CountRow[];
  task_states: CountRow[];
  evaluation_queue_states: CountRow[];
  funnel: {
    canonical_jobs: number;
    gate_passed: number;
    current_requirements: number;
    current_matches: number;
    current_decisions: number;
    current_evaluations: number;
    active_evaluation_queue: number;
    current_evaluation_queue: number;
    stale_evaluation_queue: number;
    stale_or_unprovable_matches: number;
    blocked_tasks: number;
    retrying_tasks: number;
    dead_letter_tasks: number;
  };
  samples: {
    pass_missing_current_requirements: string[];
    pass_missing_current_matches: string[];
    blocked_tasks: string[];
  };
}

function parseArgs(argv: string[]): {
  workspaceKey?: string;
  userKey?: string;
  json: boolean;
} {
  const out: { workspaceKey?: string; userKey?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace-key" && argv[i + 1]) {
      out.workspaceKey = String(argv[++i]).trim();
    } else if (arg === "--user-key" && argv[i + 1]) {
      out.userKey = String(argv[++i]).trim();
    } else if (arg === "--json") {
      out.json = true;
    }
  }
  return out;
}

async function countRows(
  client: pg.PoolClient,
  sql: string,
  params: unknown[]
): Promise<CountRow[]> {
  const result = await client.query<{ key: string | null; count: number }>(sql, params);
  return result.rows.map((row) => ({ key: row.key ?? "UNKNOWN", count: Number(row.count) }));
}

async function run(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const args = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();

  try {
    const ctx = await resolveWorkspaceContext(client as any, {
      workspaceKey: args.workspaceKey,
      userKey: args.userKey,
    });

    const activeProfile = await client.query<{ id: string }>(
      `SELECT id
       FROM profile_versions
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC
       LIMIT 1`,
      [ctx.workspaceId]
    );
    const activeProfileVersionId = activeProfile.rows[0]?.id ?? null;

    const jobStates = await countRows(
      client,
      `SELECT COALESCE(processing_state, processing_status) AS key, COUNT(*)::int AS count
       FROM canonical_jobs
       WHERE workspace_id = $1
       GROUP BY COALESCE(processing_state, processing_status)
       ORDER BY key`,
      [ctx.workspaceId]
    );
    const taskStates = await countRows(
      client,
      `SELECT status AS key, COUNT(*)::int AS count
       FROM pipeline_tasks
       WHERE workspace_id = $1
       GROUP BY status
       ORDER BY status`,
      [ctx.workspaceId]
    );
    const evaluationQueueStates = await countRows(
      client,
      `SELECT status AS key, COUNT(*)::int AS count
       FROM evaluation_queue
       WHERE workspace_id = $1
       GROUP BY status
       ORDER BY status`,
      [ctx.workspaceId]
    );

    const evaluationQueueCurrentness = await client.query<{
      active_evaluation_queue: number;
      current_evaluation_queue: number;
    }>(
      `WITH latest_versions AS (
         SELECT DISTINCT ON (jv.canonical_job_id)
                jv.canonical_job_id,
                jv.id AS job_version_id,
                jv.active_requirement_set_id,
                jv.content_hash
         FROM job_versions jv
         WHERE jv.workspace_id = $1
         ORDER BY jv.canonical_job_id, jv.observed_at DESC, jv.id DESC
       ),
       current_evaluation_queue AS (
         SELECT DISTINCT eq.id
         FROM evaluation_queue eq
         JOIN canonical_jobs c
           ON c.workspace_id = eq.workspace_id
          AND c.id = eq.canonical_job_id
         JOIN latest_versions lv
           ON lv.canonical_job_id = c.id
         JOIN profile_versions pv
           ON pv.workspace_id = c.workspace_id
          AND pv.status = 'ACTIVE'
         JOIN match_runs mr
           ON mr.workspace_id = c.workspace_id
          AND mr.id = c.latest_match_run_id
          AND mr.canonical_job_id = c.id
          AND mr.job_version_id = lv.job_version_id
          AND mr.profile_version_id = pv.id
          AND mr.requirement_set_id = lv.active_requirement_set_id
          AND mr.job_content_hash = lv.content_hash
          AND mr.context_fingerprint IS NOT NULL
          AND mr.status = 'COMPLETED'
         JOIN deterministic_decisions dd
           ON dd.workspace_id = c.workspace_id
          AND dd.id = c.latest_deterministic_decision_id
          AND dd.canonical_job_id = c.id
          AND dd.job_version_id = lv.job_version_id
          AND dd.match_run_id = mr.id
          AND dd.context_fingerprint IS NOT NULL
         WHERE eq.workspace_id = $1
           AND eq.status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
           AND eq.job_version_id = lv.job_version_id
           AND eq.profile_version_id = pv.id
           AND eq.match_run_id = mr.id
           AND eq.deterministic_decision_id = dd.id
           AND eq.job_content_hash = lv.content_hash
           AND eq.context_fingerprint = dd.context_fingerprint
       )
       SELECT
         (SELECT COUNT(*)::int
          FROM evaluation_queue
          WHERE workspace_id = $1
            AND status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')) AS active_evaluation_queue,
         (SELECT COUNT(*)::int FROM current_evaluation_queue) AS current_evaluation_queue`,
      [ctx.workspaceId]
    );

    const funnel = await client.query<{
      canonical_jobs: number;
      gate_passed: number;
      current_requirements: number;
      current_matches: number;
      current_decisions: number;
      current_evaluations: number;
      active_evaluation_queue: number;
      current_evaluation_queue: number;
      stale_evaluation_queue: number;
      stale_or_unprovable_matches: number;
      blocked_tasks: number;
      retrying_tasks: number;
      dead_letter_tasks: number;
    }>(
      `WITH latest_versions AS (
         SELECT DISTINCT ON (jv.canonical_job_id)
                jv.canonical_job_id,
                jv.id AS job_version_id,
                jv.active_requirement_set_id,
                jv.content_hash
         FROM job_versions jv
         WHERE jv.workspace_id = $1
         ORDER BY jv.canonical_job_id, jv.observed_at DESC, jv.id DESC
       ),
       current_requirements AS (
         SELECT DISTINCT jv.job_version_id
         FROM latest_versions jv
         JOIN job_version_pipeline_state ps
           ON ps.workspace_id = $1
          AND ps.job_version_id = jv.job_version_id
          AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
          AND ps.stage_status = 'COMPLETED'
         JOIN requirement_extraction_runs rer
           ON rer.workspace_id = $1
          AND rer.job_version_id = jv.job_version_id
          AND rer.run_type = 'DETERMINISTIC'
          AND rer.status = 'COMPLETED'
          AND rer.requirement_set_id = jv.active_requirement_set_id
         WHERE jv.active_requirement_set_id IS NOT NULL
       ),
       current_matches AS (
         SELECT c.id AS canonical_job_id
         FROM canonical_jobs c
         JOIN latest_versions lv ON lv.canonical_job_id = c.id
         JOIN match_runs mr
           ON mr.workspace_id = $1
          AND mr.id = c.latest_match_run_id
          AND mr.canonical_job_id = c.id
          AND mr.job_version_id = lv.job_version_id
          AND mr.profile_version_id = $2
          AND mr.requirement_set_id = lv.active_requirement_set_id
          AND mr.job_content_hash = lv.content_hash
          AND mr.context_fingerprint IS NOT NULL
          AND mr.status = 'COMPLETED'
         WHERE c.workspace_id = $1
       ),
       current_decisions AS (
         SELECT cm.canonical_job_id
         FROM current_matches cm
         JOIN canonical_jobs c ON c.id = cm.canonical_job_id
         JOIN latest_versions lv ON lv.canonical_job_id = c.id
         JOIN deterministic_decisions dd
           ON dd.workspace_id = $1
          AND dd.id = c.latest_deterministic_decision_id
          AND dd.canonical_job_id = c.id
          AND dd.job_version_id = lv.job_version_id
          AND dd.match_run_id = c.latest_match_run_id
          AND dd.context_fingerprint IS NOT NULL
         WHERE c.workspace_id = $1
       ),
       current_evaluations AS (
         SELECT DISTINCT cd.canonical_job_id
         FROM current_decisions cd
         JOIN canonical_jobs c ON c.id = cd.canonical_job_id
         JOIN latest_versions lv ON lv.canonical_job_id = c.id
         JOIN deterministic_decisions dd
           ON dd.workspace_id = $1
          AND dd.id = c.latest_deterministic_decision_id
          AND dd.canonical_job_id = c.id
         JOIN ai_evaluations ae
           ON ae.workspace_id = $1
          AND ae.canonical_job_id = c.id
          AND ae.job_version_id = lv.job_version_id
          AND ae.profile_version_id = $2
          AND ae.match_run_id = c.latest_match_run_id
          AND ae.deterministic_decision_id = dd.id
          AND ae.job_content_hash = lv.content_hash
          AND ae.context_fingerprint IS NOT NULL
       ),
       stale_matches AS (
         SELECT c.id
         FROM canonical_jobs c
         JOIN match_runs mr
           ON mr.workspace_id = $1 AND mr.id = c.latest_match_run_id
         WHERE c.workspace_id = $1
           AND (mr.status = 'COMPLETED' OR mr.status IS NULL)
           AND NOT EXISTS (SELECT 1 FROM current_matches cm WHERE cm.canonical_job_id = c.id)
       ),
       task_counts AS (
         SELECT
           COUNT(*) FILTER (WHERE status = 'BLOCKED_DEPENDENCY')::int AS blocked_tasks,
           COUNT(*) FILTER (WHERE status = 'RETRY_WAIT')::int AS retrying_tasks,
           COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter_tasks
         FROM pipeline_tasks
         WHERE workspace_id = $1
       )
       SELECT
         (SELECT COUNT(*)::int FROM canonical_jobs WHERE workspace_id = $1) AS canonical_jobs,
         (SELECT COUNT(*)::int FROM canonical_jobs WHERE workspace_id = $1 AND gate_decision = 'PASS') AS gate_passed,
         (SELECT COUNT(*)::int FROM current_requirements) AS current_requirements,
         (SELECT COUNT(*)::int FROM current_matches) AS current_matches,
         (SELECT COUNT(*)::int FROM current_decisions) AS current_decisions,
         (SELECT COUNT(*)::int FROM current_evaluations) AS current_evaluations,
         $3::int AS active_evaluation_queue,
         $4::int AS current_evaluation_queue,
         GREATEST($3::int - $4::int, 0) AS stale_evaluation_queue,
         (SELECT COUNT(*)::int FROM stale_matches) AS stale_or_unprovable_matches,
         task_counts.blocked_tasks,
         task_counts.retrying_tasks,
         task_counts.dead_letter_tasks
       FROM task_counts`,
      [
        ctx.workspaceId,
        activeProfileVersionId,
        Number(evaluationQueueCurrentness.rows[0]?.active_evaluation_queue ?? 0),
        Number(evaluationQueueCurrentness.rows[0]?.current_evaluation_queue ?? 0),
      ]
    );

    const samples = await client.query<{
      pass_missing_current_requirements: string[];
      pass_missing_current_matches: string[];
      blocked_tasks: string[];
    }>(
      `WITH latest_versions AS (
         SELECT DISTINCT ON (jv.canonical_job_id)
                jv.canonical_job_id, jv.id AS job_version_id,
                jv.active_requirement_set_id, jv.content_hash
         FROM job_versions jv
         WHERE jv.workspace_id = $1
         ORDER BY jv.canonical_job_id, jv.observed_at DESC, jv.id DESC
       )
       SELECT
         ARRAY(
           SELECT c.id::text
           FROM canonical_jobs c
           JOIN latest_versions lv ON lv.canonical_job_id = c.id
           WHERE c.workspace_id = $1
             AND c.gate_decision = 'PASS'
             AND NOT EXISTS (
               SELECT 1
               FROM job_version_pipeline_state ps
               JOIN requirement_extraction_runs rer
                 ON rer.workspace_id = $1
                AND rer.job_version_id = lv.job_version_id
                AND rer.run_type = 'DETERMINISTIC'
                AND rer.status = 'COMPLETED'
                AND rer.requirement_set_id = lv.active_requirement_set_id
               WHERE ps.workspace_id = $1
                 AND ps.job_version_id = lv.job_version_id
                 AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
                 AND ps.stage_status = 'COMPLETED'
             )
           LIMIT 20
         ) AS pass_missing_current_requirements,
         ARRAY(
           SELECT c.id::text
           FROM canonical_jobs c
           JOIN latest_versions lv ON lv.canonical_job_id = c.id
           LEFT JOIN match_runs mr ON mr.workspace_id = $1 AND mr.id = c.latest_match_run_id
           WHERE c.workspace_id = $1
             AND c.gate_decision = 'PASS'
             AND NOT (
               mr.status = 'COMPLETED'
               AND mr.canonical_job_id = c.id
               AND mr.job_version_id = lv.job_version_id
               AND mr.profile_version_id = $2
               AND mr.requirement_set_id = lv.active_requirement_set_id
               AND mr.job_content_hash = lv.content_hash
               AND mr.context_fingerprint IS NOT NULL
             )
           LIMIT 20
         ) AS pass_missing_current_matches,
         ARRAY(
           SELECT t.id::text
           FROM pipeline_tasks t
           WHERE t.workspace_id = $1 AND t.status = 'BLOCKED_DEPENDENCY'
           ORDER BY t.updated_at ASC
           LIMIT 20
         ) AS blocked_tasks`,
      [ctx.workspaceId, activeProfileVersionId]
    );

    const report: ReconciliationReport = {
      mode: "read_only",
      generated_at: new Date().toISOString(),
      workspace_id: ctx.workspaceId,
      active_profile_version_id: activeProfileVersionId,
      job_states: jobStates,
      task_states: taskStates,
      evaluation_queue_states: evaluationQueueStates,
      funnel: { ...funnel.rows[0] },
      samples: samples.rows[0] ?? {
        pass_missing_current_requirements: [],
        pass_missing_current_matches: [],
        blocked_tasks: [],
      },
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("PIPELINE RECONCILIATION (READ ONLY)");
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Pipeline reconciliation failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
