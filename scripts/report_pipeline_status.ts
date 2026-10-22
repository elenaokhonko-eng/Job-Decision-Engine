import { appendFile, writeFile } from "node:fs/promises";

import dotenv from "dotenv";
import pg from "pg";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { readDeadLetterTaskHealth } from "../src/tasks/deadLetterPolicy.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const STAGES = [
  "SOURCE_INGESTION",
  "NORMALIZATION",
  "REQUIREMENTS",
  "HARD_GATE",
  "EMBEDDINGS",
  "LANE_ROUTING",
  "PROFILE_MATCH",
  "RECOMMENDATION",
  "AI_EVALUATION",
] as const;

type PipelineStage = (typeof STAGES)[number];

interface CountRow {
  key: string;
  count: number;
}

interface TaskHealthRow {
  task_type: string;
  status: string;
  task_count: number;
  oldest_age_seconds: number | null;
  actionable_dead_letter_count?: number;
  stale_historical_dead_letter_count?: number;
}

interface SourceConnectorRow {
  connector: string;
  observations: number;
  source_runs: number;
}

interface StageSummary {
  stage: PipelineStage;
  status: "SUCCESS" | "BACKLOG_HEALTHY" | "RETRYING" | "BLOCKED" | "ERROR" | "IDLE";
  pending: number;
  retry_wait: number;
  blocked_dependency: number;
  dead_letter: number;
  actionable_dead_letter: number;
  stale_historical_dead_letter: number;
  oldest_age_seconds: number;
}

const TASK_STAGE: Record<string, PipelineStage> = {
  NORMALIZE_OBSERVATION: "NORMALIZATION",
  EXTRACT_DETERMINISTIC_REQUIREMENTS: "REQUIREMENTS",
  EXTRACT_QUOTED_REQUIREMENTS: "REQUIREMENTS",
  APPLY_HARD_GATES: "HARD_GATE",
  PUBLISH_EMBEDDING: "EMBEDDINGS",
  ROUTE_LANE: "LANE_ROUTING",
  MATCH_PROFILE_EVIDENCE: "PROFILE_MATCH",
  DECIDE_RECOMMENDATION: "RECOMMENDATION",
  ENQUEUE_EXPLANATION: "RECOMMENDATION",
};

function initialStageSummary(stage: PipelineStage): StageSummary {
  return {
    stage,
    status: "IDLE",
    pending: 0,
    retry_wait: 0,
    blocked_dependency: 0,
    dead_letter: 0,
    actionable_dead_letter: 0,
    stale_historical_dead_letter: 0,
    oldest_age_seconds: 0,
  };
}

export function summarizeTaskStages(rows: readonly TaskHealthRow[]): StageSummary[] {
  const stages = new Map<PipelineStage, StageSummary>(
    STAGES.map((stage) => [stage, initialStageSummary(stage)]),
  );

  for (const row of rows) {
    const stage = TASK_STAGE[row.task_type];
    if (!stage) continue;
    const summary = stages.get(stage);
    if (!summary) continue;
    const count = Number(row.task_count);
    if (row.status === "PENDING") summary.pending += count;
    if (row.status === "RETRY_WAIT") summary.retry_wait += count;
    if (row.status === "BLOCKED_DEPENDENCY") summary.blocked_dependency += count;
    if (row.status === "DEAD_LETTER") {
      summary.dead_letter += count;
      summary.actionable_dead_letter += Number(row.actionable_dead_letter_count ?? count);
      summary.stale_historical_dead_letter += Number(row.stale_historical_dead_letter_count ?? 0);
    }
    summary.oldest_age_seconds = Math.max(summary.oldest_age_seconds, Number(row.oldest_age_seconds ?? 0));
  }

  return STAGES.map((stage) => {
    const summary = stages.get(stage) ?? initialStageSummary(stage);
    if (summary.actionable_dead_letter > 0) return { ...summary, status: "ERROR" };
    if (summary.retry_wait > 0) return { ...summary, status: "RETRYING" };
    if (summary.blocked_dependency > 0) return { ...summary, status: "BLOCKED" };
    if (summary.pending > 0 || summary.stale_historical_dead_letter > 0) {
      return { ...summary, status: "BACKLOG_HEALTHY" };
    }
    return summary;
  });
}

