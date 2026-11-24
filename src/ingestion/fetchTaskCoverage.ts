import type pg from "pg";
import type { Queryable } from "./contentCompleteness.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import type { WorkspaceContext } from "../workspace/context.js";

/**
 * Every alert observation is known only from an email snippet until its posting page is fetched, so every one
 * gets a FETCH_JOB_CONTENT task in the same transaction that stages it (scripts/parse_emails.ts). This module is
 * the one place that names the task key and checks that the task exists, and it reports the other direction for
 * reconciliation: a live job that has neither complete content nor a fetch task can never become complete.
 */

export const ALERT_FETCH_STAGE_VERSION = "posting_fetch_v1";

export function alertFetchTaskKey(observationId: string): string {
  return `FETCH_JOB_CONTENT:${observationId}:${ALERT_FETCH_STAGE_VERSION}`;
}

/** Queues the posting fetch for one staged alert observation. Idempotent on the task key. */
export async function enqueueAlertFetchTask(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  input: { observationId: string; producer: string },
): Promise<{ taskId: string; inserted: boolean; skippedBecauseArchived: boolean }> {
  const taskKey = alertFetchTaskKey(input.observationId);
  const task = await enqueuePipelineTask(
    {
      taskType: "FETCH_JOB_CONTENT",
      taskKey,
      payload: { observation_id: input.observationId },
      maxAttempts: 8,
      producer: input.producer,
      stageVersion: ALERT_FETCH_STAGE_VERSION,
      requestId: taskKey,
    },
    client,
    { context: ctx },
  );
  return { taskId: task.taskId, inserted: task.inserted, skippedBecauseArchived: task.skippedReason === "JOB_ARCHIVED" };
}

/**
 * Throws when a just-staged observation has no FETCH_JOB_CONTENT task. Called inside the staging transaction, so
 * a missing task rolls the whole alert back and leaves it unprocessed for the next run (nothing is lost).
 */
export async function assertObservationsHaveFetchTask(
  client: pg.PoolClient,
  workspaceId: string,
  observationIds: readonly string[],
): Promise<void> {
  if (observationIds.length === 0) return;
  const missing = await client.query<{ id: string }>(
    `SELECT observation.id::text AS id
       FROM raw_job_observations observation
      WHERE observation.workspace_id = $1::uuid
        AND observation.id = ANY($2::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_tasks task
           WHERE task.workspace_id = observation.workspace_id
             AND task.task_type = 'FETCH_JOB_CONTENT'
             AND task.payload->>'observation_id' = observation.id::text
        )`,
    [workspaceId, observationIds],
  );
  if (missing.rows.length > 0) {
    throw new Error(
      `Alert staging left ${missing.rows.length} observation(s) without a FETCH_JOB_CONTENT task: ${missing.rows.slice(0, 5).map((r) => r.id).join(", ")}.`,
    );
  }
}

export interface FetchTaskCoverageReport {
  /** Live jobs without complete content. */
  awaitingContentJobs: number;
  /** Of those, jobs with no FETCH_JOB_CONTENT task for any of their observations (each is a violation). */
  withoutFetchTask: string[];
  /** Of those, jobs whose every fetch task is DEAD_LETTER: stuck until the expiry rule archives them (information). */
  fetchDeadLetteredOnly: number;
}

/** Live jobs that neither have complete content nor a fetch task. Read only; ids only. */
export async function reportContentWithoutFetchTask(
  client: Queryable,
  workspaceId: string,
): Promise<FetchTaskCoverageReport> {
  const result = await client.query<{ canonical_job_id: string; task_count: number; live_task_count: number }>(
    `SELECT awaiting.canonical_job_id::text AS canonical_job_id,
            COALESCE(tasks.task_count, 0)::int AS task_count,
            COALESCE(tasks.live_task_count, 0)::int AS live_task_count
       FROM v_job_awaiting_content_scoped awaiting
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS task_count,
                COUNT(*) FILTER (WHERE task.status <> 'DEAD_LETTER')::int AS live_task_count
           FROM pipeline_tasks task
           JOIN raw_job_observations observation
             ON observation.workspace_id = task.workspace_id
            AND observation.id::text = task.payload->>'observation_id'
           JOIN job_versions version
             ON version.workspace_id = observation.workspace_id
            AND version.id = observation.job_version_id
          WHERE task.workspace_id = awaiting.workspace_id
            AND task.task_type = 'FETCH_JOB_CONTENT'
            AND version.canonical_job_id = awaiting.canonical_job_id
       ) tasks ON TRUE
      WHERE awaiting.workspace_id = $1::uuid
        -- An aggregator lead deliberately has no fetch task (FETCH_BLOCKED, see leadStaging.ts): it waits for the
        -- employer's posting or a saved-jobs export. Such a job is not a coverage violation.
        AND NOT EXISTS (
          SELECT 1
            FROM raw_job_observations lead
            JOIN job_versions lead_version
              ON lead_version.workspace_id = lead.workspace_id AND lead_version.id = lead.job_version_id
           WHERE lead.workspace_id = awaiting.workspace_id
             AND lead_version.canonical_job_id = awaiting.canonical_job_id
             AND lead.processing_status = 'FETCH_BLOCKED'
             AND lead.raw_payload->>'lead_kind' = 'AGGREGATOR_LEAD'
        )
      ORDER BY awaiting.canonical_job_id`,
    [workspaceId],
  );
  return {
    awaitingContentJobs: result.rows.length,
    withoutFetchTask: result.rows.filter((row) => row.task_count === 0).map((row) => row.canonical_job_id),
    fetchDeadLetteredOnly: result.rows.filter((row) => row.task_count > 0 && row.live_task_count === 0).length,
  };
}

