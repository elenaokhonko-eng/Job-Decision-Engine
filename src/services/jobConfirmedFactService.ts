/**
 * Record and read employer-confirmed facts for one job version (migration 110).
 *
 * Recording a fact appends it (superseding the current fact of the same type, if any) and, in the
 * same transaction, enqueues a forced hard-gate re-run task for that job version. The normal stage
 * worker runs the gate, and the gate's successors (embedding, lane routing, matching, recommendation
 * decision and readiness) follow through the usual pipeline_tasks chain. Nothing is recomputed
 * synchronously, so a worker or provider failure stays an operational retry, never a rejection.
 */
import type pg from "pg";

import {
  ConfirmedJobFactSchema,
  JOB_VERIFICATION_CHECKS_SCHEMA_VERSION,
  JobVerificationChecksSchema,
  type ConfirmedJobFact,
  type JobConfirmedFactRequest,
  type JobVerificationChecks,
} from "../contracts/jobConfirmedFacts.js";
import { extractTerritories } from "../pipeline/workabilityPolicy.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import { pipelineTaskStageVersion } from "../tasks/pipelineTaskCurrentness.js";
import { createTaskIntentV2 } from "../tasks/taskIntent.js";
import type { WorkspaceContext } from "../workspace/context.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export const CONFIRMED_FACT_RERUN_PRODUCER = "api.job_confirmed_fact" as const;

export class ConfirmedFactRequestError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfirmedFactRequestError";
  }
}

