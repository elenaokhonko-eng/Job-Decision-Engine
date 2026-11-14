/**
 * Re-fetch the full posting of a Gmail-discovered job through the pipeline's own
 * FETCH_JOB_CONTENT task.
 *
 * Shared by `scripts/repair_job_content.ts` (operator CLI) and the dashboard's
 * "Fetch full description" support action (`src/services/jobSupportIssues.ts`). Nothing is
 * fetched here: the stage worker fetches, persists the posting and normalizes it as for any
 * other alert, so the hard gates and every later stage run as usual.
 */
import crypto from "node:crypto";
import pg from "pg";

import { classifyDescriptionQuality, sourceContentEvidencePredicate } from "../pipeline/descriptionQuality.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import type { WorkspaceContext } from "../workspace/context.js";

export interface JobContentRepairTarget {
  readonly observationId?: string;
  readonly canonicalJobId?: string;
}

export interface JobContentRepairCandidate {
  observation_id: string;
  canonical_job_id: string | null;
  latest_job_version_id: string | null;
  processing_state: string | null;
  source_url: string;
  company_name: string;
  title: string;
  description_length: number;
  current_description: string | null;
  description_quality_status: string | null;
  raw_email_alert_id: string | null;
  gmail_message_id: string | null;
  observation_status: string | null;
  has_source_content_evidence: boolean;
  is_test_fixture: boolean;
  has_application: boolean;
  has_documents: boolean;
  has_active_pipeline_task: boolean;
  has_active_evaluation: boolean;
}

/** Refusal that leaves nothing changed; the message is safe to show to the user. */
export class JobContentRepairRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobContentRepairRefusal";
  }
}

export async function loadJobContentRepairCandidate(
  client: pg.Pool | pg.PoolClient,
  context: Pick<WorkspaceContext, "workspaceId">,
  target: JobContentRepairTarget,
  lockObservation = false,
): Promise<JobContentRepairCandidate | null> {
  if (Boolean(target.observationId) === Boolean(target.canonicalJobId)) {
    throw new Error("Provide exactly one of observationId or canonicalJobId.");
  }
  const selector = target.observationId
    ? "observation.id = $2::uuid"
    : "canonical.id = $2::uuid";
  const result = await client.query<JobContentRepairCandidate>(
    `SELECT observation.id::text AS observation_id,
            canonical.id::text AS canonical_job_id,
            canonical.latest_job_version_id::text AS latest_job_version_id,
            COALESCE(canonical.processing_state, canonical.processing_status) AS processing_state,
            observation.source_url,
            observation.company_name,
            observation.title,
            LENGTH(COALESCE(observation.description_raw, '')) AS description_length,
            current_version.description_text AS current_description,
            canonical.description_quality_status,
            observation.raw_email_alert_id::text AS raw_email_alert_id,
            observation.gmail_message_id,
            observation.processing_status AS observation_status,
            ${sourceContentEvidencePredicate("current_version.workspace_id", "current_version.id")} AS has_source_content_evidence,
            COALESCE(canonical.is_test_fixture, FALSE) AS is_test_fixture,
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
                AND task.status = 'RUNNING'
                AND (
                  task.payload->>'observation_id' = observation.id::text
                  OR task.payload->>'job_version_id' = current_version.id::text
                )
            ) AS has_active_pipeline_task,
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
       AND ${selector}
     ORDER BY (observation.job_version_id = canonical.latest_job_version_id) DESC NULLS LAST,
              LENGTH(COALESCE(observation.description_raw, '')) ASC,
              observation.retrieved_at DESC,
              observation.id ASC
     LIMIT 1
     ${lockObservation ? "FOR UPDATE OF observation" : ""}`,
    [context.workspaceId, target.observationId ?? target.canonicalJobId],
  );
  return result.rows[0] ?? null;
}

export function currentDescriptionQuality(
  candidate: Pick<JobContentRepairCandidate, "current_description">,
): ReturnType<typeof classifyDescriptionQuality> {
  return classifyDescriptionQuality(candidate.current_description ?? "");
}

export interface EnqueueJobContentRefetchResult {
  readonly candidate: JobContentRepairCandidate;
  readonly taskId: string;
  readonly inserted: boolean;
}

