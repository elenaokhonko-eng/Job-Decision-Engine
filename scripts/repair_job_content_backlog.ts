import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import { classifyDescriptionQuality, sourceContentEvidencePredicate } from "../src/pipeline/descriptionQuality.js";
import { emailReplayCommand } from "../src/ingestion/emailParserReplay.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

export const MAX_REPAIR_BACKLOG_BATCH_SIZE = 25;
const BACKLOG_STEP_KEY = "gmail_posting_retrieval_v1";
const FETCH_STAGES = [
  "FETCH_JOB_CONTENT",
  "NORMALIZE_OBSERVATION",
  "EXTRACT_DETERMINISTIC_REQUIREMENTS",
  "APPLY_HARD_GATES",
].join(",");

export interface RepairBacklogArguments {
  readonly workspaceKey: string;
  readonly userKey?: string;
  readonly runKey: string;
  readonly batchSize: number;
  readonly apply: boolean;
}

export interface RepairBacklogCandidate {
  readonly observationId: string;
  readonly retrievedAt: string;
  readonly sourceUrl: string;
  readonly description: string;
  readonly rawEmailAlertId: string | null;
  readonly gmailMessageId: string | null;
  readonly eligible: boolean;
  readonly skipReason: string | null;
}

interface BacklogCandidateRow {
  observation_id: string;
  retrieved_at: string;
  source_url: string;
  description: string;
  raw_email_alert_id: string | null;
  gmail_message_id: string | null;
  current_description: string | null;
  has_source_content_evidence: boolean;
  is_test_fixture: boolean;
  is_manually_removed: boolean;
  has_application: boolean;
  has_documents: boolean;
  has_active_task: boolean;
  has_active_evaluation: boolean;
}

interface BacklogCursor {
  readonly retrievedAt: string | null;
  readonly observationId: string | null;
  readonly scanned: number;
  readonly enqueued: number;
  readonly skipped: number;
}

export function parseRepairBacklogArguments(argv: readonly string[]): RepairBacklogArguments {
  const values: Record<string, string> = {};
  let apply = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be provided once.");
      dryRun = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${argument ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    const key = argument.slice(2);
    if (!["workspace-key", "user-key", "run-key", "batch-size"].includes(key)) {
      throw new Error(`Unsupported argument: ${argument}`);
    }
    if (values[key]) throw new Error(`${argument} may only be provided once.`);
    values[key] = value;
    index += 1;
  }

  const workspaceKey = values["workspace-key"]?.trim();
  const runKey = values["run-key"]?.trim() || "gmail_posting_retrieval_v1";
  const batchSize = values["batch-size"] === undefined ? MAX_REPAIR_BACKLOG_BATCH_SIZE : Number(values["batch-size"]);
  if (!workspaceKey) throw new Error("--workspace-key is required to scope the backlog repair.");
  if (apply && dryRun) throw new Error("--apply and --dry-run cannot be combined.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(runKey)) {
    throw new Error("--run-key must be 1-120 letters, digits, dots, underscores, colons, or hyphens.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_REPAIR_BACKLOG_BATCH_SIZE) {
    throw new Error(`--batch-size must be an integer from 1 to ${MAX_REPAIR_BACKLOG_BATCH_SIZE}.`);
  }
  return {
    workspaceKey,
    ...(values["user-key"] ? { userKey: values["user-key"].trim() } : {}),
    runKey,
    batchSize,
    apply,
  };
}

function readCursor(value: unknown): BacklogCursor {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch {
      throw new Error("The persisted Gmail backlog checkpoint is not valid JSON; refusing to restart from the beginning.");
    }
  }
  if (parsed === null || parsed === undefined) {
    return { retrievedAt: null, observationId: null, scanned: 0, enqueued: 0, skipped: 0 };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The persisted Gmail backlog checkpoint has an unsupported shape.");
  }
  const record = parsed as Record<string, unknown>;
  const retrievedAt = typeof record.retrievedAt === "string" ? record.retrievedAt : null;
  const observationId = typeof record.observationId === "string" ? record.observationId : null;
  const counts = [record.scanned, record.enqueued, record.skipped];
  if ((retrievedAt === null) !== (observationId === null)
      || (observationId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(observationId))
      || counts.some((count) => !Number.isInteger(count) || Number(count) < 0)) {
    throw new Error("The persisted Gmail backlog checkpoint is incomplete or invalid; refusing to skip or repeat work.");
  }
  return {
    retrievedAt,
    observationId,
    scanned: Number(record.scanned),
    enqueued: Number(record.enqueued),
    skipped: Number(record.skipped),
  };
}

