import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

/**
 * Parks waiting FETCH_JOB_CONTENT tasks for Gmail-alert jobs from sources the user
 * has retired (LinkedIn and MyCareersFuture). Their pages cannot be fetched, so the
 * tasks only delay employer career-site alerts in the queue.
 *
 * Parking deletes nothing. The task becomes BLOCKED_DEPENDENCY on JOB_CONTENT with
 * repair action IMPORT_SAVED_JOB_EXPORT, and the observation becomes FETCH_BLOCKED
 * with an error-history entry. A saved-jobs export for the same job id reactivates
 * it; the employer-board requeue (PROVIDE_EMPLOYER_URL_OR_FULL_JD) does not select it.
 * Raw email alerts are left unchanged, so Gmail clean-up treats them as before.
 */

export const RETIRED_ALERT_HOSTS = ["linkedin.com", "mycareersfuture.gov.sg", "swda.gov.sg"] as const;
export const PARKED_REPAIR_ACTION = "IMPORT_SAVED_JOB_EXPORT";
export const PARKED_REASON =
  "SOURCE_RETIRED_BY_USER: LinkedIn and MyCareersFuture alert content comes from the saved-jobs export, not from fetching the page.";

function hostMatches(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((retired) => host === retired || host.endsWith("." + retired));
}

/** The host whose content the alert link points at, looking through SES click tracking. */
export function retiredHostOf(sourceUrl: string, hosts: readonly string[] = RETIRED_ALERT_HOSTS): string | null {
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
  if (!hostMatches(url.hostname, hosts)) return null;
  return hosts.find((retired) => hostMatches(url.hostname, [retired])) ?? null;
}

interface Candidate {
  readonly task_id: string;
  readonly observation_id: string;
  readonly source_url: string;
}

export interface ParkReport {
  readonly mode: "DRY_RUN" | "APPLY";
  readonly candidates: number;
  readonly byHost: Record<string, number>;
  readonly parkedTasks: number;
  readonly parkedObservations: number;
}

export async function parkRetiredAlertSources(
  client: pg.PoolClient,
  context: WorkspaceContext,
  options: { readonly apply: boolean; readonly hosts?: readonly string[] },
): Promise<ParkReport> {
  const hosts = options.hosts ?? RETIRED_ALERT_HOSTS;
  await client.query("BEGIN");
  try {
    // Only unleased waiting tasks; RUNNING work and rows locked by a worker are skipped.
    const { rows } = await client.query<Candidate>(
      `SELECT task.id::text AS task_id, observation.id::text AS observation_id, observation.source_url
       FROM pipeline_tasks AS task
       JOIN raw_job_observations AS observation
         ON observation.workspace_id = task.workspace_id
        AND observation.id::text = COALESCE(
              task.payload->'task_intent'->'target'->>'observationId',
              task.payload->>'observation_id')
       WHERE task.workspace_id = $1
         AND task.task_type = 'FETCH_JOB_CONTENT'
         AND task.status IN ('PENDING', 'RETRY_WAIT')
         AND task.lease_id IS NULL
         AND observation.source_name = 'GMAIL_ALERT'
       FOR UPDATE OF task SKIP LOCKED`,
      [context.workspaceId],
    );
    const byHost: Record<string, number> = {};
    const selected: Candidate[] = [];
    for (const row of rows) {
      const host = retiredHostOf(row.source_url, hosts);
      if (!host) continue;
      byHost[host] = (byHost[host] ?? 0) + 1;
      selected.push(row);
    }

    if (!options.apply || selected.length === 0) {
      await client.query("ROLLBACK");
      return { mode: options.apply ? "APPLY" : "DRY_RUN", candidates: selected.length, byHost, parkedTasks: 0, parkedObservations: 0 };
    }

    const taskIds = selected.map((row) => row.task_id);
    const observationIds = [...new Set(selected.map((row) => row.observation_id))];
    const parkedTasks = await client.query(
      `UPDATE pipeline_tasks
       SET status = 'BLOCKED_DEPENDENCY',
           available_at = NOW(),
           lease_id = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           claimed_by = NULL,
           last_error = $3,
           blocked_on = 'JOB_CONTENT',
           blocked_reason = $3,
           repair_action = $4,
           completed_at = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id::text = ANY($2::text[])
         AND status IN ('PENDING', 'RETRY_WAIT')`,
      [context.workspaceId, taskIds, PARKED_REASON, PARKED_REPAIR_ACTION],
    );
    const parkedObservations = await client.query(
      `UPDATE raw_job_observations
       SET processing_status = 'FETCH_BLOCKED',
           error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array($3::jsonb)
       WHERE workspace_id = $1 AND id::text = ANY($2::text[])`,
      [context.workspaceId, observationIds, JSON.stringify({
        stage: "FETCH_JOB_CONTENT",
        processing_status: "FETCH_BLOCKED",
        error: PARKED_REASON,
        occurred_at: new Date().toISOString(),
      })],
    );
    if (parkedTasks.rowCount !== taskIds.length) {
      throw new Error(`Expected to park ${taskIds.length} task(s) but updated ${parkedTasks.rowCount}; nothing was changed.`);
    }
    await client.query("COMMIT");
    return {
      mode: "APPLY",
      candidates: selected.length,
      byHost,
      parkedTasks: parkedTasks.rowCount ?? 0,
      parkedObservations: parkedObservations.rowCount ?? 0,
    };
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
    const report = await parkRetiredAlertSources(client, context, { apply });
    console.log(JSON.stringify(report, null, 2));
    if (!apply) console.log("Dry run only. Re-run with --apply to park these tasks.");
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("park_retired_alert_sources")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