export interface EnsureFetchTasksReport {
  mode: "DRY_RUN" | "APPLY";
  /** Live waiting jobs with no fetch task whose latest alert observation can be fetched, after the cap. */
  candidates: number;
  queued: number;
  /** Waiting jobs without a fetch task that were left alone because the owner saved them (their text comes from the export). */
  skippedOwnerSaved: number;
}

/** Per-run cap used by the worker seed (seedRecoverablePipelineTasks maxSeedPerType default). */
export const AWAITING_FETCH_SEED_DEFAULT_CAP = 200;

/**
 * Additive, idempotent path for a live job that has neither complete content nor a fetch task: queue one
 * FETCH_JOB_CONTENT task for its latest Gmail alert observation (idempotent on the shared key). It changes no job
 * status and no decision, and removing the task undoes it. Left alone: aggregator leads (they have no fetch task by
 * design), jobs the owner saved through a saved-jobs export (their text comes from the export, and a content-attach
 * task is the import's job), archived jobs (not live), and jobs with no Gmail alert observation (Hacker News,
 * Himalayas and exported jobs have nothing this fetch can retrieve). At most `limit` tasks per call, so a seed stays
 * bounded. The caller owns the transaction; a dry run only reads.
 */
export async function ensureFetchTasksForAwaitingContent(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  input: { apply: boolean; producer: string; limit?: number },
): Promise<EnsureFetchTasksReport> {
  const coverage = await reportContentWithoutFetchTask(client, ctx.workspaceId);
  const limit = input.limit ?? AWAITING_FETCH_SEED_DEFAULT_CAP;
  const jobIds = coverage.withoutFetchTask;
  const found = jobIds.length === 0 ? { rows: [] as { observation_id: string; owner_saved: boolean }[] } : await client.query<{ observation_id: string; owner_saved: boolean }>(
    `SELECT DISTINCT ON (version.canonical_job_id) observation.id::text AS observation_id,
            EXISTS (
              SELECT 1 FROM job_versions saved_version
                JOIN raw_job_observations saved_observation
                  ON saved_observation.workspace_id = saved_version.workspace_id AND saved_observation.job_version_id = saved_version.id
               WHERE saved_version.workspace_id = observation.workspace_id
                 AND saved_version.canonical_job_id = version.canonical_job_id
                 AND saved_observation.source_name IN ('LINKEDIN_SAVED', 'MCF_SAVED')
            ) AS owner_saved
       FROM raw_job_observations observation
       JOIN job_versions version
         ON version.workspace_id = observation.workspace_id AND version.id = observation.job_version_id
      WHERE observation.workspace_id = $1::uuid
        AND observation.source_name = 'GMAIL_ALERT'
        AND version.canonical_job_id = ANY($2::uuid[])
      ORDER BY version.canonical_job_id, observation.retrieved_at DESC, observation.id DESC`,
    [ctx.workspaceId, jobIds],
  );
  const skippedOwnerSaved = found.rows.filter((row) => row.owner_saved).length;
  const observations = found.rows.filter((row) => !row.owner_saved).slice(0, limit);
  let queued = 0;
  if (input.apply) {
    for (const row of observations) {
      const task = await enqueueAlertFetchTask(client, ctx, { observationId: row.observation_id, producer: input.producer });
      if (task.inserted) queued += 1;
    }
  }
  return { mode: input.apply ? "APPLY" : "DRY_RUN", candidates: observations.length, queued, skippedOwnerSaved };
}
