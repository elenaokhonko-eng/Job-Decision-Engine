import { appendFile, writeFile } from "node:fs/promises";

import dotenv from "dotenv";
import pg from "pg";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { readDeadLetterTaskHealth } from "../src/tasks/deadLetterPolicy.js";
import {
  GEMINI_FLEX_PROVIDER_LABEL,
  summarizeProviderCalls,
  type ProviderCallCounts,
  type ProviderCallSummary,
} from "../src/services/modelCallResilience.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import {
  BOARD_YIELD_SQL,
  BOARD_YIELD_WINDOW_DAYS,
  boardYieldReportEnabled,
  summarizeBoardYield,
  type BoardYieldRow,
  type BoardYieldSummary,
} from "../src/reporting/boardYield.js";

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

export function isWorkflowKillSwitchOn(value = process.env.WORKFLOW_KILL_SWITCH): boolean {
  return (value || "").trim().toLowerCase() === "true";
}

interface CountRow {
  key: string;
  count: number;
}

interface TaskHealthRow {
  task_type: string;
  status: string;
  task_count: number;
  oldest_age_seconds: number | null;
  /** Seconds since the longest-held task entered this status (v_pipeline_task_status_age). */
  oldest_status_age_seconds?: number | null;
  /** PENDING only: seconds since the longest-waiting due task became claimable (v_pipeline_task_due_age). */
  oldest_due_age_seconds?: number | null;
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
  status: "SUCCESS" | "BACKLOG_HEALTHY" | "BACKLOG_AGED" | "RETRYING" | "BLOCKED" | "ERROR" | "IDLE";
  pending: number;
  retry_wait: number;
  blocked_dependency: number;
  dead_letter: number;
  actionable_dead_letter: number;
  stale_historical_dead_letter: number;
  oldest_age_seconds: number;
  oldest_retry_wait_age_seconds: number;
  oldest_dead_letter_age_seconds: number;
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
    oldest_retry_wait_age_seconds: 0,
    oldest_dead_letter_age_seconds: 0,
  };
}

interface ProviderCallRow {
  provider: string;
  model: string;
  calls: number;
  succeeded: number;
  rate_limited: number;
  daily_quota: number;
  timeouts: number;
  server_errors: number;
  retries: number;
}

/**
 * Per-model provider HTTP attempts recorded in model_route_invocations.response_metadata
 * .provider_attempts over the last window (one row per attempt; no prompt text is read).
 * Attempts sent on Vertex Flex PayGo are reported as provider "gemini-flex" and are not part of
 * the 429 stop-rule share (the standard retry after Flex covers them).
 * Embedding invocations are recorded per input, so batched embedding requests count once per input.
 */
export const PROVIDER_CALLS_SQL = `
  WITH attempts AS (
    SELECT attempt
    FROM model_route_invocations inv
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(inv.response_metadata->'provider_attempts') = 'array'
           THEN inv.response_metadata->'provider_attempts'
           ELSE '[]'::jsonb END
    ) AS attempt
    WHERE inv.workspace_id = $1
      AND inv.created_at >= NOW() - make_interval(mins => $2::int)
  )
  SELECT CASE WHEN attempt->>'path' = 'FLEX' THEN '${GEMINI_FLEX_PROVIDER_LABEL}'
              ELSE COALESCE(attempt->>'provider', 'unknown') END AS provider,
         COALESCE(attempt->>'model', 'unknown') AS model,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE attempt->>'status' = 'COMPLETED')::int AS succeeded,
         COUNT(*) FILTER (
           WHERE attempt->>'errorKind' = 'RATE_LIMITED'
              OR (attempt->>'errorKind' IS NULL AND attempt->>'httpStatus' = '429')
         )::int AS rate_limited,
         COUNT(*) FILTER (WHERE attempt->>'errorKind' = 'DAILY_QUOTA')::int AS daily_quota,
         COUNT(*) FILTER (WHERE attempt->>'errorKind' IN ('TIMEOUT', 'DEADLINE'))::int AS timeouts,
         COUNT(*) FILTER (WHERE attempt->>'errorKind' = 'SERVER_ERROR')::int AS server_errors,
         COUNT(*) FILTER (
           WHERE attempt->>'attempt' ~ '^[0-9]+$' AND (attempt->>'attempt')::int > 1
         )::int AS retries
  FROM attempts
  GROUP BY 1, 2
  ORDER BY 1, 2
`;

/** Provider call counts for the report, with the ">5% of calls rate limited" stop rule. */
export function summarizeProviderCallRows(rows: readonly ProviderCallRow[]): ProviderCallSummary {
  const byModel: ProviderCallCounts[] = rows.map((row) => {
    const calls = Number(row.calls);
    const succeeded = Number(row.succeeded);
    const rateLimited = Number(row.rate_limited);
    const dailyQuota = Number(row.daily_quota);
    const timeouts = Number(row.timeouts);
    const serverErrors = Number(row.server_errors);
    return {
      provider: row.provider,
      model: row.model,
      calls,
      succeeded,
      rate_limited: rateLimited,
      daily_quota: dailyQuota,
      timeouts,
      server_errors: serverErrors,
      other_failures: Math.max(0, calls - succeeded - rateLimited - dailyQuota - timeouts - serverErrors),
      retries: Number(row.retries),
    };
  });
  return summarizeProviderCalls(byModel);
}

