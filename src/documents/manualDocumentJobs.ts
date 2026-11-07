import pg from "pg";

import type { WorkspaceContext } from "../workspace/context.js";
import { MANUAL_APPLICATION_SCHEMA_VERSION } from "../contracts/manualApplication.js";
import { ModelCallDeadlineError, isRateLimitedFailure } from "../services/modelCallResilience.js";

/**
 * Durable manual document generation jobs (migration 098). POST /:draftId/documents creates (or
 * returns) the job for an approval and the API process runs it in the background; the client polls
 * GET /:draftId/document-jobs/:jobId. Step progress and outcomes are stored without prompt text or
 * document text; the documents themselves are stored exactly as before.
 */

export type DocumentJobStepName = "SUMMARY" | "LETTER" | "FILES";
export type DocumentJobStepStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FALLBACK" | "SKIPPED" | "FAILED";
export type DocumentJobFailureKind = "RATE_LIMITED" | "TIMEOUT" | "VALIDATION" | "PROVIDER_ERROR";
export type DocumentJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";

export interface DocumentJobStep {
  step: DocumentJobStepName;
  status: DocumentJobStepStatus;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  provider: string | null;
  model: string | null;
  failure_kind: DocumentJobFailureKind | null;
}

export interface DocumentJobRow {
  id: string;
  draft_id: string;
  approval_id: string;
  status: DocumentJobStatus;
  steps: DocumentJobStep[];
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  error_http_status: number | null;
  deadline_at: Date | string;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export const DOCUMENT_JOB_INTERRUPTED_CODE = "GENERATION_INTERRUPTED";

/** The whole-job deadline (summary + letter + files). Default 5 minutes; MANUAL_DOCUMENT_JOB_DEADLINE_MS. */
export function documentJobDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(String(env.MANUAL_DOCUMENT_JOB_DEADLINE_MS ?? ""), 10);
  if (!Number.isFinite(parsed)) return 300_000;
  return Math.max(30_000, Math.min(1_800_000, parsed));
}

export function initialDocumentJobSteps(): DocumentJobStep[] {
  return (["SUMMARY", "LETTER", "FILES"] as const).map((step) => ({
    step, status: "PENDING", started_at: null, finished_at: null, elapsed_ms: null, provider: null, model: null, failure_kind: null,
  }));
}

/** Why a writer failed, from its error, without echoing the error text. */
export function documentFailureKind(error: unknown): DocumentJobFailureKind {
  if (isRateLimitedFailure(error)) return "RATE_LIMITED";
  if (error instanceof ModelCallDeadlineError) return "TIMEOUT";
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "");
  if (/\b429\b|RESOURCE_EXHAUSTED|rate limited/i.test(message)) return "RATE_LIMITED";
  if (/deadline|timed out|timeout|aborted/i.test(message)) return "TIMEOUT";
  if (/validation|invalid JSON/i.test(message)) return "VALIDATION";
  return "PROVIDER_ERROR";
}

const JOB_COLUMNS = `id::text, draft_id::text, approval_id::text, status, steps, result, error_code, error_message,
  error_http_status, deadline_at, created_at, started_at, finished_at`;

/** Marks QUEUED/RUNNING jobs of this user past their deadline as FAILED (interrupted, retry allowed). */
export async function expireStaleDocumentJobs(db: Queryable, ctx: WorkspaceContext, approvalId?: string): Promise<number> {
  const result = await db.query(
    `UPDATE manual_document_generation_jobs
     SET status = 'FAILED',
         error_code = $4,
         error_message = 'Document generation stopped before it finished (the API restarted or the job ran past its deadline). Generate again.',
         error_http_status = 503,
         finished_at = NOW(),
         updated_at = NOW(),
         steps = (
           SELECT COALESCE(jsonb_agg(
             CASE WHEN step->>'status' IN ('PENDING', 'RUNNING')
                  THEN jsonb_set(step, '{status}', '"FAILED"')
                  ELSE step END ORDER BY ordinality), '[]'::jsonb)
           FROM jsonb_array_elements(steps) WITH ORDINALITY AS item(step, ordinality)
         )
     WHERE workspace_id = $1 AND user_id = $2
       AND status IN ('QUEUED', 'RUNNING')
       AND deadline_at < NOW()
       AND ($3::uuid IS NULL OR approval_id = $3::uuid)`,
    [ctx.workspaceId, ctx.userId, approvalId ?? null, DOCUMENT_JOB_INTERRUPTED_CODE],
  );
  return result.rowCount ?? 0;
}

/**
 * Returns the approval's live (QUEUED/RUNNING) or SUCCEEDED job, creating a QUEUED one when there
 * is none. The partial unique index makes concurrent requests converge on one job.
 */