export interface RecordConfirmedFactResult {
  readonly fact: ConfirmedJobFact;
  readonly supersededFactId: string | null;
  readonly rerun: { readonly taskType: "APPLY_HARD_GATES"; readonly taskId: string; readonly taskKey: string; readonly inserted: boolean };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function factFromRow(row: Record<string, unknown>): ConfirmedJobFact {
  return ConfirmedJobFactSchema.parse({
    confirmed_fact_id: row.confirmed_fact_id ?? row.id,
    fact_type: row.fact_type,
    fact_value: row.fact_value,
    source_type: row.source_type,
    source_note: row.source_note ?? null,
    source_url: row.source_url ?? null,
    supersedes_fact_id: row.supersedes_fact_id ?? null,
    recorded_by_user_id: row.recorded_by_user_id,
    recorded_at: iso(row.recorded_at),
  });
}

/** The stored value for the request; a location also stores its normalized territories. */
export function storedFactValue(request: JobConfirmedFactRequest): Record<string, unknown> {
  if (request.fact_type === "LOCATION") {
    return { location: request.value.location, territories: extractTerritories(request.value.location) };
  }
  return { ...request.value };
}

/**
 * Record a confirmed fact for the job's current version and enqueue the gate re-run. Runs in the
 * caller's transaction when `manageTransaction` is false.
 */
export async function recordConfirmedJobFact(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  request: JobConfirmedFactRequest,
  options: { readonly manageTransaction?: boolean } = {},
): Promise<RecordConfirmedFactResult> {
  if (ctx.role === "READER") {
    throw new ConfirmedFactRequestError(403, "FORBIDDEN", "A writable workspace role is required to record a confirmed fact.");
  }
  const manageTransaction = options.manageTransaction !== false;
  if (manageTransaction) await client.query("BEGIN");
  try {
    // Lock the job so concurrent confirmations of the same job serialize on the chain head.
    const job = await client.query<{ latest_job_version_id: string | null; archived_at: Date | null }>(
      `SELECT latest_job_version_id, archived_at
       FROM canonical_jobs
       WHERE workspace_id = $1 AND id = $2
       FOR UPDATE`,
      [ctx.workspaceId, canonicalJobId],
    );
    const current = job.rows[0];
    if (!current) throw new ConfirmedFactRequestError(404, "JOB_NOT_FOUND", "The job was not found in this workspace.");
    if (current.archived_at) {
      throw new ConfirmedFactRequestError(409, "JOB_ARCHIVED", "The job is archived; restore it before recording a confirmed fact.");
    }
    if (current.latest_job_version_id !== request.job_version_id) {
      throw new ConfirmedFactRequestError(
        409,
        "JOB_VERSION_NOT_CURRENT",
        "The job version is not the job's current version; reload the job and confirm the fact for its current version.",
      );
    }

    const head = await client.query<{ id: string }>(
      `SELECT confirmed_fact_id AS id
       FROM v_job_confirmed_facts_current
       WHERE workspace_id = $1 AND job_version_id = $2 AND fact_type = $3`,
      [ctx.workspaceId, request.job_version_id, request.fact_type],
    );
    if (head.rows.length > 1) {
      throw new Error(`Confirmed fact chain for ${request.fact_type} has ${head.rows.length} current facts.`);
    }
    const supersededFactId = head.rows[0]?.id ?? null;

    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO job_confirmed_facts (
         workspace_id, canonical_job_id, job_version_id, fact_type, fact_value,
         source_type, source_note, source_url, supersedes_fact_id, recorded_by_user_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
       RETURNING id AS confirmed_fact_id, fact_type, fact_value, source_type, source_note, source_url,
                 supersedes_fact_id, recorded_by_user_id, recorded_at`,
      [
        ctx.workspaceId,
        canonicalJobId,
        request.job_version_id,
        request.fact_type,
        JSON.stringify(storedFactValue(request)),
        request.source_type,
        request.source_note,
        request.source_url,
        supersededFactId,
        ctx.userId,
      ],
    );
    const fact = factFromRow(inserted.rows[0]);
    const rerun = await enqueueConfirmedFactGateRerun(client, ctx, canonicalJobId, request.job_version_id, fact.confirmed_fact_id);
    if (manageTransaction) await client.query("COMMIT");
    return { fact, supersededFactId, rerun };
  } catch (error) {
    if (manageTransaction) await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * A forced APPLY_HARD_GATES task identified by the confirmed fact. `reprocess` makes the gate
 * re-evaluate a job past RAW_STAGED; `reprocess_existing_state` and `repair_generation` carry a fresh
 * identity to every successor stage, so completed tasks from earlier runs never suppress them.
 */
export async function enqueueConfirmedFactGateRerun(
  client: QueryClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  jobVersionId: string,
  confirmedFactId: string,
): Promise<RecordConfirmedFactResult["rerun"]> {
  const taskType = "APPLY_HARD_GATES" as const;
  const stageVersion = pipelineTaskStageVersion(taskType);
  if (!stageVersion) throw new Error("APPLY_HARD_GATES has no stage version.");
  const repairGeneration = `confirmed-fact:${confirmedFactId}`;
  const taskKey = `${taskType}:${jobVersionId}:${stageVersion}:${repairGeneration}`;
  const payload = {
    canonical_job_id: canonicalJobId,
    job_version_id: jobVersionId,
    reprocess: true,
    reprocess_existing_state: true,
    repair_generation: repairGeneration,
  };
  const intent = createTaskIntentV2({
    workspaceId: ctx.workspaceId,
    taskType,
    stageVersion,
    producer: CONFIRMED_FACT_RERUN_PRODUCER,
    requestId: repairGeneration,
    mode: "FORCE_RECOMPUTE",
    triggerRevisionId: confirmedFactId,
    payload,
  });
  const result = await enqueuePipelineTask(
    { taskType, taskKey, payload, intent, maxAttempts: 8 },
    client as pg.PoolClient,
    { context: ctx },
  );
  if (result.skippedReason) {
    throw new ConfirmedFactRequestError(409, result.skippedReason, "The job is archived; its pipeline cannot be re-run.");
  }
  return { taskType, taskId: result.taskId, taskKey, inserted: result.inserted };
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The verification read-model row for the job's current version, or null when it has none. */
export async function loadJobVerificationChecks(
  client: QueryClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
): Promise<JobVerificationChecks | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT workspace_id, canonical_job_id, job_version_id, gate_decision, gate_rejection_codes,
            gate_evidence_quotes, gate_workability_facts, gate_decided_at, open_checks, confirmed_facts,
            confirmed_fact_history_count, rerun_pending
     FROM v_job_verification_checks_scoped
     WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [ctx.workspaceId, canonicalJobId],
  );
  const row = rows[0];
  if (!row) return null;
  return JobVerificationChecksSchema.parse({
    schema_version: JOB_VERIFICATION_CHECKS_SCHEMA_VERSION,
    workspace_id: row.workspace_id,
    canonical_job_id: row.canonical_job_id,
    job_version_id: row.job_version_id,
    gate_decision: row.gate_decision ?? null,
    gate_rejection_codes: jsonArray(row.gate_rejection_codes).map(String),
    gate_evidence_quotes: jsonArray(row.gate_evidence_quotes).map(String),
    gate_workability_facts: row.gate_workability_facts ?? null,
    gate_decided_at: iso(row.gate_decided_at),
    open_checks: jsonArray(row.open_checks),
    confirmed_facts: jsonArray(row.confirmed_facts).map((fact) => factFromRow(fact as Record<string, unknown>)),
    confirmed_fact_history_count: Number(row.confirmed_fact_history_count),
    rerun_pending: row.rerun_pending === true,
  });
}

/** Every recorded fact for the job's current version, newest first (superseded ones included). */
export async function loadConfirmedFactHistory(
  client: QueryClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  jobVersionId: string,
): Promise<ConfirmedJobFact[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id AS confirmed_fact_id, fact_type, fact_value, source_type, source_note, source_url,
            supersedes_fact_id, recorded_by_user_id, recorded_at
     FROM job_confirmed_facts
     WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3
     ORDER BY recorded_at DESC, id DESC`,
    [ctx.workspaceId, canonicalJobId, jobVersionId],
  );
  return rows.map(factFromRow);
}
