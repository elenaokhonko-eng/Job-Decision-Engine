/**
 * Technical-error support actions (migration 112, `v_job_support_issues_scoped`).
 *
 * Each technical-error job is listed once per issue class with the actions that can resolve it.
 * Every action re-reads the issue inside its own transaction, refuses an action the current row
 * does not offer, and writes one append-only `job_support_actions` audit row in the same
 * transaction as its effect:
 *
 * - FETCH_DESCRIPTION: re-opens the Gmail card and enqueues a forced FETCH_JOB_CONTENT task
 *   (src/services/jobContentRepair.ts); the stage worker fetches and normalizes the posting.
 * - PASTE_DESCRIPTION: stages the pasted posting as a new MANUAL_STREAMLIT observation carrying the
 *   canonical job's own URL, company, title and location (so normalization resolves the same
 *   canonical job and creates a new version) and enqueues its NORMALIZE_OBSERVATION task. The hard
 *   gates and every later stage run as usual; nothing is decided here.
 * - RETRY: moves the issue's DEAD_LETTER tasks back to PENDING with a few more attempts. Attempt
 *   history is kept (attempt_count is never reset) and the stage re-runs its own checks.
 * - DISMISS: records the user's "not interested" decision as MANUALLY_REMOVED (the existing manual
 *   removal state). Nothing is deleted, and an operational failure is never turned into a
 *   rejection (invariant 1): the job moves to Removed, not Rejected.
 */
import crypto from "node:crypto";
import pg from "pg";

import {
  JOB_SUPPORT_ACTION_SCHEMA_VERSION,
  JobSupportIssueRowSchema,
  type JobSupportActionRequest,
  type JobSupportActionResult,
  type JobSupportIssueRow,
  type JobSupportRetryAllResult,
} from "../contracts/jobStatus.js";
import { classifyDescriptionQuality } from "../pipeline/descriptionQuality.js";
import { replayDeadLetterPipelineTask } from "../tasks/pipelineTasks.js";
import { seedRecoverablePipelineTasks } from "../tasks/stageTaskWorker.js";
import type { WorkspaceContext } from "../workspace/context.js";
import { JobContentRepairRefusal, enqueueJobContentRefetch } from "./jobContentRepair.js";

/** Extra attempts a manual retry grants beyond the attempts already used. */
export const SUPPORT_RETRY_EXTRA_ATTEMPTS = 3;
/** Upper bound on the jobs one "Retry all retryable" request touches. */
export const SUPPORT_RETRY_ALL_LIMIT = 100;
export const SUPPORT_DISMISS_REASON = "MANUALLY_REMOVED: dismissed from technical errors (not interested)";

export class SupportActionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupportActionError";
  }
}

export function canWriteSupportActions(ctx: Pick<WorkspaceContext, "role">): boolean {
  return ctx.role === "OWNER" || ctx.role === "MEMBER";
}

type Queryable = Pick<pg.PoolClient, "query">;

const ISSUE_COLUMNS = `
  workspace_id::text, canonical_job_id::text, job_version_id::text, title, company, canonical_url,
  source, processing_state, recommendation_outcome, issue_class, issue_detail, repair_action,
  task_ids::text[] AS task_ids, task_types, retryable, fetchable_source, available_actions,
  detected_at`;

export async function listSupportIssues(client: Queryable, ctx: Pick<WorkspaceContext, "workspaceId">): Promise<JobSupportIssueRow[]> {
  const { rows } = await client.query(
    `SELECT ${ISSUE_COLUMNS}
     FROM v_job_support_issues_scoped
     WHERE workspace_id = $1
     ORDER BY detected_at DESC NULLS LAST, company, title, canonical_job_id, issue_class`,
    [ctx.workspaceId],
  );
  return rows.map((row) => JobSupportIssueRowSchema.parse(row));
}

async function loadIssue(
  client: Queryable,
  ctx: Pick<WorkspaceContext, "workspaceId">,
  canonicalJobId: string,
  issueClass: string,
): Promise<JobSupportIssueRow | null> {
  const { rows } = await client.query(
    `SELECT ${ISSUE_COLUMNS}
     FROM v_job_support_issues_scoped
     WHERE workspace_id = $1 AND canonical_job_id = $2::uuid AND issue_class = $3
     LIMIT 1`,
    [ctx.workspaceId, canonicalJobId, issueClass],
  );
  return rows[0] ? JobSupportIssueRowSchema.parse(rows[0]) : null;
}

