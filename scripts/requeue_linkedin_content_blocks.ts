/**
 * Requeues FETCH_JOB_CONTENT tasks for LinkedIn alert cards that were blocked (or dead-lettered)
 * before the employer-board lookup existed, so the worker retries them through the lookup.
 *
 * Dry run by default; --apply requires an OWNER membership. Only tasks whose last error predates
 * the lookup (no EMPLOYER_BOARD_* reason) are selected, so a task the lookup has already settled
 * is never requeued in a loop. Task and attempt history, observations and error history are kept.
 *
 *   npm run pipeline:requeue-linkedin-blocks -- --workspace-key <key> [--limit 200] [--apply]
 */
import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

export const MAX_REQUEUE_LIMIT = 2000;

export interface RequeueArguments {
  readonly workspaceKey: string;
  readonly limit: number;
  readonly apply: boolean;
}

export function parseRequeueArguments(argv: readonly string[]): RequeueArguments {
  let apply = false;
  let workspaceKey = "";
  let limit = 200;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    const value = argv[index + 1];
    if ((argument === "--workspace-key" || argument === "--limit") && value && !value.startsWith("--")) {
      if (argument === "--workspace-key") workspaceKey = value.trim();
      else limit = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unexpected or incomplete argument: ${argument ?? ""}`);
  }
  if (!workspaceKey) throw new Error("--workspace-key is required.");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REQUEUE_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_REQUEUE_LIMIT}.`);
  }
  return { workspaceKey, limit, apply };
}

/** Selection shared by the dry run and the update. $1 = workspace, $2 = limit. */
const TARGETS_SQL = `
  SELECT task.id AS task_id, observation.id AS observation_id
  FROM pipeline_tasks task
  JOIN raw_job_observations observation
    ON observation.workspace_id = task.workspace_id
   AND observation.id::text = task.payload->>'observation_id'
  WHERE task.workspace_id = $1
    AND task.task_type = 'FETCH_JOB_CONTENT'
    AND (
      (task.status = 'BLOCKED_DEPENDENCY' AND task.blocked_on = 'JOB_CONTENT'
        AND task.repair_action = 'PROVIDE_EMPLOYER_URL_OR_FULL_JD')
      OR task.status = 'DEAD_LETTER'
    )
    AND COALESCE(task.last_error, '') NOT LIKE '%EMPLOYER_BOARD_%'
    AND observation.source_name = 'GMAIL_ALERT'
    AND observation.processing_status IN ('FETCH_BLOCKED', 'FETCH_FAILED')
    AND observation.source_url ~* '^https?://([a-z0-9-]+\\.)*linkedin\\.com/(comm/)?jobs/view/'
    AND NOT EXISTS (
      SELECT 1 FROM pipeline_tasks active
      WHERE active.workspace_id = task.workspace_id
        AND active.task_type = 'FETCH_JOB_CONTENT'
        AND active.id <> task.id
        AND active.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
        AND active.payload->>'observation_id' = task.payload->>'observation_id'
    )
  ORDER BY task.updated_at, task.id
  LIMIT $2`;

export interface RequeueResult {
  readonly mode: "DRY_RUN" | "APPLY";
  readonly selected: number;
  readonly requeued: number;
  readonly taskIds: readonly string[];
}

export async function requeueLinkedInContentBlocks(
  client: pg.PoolClient,
  context: WorkspaceContext,
  options: { readonly limit: number; readonly apply: boolean },
): Promise<RequeueResult> {
  if (!options.apply) {
    const { rows } = await client.query<{ task_id: string }>(TARGETS_SQL, [context.workspaceId, options.limit]);
    return { mode: "DRY_RUN", selected: rows.length, requeued: 0, taskIds: rows.map((row) => row.task_id) };
  }
  await client.query("BEGIN");
  try {
    const { rows } = await client.query<{ task_id: string; observation_id: string }>(
      `${TARGETS_SQL} FOR UPDATE OF task SKIP LOCKED`,
      [context.workspaceId, options.limit],
    );
    const taskIds = rows.map((row) => row.task_id);
    const updated = await client.query<{ id: string }>(
      `UPDATE pipeline_tasks
       SET status = 'PENDING',
           available_at = NOW(),
           lease_id = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           claimed_by = NULL,
           blocked_on = NULL,
           blocked_reason = NULL,
           repair_action = NULL,
           dead_letter_reason = NULL,
           completed_at = NULL,
           max_attempts = GREATEST(max_attempts, attempt_count + 3),
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])
       RETURNING id::text`,
      [context.workspaceId, taskIds],
    );
    await client.query(
      `UPDATE raw_job_observations
       SET processing_status = 'FETCH_PENDING'
       WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND source_name = 'GMAIL_ALERT'
         AND processing_status IN ('FETCH_BLOCKED', 'FETCH_FAILED')`,
      [context.workspaceId, rows.map((row) => row.observation_id)],
    );
    if (updated.rows.length !== taskIds.length) {
      throw new Error(`Requeue updated ${updated.rows.length} of ${taskIds.length} selected tasks; rolled back.`);
    }
    await client.query("COMMIT");
    return { mode: "APPLY", selected: taskIds.length, requeued: updated.rows.length, taskIds };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseRequeueArguments(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    const context = await resolveWorkspaceContext(client, { workspaceKey: args.workspaceKey });
    if (args.apply && context.role !== "OWNER") throw new Error("Applying a requeue requires an OWNER workspace membership.");
    const result = await requeueLinkedInContentBlocks(client, context, args);
    // Counts and task ids only; no URLs, titles or employer names.
    console.log(JSON.stringify({ ...result, taskIds: result.taskIds.slice(0, 20) }, null, 2));
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("requeue_linkedin_content_blocks")) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