export async function createOrGetDocumentJob(
  db: Queryable,
  ctx: WorkspaceContext,
  input: { draftId: string; approvalId: string; comparisonFingerprint: string; requestOptions: Record<string, unknown>; deadlineMs?: number },
): Promise<{ job: DocumentJobRow; created: boolean }> {
  await expireStaleDocumentJobs(db, ctx, input.approvalId);
  // A SUCCEEDED job whose files were since removed (scripts/reset_manual_documents.ts) no longer
  // describes stored documents: retire it so the approval can generate again.
  await db.query(
    `UPDATE manual_document_generation_jobs job
     SET status = 'FAILED', result = NULL, error_code = 'DOCUMENTS_RESET',
         error_message = 'The stored documents for this approval were reset; generate again.',
         error_http_status = NULL, updated_at = NOW()
     WHERE job.workspace_id = $1 AND job.user_id = $2 AND job.approval_id = $3 AND job.status = 'SUCCEEDED'
       AND NOT EXISTS (
         SELECT 1 FROM manual_application_document_artifacts artifact
         WHERE artifact.workspace_id = job.workspace_id AND artifact.user_id = job.user_id
           AND artifact.approval_id = job.approval_id
       )`,
    [ctx.workspaceId, ctx.userId, input.approvalId],
  );
  const deadlineMs = input.deadlineMs ?? documentJobDeadlineMs();
  const inserted = await db.query<DocumentJobRow>(
    `INSERT INTO manual_document_generation_jobs (
       workspace_id, user_id, draft_id, approval_id, comparison_fingerprint, status, steps, request_options, deadline_at
     ) VALUES ($1, $2, $3, $4, $5, 'QUEUED', $6::jsonb, $7::jsonb, NOW() + make_interval(secs => $8::double precision))
     ON CONFLICT (workspace_id, user_id, approval_id) WHERE status IN ('QUEUED', 'RUNNING', 'SUCCEEDED')
     DO NOTHING
     RETURNING ${JOB_COLUMNS}`,
    [ctx.workspaceId, ctx.userId, input.draftId, input.approvalId, input.comparisonFingerprint,
      JSON.stringify(initialDocumentJobSteps()), JSON.stringify(input.requestOptions), deadlineMs / 1000],
  );
  if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
  const existing = await db.query<DocumentJobRow>(
    `SELECT ${JOB_COLUMNS} FROM manual_document_generation_jobs
     WHERE workspace_id = $1 AND user_id = $2 AND approval_id = $3 AND status IN ('QUEUED', 'RUNNING', 'SUCCEEDED')
     LIMIT 1`,
    [ctx.workspaceId, ctx.userId, input.approvalId],
  );
  if (!existing.rows[0]) throw new Error("A document job for this approval changed state concurrently; retry the request.");
  return { job: existing.rows[0], created: false };
}

export async function loadDocumentJob(db: Queryable, ctx: WorkspaceContext, draftId: string, jobId: string): Promise<DocumentJobRow | null> {
  await expireStaleDocumentJobs(db, ctx);
  const result = await db.query<DocumentJobRow>(
    `SELECT ${JOB_COLUMNS} FROM manual_document_generation_jobs
     WHERE workspace_id = $1 AND user_id = $2 AND draft_id = $3 AND id = $4`,
    [ctx.workspaceId, ctx.userId, draftId, jobId],
  );
  return result.rows[0] ?? null;
}

/** Claims a QUEUED job for this process; false when another request already started it. */
export async function markDocumentJobRunning(db: Queryable, ctx: WorkspaceContext, jobId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE manual_document_generation_jobs
     SET status = 'RUNNING', started_at = NOW(), heartbeat_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND status = 'QUEUED'`,
    [ctx.workspaceId, ctx.userId, jobId],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function saveDocumentJobSteps(db: Queryable, ctx: WorkspaceContext, jobId: string, steps: DocumentJobStep[]): Promise<void> {
  await db.query(
    `UPDATE manual_document_generation_jobs
     SET steps = $4::jsonb, heartbeat_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND status = 'RUNNING'`,
    [ctx.workspaceId, ctx.userId, jobId, JSON.stringify(steps)],
  );
}

export async function finishDocumentJobSucceeded(
  db: Queryable, ctx: WorkspaceContext, jobId: string, result: Record<string, unknown>, steps: DocumentJobStep[],
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE manual_document_generation_jobs
     SET status = 'SUCCEEDED', result = $4::jsonb, steps = $5::jsonb, finished_at = NOW(), heartbeat_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND status = 'RUNNING'`,
    [ctx.workspaceId, ctx.userId, jobId, JSON.stringify(result), JSON.stringify(steps)],
  );
  return (updated.rowCount ?? 0) === 1;
}

