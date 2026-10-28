import pg from "pg";
import { z } from "zod";

import {
  ARCHIVE_CONTRACT_SCHEMA_VERSION,
  ArchiveCandidateSchema,
  ArchiveHoldSchema,
  ArchiveRunReportSchema,
  type ArchiveCandidate,
  type ArchiveHold,
  type ArchiveRunReport,
} from "../contracts/archive.js";
import {
  assessJobArchiveAge,
  referenceIsOlderThanCutoff,
  type JobArchiveAgeAssessment,
  type JobArchiveVersionEvidence,
} from "./jobArchivePolicy.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import { pipelineTaskStageVersion } from "../tasks/pipelineTaskCurrentness.js";
import { createTaskIntentV2 } from "../tasks/taskIntent.js";
import type { WorkspaceContext } from "../workspace/context.js";

const ARCHIVE_REASON = "JOB_OLDER_THAN_THREE_CALENDAR_MONTHS";
const DEFAULT_PAGE_SIZE = 250;
const DEFAULT_MAX_ARCHIVES = 500;
const MAX_PAGE_SIZE = 1000;
const MAX_ARCHIVES_PER_RUN = 2000;
const RESTORE_REASSESSMENT_HOLD_DAYS = 14;
const uuidSchema = z.string().uuid();
const holdTypeSchema = z.enum(["USER_PRESERVE", "AGENT2_PILOT", "RESTORE_REASSESSMENT"]);
const holdCreateSchema = z.object({
  workspace_id: z.string().uuid(),
  canonical_job_id: z.string().uuid(),
  hold_reason: z.string().trim().min(1).max(1000),
  hold_type: holdTypeSchema,
  created_by: z.string().trim().min(1).max(200),
  expires_at: z.date(),
});
const archiveHoldDatabaseRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  canonical_job_id: z.string(),
  hold_reason: z.string(),
  hold_type: holdTypeSchema,
  created_by: z.string(),
  created_at: z.union([z.date(), z.string()]),
  expires_at: z.union([z.date(), z.string()]),
  released_at: z.union([z.date(), z.string()]).nullable(),
  release_reason: z.string().nullable(),
});

interface ArchiveSchemaCapabilities {
  readonly archiveColumns: boolean;
  readonly archiveRunTable: boolean;
  readonly archiveHoldTable: boolean;
  readonly rawObservationEvidence: boolean;
  readonly evaluationQueueSkipColumns: boolean;
}

interface CandidateRow extends pg.QueryResultRow {
  workspace_id: string;
  canonical_job_id: string;
  latest_job_version_id: string | null;
  title: string;
  company: string;
  versions: unknown;
  has_active_application: boolean;
  has_active_document_run: boolean;
  has_active_document_task: boolean;
  has_running_pipeline_lease: boolean;
  has_running_evaluation_lease: boolean;
  has_manual_review: boolean;
  has_active_archive_hold: boolean;
}

interface ArchiveCandidateState {
  readonly row: CandidateRow;
  readonly age: JobArchiveAgeAssessment;
  readonly cutoffAt: Date;
  readonly isOlderThanCutoff: boolean;
}

interface ArchiveCounts {
  scanned: number;
  eligible: number;
  archived: number;
  protected: number;
  invalidDate: number;
  failed: number;
  unknownPublication: number;
  deferred: number;
}

export interface RunJobArchiveOptions {
  readonly mode: "DRY_RUN" | "APPLY";
  readonly workspaceId?: string;
  readonly pageSize?: number;
  readonly maxArchives?: number;
  readonly runStartedAt?: Date;
  readonly actor?: string;
}

export interface CreateArchiveHoldInput {
  readonly workspaceId: string;
  readonly canonicalJobId: string;
  readonly holdReason: string;
  readonly holdType: "USER_PRESERVE" | "AGENT2_PILOT" | "RESTORE_REASSESSMENT";
  readonly createdBy: string;
  readonly expiresAt: Date;
}

export interface RestoreArchivedJobInput {
  readonly workspaceId: string;
  readonly canonicalJobId: string;
  readonly actor: string;
  readonly reason: string;
  readonly context: WorkspaceContext;
}

