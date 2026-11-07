import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { isEmailAlertPostingLink } from "../src/ingestion/emailAlertExtractor.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

/**
 * Requeues FETCH_JOB_CONTENT tasks for employer career-site alert links that were
 * blocked as POSTING_IDENTITY_CONFLICT before the fetcher could read schema.org
 * microdata, tolerate a location or requisition suffix on the alert title, and
 * take the employer from the page when the alert card named none.
 *
 * Selection: waiting (unleased) BLOCKED_DEPENDENCY fetch tasks whose block is a
 * posting identity conflict (repair action VERIFY_POSTING_IDENTITY or a
 * POSTING_IDENTITY_CONFLICT reason), for GMAIL_ALERT observations whose link host
 * is not LinkedIn or MyCareersFuture. Observations the current alert extractor
 * treats as navigation (career home pages, alert management, "here" links) stay
 * blocked and are reported.
 *
 * Requeue deletes nothing. The task returns to PENDING with its block cleared and
 * max_attempts raised to leave at least REQUEUE_EXTRA_ATTEMPTS attempts; the
 * observation returns to FETCH_PENDING with an error-history entry that keeps the
 * previous block reason. Raw email alerts are left unchanged. Dry run by default;
 * --apply writes everything in one transaction.
 */

export const EXCLUDED_ALERT_HOSTS = ["linkedin.com", "mycareersfuture.gov.sg"] as const;
export const IDENTITY_CONFLICT_REPAIR_ACTION = "VERIFY_POSTING_IDENTITY";
export const IDENTITY_CONFLICT_REASON_PREFIX = "POSTING_IDENTITY_CONFLICT:";
export const REQUEUE_EXTRA_ATTEMPTS = 3;
export const REQUEUE_EVENT = "REQUEUED_AFTER_EMPLOYER_IDENTITY_FIX";

/** The host the alert link points at, looking through SES click tracking; null when unparseable. */
export function alertLinkHost(sourceUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (/(?:^|\.)awstrack\.me$/i.test(url.hostname)) {
    const encoded = url.pathname.match(/^\/L0\/([^/]+)/)?.[1];
    if (!encoded) return null;
    try {
      url = new URL(decodeURIComponent(encoded));
    } catch {
      return null;
    }
  }
  return url.hostname.toLowerCase();
}

function isExcludedHost(host: string): boolean {
  return EXCLUDED_ALERT_HOSTS.some((excluded) => host === excluded || host.endsWith("." + excluded));
}

interface Candidate {
  readonly task_id: string;
  readonly observation_id: string;
  readonly source_url: string | null;
  readonly title: string;
  readonly blocked_reason: string | null;
}

export interface RequeueReport {
  readonly mode: "DRY_RUN" | "APPLY";
  /** Blocked identity-conflict fetch tasks for Gmail alert observations. */
  readonly identityConflictTasks: number;
  readonly requeueable: number;
  readonly requeueableByHost: Record<string, number>;
  readonly skippedExcludedHost: number;
  readonly skippedNavigation: number;
  readonly skippedNavigationByHost: Record<string, number>;
  readonly requeuedTasks: number;
  readonly requeuedObservations: number;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function requeueEmployerIdentityConflicts(
  client: pg.PoolClient,
  context: WorkspaceContext,
  options: { readonly apply: boolean; readonly now?: () => Date },
): Promise<RequeueReport> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query<Candidate>(
      `SELECT task.id::text AS task_id,
              observation.id::text AS observation_id,
              observation.source_url,
              observation.title,
              COALESCE(task.blocked_reason, task.last_error) AS blocked_reason
       FROM pipeline_tasks AS task
       JOIN raw_job_observations AS observation
         ON observation.workspace_id = task.workspace_id
        AND observation.id::text = COALESCE(
              task.payload->'task_intent'->'target'->>'observationId',
              task.payload->>'observation_id')
       WHERE task.workspace_id = $1
         AND task.task_type = 'FETCH_JOB_CONTENT'
         AND task.status = 'BLOCKED_DEPENDENCY'
         AND task.lease_id IS NULL
         AND (
           task.repair_action = $2
           OR task.blocked_reason LIKE $3
           OR task.last_error LIKE $3
         )
         AND observation.source_name = 'GMAIL_ALERT'
       ORDER BY task.created_at, task.id
       FOR UPDATE OF task SKIP LOCKED`,
      [context.workspaceId, IDENTITY_CONFLICT_REPAIR_ACTION, IDENTITY_CONFLICT_REASON_PREFIX + "%"],
    );