function candidateFromRow(row: BacklogCandidateRow): RepairBacklogCandidate {
  const quality = classifyDescriptionQuality(row.current_description ?? row.description);
  const protectedReason = row.is_manually_removed ? "MANUALLY_REMOVED"
    : row.is_test_fixture ? "TEST_FIXTURE"
      : row.has_application ? "HAS_APPLICATION"
        : row.has_documents ? "HAS_DOCUMENTS"
          : row.has_active_task ? "ACTIVE_PIPELINE_TASK"
            : row.has_active_evaluation ? "ACTIVE_EVALUATION"
              : row.has_source_content_evidence && quality.status === "COMPLETE" ? "SOURCE_ALREADY_COMPLETE"
                : null;
  return {
    observationId: row.observation_id,
    retrievedAt: row.retrieved_at,
    sourceUrl: row.source_url,
    description: row.description,
    rawEmailAlertId: row.raw_email_alert_id,
    gmailMessageId: row.gmail_message_id,
    eligible: protectedReason === null,
    skipReason: protectedReason,
  };
}

async function selectBacklogCandidates(
  client: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
  cursor: BacklogCursor,
  batchSize: number,
  lockRows: boolean,
): Promise<{ candidates: RepairBacklogCandidate[]; hasMore: boolean }> {
  const rows = await client.query<BacklogCandidateRow>(
    `SELECT observation.id::text AS observation_id,
            observation.retrieved_at::text AS retrieved_at,
            observation.source_url,
            observation.description_raw AS description,
            observation.raw_email_alert_id::text AS raw_email_alert_id,
            observation.gmail_message_id,
            current_version.description_text AS current_description,
            ${sourceContentEvidencePredicate("current_version.workspace_id", "current_version.id")} AS has_source_content_evidence,
            COALESCE(canonical.is_test_fixture, FALSE) AS is_test_fixture,
            COALESCE(canonical.processing_state, canonical.processing_status) = 'MANUALLY_REMOVED' AS is_manually_removed,
            EXISTS (
              SELECT 1 FROM application_records application
              WHERE application.workspace_id = observation.workspace_id
                AND application.canonical_job_id = canonical.id
            ) AS has_application,
            EXISTS (
              SELECT 1 FROM document_runs document
              WHERE document.canonical_job_id = canonical.id
            ) AS has_documents,
            EXISTS (
              SELECT 1 FROM pipeline_tasks task
              WHERE task.workspace_id = observation.workspace_id
                AND task.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
                AND (task.payload->>'observation_id' = observation.id::text
                  OR task.payload->>'job_version_id' = current_version.id::text)
            ) AS has_active_task,
            EXISTS (
              SELECT 1 FROM evaluation_queue evaluation
              WHERE evaluation.workspace_id = observation.workspace_id
                AND evaluation.job_version_id = current_version.id
                AND evaluation.status = 'EVALUATING'
            ) AS has_active_evaluation
     FROM raw_job_observations observation
     LEFT JOIN job_versions observed_version
       ON observed_version.workspace_id = observation.workspace_id
      AND observed_version.id = observation.job_version_id
     LEFT JOIN canonical_jobs canonical
       ON canonical.workspace_id = observed_version.workspace_id
      AND canonical.id = observed_version.canonical_job_id
     LEFT JOIN job_versions current_version
       ON current_version.workspace_id = canonical.workspace_id
      AND current_version.id = canonical.latest_job_version_id
     WHERE observation.workspace_id = $1
       AND observation.source_name = 'GMAIL_ALERT'
       AND NULLIF(BTRIM(observation.source_url), '') IS NOT NULL
       AND ($2::timestamptz IS NULL OR (observation.retrieved_at, observation.id) > ($2::timestamptz, $3::uuid))
     ORDER BY observation.retrieved_at, observation.id
     LIMIT $4
     ${lockRows ? "FOR UPDATE OF observation" : ""}`,
    [context.workspaceId, cursor.retrievedAt, cursor.observationId, batchSize + 1],
  );
  const hasMore = rows.rows.length > batchSize;
  const page = rows.rows.slice(0, batchSize);
  return { candidates: page.map(candidateFromRow), hasMore };
}