export async function finishDocumentJobFailed(
  db: Queryable, ctx: WorkspaceContext, jobId: string,
  error: { code: string; message: string; httpStatus: number | null }, steps: DocumentJobStep[],
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE manual_document_generation_jobs
     SET status = 'FAILED', error_code = $4, error_message = $5, error_http_status = $6, steps = $7::jsonb,
         finished_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND status IN ('QUEUED', 'RUNNING')`,
    [ctx.workspaceId, ctx.userId, jobId, error.code.slice(0, 64), error.message.slice(0, 2000), error.httpStatus, JSON.stringify(steps)],
  );
  return (updated.rowCount ?? 0) === 1;
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** The ManualDocumentJobResponse body for a stored job. */
export function documentJobResponse(row: DocumentJobRow) {
  return {
    schema_version: MANUAL_APPLICATION_SCHEMA_VERSION,
    ok: true as const,
    job: {
      job_id: row.id,
      draft_id: row.draft_id,
      approval_id: row.approval_id,
      status: row.status,
      steps: row.steps,
      created_at: iso(row.created_at)!,
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
      deadline_at: iso(row.deadline_at)!,
      error: row.status === "FAILED" && row.error_code
        ? { code: row.error_code, message: row.error_message || row.error_code, http_status: row.error_http_status }
        : null,
      result: row.status === "SUCCEEDED" ? row.result : null,
    },
  };
}

/**
 * Records step progress for one job, persisting after each change and logging which step was slow
 * or failed (step, elapsed time, provider/model, failure kind), never prompt or document text.
 */
export class DocumentJobTracker {
  readonly steps: DocumentJobStep[] = initialDocumentJobSteps();
  private readonly startedAt = new Map<DocumentJobStepName, number>();

  constructor(
    private readonly jobId: string,
    private readonly persist: (steps: DocumentJobStep[]) => Promise<void>,
    private readonly logger: Pick<Console, "log" | "warn"> = console,
  ) {}

  private step(name: DocumentJobStepName): DocumentJobStep {
    return this.steps.find((item) => item.step === name)!;
  }

  async start(name: DocumentJobStepName): Promise<void> {
    const step = this.step(name);
    this.startedAt.set(name, Date.now());
    Object.assign(step, { status: "RUNNING", started_at: new Date().toISOString() });
    this.logger.log(`[manual-documents] job=${this.jobId} step=${name} started`);
    await this.persist(this.steps);
  }

  async finish(
    name: DocumentJobStepName,
    status: Exclude<DocumentJobStepStatus, "PENDING" | "RUNNING">,
    details: { provider?: string | null; model?: string | null; failureKind?: DocumentJobFailureKind | null } = {},
  ): Promise<void> {
    const step = this.step(name);
    const started = this.startedAt.get(name);
    const elapsed = started === undefined ? null : Date.now() - started;
    Object.assign(step, {
      status,
      finished_at: new Date().toISOString(),
      elapsed_ms: elapsed,
      provider: details.provider ?? null,
      model: details.model ?? null,
      failure_kind: details.failureKind ?? null,
    });
    const line = `[manual-documents] job=${this.jobId} step=${name} status=${status} elapsed_ms=${elapsed ?? 0}` +
      `${details.provider ? ` provider=${details.provider}` : ""}${details.model ? ` model=${details.model}` : ""}` +
      `${details.failureKind ? ` failure_kind=${details.failureKind}` : ""}`;
    if (status === "FALLBACK" || status === "FAILED") this.logger.warn(line);
    else this.logger.log(line);
    await this.persist(this.steps);
  }

  /** Steps never started (AI writing skipped, or documents already stored) become SKIPPED. */
  async skipPending(names: DocumentJobStepName[] = ["SUMMARY", "LETTER"]): Promise<void> {
    let changed = false;
    for (const name of names) {
      const step = this.step(name);
      if (step.status === "PENDING") {
        step.status = "SKIPPED";
        changed = true;
      }
    }
    if (changed) await this.persist(this.steps);
  }

  /** Marks running steps FAILED after an error that stopped the job. */
  failRunning(): void {
    for (const step of this.steps) {
      if (step.status === "RUNNING" || step.status === "PENDING") step.status = step.status === "RUNNING" ? "FAILED" : "SKIPPED";
    }
  }

  /**
   * Wraps a section writer: RUNNING while it works, COMPLETED with provider/model on success, and
   * FALLBACK with the failure kind when it throws (the caller then assembles the section from the
   * candidate's statements).
   */
  wrap<I, O extends { provider: string; model: string }>(name: DocumentJobStepName, writer: (input: I) => Promise<O>) {
    return async (input: I): Promise<O> => {
      await this.start(name);
      try {
        const output = await writer(input);
        await this.finish(name, "COMPLETED", { provider: output.provider, model: output.model });
        return output;
      } catch (error) {
        await this.finish(name, "FALLBACK", { failureKind: documentFailureKind(error) });
        throw error;
      }
    };
  }
}