    const requeueableByHost: Record<string, number> = {};
    const skippedNavigationByHost: Record<string, number> = {};
    let skippedExcludedHost = 0;
    const selected: Candidate[] = [];
    for (const row of rows) {
      const host = row.source_url ? alertLinkHost(row.source_url) : null;
      if (host && isExcludedHost(host)) {
        skippedExcludedHost += 1;
        continue;
      }
      if (!host || !row.source_url || !isEmailAlertPostingLink(row.source_url, row.title)) {
        increment(skippedNavigationByHost, host ?? "(unparseable)");
        continue;
      }
      increment(requeueableByHost, host);
      selected.push(row);
    }
    const skippedNavigation = Object.values(skippedNavigationByHost).reduce((sum, count) => sum + count, 0);
    const summary = {
      identityConflictTasks: rows.length,
      requeueable: selected.length,
      requeueableByHost,
      skippedExcludedHost,
      skippedNavigation,
      skippedNavigationByHost,
    };

    if (!options.apply || selected.length === 0) {
      await client.query("ROLLBACK");
      return { mode: options.apply ? "APPLY" : "DRY_RUN", ...summary, requeuedTasks: 0, requeuedObservations: 0 };
    }

    const occurredAt = (options.now?.() ?? new Date()).toISOString();
    const taskIds = selected.map((row) => row.task_id);
    const requeuedTasks = await client.query(
      `UPDATE pipeline_tasks
       SET status = 'PENDING',
           available_at = NOW(),
           lease_id = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           claimed_by = NULL,
           max_attempts = GREATEST(max_attempts, attempt_count + $3),
           last_error = NULL,
           blocked_on = NULL,
           blocked_reason = NULL,
           repair_action = NULL,
           completed_at = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id::text = ANY($2::text[])
         AND status = 'BLOCKED_DEPENDENCY'
         AND lease_id IS NULL`,
      [context.workspaceId, taskIds, REQUEUE_EXTRA_ATTEMPTS],
    );
    if (requeuedTasks.rowCount !== taskIds.length) {
      throw new Error(`Expected to requeue ${taskIds.length} task(s) but updated ${requeuedTasks.rowCount}; nothing was changed.`);
    }

    let requeuedObservations = 0;
    const seenObservations = new Set<string>();
    for (const row of selected) {
      if (seenObservations.has(row.observation_id)) continue;
      seenObservations.add(row.observation_id);
      const updated = await client.query(
        `UPDATE raw_job_observations
         SET processing_status = 'FETCH_PENDING',
             error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array($3::jsonb)
         WHERE workspace_id = $1 AND id::text = $2 AND source_name = 'GMAIL_ALERT'`,
        [context.workspaceId, row.observation_id, JSON.stringify({
          stage: "FETCH_JOB_CONTENT",
          processing_status: "FETCH_PENDING",
          event: REQUEUE_EVENT,
          previous_error: row.blocked_reason,
          occurred_at: occurredAt,
        })],
      );
      requeuedObservations += updated.rowCount ?? 0;
    }
    if (requeuedObservations !== seenObservations.size) {
      throw new Error(
        `Expected to reset ${seenObservations.size} observation(s) but updated ${requeuedObservations}; nothing was changed.`,
      );
    }
    await client.query("COMMIT");
    return { mode: "APPLY", ...summary, requeuedTasks: requeuedTasks.rowCount ?? 0, requeuedObservations };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  dotenv.config();
  dotenv.config({ path: ".env.local" });
  const apply = process.argv.includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  const client = await pool.connect();
  try {
    const context = await resolveWorkspaceContext(client);
    const report = await requeueEmployerIdentityConflicts(client, context, { apply });
    console.log(JSON.stringify(report, null, 2));
    if (!apply) console.log("Dry run only. Re-run with --apply to requeue these tasks.");
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("requeue_employer_identity_conflicts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
