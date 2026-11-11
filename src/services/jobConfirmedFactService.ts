/**
 * Record, withdraw and read employer-confirmed facts for one job version (migration 110).
 *
 * Recording a fact compares it with the posting (structured fields, extracted requirements,
 * description and normalized source evidence) and stores the outcome: FILLS_UNKNOWN, MATCHES_POSTING
 * or CONFLICTS_WITH_POSTING, with the posting's value, source and evidence. Only FILLS_UNKNOWN facts
 * are ever applied by the gate and readiness. Withdrawing appends a WITHDRAWAL row that supersedes
 * the fact, so the fact returns to "no confirmation" with the withdrawal audited.
 *
 * Every record or withdrawal enqueues, in the same transaction, a forced hard-gate re-run for that
 * job version; the stage worker does the rest. Nothing is recomputed synchronously, so a worker or
 * provider failure stays an operational retry, never a rejection.
 */
import type pg from "pg";

import {
  ConfirmedJobFactSchema,
  JOB_VERIFICATION_CHECKS_SCHEMA_VERSION,
  JobVerificationChecksSchema,
  type ConfirmedFactType,
  type ConfirmedJobFact,
  type JobConfirmedFactRequest,
  type JobConfirmedFactWithdrawRequest,
  type JobVerificationChecks,
  type PostingFactEvidenceRecord,
} from "../contracts/jobConfirmedFacts.js";
import {
  assessConfirmedValue,
  assessPostingFacts,
  describePostingValue,
  postingSourceEvidence,
  type ConfirmedFactAssessmentOutcome,
} from "../pipeline/postingStatedFacts.js";
import { resolveEffectiveWorkabilityPolicy } from "../pipeline/effectiveWorkabilityPolicy.js";
import { extractTerritories } from "../pipeline/workabilityPolicy.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import { pipelineTaskStageVersion } from "../tasks/pipelineTaskCurrentness.js";
import { createTaskIntentV2 } from "../tasks/taskIntent.js";
import type { WorkspaceContext } from "../workspace/context.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export const CONFIRMED_FACT_RERUN_PRODUCER = "api.job_confirmed_fact" as const;

/** Only OWNER and MEMBER may record or withdraw; any other or future role is read-only. */
export function canWriteConfirmedFacts(ctx: Pick<WorkspaceContext, "role">): boolean {
  return ctx.role === "OWNER" || ctx.role === "MEMBER";
}

export class ConfirmedFactRequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfirmedFactRequestError";
  }
}

export interface ConfirmedFactRerun {
  readonly taskType: "APPLY_HARD_GATES";
  readonly taskId: string;
  readonly taskKey: string;
  readonly inserted: boolean;
}