export interface RestoreArchivedJobResult {
  readonly restored: boolean;
  readonly eventId: string | null;
  readonly jobVersionId: string | null;
  readonly reassessmentTaskId: string | null;
  readonly hold: ArchiveHold | null;
  readonly reasonCode: "RESTORED" | "JOB_NOT_FOUND" | "JOB_NOT_ARCHIVED";
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseVersions(value: unknown): JobArchiveVersionEvidence[] {
  const rows: JobArchiveVersionEvidence[] = [];
  for (const item of parseJsonArray(value)) {
    const parsed = z.object({
      job_version_id: z.string(),
      source_posting_identity_hash: z.string().nullable().optional(),
      source_published_at: z.union([z.string(), z.date()]).nullable().optional(),
      reposted_at: z.union([z.string(), z.date()]).nullable().optional(),
      first_seen_at: z.union([z.string(), z.date()]).nullable().optional(),
      observation_first_seen_at: z.union([z.string(), z.date()]).nullable().optional(),
      date_evidence: z.unknown().optional(),
    }).safeParse(item);
    if (!parsed.success) continue;
    rows.push(parsed.data);
  }
  return rows;
}

function candidateSelectSql(capabilities: ArchiveSchemaCapabilities, whereClause: string): string {
  const archiveFilter = capabilities.archiveColumns ? "AND canonical.archived_at IS NULL" : "";
  const holdExists = capabilities.archiveHoldTable
    ? `EXISTS (
        SELECT 1 FROM job_archive_holds hold
        WHERE hold.workspace_id = canonical.workspace_id
          AND hold.canonical_job_id = canonical.id
          AND hold.released_at IS NULL
          AND hold.expires_at > $1
      )`
    : "FALSE";
  const observationEvidenceSelect = capabilities.rawObservationEvidence
    ? `observation.normalized_evidence AS date_evidence`
    : `NULL::jsonb AS date_evidence`;
  const observationEvidencePredicate = capabilities.rawObservationEvidence
    ? "AND observation.normalized_evidence IS NOT NULL"
    : "";
  return `
    SELECT
      canonical.workspace_id,
      canonical.id::text AS canonical_job_id,
      canonical.latest_job_version_id::text AS latest_job_version_id,
      COALESCE(canonical.normalized_title, 'Untitled role') AS title,
      COALESCE(canonical.company_name, 'Unknown company') AS company,
      COALESCE(version_data.versions, '[]'::jsonb) AS versions,
      EXISTS (
        SELECT 1 FROM application_records application
        WHERE application.workspace_id = canonical.workspace_id
          AND application.canonical_job_id = canonical.id
          AND application.status NOT IN ('REJECTED', 'WITHDRAWN', 'CLOSED')
      ) AS has_active_application,
      EXISTS (
        SELECT 1 FROM document_runs document_run
        WHERE document_run.workspace_id = canonical.workspace_id
          AND document_run.canonical_job_id = canonical.id
          AND document_run.status = 'STARTED'
      ) AS has_active_document_run,
      EXISTS (
        SELECT 1 FROM pipeline_tasks document_task
        WHERE document_task.workspace_id = canonical.workspace_id
          AND document_task.status IN ('PENDING', 'RETRY_WAIT', 'RUNNING')
          AND (UPPER(document_task.task_type) LIKE '%DOCUMENT%'
            OR UPPER(document_task.task_type) LIKE '%COVER%'
            OR UPPER(document_task.task_type) LIKE '%CV%')
          AND (document_task.payload->>'canonical_job_id' = canonical.id::text
            OR EXISTS (
              SELECT 1 FROM job_versions document_version
              WHERE document_version.workspace_id = canonical.workspace_id
                AND document_version.canonical_job_id = canonical.id
                AND document_task.payload->>'job_version_id' = document_version.id::text
            ))
      ) AS has_active_document_task,
      EXISTS (
        SELECT 1 FROM pipeline_tasks running_task
        WHERE running_task.workspace_id = canonical.workspace_id
          AND running_task.status = 'RUNNING'
          AND running_task.lease_expires_at > $1
          AND (running_task.payload->>'canonical_job_id' = canonical.id::text
            OR EXISTS (
              SELECT 1 FROM job_versions running_version
              WHERE running_version.workspace_id = canonical.workspace_id
                AND running_version.canonical_job_id = canonical.id
                AND running_task.payload->>'job_version_id' = running_version.id::text
            )
            OR EXISTS (
              SELECT 1 FROM raw_job_observations running_observation
              JOIN job_versions observation_version
                ON observation_version.workspace_id = running_observation.workspace_id
               AND observation_version.id = running_observation.job_version_id
              WHERE running_observation.workspace_id = canonical.workspace_id
                AND running_observation.id::text = running_task.payload->>'observation_id'
                AND observation_version.canonical_job_id = canonical.id
            ))
      ) AS has_running_pipeline_lease,
      EXISTS (
        SELECT 1 FROM evaluation_queue evaluation
        WHERE evaluation.workspace_id = canonical.workspace_id
          AND evaluation.canonical_job_id = canonical.id
          AND evaluation.status = 'EVALUATING'
          AND evaluation.lease_expires_at > $1
      ) AS has_running_evaluation_lease,
      EXISTS (
        SELECT 1 FROM evaluation_queue evaluation
        WHERE evaluation.workspace_id = canonical.workspace_id
          AND evaluation.canonical_job_id = canonical.id
          AND evaluation.status = 'NEEDS_MANUAL_REVIEW'
      ) AS has_manual_review,
      ${holdExists} AS has_active_archive_hold
    FROM canonical_jobs canonical
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'job_version_id', version.id::text,
          'source_posting_identity_hash', version.source_posting_identity_hash,
          'source_published_at', version.source_published_at,
          'reposted_at', version.reposted_at,
          'first_seen_at', version.first_seen_at,
          'observation_first_seen_at', observation_first.first_seen_at,
          'date_evidence', source_evidence.date_evidence
        ) ORDER BY version.first_seen_at NULLS LAST, version.id
      ) AS versions
      FROM job_versions version
      LEFT JOIN LATERAL (
        SELECT MIN(observation.retrieved_at) AS first_seen_at
        FROM raw_job_observations observation
        WHERE observation.workspace_id = version.workspace_id
          AND observation.job_version_id = version.id
      ) observation_first ON TRUE
      LEFT JOIN LATERAL (
        SELECT ${observationEvidenceSelect}
        FROM raw_job_observations observation
        WHERE observation.workspace_id = version.workspace_id
          AND observation.job_version_id = version.id
          ${observationEvidencePredicate}
        ORDER BY observation.retrieved_at DESC, observation.id DESC
        LIMIT 1
      ) source_evidence ON TRUE
      WHERE version.workspace_id = canonical.workspace_id
        AND version.canonical_job_id = canonical.id
    ) version_data ON TRUE
    WHERE ${whereClause}
      AND canonical.is_test_fixture = FALSE
      ${archiveFilter}
  `;
}

async function readSchemaCapabilities(client: pg.PoolClient): Promise<ArchiveSchemaCapabilities> {
  const result = await client.query<{
    archive_columns: boolean;
    archive_run_table: boolean;
    archive_hold_table: boolean;
    raw_observation_evidence: boolean;
    evaluation_queue_skip_columns: boolean;
  }>(
    `SELECT
       (SELECT COUNT(*) = 5 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'canonical_jobs'
           AND column_name IN ('archived_at', 'archive_reason', 'archive_age_basis', 'archive_reference_at', 'archive_run_id')) AS archive_columns,
       to_regclass('job_archive_runs') IS NOT NULL AS archive_run_table,
       to_regclass('job_archive_holds') IS NOT NULL AS archive_hold_table,
       EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'raw_job_observations'
           AND column_name = 'normalized_evidence') AS raw_observation_evidence,
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'evaluation_queue'
           AND column_name IN ('skipped_at', 'skip_reason_code')) AS evaluation_queue_skip_columns`,
  );
  const row = result.rows[0];
  return {
    archiveColumns: row?.archive_columns === true,
    archiveRunTable: row?.archive_run_table === true,
    archiveHoldTable: row?.archive_hold_table === true,
    rawObservationEvidence: row?.raw_observation_evidence === true,
    evaluationQueueSkipColumns: row?.evaluation_queue_skip_columns === true,
  };
}

function isProtected(row: CandidateRow): boolean {
  return row.has_active_application || row.has_active_document_run ||
    row.has_active_document_task || row.has_running_pipeline_lease ||
    row.has_running_evaluation_lease || row.has_manual_review || row.has_active_archive_hold;
}

function ageAssessment(
  row: CandidateRow,
  runStartedAt: Date,
  cutoffAt: Date,
): ArchiveCandidateState {
  const versions = parseVersions(row.versions);
  const latestVersion = versions.find((version) => version.job_version_id === row.latest_job_version_id);
  const latestPostingIdentityHash = typeof latestVersion?.source_posting_identity_hash === "string"
    ? latestVersion.source_posting_identity_hash
    : null;
  const age = assessJobArchiveAge(versions, latestPostingIdentityHash, runStartedAt);
  return {
    row,
    age,
    cutoffAt,
    isOlderThanCutoff: age.status === "REFERENCE_FOUND" && referenceIsOlderThanCutoff(age.referenceAt, cutoffAt),
  };
}

async function readCandidatePage(
  client: pg.PoolClient,
  capabilities: ArchiveSchemaCapabilities,
  runStartedAt: Date,
  cursor: string | null,
  pageSize: number,
  workspaceId: string | null,
): Promise<CandidateRow[]> {
  const query = candidateSelectSql(
    capabilities,
    "($4::uuid IS NULL OR canonical.workspace_id = $4::uuid) AND ($2::uuid IS NULL OR canonical.id > $2::uuid)",
  ) + " ORDER BY canonical.id LIMIT $3";
  const result = await client.query<CandidateRow>(query, [runStartedAt, cursor, pageSize, workspaceId]);
  return result.rows;
}

async function readCandidateForUpdate(
  client: pg.PoolClient,
  capabilities: ArchiveSchemaCapabilities,
  runStartedAt: Date,
  workspaceId: string,
  canonicalJobId: string,
): Promise<CandidateRow | null> {
  const query = candidateSelectSql(
    capabilities,
    "canonical.workspace_id = $2::uuid AND canonical.id = $3::uuid",
  ) + " FOR UPDATE OF canonical";
  const result = await client.query<CandidateRow>(query, [runStartedAt, workspaceId, canonicalJobId]);
  return result.rows[0] ?? null;
}

function archiveCandidate(row: CandidateRow, state: ArchiveCandidateState): ArchiveCandidate {
  if (state.age.status !== "REFERENCE_FOUND") {
    throw new Error("Cannot create an archive candidate without an evidenced age reference.");
  }
  return ArchiveCandidateSchema.parse({
    canonical_job_id: row.canonical_job_id,
    workspace_id: row.workspace_id,
    title: row.title,
    company: row.company,
    reference_at: state.age.referenceAt.toISOString(),
    age_basis: state.age.ageBasis,
    archive_reason: ARCHIVE_REASON,
    publication_date_unknown: state.age.publicationDateUnknown,
  });
}

async function insertArchiveEvent(
  client: pg.PoolClient,
  input: {
    workspaceId: string;
    canonicalJobId: string;
    archiveRunId: string | null;
    action: "ARCHIVED";
    actor: string;
    reason: string;
    referenceAt: Date;
    ageBasis: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO job_archive_events (
       workspace_id, canonical_job_id, archive_run_id, action, actor, reason,
       reference_at, age_basis, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [input.workspaceId, input.canonicalJobId, input.archiveRunId, input.action,
      input.actor, input.reason, input.referenceAt, input.ageBasis, JSON.stringify(input.details)],
  );
}

async function archiveOne(
  client: pg.PoolClient,
  capabilities: ArchiveSchemaCapabilities,
  input: {
    workspaceId: string;
    canonicalJobId: string;
    runStartedAt: Date;
    cutoffAt: Date;
    runId: string;
    actor: string;
  },
): Promise<"ARCHIVED" | "PROTECTED" | "INVALID_DATE" | "NO_LONGER_ELIGIBLE"> {
  await client.query("BEGIN");
  try {
    const row = await readCandidateForUpdate(
      client, capabilities, input.runStartedAt, input.workspaceId, input.canonicalJobId,
    );
    if (row === null) {
      await client.query("COMMIT");
      return "NO_LONGER_ELIGIBLE";
    }
    if (isProtected(row)) {
      await client.query("COMMIT");
      return "PROTECTED";
    }
    const ageState = ageAssessment(row, input.runStartedAt, input.cutoffAt);
    const age = ageState.age;
    if (age.status === "INVALID_DATE") {
      await client.query("COMMIT");
      return "INVALID_DATE";
    }
    if (age.status !== "REFERENCE_FOUND" || !ageState.isOlderThanCutoff) {
      await client.query("COMMIT");
      return "NO_LONGER_ELIGIBLE";
    }
    const update = await client.query(
      `UPDATE canonical_jobs
       SET archived_at = $3,
           archive_reason = $4,
           archive_age_basis = $5,
           archive_reference_at = $6,
           archive_run_id = $7,
           updated_at = $3
       WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL`,
      [input.workspaceId, input.canonicalJobId, input.runStartedAt,
        ARCHIVE_REASON, age.ageBasis, age.referenceAt, input.runId],
    );
    if (update.rowCount !== 1) {
      await client.query("COMMIT");
      return "NO_LONGER_ELIGIBLE";
    }
    await insertArchiveEvent(client, {
      workspaceId: input.workspaceId,
      canonicalJobId: input.canonicalJobId,
      archiveRunId: input.runId,
      action: "ARCHIVED",
      actor: input.actor,
      reason: ARCHIVE_REASON,
      referenceAt: age.referenceAt,
      ageBasis: age.ageBasis,
      details: { cutoff_at: ageState.cutoffAt.toISOString(), publication_date_unknown: age.publicationDateUnknown },
    });
    await client.query(
      `WITH skipped_tasks AS (
         SELECT task.id
         FROM pipeline_tasks task
         WHERE task.workspace_id = $1::uuid
           AND task.task_type <> 'NORMALIZE_OBSERVATION'
           AND (task.status IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
             OR (task.status = 'RUNNING' AND (task.lease_expires_at IS NULL OR task.lease_expires_at <= $3::timestamptz)))
           AND (task.payload->>'canonical_job_id' = ($2::uuid)::text
             OR EXISTS (
               SELECT 1 FROM job_versions version
               WHERE version.workspace_id = $1::uuid
                 AND version.canonical_job_id = $2::uuid
                 AND task.payload->>'job_version_id' = version.id::text
             )
             OR EXISTS (
               SELECT 1 FROM raw_job_observations observation
               JOIN job_versions version
                 ON version.workspace_id = observation.workspace_id
                AND version.id = observation.job_version_id
               WHERE observation.workspace_id = $1::uuid
                 AND observation.id::text = task.payload->>'observation_id'
                 AND version.canonical_job_id = $2::uuid
             ))
         FOR UPDATE SKIP LOCKED
       ), completed_tasks AS (
         UPDATE pipeline_tasks task
         SET status = 'COMPLETED',
             completed_at = $3::timestamptz,
             lease_id = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             last_error = NULL,
             dead_letter_reason = NULL,
             repair_action = 'SKIPPED_ARCHIVED_JOB',
             updated_at = $3::timestamptz
         FROM skipped_tasks
         WHERE task.workspace_id = $1::uuid AND task.id = skipped_tasks.id
         RETURNING task.id
       )
       UPDATE pipeline_task_attempts attempt
       SET status = 'COMPLETED', finished_at = $3::timestamptz
       WHERE attempt.workspace_id = $1::uuid
         AND attempt.status = 'RUNNING'
         AND attempt.task_id IN (SELECT id FROM completed_tasks)`,
      [input.workspaceId, input.canonicalJobId, input.runStartedAt],
    );
    if (capabilities.evaluationQueueSkipColumns) {
      await client.query(
        `UPDATE evaluation_queue
         SET status = 'SKIPPED_ARCHIVED',
             skipped_at = $3,
             skip_reason_code = 'JOB_ARCHIVED',
             lease_id = NULL,
             lease_expires_at = NULL,
             last_error = NULL,
             updated_at = $3
         WHERE workspace_id = $1
           AND canonical_job_id = $2
           AND (status IN ('PENDING', 'RETRY_WAIT')
             OR (status = 'EVALUATING' AND (lease_expires_at IS NULL OR lease_expires_at <= $3)))`,
        [input.workspaceId, input.canonicalJobId, input.runStartedAt],
      );
    }
    await client.query("COMMIT");
    return "ARCHIVED";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendWorkflowSummary(report: ArchiveRunReport): Promise<void> {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (!summaryFile) return;
  const { appendFile } = await import("node:fs/promises");
  const lines = [
    "## Daily job archiving",
    "",
    `- Mode: ${report.mode}`,
    `- Started: ${report.run_started_at}`,
    `- Cutoff: ${report.cutoff_at}`,
    `- Scanned: ${report.scanned_count}`,
    `- Eligible: ${report.eligible_count}`,
    `- Archived: ${report.archived_count}`,
    `- Protected: ${report.protected_count}`,
    `- Invalid dates: ${report.invalid_date_count}`,
    `- Failed: ${report.failed_count}`,
    `- Observed-age/publication-unknown: ${report.observed_age_publication_unknown_count}`,
    `- Run status: ${report.run_status}`,
    "",
  ];
  await appendFile(summaryFile, `${lines.join("\n")}\n`, "utf8");
}

export async function runJobArchive(
  pool: pg.Pool,
  options: RunJobArchiveOptions,
): Promise<ArchiveRunReport> {
  const runStartedAt = options.runStartedAt ? new Date(options.runStartedAt.getTime()) : new Date();
  if (Number.isNaN(runStartedAt.getTime())) throw new Error("Invalid archive run start timestamp.");
  const pageSize = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const maxArchives = Math.min(Math.max(options.maxArchives ?? DEFAULT_MAX_ARCHIVES, 1), MAX_ARCHIVES_PER_RUN);
  const workspaceId = options.workspaceId === undefined ? null : uuidSchema.parse(options.workspaceId);
  const actor = options.actor?.trim() || `workflow:${process.env.GITHUB_ACTOR?.trim() || "local"}`;
  const client = await pool.connect();
  const counts: ArchiveCounts = {
    scanned: 0, eligible: 0, archived: 0, protected: 0,
    invalidDate: 0, failed: 0, unknownPublication: 0, deferred: 0,
  };
  const candidates: ArchiveCandidate[] = [];
  const invalidDateJobs: Array<{ canonical_job_id: string; reason_code: string }> = [];
  const failedJobs: Array<{ canonical_job_id: string; reason: string }> = [];
  let runId: string | null = null;
  let runStatus: "DRY_RUN" | "RUNNING" | "SUCCEEDED" | "FAILED" = options.mode === "DRY_RUN" ? "DRY_RUN" : "RUNNING";
  let completedAt: Date | null = null;
  let hasLock = false;
  let readOnlyTransaction = false;
  let cursor: string | null = null;
  let capabilities: ArchiveSchemaCapabilities | null = null;

  try {
    if (options.mode === "APPLY") {
      const lockResult = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('job_archive_daily'), hashtext(current_database())) AS locked",
      );
      hasLock = lockResult.rows[0]?.locked === true;
      if (!hasLock) throw new Error("Another daily archive apply run holds the database advisory lock.");
    }

    capabilities = await readSchemaCapabilities(client);
    if (options.mode === "APPLY" && (!capabilities.archiveColumns || !capabilities.archiveRunTable || !capabilities.archiveHoldTable || !capabilities.evaluationQueueSkipColumns || !capabilities.rawObservationEvidence)) {
      throw new Error("Archive schema migration 080 must be applied before archive mode.");
    }
    if (!capabilities.archiveColumns) {
      throw new Error("Archive age scan requires migration 075 and the canonical job-version date columns.");
    }

    const cutoffResult = await client.query<{ cutoff_at: Date }>(
      `SELECT $1::timestamptz - INTERVAL '3 months' AS cutoff_at`,
      [runStartedAt],
    );
    const cutoffAt = cutoffResult.rows[0]?.cutoff_at;
    if (!(cutoffAt instanceof Date) || Number.isNaN(cutoffAt.getTime())) {
      throw new Error("Database did not return a valid three-calendar-month archive cutoff.");
    }

    if (capabilities.archiveRunTable) {
      const run = await client.query<{ id: string }>(
        `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status)
         VALUES ($1, $2, $3, 'RUNNING') RETURNING id::text`,
        [runStartedAt, cutoffAt, options.mode],
      );
      runId = run.rows[0]?.id ?? null;
      if (runId === null) throw new Error("Archive run could not be persisted.");
    }
    if (options.mode === "DRY_RUN") {
      await client.query("BEGIN READ ONLY");
      readOnlyTransaction = true;
    }

    while (true) {
      const page = await readCandidatePage(client, capabilities, runStartedAt, cursor, pageSize, workspaceId);
      if (page.length === 0) break;
      cursor = page.at(-1)?.canonical_job_id ?? cursor;
      for (const row of page) {
        counts.scanned += 1;
        const state = ageAssessment(row, runStartedAt, cutoffAt);
        const age = state.age;
        if (age.status === "INVALID_DATE") {
          counts.invalidDate += 1;
          invalidDateJobs.push({ canonical_job_id: row.canonical_job_id, reason_code: age.reasonCode });
          continue;
        }
        if (age.ageBasis === "OBSERVED_AGE_PUBLICATION_UNKNOWN") counts.unknownPublication += 1;
        if (!state.isOlderThanCutoff) continue;
        if (isProtected(row)) {
          counts.protected += 1;
          continue;
        }
        counts.eligible += 1;
        if (candidates.length >= maxArchives) {
          counts.deferred += 1;
          continue;
        }
        const candidate = archiveCandidate(row, state);
        candidates.push(candidate);
        if (options.mode === "DRY_RUN") continue;
        try {
          const result = await archiveOne(client, capabilities, {
            workspaceId: row.workspace_id,
            canonicalJobId: row.canonical_job_id,
            runStartedAt,
            cutoffAt,
            runId: runId ?? "",
            actor,
          });
          if (result === "ARCHIVED") {
            counts.archived += 1;
          } else if (result === "PROTECTED") {
            counts.protected += 1;
            counts.eligible -= 1;
            candidates.pop();
          } else if (result === "INVALID_DATE") {
            counts.invalidDate += 1;
            counts.eligible -= 1;
            candidates.pop();
            invalidDateJobs.push({ canonical_job_id: row.canonical_job_id, reason_code: "DATE_CHANGED_DURING_ARCHIVE" });
          } else {
            counts.eligible -= 1;
            candidates.pop();
          }
        } catch (error) {
          counts.failed += 1;
          counts.eligible -= 1;
          candidates.pop();
          failedJobs.push({ canonical_job_id: row.canonical_job_id, reason: errorMessage(error).slice(0, 500) });
        }
      }
      if (page.length < pageSize) break;
    }

    completedAt = new Date();
    runStatus = options.mode === "DRY_RUN" ? "DRY_RUN" : counts.failed > 0 ? "FAILED" : "SUCCEEDED";
    const report = ArchiveRunReportSchema.parse({
      schema_version: ARCHIVE_CONTRACT_SCHEMA_VERSION,
      run_id: runId,
      mode: options.mode,
      workspace_id: workspaceId,
      run_status: runStatus,
      completed_at: completedAt.toISOString(),
      archive_schema_ready: capabilities.archiveColumns && capabilities.archiveRunTable && capabilities.archiveHoldTable && capabilities.evaluationQueueSkipColumns && capabilities.rawObservationEvidence,
      run_started_at: runStartedAt.toISOString(),
      cutoff_at: cutoffAt.toISOString(),
      scanned_count: counts.scanned,
      eligible_count: counts.eligible,
      archived_count: counts.archived,
      protected_count: counts.protected,
      invalid_date_count: counts.invalidDate,
      failed_count: counts.failed,
      observed_age_publication_unknown_count: counts.unknownPublication,
      deferred_count: counts.deferred,
      candidates,
      invalid_date_jobs: invalidDateJobs,
      failed_jobs: failedJobs,
    });

    if (readOnlyTransaction) {
      await client.query("COMMIT");
      readOnlyTransaction = false;
    }
    if (runId !== null) {
      const persistedRunStatus = runStatus === "DRY_RUN" ? "SUCCEEDED" : runStatus;
      await client.query(
        `UPDATE job_archive_runs
         SET status = $2,
             scanned_count = $3,
             eligible_count = $4,
             archived_count = $5,
             protected_count = $6,
             invalid_date_count = $7,
             failed_count = $8,
             observed_age_publication_unknown_count = $9,
             report_summary = $10::jsonb,
             error_summary = $11::jsonb,
             completed_at = $12
         WHERE id = $1`,
        [runId, persistedRunStatus, counts.scanned, counts.eligible, counts.archived,
          counts.protected, counts.invalidDate, counts.failed, counts.unknownPublication,
          JSON.stringify({
            workspace_id: workspaceId,
            deferred_count: counts.deferred,
            candidate_count: candidates.length,
            candidates: options.mode === "DRY_RUN" ? candidates : [],
            invalid_date_jobs: invalidDateJobs.slice(0, 100),
            failed_jobs: failedJobs,
          }),
          JSON.stringify(failedJobs), completedAt],
      );
    }
    console.log(JSON.stringify(report, null, 2));
    await appendWorkflowSummary(report);
    return report;
  } catch (error) {
    if (readOnlyTransaction) {
      await client.query("ROLLBACK");
      readOnlyTransaction = false;
    }
    if (runId !== null) {
      runStatus = "FAILED";
      completedAt = new Date();
      try {
        await client.query(
          `UPDATE job_archive_runs
           SET status = 'FAILED', failed_count = failed_count + 1,
               error_summary = error_summary || $2::jsonb, completed_at = $3
           WHERE id = $1`,
          [runId, JSON.stringify([{ reason: errorMessage(error).slice(0, 500) }]), completedAt],
        );
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], "Archive failed and its failure status could not be persisted.");
      }
    }
    throw error;
  } finally {
    try {
      if (hasLock) {
        const unlock = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtext('job_archive_daily'), hashtext(current_database())) AS unlocked",
        );
        if (unlock.rows[0]?.unlocked !== true) throw new Error("Archive advisory lock was not released.");
      }
    } finally {
      client.release();
    }
  }
}