interface ActionEffect {
  readonly outcome: "APPLIED" | "NO_CHANGE";
  readonly message: string;
  readonly taskIds: string[];
  readonly observationId: string | null;
  readonly details: Record<string, unknown>;
}

async function retryDeadLetters(client: Queryable, ctx: WorkspaceContext, issue: JobSupportIssueRow): Promise<ActionEffect> {
  const retried: string[] = [];
  for (const taskId of issue.task_ids) {
    const { rows } = await client.query<{ attempt_count: number; status: string }>(
      `SELECT attempt_count, status FROM pipeline_tasks
       WHERE workspace_id = $1 AND id = $2::uuid
       FOR UPDATE`,
      [ctx.workspaceId, taskId],
    );
    const task = rows[0];
    if (!task || task.status !== "DEAD_LETTER") continue;
    const replay = await replayDeadLetterPipelineTask({
      taskId,
      maxAttempts: Number(task.attempt_count) + SUPPORT_RETRY_EXTRA_ATTEMPTS,
    }, client as pg.PoolClient, { context: ctx });
    if (replay.replayed) retried.push(replay.taskId);
  }
  return retried.length > 0
    ? {
      outcome: "APPLIED",
      message: `Queued ${retried.length} failed pipeline step(s) to run again; the next pipeline run picks them up.`,
      taskIds: retried,
      observationId: null,
      details: { retried_task_ids: retried, extra_attempts: SUPPORT_RETRY_EXTRA_ATTEMPTS },
    }
    : {
      outcome: "NO_CHANGE",
      message: "Nothing to retry: the failed steps are already queued or finished.",
      taskIds: [],
      observationId: null,
      details: {},
    };
}

async function dismissJob(client: Queryable, ctx: WorkspaceContext, issue: JobSupportIssueRow, note: string | undefined): Promise<ActionEffect> {
  const updated = await client.query(
    `UPDATE canonical_jobs
     SET processing_state = 'MANUALLY_REMOVED',
         processing_status = 'MANUALLY_REMOVED',
         rejection_reason = $3,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2::uuid
       AND COALESCE(processing_state, processing_status) <> 'MANUALLY_REMOVED'`,
    [ctx.workspaceId, issue.canonical_job_id, SUPPORT_DISMISS_REASON],
  );
  const changed = (updated.rowCount ?? 0) > 0;
  return {
    outcome: changed ? "APPLIED" : "NO_CHANGE",
    message: changed
      ? "Dismissed: the job moved to Removed. Its record and history are kept."
      : "The job was already removed.",
    taskIds: [],
    observationId: null,
    details: {
      previous_processing_state: issue.processing_state,
      ...(note ? { note } : {}),
    },
  };
}

async function fetchDescription(client: pg.PoolClient, ctx: WorkspaceContext, issue: JobSupportIssueRow): Promise<ActionEffect> {
  try {
    const { candidate, taskId, inserted } = await enqueueJobContentRefetch(
      client,
      ctx,
      { canonicalJobId: issue.canonical_job_id },
      { forceRefetch: false, producer: "support_issue_fetch_description" },
    );
    return {
      outcome: taskId ? "APPLIED" : "NO_CHANGE",
      message: taskId
        ? "Queued a fresh fetch of the full posting; the next pipeline run fetches it and re-runs the checks."
        : "The job is archived, so no fetch was queued.",
      taskIds: taskId ? [taskId] : [],
      observationId: candidate.observation_id,
      details: { observation_id: candidate.observation_id, task_inserted: inserted },
    };
  } catch (error) {
    if (error instanceof JobContentRepairRefusal) {
      throw new SupportActionError(409, "FETCH_NOT_POSSIBLE", `${error.message} Paste the full description instead.`);
    }
    throw error;
  }
}

interface CanonicalIdentityRow {
  company_name: string;
  normalized_title: string;
  canonical_url: string | null;
  location: string | null;
  location_summary: string | null;
  latest_job_version_id: string | null;
}