export interface RecordConfirmedFactResult {
  readonly fact: ConfirmedJobFact;
  readonly supersededFactId: string | null;
  readonly rerun: ConfirmedFactRerun;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function factFromRow(row: Record<string, unknown>): ConfirmedJobFact {
  return ConfirmedJobFactSchema.parse({
    confirmed_fact_id: row.confirmed_fact_id ?? row.id,
    entry_kind: row.entry_kind ?? "CONFIRMATION",
    fact_type: row.fact_type,
    fact_value: row.fact_value,
    source_type: row.source_type ?? null,
    source_note: row.source_note ?? null,
    source_url: row.source_url ?? null,
    posting_assessment: row.posting_assessment ?? null,
    posting_evidence: row.posting_evidence ?? null,
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

const RETURNING = `RETURNING id AS confirmed_fact_id, entry_kind, fact_type, fact_value, source_type, source_note,
                  source_url, posting_assessment, posting_evidence, supersedes_fact_id, recorded_by_user_id, recorded_at`;

/** Lock the job and check that the version is its current, non-archived version. */
async function lockCurrentVersion(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  jobVersionId: string,
): Promise<void> {
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
  if (current.latest_job_version_id !== jobVersionId) {
    throw new ConfirmedFactRequestError(
      409,
      "JOB_VERSION_NOT_CURRENT",
      "The job version is not the job's current version; reload the job and confirm the fact for its current version.",
    );
  }
}

/** The head of a (job version, fact type) chain: a confirmation or a withdrawal, or none. */
async function chainHead(
  client: QueryClient,
  ctx: WorkspaceContext,
  jobVersionId: string,
  factType: ConfirmedFactType,
): Promise<{ id: string; entry_kind: string } | null> {
  const heads = await client.query<{ id: string; entry_kind: string }>(
    `SELECT fact.id, fact.entry_kind
     FROM job_confirmed_facts fact
     WHERE fact.workspace_id = $1 AND fact.job_version_id = $2 AND fact.fact_type = $3
       AND NOT EXISTS (SELECT 1 FROM job_confirmed_facts successor WHERE successor.supersedes_fact_id = fact.id)`,
    [ctx.workspaceId, jobVersionId, factType],
  );
  if (heads.rows.length > 1) throw new Error(`Confirmed fact chain for ${factType} has ${heads.rows.length} heads.`);
  return heads.rows[0] ?? null;
}

/**
 * The posting's side of the fact, read from the same inputs the gate and readiness use: the
 * canonical job's structured fields, the version's description and validated requirements, the
 * latest observation's location and normalized source evidence, and the workspace policy.
 */
export async function assessFactAgainstPosting(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  jobVersionId: string,
  factType: ConfirmedFactType,
  value: Record<string, unknown>,
): Promise<{ outcome: ConfirmedFactAssessmentOutcome; evidence: PostingFactEvidenceRecord }> {
  const { rows } = await client.query<{
    workplace_type: string | null;
    employment_type: string | null;
    location: string | null;
    company_name: string | null;
    description_text: string | null;
    source_location_raw: string | null;
    normalized_evidence: unknown;
  }>(
    `SELECT c.workplace_type, c.employment_type, c.location, c.company_name, jv.description_text,
            observation.location_raw AS source_location_raw, evidence.normalized_evidence
     FROM canonical_jobs c
     JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = $3 AND jv.canonical_job_id = c.id
     LEFT JOIN LATERAL (
       SELECT o.location_raw FROM raw_job_observations o
       WHERE o.workspace_id = jv.workspace_id AND o.job_version_id = jv.id
       ORDER BY o.retrieved_at DESC, o.id DESC LIMIT 1
     ) observation ON TRUE
     LEFT JOIN LATERAL (
       SELECT o.normalized_evidence FROM raw_job_observations o
       WHERE o.workspace_id = jv.workspace_id AND o.job_version_id = jv.id AND o.normalized_evidence IS NOT NULL
       ORDER BY o.retrieved_at DESC, o.id DESC LIMIT 1
     ) evidence ON TRUE
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [ctx.workspaceId, canonicalJobId, jobVersionId],
  );
  const job = rows[0];
  if (!job) throw new ConfirmedFactRequestError(404, "JOB_NOT_FOUND", "The job version was not found in this workspace.");
  const requirements = await client.query<{
    requirement_type: string;
    requirement_text: string;
    quote_text: string | null;
    structured_value: Record<string, unknown> | null;
  }>(
    `SELECT jr.requirement_type, jr.requirement_text, jr.quote_text, jr.structured_value
     FROM job_versions jv
     JOIN job_requirements jr
       ON jr.workspace_id = jv.workspace_id
      AND (
        (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
        OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
      )
     WHERE jv.workspace_id = $1 AND jv.id = $2 AND jr.status = 'VALIDATED'
     ORDER BY jr.requirement_key ASC`,
    [ctx.workspaceId, jobVersionId],
  );
  const sourceEvidence = postingSourceEvidence(job.normalized_evidence);
  // The same effective policy (workspace policy + stage3 on-site exception employers) the gate uses.
  const { policy } = await resolveEffectiveWorkabilityPolicy(client, { context: ctx });
  const posting = assessPostingFacts({
    workplaceType: job.workplace_type,
    employmentType: job.employment_type,
    location: job.location,
    sourceLocation: job.source_location_raw,
    description: job.description_text,
    companyName: job.company_name,
    requirements: requirements.rows,
    sourceEvidence,
    policy,
  })[factType];
  return {
    outcome: assessConfirmedValue(factType, value, posting),
    evidence: { ...posting, summary: describePostingValue(posting) },
  };
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
  if (!canWriteConfirmedFacts(ctx)) {
    throw new ConfirmedFactRequestError(403, "FORBIDDEN", "A writable workspace role is required to record a confirmed fact.");
  }
  const manageTransaction = options.manageTransaction !== false;
  if (manageTransaction) await client.query("BEGIN");
  try {
    await lockCurrentVersion(client, ctx, canonicalJobId, request.job_version_id);
    const head = await chainHead(client, ctx, request.job_version_id, request.fact_type);
    const value = storedFactValue(request);
    const assessment = await assessFactAgainstPosting(client, ctx, canonicalJobId, request.job_version_id, request.fact_type, value);
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO job_confirmed_facts (
         workspace_id, canonical_job_id, job_version_id, entry_kind, fact_type, fact_value,
         source_type, source_note, source_url, posting_assessment, posting_evidence,
         supersedes_fact_id, recorded_by_user_id
       ) VALUES ($1, $2, $3, 'CONFIRMATION', $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12)
       ${RETURNING}`,
      [
        ctx.workspaceId,
        canonicalJobId,
        request.job_version_id,
        request.fact_type,
        JSON.stringify(value),
        request.source_type,
        request.source_note,
        request.source_url,
        assessment.outcome,
        JSON.stringify(assessment.evidence),
        head?.id ?? null,
        ctx.userId,
      ],
    );
    const fact = factFromRow(inserted.rows[0]);
    const rerun = await enqueueConfirmedFactGateRerun(client, ctx, canonicalJobId, request.job_version_id, fact.confirmed_fact_id);
    if (manageTransaction) await client.query("COMMIT");
    return { fact, supersededFactId: head?.id ?? null, rerun };
  } catch (error) {
    if (manageTransaction) await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Withdraw the current confirmation: a WITHDRAWAL row supersedes it, the fact returns to "no
 * confirmation" and the gate re-runs. The withdrawal records who, when and the optional reason.
 */
export async function withdrawConfirmedJobFact(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  confirmedFactId: string,
  request: JobConfirmedFactWithdrawRequest,
  options: { readonly manageTransaction?: boolean } = {},
): Promise<RecordConfirmedFactResult> {
  if (!canWriteConfirmedFacts(ctx)) {
    throw new ConfirmedFactRequestError(403, "FORBIDDEN", "A writable workspace role is required to withdraw a confirmed fact.");
  }
  const manageTransaction = options.manageTransaction !== false;
  if (manageTransaction) await client.query("BEGIN");
  try {
    await lockCurrentVersion(client, ctx, canonicalJobId, request.job_version_id);
    const target = await client.query<{ fact_type: ConfirmedFactType }>(
      `SELECT fact_type FROM v_job_confirmed_facts_current
       WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3 AND confirmed_fact_id = $4`,
      [ctx.workspaceId, canonicalJobId, request.job_version_id, confirmedFactId],
    );
    if (!target.rows[0]) {
      throw new ConfirmedFactRequestError(
        409,
        "FACT_NOT_CURRENT",
        "Only the current confirmation of the job's current version can be withdrawn.",
      );
    }
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO job_confirmed_facts (
         workspace_id, canonical_job_id, job_version_id, entry_kind, fact_type, fact_value,
         source_note, supersedes_fact_id, recorded_by_user_id
       ) VALUES ($1, $2, $3, 'WITHDRAWAL', $4, '{}'::jsonb, $5, $6, $7)
       ${RETURNING}`,
      [ctx.workspaceId, canonicalJobId, request.job_version_id, target.rows[0].fact_type, request.reason, confirmedFactId, ctx.userId],
    );
    const fact = factFromRow(inserted.rows[0]);
    const rerun = await enqueueConfirmedFactGateRerun(client, ctx, canonicalJobId, request.job_version_id, fact.confirmed_fact_id);
    if (manageTransaction) await client.query("COMMIT");
    return { fact, supersededFactId: confirmedFactId, rerun };
  } catch (error) {
    if (manageTransaction) await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * A forced APPLY_HARD_GATES task identified by the confirmed-fact row. `reprocess` makes the gate
 * re-evaluate a job past RAW_STAGED; `reprocess_existing_state` and `repair_generation` carry a fresh
 * identity to every successor stage, so completed tasks from earlier runs never suppress them.
 */
export async function enqueueConfirmedFactGateRerun(
  client: QueryClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  jobVersionId: string,
  confirmedFactId: string,
): Promise<ConfirmedFactRerun> {
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
            conflicts, confirmed_fact_history_count, rerun_pending
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
    conflicts: jsonArray(row.conflicts),
    confirmed_fact_history_count: Number(row.confirmed_fact_history_count),
    rerun_pending: row.rerun_pending === true,
  });
}

/** Every recorded entry for the job's current version, newest first (superseded and withdrawals included). */
export async function loadConfirmedFactHistory(
  client: QueryClient,
  ctx: WorkspaceContext,
  canonicalJobId: string,
  jobVersionId: string,
): Promise<ConfirmedJobFact[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id AS confirmed_fact_id, entry_kind, fact_type, fact_value, source_type, source_note, source_url,
            posting_assessment, posting_evidence, supersedes_fact_id, recorded_by_user_id, recorded_at
     FROM job_confirmed_facts
     WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3
     ORDER BY recorded_at DESC, id DESC`,
    [ctx.workspaceId, canonicalJobId, jobVersionId],
  );
  return rows.map(factFromRow);
}