function markdownText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}\[\]()<>|])/g, "\\$1");
}

function toMarkdown(report: Record<string, unknown>): string {
  const stages = report.stages as StageSummary[];
  const taskRows = report.pending_queue_by_task_type as TaskHealthRow[];
  const sourceRows = report.source_runs_by_connector as SourceConnectorRow[];
  const stateRows = report.processing_state_counts as CountRow[];
  const routingRows = report.routing_disposition_counts as CountRow[];
  const retryReasons = report.retry_wait_reasons as CountRow[];
  const blockedReasons = report.blocked_dependency_reasons as CountRow[];
  const formatCounts = (rows: readonly CountRow[]) => rows
    .map((row) => `${markdownText(row.key)}=${row.count}`)
    .join(", ") || "none";
  const lines = [
    "## Pipeline status",
    "",
    "| Stage | Status | Pending | Retry | Blocked | Dead letter total | Actionable dead letter | Stale historical dead letter | Oldest age (s) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...stages.map((stage) =>
      `| ${stage.stage} | ${stage.status} | ${stage.pending} | ${stage.retry_wait} | ${stage.blocked_dependency} | ${stage.dead_letter} | ${stage.actionable_dead_letter} | ${stage.stale_historical_dead_letter} | ${stage.oldest_age_seconds} |`,
    ),
    "",
    "### Source runs by connector",
    "",
    "| Connector | Observations (24h) | Source runs |",
    "|---|---:|---:|",
    ...sourceRows.map((row) => `| ${markdownText(row.connector)} | ${row.observations} | ${row.source_runs} |`),
    "",
    `Dead letters created in this run: ${report.dead_letters_created_this_run ?? "not available"}`,
    `Actionable current dead letters: ${report.actionable_dead_letters}`,
    `Stale historical dead letters: ${report.stale_historical_dead_letters}`,
    "",
    "### Pending queue by task type",
    "",
    "| Task type | State | Count | Actionable dead letters | Stale historical dead letters | Oldest age (s) |",
    "|---|---|---:|---:|---:|---:|",
    ...taskRows.map((row) => `| ${markdownText(row.task_type)} | ${markdownText(row.status)} | ${row.task_count} | ${row.actionable_dead_letter_count ?? 0} | ${row.stale_historical_dead_letter_count ?? 0} | ${row.oldest_age_seconds ?? 0} |`),
    "",
    `Retry reasons: ${formatCounts(retryReasons)}`,
    "",
    `Blocked dependency reasons: ${formatCounts(blockedReasons)}`,
    "",
    `Requires user action: ${report.requires_user_action_count}`,
    "",
    `New observations in the last 24h: ${report.new_observations_last_24h}`,
    "",
    `Processing states: ${formatCounts(stateRows)}`,
    "",
    `Routing dispositions: ${formatCounts(routingRows)}`,
    "",
  ];
  return lines.join("\n");
}