export async function createArchiveHold(
  client: pg.PoolClient,
  input: CreateArchiveHoldInput,
): Promise<ArchiveHold> {
  const parsed = holdCreateSchema.parse({
    workspace_id: input.workspaceId,
    canonical_job_id: input.canonicalJobId,
    hold_reason: input.holdReason,
    hold_type: input.holdType,
    created_by: input.createdBy,
    expires_at: input.expiresAt,
  });
  const existing = await client.query<{ id: string }>(
    `SELECT id::text FROM job_archive_holds
     WHERE workspace_id = $1 AND canonical_job_id = $2
       AND hold_type = $3 AND released_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [parsed.workspace_id, parsed.canonical_job_id, parsed.hold_type],
  );
  if (existing.rows[0]) {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id::text, workspace_id::text, canonical_job_id::text, hold_reason,
              hold_type, created_by, created_at, expires_at, released_at, release_reason
       FROM job_archive_holds WHERE id = $1`,
      [existing.rows[0].id],
    );
    return mapArchiveHold(result.rows[0]);
  }
  const job = await client.query<{ archived_at: Date | null }>(
    `SELECT archived_at FROM canonical_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [parsed.workspace_id, parsed.canonical_job_id],
  );
  if (job.rows.length === 0) throw new Error("Canonical job does not exist in the requested workspace.");
  if (job.rows[0].archived_at !== null) throw new Error("Restore the archived job before adding a preservation hold.");
  const result = await client.query<Record<string, unknown>>(
    `INSERT INTO job_archive_holds (
       workspace_id, canonical_job_id, hold_reason, hold_type, created_by, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text, workspace_id::text, canonical_job_id::text, hold_reason,
               hold_type, created_by, created_at, expires_at, released_at, release_reason`,
    [parsed.workspace_id, parsed.canonical_job_id, parsed.hold_reason,
      parsed.hold_type, parsed.created_by, parsed.expires_at],
  );
  return mapArchiveHold(result.rows[0]);
}

function mapArchiveHold(row: unknown): ArchiveHold {
  const databaseRow = archiveHoldDatabaseRowSchema.parse(row);
  const createdAt = toIso(databaseRow.created_at);
  const expiresAt = toIso(databaseRow.expires_at);
  if (createdAt === null || expiresAt === null) throw new Error("Archive hold timestamps are invalid.");
  return ArchiveHoldSchema.parse({
    schema_version: ARCHIVE_CONTRACT_SCHEMA_VERSION,
    ...databaseRow,
    created_at: createdAt,
    expires_at: expiresAt,
    released_at: toIso(databaseRow.released_at),
  });
}

export async function releaseArchiveHold(
  client: pg.PoolClient,
  input: { workspaceId: string; holdId: string; actor: string; reason: string },
): Promise<boolean> {
  uuidSchema.parse(input.workspaceId);
  uuidSchema.parse(input.holdId);
  const result = await client.query(
    `UPDATE job_archive_holds
     SET released_at = NOW(), released_by = $3, release_reason = $4
     WHERE workspace_id = $1 AND id = $2
       AND released_at IS NULL AND expires_at > NOW()`,
    [input.workspaceId, input.holdId, input.actor, input.reason],
  );
  return result.rowCount === 1;
}

async function insertArchiveRestoreEvent(
  client: pg.PoolClient,
  input: { workspaceId: string; canonicalJobId: string; actor: string; reason: string; action: "RESTORED" | "REPOST_REACTIVATED"; referenceAt: Date | null; details: Record<string, unknown> },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO job_archive_events (
       workspace_id, canonical_job_id, action, actor, reason, reference_at, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id::text`,
    [input.workspaceId, input.canonicalJobId, input.action, input.actor,
      input.reason, input.referenceAt, JSON.stringify(input.details)],
  );
  const eventId = result.rows[0]?.id;
  if (!eventId) throw new Error("Archive restore event was not persisted.");
  return eventId;
}