async function pasteDescription(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  issue: JobSupportIssueRow,
  description: string,
): Promise<ActionEffect> {
  const quality = classifyDescriptionQuality(description);
  if (quality.status !== "COMPLETE") {
    throw new SupportActionError(
      422,
      "DESCRIPTION_INSUFFICIENT",
      `The pasted text does not look like a full posting (${quality.reason ?? quality.status}). Include the responsibilities and the requirements.`,
    );
  }
  const identity = await client.query<CanonicalIdentityRow>(
    `SELECT company_name, normalized_title, canonical_url, location, location_summary,
            latest_job_version_id::text AS latest_job_version_id
     FROM canonical_jobs
     WHERE workspace_id = $1 AND id = $2::uuid`,
    [ctx.workspaceId, issue.canonical_job_id],
  );
  const job = identity.rows[0];
  if (!job) throw new SupportActionError(404, "JOB_NOT_FOUND", "The job no longer exists in this workspace.");
  const url = String(job.canonical_url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    // Without the canonical URL the pasted posting could resolve to a different job of the same company.
    throw new SupportActionError(409, "JOB_URL_MISSING", "This job has no posting URL, so a pasted description cannot be attached to it safely. Add the posting with Add job instead.");
  }
  const location = job.location ?? job.location_summary ?? "Unknown";
  const trimmed = description.trim();
  // Normalization resolves identity by canonical URL + company + location, then by
  // company + normalized title + location; the observation carries the canonical job's own values.
  const rawPayload = {
    source: "MANUAL_STREAMLIT",
    source_provenance: "USER_PROVIDED",
    source_content_status: "USER_PROVIDED",
    support_action: "PASTE_DESCRIPTION",
    canonical_job_id: issue.canonical_job_id,
    replaces_job_version_id: issue.job_version_id,
    url,
    title: job.normalized_title,
    company: job.company_name,
    location,
    description_sha256: crypto.createHash("sha256").update(trimmed).digest("hex"),
    description: trimmed,
  };
  const serialized = JSON.stringify(rawPayload);
  const payloadHash = crypto.createHash("sha256").update(serialized).digest("hex");
  const run = await client.query<{ id: string }>(
    `INSERT INTO source_runs (workspace_id, status, total_fetched, total_new)
     VALUES ($1, 'COMPLETED', 1, 1) RETURNING id`,
    [ctx.workspaceId],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO raw_job_observations (
       workspace_id, source_run_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, location_raw, workplace_type_raw, employment_type_raw,
       compensation_raw, canonical_apply_url, source_lane, search_plan_version, raw_payload, raw_payload_hash
     ) VALUES ($1, $2, 'MANUAL_STREAMLIT', $3, $4, NOW(), $5, $6, $7, $8, 'UNKNOWN', 'UNKNOWN',
               'UNKNOWN', $4, 'UNKNOWN', 'support_paste_description_v1', $9::jsonb, $10)
     ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING
     RETURNING id::text`,
    [ctx.workspaceId, run.rows[0]?.id, `support-paste-${payloadHash.slice(0, 16)}`, url,
      job.company_name, job.normalized_title, trimmed, location, serialized, payloadHash],
  );
  const observationId = inserted.rows[0]?.id ?? null;
  if (!observationId) {
    return {
      outcome: "NO_CHANGE",
      message: "This exact description was already submitted for this job; it is waiting for the next pipeline run.",
      taskIds: [],
      observationId: null,
      details: { raw_payload_hash: payloadHash },
    };
  }
  const seeded = await seedRecoverablePipelineTasks(client, {
    context: ctx,
    taskTypes: ["NORMALIZE_OBSERVATION"],
    observationIds: [observationId],
    maxSeedPerType: 1,
  });
  const counts = seeded.byType.NORMALIZE_OBSERVATION ?? { inserted: 0, existing: 0 };
  if (counts.inserted + counts.existing === 0) {
    // The observation stays staged (PENDING) for the worker's own seeding; report it rather than hide it.
    throw new Error("The pasted posting was staged but its normalization task could not be queued.");
  }
  return {
    outcome: "APPLIED",
    message: "Saved the description as a new posting version; the next pipeline run normalizes it and re-runs the hard gates and matching.",
    taskIds: [],
    observationId,
    details: {
      observation_id: observationId,
      raw_payload_hash: payloadHash,
      description_chars: trimmed.length,
      normalize_tasks_inserted: counts.inserted,
    },
  };
}

/** Runs one support action for one issue in its own transaction and audits it. */
export async function performSupportAction(
  pool: pg.Pool,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  request: JobSupportActionRequest,
): Promise<JobSupportActionResult> {
  if (!canWriteSupportActions(ctx)) {
    throw new SupportActionError(403, "FORBIDDEN", "A writable workspace role is required to act on technical errors.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const locked = await client.query(
        `SELECT id FROM canonical_jobs WHERE workspace_id = $1 AND id = $2::uuid FOR UPDATE`,
        [ctx.workspaceId, canonicalJobId],
      );
      if (locked.rows.length === 0) {
        throw new SupportActionError(404, "JOB_NOT_FOUND", "The job does not exist in this workspace.");
      }
      const issue = await loadIssue(client, ctx, canonicalJobId, request.issue_class);
      if (!issue) {
        throw new SupportActionError(409, "ISSUE_NOT_OPEN", "This issue is no longer open. Refresh the list.");
      }
      if (issue.job_version_id !== request.job_version_id) {
        throw new SupportActionError(409, "JOB_VERSION_CHANGED", "The job has a newer version since this list was loaded. Refresh the list.");
      }
      if (!issue.available_actions.includes(request.action)) {
        throw new SupportActionError(422, "ACTION_NOT_AVAILABLE", `${request.action} is not available for ${issue.issue_class}.`);
      }
      let effect: ActionEffect;
      switch (request.action) {
        case "RETRY":
          effect = await retryDeadLetters(client, ctx, issue);
          break;
        case "DISMISS":
          effect = await dismissJob(client, ctx, issue, request.note);
          break;
        case "FETCH_DESCRIPTION":
          effect = await fetchDescription(client, ctx, issue);
          break;
        case "PASTE_DESCRIPTION":
          if (!request.description) {
            throw new SupportActionError(400, "INVALID_REQUEST", "PASTE_DESCRIPTION requires the full posting description.");
          }
          effect = await pasteDescription(client, ctx, issue, request.description);
          break;
      }
      const audit = await client.query<{ id: string }>(
        `INSERT INTO job_support_actions (
           workspace_id, canonical_job_id, job_version_id, issue_class, action, outcome, details, performed_by_user_id
         ) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8)
         RETURNING id::text`,
        [ctx.workspaceId, canonicalJobId, issue.job_version_id, issue.issue_class, request.action,
          effect.outcome, JSON.stringify({ ...effect.details, issue_detail: issue.issue_detail }), ctx.userId],
      );
      await client.query("COMMIT");
      const auditId = audit.rows[0]?.id;
      if (!auditId) throw new Error("The support action audit row was not persisted.");
      return {
        schema_version: JOB_SUPPORT_ACTION_SCHEMA_VERSION,
        ok: true,
        canonical_job_id: canonicalJobId,
        action: request.action,
        outcome: effect.outcome,
        audit_id: auditId,
        message: effect.message,
        task_ids: effect.taskIds,
        observation_id: effect.observationId,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Retries every open issue that offers RETRY, one transaction per issue. */
export async function retryAllRetryable(pool: pg.Pool, ctx: WorkspaceContext): Promise<JobSupportRetryAllResult> {
  if (!canWriteSupportActions(ctx)) {
    throw new SupportActionError(403, "FORBIDDEN", "A writable workspace role is required to act on technical errors.");
  }
  const { rows } = await pool.query(
    `SELECT ${ISSUE_COLUMNS}
     FROM v_job_support_issues_scoped
     WHERE workspace_id = $1 AND 'RETRY' = ANY(available_actions)
     ORDER BY detected_at DESC NULLS LAST, canonical_job_id, issue_class
     LIMIT $2`,
    [ctx.workspaceId, SUPPORT_RETRY_ALL_LIMIT],
  );
  const issues = rows.map((row) => JobSupportIssueRowSchema.parse(row));
  const results: JobSupportActionResult[] = [];
  let unchanged = 0;
  for (const issue of issues) {
    try {
      const result = await performSupportAction(pool, ctx, issue.canonical_job_id, {
        job_version_id: issue.job_version_id,
        issue_class: issue.issue_class,
        action: "RETRY",
      });
      results.push(result);
      if (result.outcome !== "APPLIED") unchanged += 1;
    } catch (error) {
      // An issue closed or changed since the list was read is reported as unchanged, not hidden.
      if (error instanceof SupportActionError && error.status === 409) {
        unchanged += 1;
        continue;
      }
      throw error;
    }
  }
  return {
    schema_version: JOB_SUPPORT_ACTION_SCHEMA_VERSION,
    ok: true,
    considered: issues.length,
    retried: results.filter((result) => result.outcome === "APPLIED").length,
    unchanged,
    results,
  };
}