async function run(): Promise<void> {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for pipeline status reporting.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    // resolveWorkspaceContext accepts the pool query surface at this script boundary.
    const context = await resolveWorkspaceContext(pool as unknown as pg.PoolClient);
    const [
      taskHealth,
      sources,
      observations,
      states,
      routing,
      userActions,
      sourceErrors,
      retryReasons,
      blockedReasons,
      deadLetterHealth,
    ] = await Promise.all([
      pool.query<TaskHealthRow>(
        `SELECT task_type, status, task_count, oldest_age_seconds
         FROM v_pipeline_task_queue_health
         WHERE workspace_id = $1
           AND status IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY', 'DEAD_LETTER')
         ORDER BY task_type, status`,
        [context.workspaceId],
      ),
      pool.query<SourceConnectorRow>(
        `SELECT COALESCE(observation.source_name, 'UNKNOWN') AS connector,
                COUNT(*)::int AS observations,
                COUNT(DISTINCT observation.source_run_id)::int AS source_runs
         FROM raw_job_observations observation
         WHERE observation.workspace_id = $1
           AND observation.retrieved_at >= NOW() - INTERVAL '24 hours'
         GROUP BY COALESCE(observation.source_name, 'UNKNOWN')
         ORDER BY connector`,
        [context.workspaceId],
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM raw_job_observations
         WHERE workspace_id = $1
           AND retrieved_at >= NOW() - INTERVAL '24 hours'`,
        [context.workspaceId],
      ),
      pool.query<CountRow>(
        `SELECT COALESCE(processing_state, processing_status) AS key, COUNT(*)::int AS count
         FROM canonical_jobs
         WHERE workspace_id = $1
           AND is_test_fixture = FALSE
         GROUP BY COALESCE(processing_state, processing_status)
         ORDER BY key`,
        [context.workspaceId],
      ),
      pool.query<CountRow>(
        `SELECT COALESCE(routing_disposition, 'NONE') AS key, COUNT(*)::int AS count
         FROM canonical_jobs
         WHERE workspace_id = $1
           AND is_test_fixture = FALSE
           AND COALESCE(processing_state, processing_status) = 'ROUTING_DEFERRED'
         GROUP BY COALESCE(routing_disposition, 'NONE')
         ORDER BY key`,
        [context.workspaceId],
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM v_canonical_shortlist_actions_scoped
         WHERE workspace_id = $1
           AND requires_user_action = TRUE`,
        [context.workspaceId],
      ),
      pool.query<{ count: number }>(
        `SELECT COALESCE(SUM(total_errors), 0)::int AS count
         FROM source_runs
         WHERE workspace_id = $1
           AND started_at >= NOW() - INTERVAL '24 hours'`,
        [context.workspaceId],
      ),
      pool.query<CountRow>(
        `SELECT COALESCE(NULLIF(task.last_error, ''), 'UNKNOWN') AS key, COUNT(*)::int AS count
         FROM pipeline_tasks task
         WHERE task.workspace_id = $1
           AND task.status = 'RETRY_WAIT'
           AND NOT EXISTS (
             SELECT 1
             FROM canonical_jobs canonical
             LEFT JOIN job_versions version
               ON version.workspace_id = canonical.workspace_id
              AND version.canonical_job_id = canonical.id
             WHERE canonical.workspace_id = task.workspace_id
               AND canonical.is_test_fixture = TRUE
               AND (
                 task.payload->>'canonical_job_id' = canonical.id::text
                 OR task.payload->>'job_version_id' = version.id::text
               )
           )
         GROUP BY COALESCE(NULLIF(task.last_error, ''), 'UNKNOWN')
         ORDER BY count DESC, key`,
        [context.workspaceId],
      ),
      pool.query<CountRow>(
        `SELECT COALESCE(NULLIF(task.blocked_reason, ''), 'UNKNOWN') AS key, COUNT(*)::int AS count
         FROM pipeline_tasks task
         WHERE task.workspace_id = $1
           AND task.status = 'BLOCKED_DEPENDENCY'
           AND NOT EXISTS (
             SELECT 1
             FROM canonical_jobs canonical
             LEFT JOIN job_versions version
               ON version.workspace_id = canonical.workspace_id
              AND version.canonical_job_id = canonical.id
             WHERE canonical.workspace_id = task.workspace_id
               AND canonical.is_test_fixture = TRUE
               AND (
                 task.payload->>'canonical_job_id' = canonical.id::text
                 OR task.payload->>'job_version_id' = version.id::text
               )
           )
         GROUP BY COALESCE(NULLIF(task.blocked_reason, ''), 'UNKNOWN')
         ORDER BY count DESC, key`,
        [context.workspaceId],
      ),
      readDeadLetterTaskHealth(pool, context.workspaceId),
    ]);

    const deadLetterHealthByType = new Map(
      deadLetterHealth.map((row) => [row.task_type, row]),
    );
    const taskHealthRows = taskHealth.rows.map((row) => {
      if (row.status !== "DEAD_LETTER") return row;
      const classified = deadLetterHealthByType.get(row.task_type);
      return {
        ...row,
        actionable_dead_letter_count: Number(classified?.actionable_dead_letter_count ?? row.task_count),
        stale_historical_dead_letter_count: Number(classified?.stale_historical_dead_letter_count ?? 0),
      };
    });
    const stages = summarizeTaskStages(taskHealthRows);
    const sourceStage = stages.find((stage) => stage.stage === "SOURCE_INGESTION");
    if (sourceStage) {
      sourceStage.status = Number(sourceErrors.rows[0]?.count ?? 0) > 0
        ? "ERROR"
        : Number(observations.rows[0]?.count ?? 0) > 0
          ? "SUCCESS"
          : "IDLE";
    }

    const deadLettersCreatedThisRunRaw = process.env.PIPELINE_DEAD_LETTERED_THIS_RUN?.trim();
    const deadLettersCreatedThisRun = deadLettersCreatedThisRunRaw === undefined || deadLettersCreatedThisRunRaw === ""
      ? null
      : Number(deadLettersCreatedThisRunRaw);
    if (
      deadLettersCreatedThisRun !== null &&
      (!Number.isInteger(deadLettersCreatedThisRun) || deadLettersCreatedThisRun < 0)
    ) {
      throw new Error("PIPELINE_DEAD_LETTERED_THIS_RUN must be a non-negative integer when provided.");
    }

    const report = {
      generated_at: new Date().toISOString(),
      workspace_id: context.workspaceId,
      stages,
      source_runs_by_connector: sources.rows,
      new_observations_last_24h: Number(observations.rows[0]?.count ?? 0),
      pending_queue_by_task_type: taskHealthRows,
      actionable_dead_letters: deadLetterHealth.reduce(
        (total, row) => total + Number(row.actionable_dead_letter_count),
        0,
      ),
      stale_historical_dead_letters: deadLetterHealth.reduce(
        (total, row) => total + Number(row.stale_historical_dead_letter_count),
        0,
      ),
      dead_letters_created_this_run: deadLettersCreatedThisRun,
      processing_state_counts: states.rows,
      routing_disposition_counts: routing.rows,
      retry_wait_reasons: retryReasons.rows,
      blocked_dependency_reasons: blockedReasons.rows,
      requires_user_action_count: Number(userActions.rows[0]?.count ?? 0),
    };
    const workflowName = process.env.PIPELINE_WORKFLOW_NAME?.trim() || "Pipeline Worker";
    const runKey = process.env.GITHUB_RUN_ID?.trim() || `local:${process.pid}:${Date.now()}`;
    await pool.query(
      `INSERT INTO pipeline_run_reports (workspace_id, workflow_name, run_key, report)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (workspace_id, workflow_name, run_key)
       DO UPDATE SET report = EXCLUDED.report, updated_at = NOW()`,
      [context.workspaceId, workflowName, runKey, JSON.stringify(report)],
    );

    const json = JSON.stringify(report, null, 2);
    console.log(json);

    const reportFile = process.env.PIPELINE_STATUS_REPORT_FILE?.trim();
    if (reportFile) await writeFile(reportFile, `${json}\n`, "utf8");
    const stepSummaryFile = process.env.GITHUB_STEP_SUMMARY?.trim();
    if (stepSummaryFile) await appendFile(stepSummaryFile, `${toMarkdown(report)}\n`, "utf8");
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes("report_pipeline_status")) {
  void run().catch((error: unknown) => {
    console.error("Pipeline status report failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