async function addRestoreAssessmentHold(
  client: pg.PoolClient,
  workspaceId: string,
  canonicalJobId: string,
  actor: string,
  eventId: string,
): Promise<ArchiveHold> {
  const expiresAt = new Date(Date.now() + RESTORE_REASSESSMENT_HOLD_DAYS * 24 * 60 * 60 * 1000);
  return createArchiveHold(client, {
    workspaceId,
    canonicalJobId,
    holdReason: `Allow availability, freshness, and readiness reassessment after archive event ${eventId}.`,
    holdType: "RESTORE_REASSESSMENT",
    createdBy: actor,
    expiresAt,
  });
}

async function enqueueRestoreReassessment(
  client: pg.PoolClient,
  input: { workspaceId: string; canonicalJobId: string; jobVersionId: string; eventId: string; context: WorkspaceContext },
): Promise<string> {
  const taskType = "APPLY_HARD_GATES";
  const stageVersion = pipelineTaskStageVersion(taskType);
  if (stageVersion === null) throw new Error("No registered pipeline stage version for restored-job reassessment.");
  const payload = {
    canonical_job_id: input.canonicalJobId,
    job_version_id: input.jobVersionId,
    force_policy_recalculation: true,
    reassessment_reason: `ARCHIVE_RESTORE:${input.eventId}`,
  };
  const taskKey = `${taskType}:${input.jobVersionId}:ARCHIVE_RESTORE:${input.eventId}`;
  const intent = createTaskIntentV2({
    workspaceId: input.workspaceId,
    taskType,
    stageVersion,
    producer: "job_archive_restore",
    requestId: input.eventId,
    mode: "FORCE_RECOMPUTE",
    triggerRevisionId: input.eventId,
    payload,
  });
  const result = await enqueuePipelineTask({
    taskType,
    taskKey,
    payload,
    intent,
    producer: "job_archive_restore",
    stageVersion,
    requestId: input.eventId,
    mode: "FORCE_RECOMPUTE",
    triggerRevisionId: input.eventId,
  }, client, { context: input.context });
  if (!result.taskId) throw new Error("Archive restore reassessment was not queued.");
  return result.taskId;
}