export function providerCallWindowMinutes(value = process.env.PIPELINE_PROVIDER_CALL_WINDOW_MINUTES): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 7 * 24 * 60) : 90;
}

export function summarizeTaskStages(rows: readonly TaskHealthRow[], maxPendingAgeSeconds = 7200): StageSummary[] {
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
    const oldestAgeSeconds = Number(row.oldest_age_seconds ?? 0);
    if (row.status === "PENDING") {
      // Scheduled future work cannot be stalled yet; age counts only due tasks, from when they became due.
      summary.oldest_age_seconds = Math.max(
        summary.oldest_age_seconds,
        row.oldest_due_age_seconds === undefined ? oldestAgeSeconds : Number(row.oldest_due_age_seconds ?? 0),
      );
    }
    if (row.status === "RETRY_WAIT") {
      // Retry age counts from entry into RETRY_WAIT, not from task creation.
      summary.oldest_retry_wait_age_seconds = Math.max(
        summary.oldest_retry_wait_age_seconds,
        Number(row.oldest_status_age_seconds ?? oldestAgeSeconds),
      );
    }
    if (row.status === "DEAD_LETTER") {
      summary.oldest_dead_letter_age_seconds = Math.max(summary.oldest_dead_letter_age_seconds, oldestAgeSeconds);
    }
  }

  return STAGES.map((stage) => {
    const summary = stages.get(stage) ?? initialStageSummary(stage);
    if (summary.actionable_dead_letter > 0) return { ...summary, status: "ERROR" };
    if (summary.retry_wait > 0) return { ...summary, status: "RETRYING" };
    if (summary.blocked_dependency > 0) return { ...summary, status: "BLOCKED" };
    if (summary.pending > 0 && summary.oldest_age_seconds > maxPendingAgeSeconds) {
      return { ...summary, status: "BACKLOG_AGED" };
    }
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

/** Markdown lines for the weekly board-yield table (empty when the section is off). */
export function boardYieldMarkdown(summary: BoardYieldSummary | null | undefined): string[] {
  if (!summary) return [];
  return [
    `### Board yield (jobs first seen in the last ${summary.window_days} days)`,
    "",
    ...(summary.flagged_boards.length > 0
      ? [`⚠️ **${summary.flagged_boards.length} board(s) with no gate pass after ${summary.zero_pass_min_staged}+ staged jobs:** ${summary.flagged_boards.map(markdownText).join(", ")}`, ""]
      : []),
    "| Source | Board | Staged | Hard-rejected | Passed gates | Evaluated | PRIORITY/REVIEW | Flag |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    ...summary.boards.map((row) =>
      `| ${markdownText(row.source)} | ${markdownText(row.board)} | ${row.staged} | ${row.hard_rejected} | ${row.passed_gates} | ${row.evaluated} | ${row.priority_review} | ${row.zero_pass_flag ? "0 passes" : ""} |`),
    "",
  ];
}

function toMarkdown(report: Record<string, unknown>): string {
  const stages = report.stages as StageSummary[];
  const taskRows = report.pending_queue_by_task_type as TaskHealthRow[];
  const sourceRows = report.source_runs_by_connector as SourceConnectorRow[];
  const stateRows = report.processing_state_counts as CountRow[];
  const routingRows = report.routing_disposition_counts as CountRow[];
  const retryReasons = report.retry_wait_reasons as CountRow[];
  const blockedReasons = report.blocked_dependency_reasons as CountRow[];
  const providerCalls = report.provider_calls_by_model as ProviderCallSummary | undefined;
  const providerLines = providerCalls
    ? [
        `### Model provider calls (last ${report.provider_call_window_minutes} min)`,
        "",
        ...(providerCalls.stop_rule_triggered
          ? [`⚠️ **Stop rule: ${(providerCalls.rate_limited_share * 100).toFixed(1)}% of calls were rate limited (429), above ${providerCalls.stop_rule_threshold * 100}%. Pause scaling.**`, ""]
          : []),
        "| Provider | Model | Calls | Succeeded | 429 | Timeouts | 5xx | Retries |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
        ...providerCalls.by_model.map((row) =>
          `| ${markdownText(row.provider)} | ${markdownText(row.model)} | ${row.calls} | ${row.succeeded} | ${row.rate_limited} | ${row.timeouts} | ${row.server_errors} | ${row.retries} |`),
        "",
      ]
    : [];
  const killSwitchWarning = report.workflow_kill_switch_on === true
    ? ["⚠️ **WORKFLOW_KILL_SWITCH is ON: all pipeline processing is paused.**", ""]
    : [];
  const formatCounts = (rows: readonly CountRow[]) => rows
    .map((row) => `${markdownText(row.key)}=${row.count}`)
    .join(", ") || "none";
  const lines = [
    "## Pipeline status",
    "",
    ...killSwitchWarning,
    "| Stage | Status | Pending | Retry | Blocked | Dead letter total | Actionable dead letter | Stale historical dead letter | Oldest pending (s) | Oldest retry (s) | Oldest dead letter (s) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...stages.map((stage) =>
      `| ${stage.stage} | ${stage.status} | ${stage.pending} | ${stage.retry_wait} | ${stage.blocked_dependency} | ${stage.dead_letter} | ${stage.actionable_dead_letter} | ${stage.stale_historical_dead_letter} | ${stage.oldest_age_seconds} | ${stage.oldest_retry_wait_age_seconds} | ${stage.oldest_dead_letter_age_seconds} |`,
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
    "| Task type | State | Count | Actionable dead letters | Stale historical dead letters | Oldest pending (s) | Oldest retry (s) | Oldest dead letter (s) |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...taskRows.map((row) => `| ${markdownText(row.task_type)} | ${markdownText(row.status)} | ${row.task_count} | ${row.actionable_dead_letter_count ?? 0} | ${row.stale_historical_dead_letter_count ?? 0} | ${row.status === "PENDING" ? row.oldest_age_seconds ?? 0 : 0} | ${row.status === "RETRY_WAIT" ? row.oldest_status_age_seconds ?? row.oldest_age_seconds ?? 0 : 0} | ${row.status === "DEAD_LETTER" ? row.oldest_age_seconds ?? 0 : 0} |`),
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
    ...providerLines,
    ...boardYieldMarkdown(report.board_yield as BoardYieldSummary | null | undefined),
  ];
  return lines.join("\n");
}

async function run(): Promise<void> {
  const workflowKillSwitchOn = isWorkflowKillSwitchOn();
  if (workflowKillSwitchOn) {
    console.error("!!! WORKFLOW_KILL_SWITCH IS ON — ALL PIPELINE PROCESSING IS PAUSED !!!");
  }
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for pipeline status reporting.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    // resolveWorkspaceContext accepts the pool query surface at this script boundary.
    const context = await resolveWorkspaceContext(pool as unknown as pg.PoolClient);
    const providerWindowMinutes = providerCallWindowMinutes();
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
      providerCallRows,
    ] = await Promise.all([
      pool.query<TaskHealthRow>(
        `SELECT health.task_type, health.status, health.task_count, health.oldest_age_seconds,
                status_age.oldest_status_age_seconds, due_age.oldest_due_age_seconds
         FROM v_pipeline_task_queue_health AS health
         LEFT JOIN v_pipeline_task_status_age AS status_age
           USING (workspace_id, task_type, status)
         LEFT JOIN v_pipeline_task_due_age AS due_age
           USING (workspace_id, task_type, status)
         WHERE health.workspace_id = $1
           AND health.status IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY', 'DEAD_LETTER')
         ORDER BY health.task_type, health.status`,
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
      pool.query<ProviderCallRow>(PROVIDER_CALLS_SQL, [context.workspaceId, providerWindowMinutes]),
    ]);

    // Off unless PIPELINE_BOARD_YIELD_REPORT_ENABLED=true; a query failure fails the report.
    const boardYield = boardYieldReportEnabled()
      ? summarizeBoardYield(
        (await pool.query<BoardYieldRow>(BOARD_YIELD_SQL, [context.workspaceId, BOARD_YIELD_WINDOW_DAYS])).rows,
      )
      : null;

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
    const maxPendingAgeRaw = Number.parseInt(process.env.PIPELINE_TASK_WORKER_MAX_PENDING_AGE_SECONDS ?? "7200", 10);
    const maxPendingAgeSeconds = Number.isFinite(maxPendingAgeRaw) && maxPendingAgeRaw > 0
      ? Math.min(maxPendingAgeRaw, 604800)
      : 7200;
    const stages = summarizeTaskStages(taskHealthRows, maxPendingAgeSeconds);
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
      workflow_kill_switch_on: workflowKillSwitchOn,
      max_pending_age_seconds: maxPendingAgeSeconds,
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
      provider_call_window_minutes: providerWindowMinutes,
      provider_calls_by_model: summarizeProviderCallRows(providerCallRows.rows),
      board_yield: boardYield,
    };
    if (report.provider_calls_by_model.stop_rule_triggered) {
      console.error(
        `!!! STOP RULE: ${(report.provider_calls_by_model.rate_limited_share * 100).toFixed(1)}% of model calls in the last ` +
          `${providerWindowMinutes} min were rate limited (429); pause scaling. !!!`
      );
    }
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