export async function runRepairBacklogBatch(
  client: pg.PoolClient,
  context: WorkspaceContext,
  options: { runKey: string; batchSize: number; apply: boolean },
): Promise<{
  runId: string | null;
  candidates: RepairBacklogCandidate[];
  eligibleCount: number;
  hasMore: boolean;
  cursor: { retrievedAt: string | null; observationId: string | null };
  totals: { scanned: number; enqueued: number; skipped: number };
  status: "DRY_RUN" | "RUNNING" | "COMPLETED";
}> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > MAX_REPAIR_BACKLOG_BATCH_SIZE) {
    throw new Error(`Backlog batch size must be between 1 and ${MAX_REPAIR_BACKLOG_BATCH_SIZE}.`);
  }
  if (!options.apply) {
    const storedRun = await client.query<{ id: string; status: string; checkpoint: unknown }>(
      `SELECT run.id::text, run.status, checkpoint.checkpoint
       FROM backfill_runs run
       LEFT JOIN backfill_checkpoints checkpoint ON checkpoint.workspace_id = run.workspace_id
         AND checkpoint.backfill_run_id = run.id AND checkpoint.step_key = $3
       WHERE run.workspace_id = $1 AND run.run_key = $2
       ORDER BY run.started_at DESC LIMIT 1`,
      [context.workspaceId, options.runKey, BACKLOG_STEP_KEY],
    );
    const prior = storedRun.rows[0];
    const priorCursor = readCursor(prior?.checkpoint);
    if (prior?.status === "COMPLETED") {
      return {
        runId: prior.id,
        candidates: [],
        eligibleCount: 0,
        hasMore: false,
        cursor: { retrievedAt: priorCursor.retrievedAt, observationId: priorCursor.observationId },
        totals: { scanned: priorCursor.scanned, enqueued: priorCursor.enqueued, skipped: priorCursor.skipped },
        status: "COMPLETED",
      };
    }
    const page = await selectBacklogCandidates(client, context, priorCursor, options.batchSize, false);
    return {
      runId: prior?.status === "RUNNING" ? prior.id : null,
      candidates: page.candidates,
      eligibleCount: page.candidates.filter((candidate) => candidate.eligible).length,
      hasMore: page.hasMore,
      cursor: {
        retrievedAt: page.candidates.at(-1)?.retrievedAt ?? null,
        observationId: page.candidates.at(-1)?.observationId ?? null,
      },
      totals: {
        scanned: priorCursor.scanned + page.candidates.length,
        enqueued: priorCursor.enqueued,
        skipped: priorCursor.skipped + page.candidates.filter((candidate) => !candidate.eligible).length,
      },
      status: "DRY_RUN",
    };
  }

  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${context.workspaceId}:${options.runKey}`]);
    let run = await client.query<{ id: string; status: string }>(
      `SELECT id::text, status FROM backfill_runs
       WHERE workspace_id = $1 AND run_key = $2 AND status = 'RUNNING'
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [context.workspaceId, options.runKey],
    );
    if (!run.rows[0]) {
      const previous = await client.query<{ status: string }>(
        `SELECT status FROM backfill_runs WHERE workspace_id = $1 AND run_key = $2
         ORDER BY started_at DESC LIMIT 1`,
        [context.workspaceId, options.runKey],
      );
      if (previous.rows[0]?.status === "COMPLETED") {
        const completed = await client.query<{ id: string; checkpoint: unknown }>(
          `SELECT run.id::text, checkpoint.checkpoint
           FROM backfill_runs run
           LEFT JOIN backfill_checkpoints checkpoint ON checkpoint.workspace_id = run.workspace_id
             AND checkpoint.backfill_run_id = run.id AND checkpoint.step_key = $3
           WHERE run.workspace_id = $1 AND run.run_key = $2 AND run.status = 'COMPLETED'
           ORDER BY run.started_at DESC LIMIT 1`,
          [context.workspaceId, options.runKey, BACKLOG_STEP_KEY],
        );
        const completedRun = completed.rows[0];
        if (!completedRun) throw new Error("Completed backlog run disappeared while locked.");
        const completedCursor = readCursor(completedRun.checkpoint);
        await client.query("COMMIT");
        return {
          runId: completedRun.id,
          candidates: [],
          eligibleCount: 0,
          hasMore: false,
          cursor: { retrievedAt: completedCursor.retrievedAt, observationId: completedCursor.observationId },
          totals: { scanned: completedCursor.scanned, enqueued: completedCursor.enqueued, skipped: completedCursor.skipped },
          status: "COMPLETED",
        };
      }
      run = await client.query<{ id: string; status: string }>(
        `INSERT INTO backfill_runs (workspace_id, run_key, status, dry_run, created_by_user_id)
         VALUES ($1, $2, 'RUNNING', FALSE, $3) RETURNING id::text, status`,
        [context.workspaceId, options.runKey, context.userId],
      );
    }
    const runId = run.rows[0]?.id;
    if (!runId) throw new Error("Could not create or resume the durable backlog run.");
    const checkpointResult = await client.query<{ checkpoint: unknown }>(
      `SELECT checkpoint FROM backfill_checkpoints
       WHERE workspace_id = $1 AND backfill_run_id = $2::uuid AND step_key = $3 FOR UPDATE`,
      [context.workspaceId, runId, BACKLOG_STEP_KEY],
    );
    const checkpoint = readCursor(checkpointResult.rows[0]?.checkpoint);
    const page = await selectBacklogCandidates(client, context, checkpoint, options.batchSize, true);
    let enqueuedThisBatch = 0;
    let skippedThisBatch = 0;

    for (const candidate of page.candidates) {
      if (!candidate.eligible) {
        skippedThisBatch += 1;
        continue;
      }
      await client.query(
        `UPDATE raw_job_observations
         SET processing_status = 'FETCH_PENDING'
         WHERE workspace_id = $1 AND id = $2::uuid AND source_name = 'GMAIL_ALERT'`,
        [context.workspaceId, candidate.observationId],
      );
      if (candidate.rawEmailAlertId) {
        await client.query(
          `UPDATE raw_email_alerts SET lifecycle_status = 'SOURCE_PENDING', last_error = NULL
           WHERE workspace_id = $1 AND id = $2::uuid`,
          [context.workspaceId, candidate.rawEmailAlertId],
        );
      } else if (candidate.gmailMessageId) {
        await client.query(
          `UPDATE raw_email_alerts SET lifecycle_status = 'SOURCE_PENDING', last_error = NULL
           WHERE workspace_id = $1 AND gmail_message_id = $2`,
          [context.workspaceId, candidate.gmailMessageId],
        );
      }
      const taskKey = `FETCH_JOB_CONTENT:${candidate.observationId}:posting_fetch_v1:backfill:${runId}`;
      const task = await enqueuePipelineTask({
        taskType: "FETCH_JOB_CONTENT",
        taskKey,
        payload: { observation_id: candidate.observationId, force_refetch: true },
        maxAttempts: 8,
        producer: "repair_job_content_backlog",
        stageVersion: "posting_fetch_v1",
        requestId: `${runId}:${candidate.observationId}`,
      }, client, { context });
      if (task.inserted || task.reactivated) enqueuedThisBatch += 1;
    }

    const lastCandidate = page.candidates.at(-1);
    const cursor = {
      retrievedAt: lastCandidate?.retrievedAt ?? checkpoint.retrievedAt,
      observationId: lastCandidate?.observationId ?? checkpoint.observationId,
    };
    const totals = {
      scanned: checkpoint.scanned + page.candidates.length,
      enqueued: checkpoint.enqueued + enqueuedThisBatch,
      skipped: checkpoint.skipped + skippedThisBatch,
    };
    const status = page.hasMore ? "RUNNING" : "COMPLETED";
    await client.query(
      `INSERT INTO backfill_checkpoints (workspace_id, backfill_run_id, step_key, checkpoint)
       VALUES ($1, $2::uuid, $3, $4::jsonb)
       ON CONFLICT (backfill_run_id, step_key)
       DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_at = NOW()`,
      [context.workspaceId, runId, BACKLOG_STEP_KEY, JSON.stringify({
        ...cursor,
        ...totals,
        status,
        lastBatchAt: new Date().toISOString(),
      })],
    );
    await client.query(
      `UPDATE backfill_runs SET status = $3, completed_at = CASE WHEN $3 = 'COMPLETED' THEN NOW() ELSE NULL END,
         updated_at = NOW(), last_error = NULL
       WHERE workspace_id = $1 AND id = $2::uuid`,
      [context.workspaceId, runId, status],
    );
    await client.query("COMMIT");
    return {
      runId,
      candidates: page.candidates,
      eligibleCount: page.candidates.filter((candidate) => candidate.eligible).length,
      hasMore: page.hasMore,
      cursor,
      totals,
      status,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    await client.query(
      `UPDATE backfill_runs SET last_error = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND run_key = $2 AND status = 'RUNNING'`,
      [context.workspaceId, options.runKey, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }
}

async function loadEmailAlertInventory(client: pg.PoolClient, workspaceId: string): Promise<{
  unprocessed: number;
  parserBlocked: number;
  otherBlocked: number;
  sourcePending: number;
}> {
  const result = await client.query<{
    unprocessed: number;
    parser_blocked: number;
    other_blocked: number;
    source_pending: number;
  }>(
    `SELECT COUNT(*) FILTER (WHERE processed = FALSE)::int AS unprocessed,
            COUNT(*) FILTER (WHERE processed = TRUE AND lifecycle_status = 'SOURCE_BLOCKED'
              AND (last_error LIKE 'MISSING_POSTING_URL:%' OR last_error LIKE 'EMAIL_EXTRACTION_FAILED:%'))::int AS parser_blocked,
            COUNT(*) FILTER (WHERE processed = TRUE AND lifecycle_status = 'SOURCE_BLOCKED'
              AND COALESCE(last_error, '') NOT LIKE 'MISSING_POSTING_URL:%'
              AND COALESCE(last_error, '') NOT LIKE 'EMAIL_EXTRACTION_FAILED:%')::int AS other_blocked,
            COUNT(*) FILTER (WHERE lifecycle_status = 'SOURCE_PENDING')::int AS source_pending
     FROM raw_email_alerts WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return {
    unprocessed: Number(row?.unprocessed ?? 0),
    parserBlocked: Number(row?.parser_blocked ?? 0),
    otherBlocked: Number(row?.other_blocked ?? 0),
    sourcePending: Number(row?.source_pending ?? 0),
  };
}

function workerCommand(observationIds: readonly string[]): string {
  if (observationIds.length === 0) return "";
  return [
    `$env:PIPELINE_TASK_WORKER_TASK_TYPES='${FETCH_STAGES}'`,
    `$env:PIPELINE_TASK_WORKER_OBSERVATION_IDS='${observationIds.join(",")}'`,
    `$env:PIPELINE_TASK_WORKER_MAX_TASKS='${Math.max(1, observationIds.length * 4)}'`,
    "$env:PIPELINE_TASK_WORKER_SEED='false'",
    "npm run pipeline:worker",
  ].join("; ");
}

async function main(): Promise<void> {
  const args = parseRepairBacklogArguments(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    const context = await resolveWorkspaceContext(client, {
      workspaceKey: args.workspaceKey,
      ...(args.userKey ? { userKey: args.userKey } : {}),
    });
    if (args.apply && context.role !== "OWNER") throw new Error("Applying a backlog repair requires an OWNER workspace membership.");
    const result = await runRepairBacklogBatch(client, context, args);
    const emailAlerts = await loadEmailAlertInventory(client, context.workspaceId);
    console.log(JSON.stringify({
      mode: args.apply ? "APPLY" : "DRY_RUN",
      workspaceKey: context.workspaceKey,
      runKey: args.runKey,
      runId: result.runId,
      batchSize: args.batchSize,
      maxBatchSize: MAX_REPAIR_BACKLOG_BATCH_SIZE,
      status: result.status,
      scanned: result.totals.scanned,
      enqueued: result.totals.enqueued,
      skipped: result.totals.skipped,
      pageHasMore: result.hasMore,
      cursor: result.cursor,
      emailAlerts,
      candidates: result.candidates.map(({ observationId, eligible, skipReason }) => ({ observationId, eligible, skipReason })),
      parserReplayCommand: emailAlerts.parserBlocked > 0
        ? emailReplayCommand(context.workspaceKey, context.userKey, Math.min(20, Math.max(1, emailAlerts.parserBlocked)))
        : null,
      resumeCommand: args.apply && result.status === "RUNNING"
        ? `npm run pipeline:repair-content-backlog -- --workspace-key '${context.workspaceKey.replace(/'/g, "''")}' --run-key '${args.runKey}' --batch-size ${args.batchSize} --apply`
        : null,
      workerCommand: args.apply
        ? workerCommand(result.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.observationId)) || null
        : null,
      note: "Run the scoped worker and verify its task claims before starting the next recovery batch.",
    }, null, 2));
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("repair_job_content_backlog")) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