export async function restoreArchivedJob(
  client: pg.PoolClient,
  input: RestoreArchivedJobInput,
): Promise<RestoreArchivedJobResult> {
  uuidSchema.parse(input.workspaceId);
  uuidSchema.parse(input.canonicalJobId);
  const jobResult = await client.query<{
    latest_job_version_id: string | null;
    archived_at: Date | null;
    archive_reference_at: Date | null;
    archive_age_basis: string | null;
  }>(
    `SELECT latest_job_version_id::text, archived_at, archive_reference_at, archive_age_basis
     FROM canonical_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [input.workspaceId, input.canonicalJobId],
  );
  const job = jobResult.rows[0];
  if (!job) return { restored: false, eventId: null, jobVersionId: null, reassessmentTaskId: null, hold: null, reasonCode: "JOB_NOT_FOUND" };
  if (job.archived_at === null) return { restored: false, eventId: null, jobVersionId: job.latest_job_version_id, reassessmentTaskId: null, hold: null, reasonCode: "JOB_NOT_ARCHIVED" };
  if (job.latest_job_version_id === null) throw new Error("Archived job has no current version to reassess.");

  const eventId = await insertArchiveRestoreEvent(client, {
    workspaceId: input.workspaceId,
    canonicalJobId: input.canonicalJobId,
    actor: input.actor,
    reason: input.reason,
    action: "RESTORED",
    referenceAt: job.archive_reference_at,
    details: { previous_age_basis: job.archive_age_basis, previous_archive_at: toIso(job.archived_at) },
  });
  await client.query(
    `UPDATE canonical_jobs
     SET archived_at = NULL,
         archive_reason = NULL,
         archive_age_basis = NULL,
         archive_reference_at = NULL,
         archive_run_id = NULL,
         latest_deterministic_decision_id = NULL,
         recommendation_outcome = NULL,
         updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2`,
    [input.workspaceId, input.canonicalJobId],
  );
  const hold = await addRestoreAssessmentHold(client, input.workspaceId, input.canonicalJobId, input.actor, eventId);
  const reassessmentTaskId = await enqueueRestoreReassessment(client, {
    workspaceId: input.workspaceId,
    canonicalJobId: input.canonicalJobId,
    jobVersionId: job.latest_job_version_id,
    eventId,
    context: input.context,
  });
  return {
    restored: true,
    eventId,
    jobVersionId: job.latest_job_version_id,
    reassessmentTaskId,
    hold,
    reasonCode: "RESTORED",
  };
}

export async function reactivateGenuineRepost(
  client: pg.PoolClient,
  input: {
    workspaceId: string;
    canonicalJobId: string;
    actor: string;
    repostedAt: Date;
    repostEvidenceHash: string;
    evidenceType: "GENUINE_REPOST_DATE" | "NEW_POSTING_IDENTITY";
  },
): Promise<string | null> {
  const state = await client.query<{
    archived_at: Date | null;
    archive_reference_at: Date | null;
    archive_age_basis: string | null;
  }>(
    `SELECT archived_at, archive_reference_at, archive_age_basis
     FROM canonical_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [input.workspaceId, input.canonicalJobId],
  );
  const row = state.rows[0];
  if (!row?.archived_at || !row.archive_reference_at || input.repostedAt <= row.archive_reference_at) return null;
  const eventId = await insertArchiveRestoreEvent(client, {
    workspaceId: input.workspaceId,
    canonicalJobId: input.canonicalJobId,
    actor: input.actor,
    reason: input.evidenceType === "GENUINE_REPOST_DATE"
      ? "GENUINE_REPOST_DATE_EXCEEDS_ARCHIVE_REFERENCE"
      : "NEW_POSTING_IDENTITY_EXCEEDS_ARCHIVE_REFERENCE",
    action: "REPOST_REACTIVATED",
    referenceAt: input.repostedAt,
    details: {
      reactivation_evidence_type: input.evidenceType,
      previous_archive_at: toIso(row.archived_at),
      previous_archive_reference_at: toIso(row.archive_reference_at),
      previous_age_basis: row.archive_age_basis,
      repost_evidence_hash: input.repostEvidenceHash,
    },
  });
  await client.query(
    `UPDATE canonical_jobs
     SET archived_at = NULL,
         archive_reason = NULL,
         archive_age_basis = NULL,
         archive_reference_at = NULL,
         archive_run_id = NULL,
         latest_deterministic_decision_id = NULL,
         recommendation_outcome = NULL,
         updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2`,
    [input.workspaceId, input.canonicalJobId],
  );
  await addRestoreAssessmentHold(client, input.workspaceId, input.canonicalJobId, input.actor, eventId);
  return eventId;
}

export async function listActiveArchiveHolds(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
): Promise<ArchiveHold[]> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT id::text, workspace_id::text, canonical_job_id::text, hold_reason,
            hold_type, created_by, created_at, expires_at, released_at, release_reason
     FROM job_archive_holds
     WHERE workspace_id = $1 AND released_at IS NULL AND expires_at > NOW()
     ORDER BY expires_at, canonical_job_id`,
    [workspaceId],
  );
  return result.rows.map((row: Record<string, unknown>) => mapArchiveHold(row));
}