/**
 * Re-opens the Gmail card for fetching and enqueues a forced FETCH_JOB_CONTENT task.
 * Must run inside the caller's transaction; throws JobContentRepairRefusal (nothing written) when
 * the job is protected or the fetch is not needed.
 */
export async function enqueueJobContentRefetch(
  client: pg.PoolClient,
  context: WorkspaceContext,
  target: JobContentRepairTarget,
  options: { readonly forceRefetch: boolean; readonly producer: string },
): Promise<EnqueueJobContentRefetchResult> {
  const candidate = await loadJobContentRepairCandidate(client, context, target, true);
  if (!candidate) throw new JobContentRepairRefusal("No Gmail discovery observation with a posting URL matched this target.");
  if (candidate.processing_state === "MANUALLY_REMOVED") {
    throw new JobContentRepairRefusal("Manual removal protects this job from automatic source repair.");
  }
  if (candidate.is_test_fixture) throw new JobContentRepairRefusal("Test fixtures cannot be repaired from live source URLs.");
  if (candidate.has_application || candidate.has_documents) {
    throw new JobContentRepairRefusal("Existing application or document history protects this job from automatic source repair.");
  }
  if (candidate.has_active_pipeline_task || candidate.has_active_evaluation) {
    throw new JobContentRepairRefusal("An active pipeline or AI evaluation lease protects this job from source repair.");
  }
  const quality = currentDescriptionQuality(candidate);
  if (!options.forceRefetch && quality.status === "COMPLETE" && candidate.has_source_content_evidence) {
    throw new JobContentRepairRefusal("The current canonical posting is already complete; pass --force-refetch to refresh it.");
  }

  const activeTasks = await client.query(
    `SELECT id
     FROM pipeline_tasks
     WHERE workspace_id = $1
       AND task_type = 'FETCH_JOB_CONTENT'
       AND payload->>'observation_id' = $2
       AND status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
     LIMIT 1
     FOR UPDATE`,
    [context.workspaceId, candidate.observation_id],
  );
  if (activeTasks.rows.length > 0) throw new JobContentRepairRefusal("A posting fetch task is already active for this observation.");

  if (candidate.latest_job_version_id) {
    const activeAssessment = await client.query(
      `SELECT id
       FROM pipeline_tasks
       WHERE workspace_id = $1
         AND payload->>'job_version_id' = $2
         AND status = 'RUNNING'
       LIMIT 1`,
      [context.workspaceId, candidate.latest_job_version_id],
    );
    if (activeAssessment.rows.length > 0) {
      throw new JobContentRepairRefusal("An assessment task is currently running for this canonical version.");
    }
  }

  await client.query(
    `UPDATE raw_job_observations
     SET processing_status = 'FETCH_PENDING'
     WHERE workspace_id = $1 AND id = $2::uuid AND source_name = 'GMAIL_ALERT'`,
    [context.workspaceId, candidate.observation_id],
  );
  if (candidate.raw_email_alert_id) {
    await client.query(
      `UPDATE raw_email_alerts
       SET lifecycle_status = 'SOURCE_PENDING', last_error = NULL
       WHERE workspace_id = $1 AND id = $2::uuid`,
      [context.workspaceId, candidate.raw_email_alert_id],
    );
  } else if (candidate.gmail_message_id) {
    await client.query(
      `UPDATE raw_email_alerts
       SET lifecycle_status = 'SOURCE_PENDING', last_error = NULL
       WHERE workspace_id = $1 AND gmail_message_id = $2`,
      [context.workspaceId, candidate.gmail_message_id],
    );
  }

  const taskKey = `FETCH_JOB_CONTENT:${candidate.observation_id}:posting_fetch_v1:repair:${crypto.randomUUID()}`;
  const task = await enqueuePipelineTask({
    taskType: "FETCH_JOB_CONTENT",
    taskKey,
    payload: { observation_id: candidate.observation_id, force_refetch: true },
    maxAttempts: 8,
    producer: options.producer,
    stageVersion: "posting_fetch_v1",
    requestId: taskKey,
  }, client, { context });
  return { candidate, taskId: task.taskId, inserted: task.inserted };
}
