import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApplicationWorkspaceSummarySchema,
  JobStatusBucketCountsSchema,
  JobStatusBucketRowSchema,
} from "../../contracts/jobStatus.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runMigrations } from "../../db/migrate.js";
import { runNormalization } from "../../pipeline/normalize.js";
import {
  SupportActionError,
  listSupportIssues,
  performSupportAction,
  retryAllRetryable,
  SUPPORT_RETRY_EXTRA_ATTEMPTS,
} from "../../services/jobSupportIssues.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Migration 112 against a migrated PostgreSQL: status buckets, the Rejected / Unmatched / Removed
// split, the technical-error support issues and every support action. Fixtures are synthetic.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const streamlitAppPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../streamlit_app.py");
const COMPLETE_DESCRIPTION = [
  "About the role: you will design and run the data platform for our analytics team.",
  "Responsibilities: build reliable pipelines, review data models, and mentor engineers.",
  "Requirements: five years of experience with Python, SQL and a cloud data warehouse,",
  "plus strong written communication skills and experience working with stakeholders.",
].join(" ").repeat(3);

let pool: pg.Pool;

interface Job {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly url: string;
  readonly company: string;
}

async function createWorkspace(label: string): Promise<WorkspaceContext> {
  const workspaceKey = `support-${label}-${randomUUID()}`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, $2) RETURNING id::text`,
    [workspaceKey, `Support ${label}`],
  );
  const user = await pool.query<{ id: string }>(`SELECT id::text FROM workspace_users WHERE user_key = 'local_user' LIMIT 1`);
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
     VALUES ($1, $2, 'OWNER', 'ACTIVE') ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [inserted.rows[0]!.id, user.rows[0]!.id],
  );
  return resolveWorkspaceContext(pool, { workspaceKey, userKey: "local_user" });
}

async function createJob(
  ctx: WorkspaceContext,
  options: {
    readonly state: string;
    readonly gate: "PASS" | "HARD_REJECT" | "NEEDS_VERIFICATION";
    readonly outcome?: string | null;
    readonly rejectionReason?: string | null;
    readonly supersededVersion?: boolean;
    readonly gmailObservation?: boolean;
  },
): Promise<Job & { readonly oldVersionId: string | null }> {
  const canonicalJobId = randomUUID();
  const company = `Support Fixture ${canonicalJobId.slice(0, 8)}`;
  const url = `https://jobs.example.test/${canonicalJobId}`;
  await pool.query(
    `INSERT INTO canonical_jobs (
       id, workspace_id, company_name, normalized_title, canonical_url, location,
       workplace_type, employment_type, processing_state, processing_status, gate_decision,
       recommendation_outcome, rejection_reason, primary_lane, is_test_fixture
     ) VALUES ($1, $2, $3, 'synthetic data architect', $4, 'Singapore', 'REMOTE', 'FULL_TIME',
               $5, $5, $6, $7, $8, 'CORE_AI_DATA', FALSE)`,
    [canonicalJobId, ctx.workspaceId, company, url, options.state, options.gate,
      options.outcome ?? null, options.rejectionReason ?? null],
  );
  let oldVersionId: string | null = null;
  if (options.supersededVersion) {
    oldVersionId = randomUUID();
    await pool.query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
       VALUES ($1, $2, $3, $4, 'Old short teaser.', NOW() - INTERVAL '2 days')`,
      [oldVersionId, ctx.workspaceId, canonicalJobId, `old-${canonicalJobId}`],
    );
  }
  const jobVersionId = randomUUID();
  await pool.query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
     VALUES ($1, $2, $3, $4, 'Short teaser text only.', NOW() - INTERVAL '1 day')`,
    [jobVersionId, ctx.workspaceId, canonicalJobId, `current-${canonicalJobId}`],
  );
  await pool.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [jobVersionId, ctx.workspaceId, canonicalJobId],
  );
  await pool.query(
    `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, decision, rejection_codes)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [ctx.workspaceId, canonicalJobId, jobVersionId, options.gate,
      JSON.stringify(options.gate === "HARD_REJECT" ? ["ONSITE_ONLY"] : [])],
  );
  if (options.gmailObservation) {
    await pool.query(
      `INSERT INTO raw_job_observations (
         workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
       ) VALUES ($1, 'GMAIL_ALERT', $2, $3, NOW(), $4, 'Synthetic Data Architect',
                 'Short teaser text only.', '{}'::jsonb, $5, 'PROCESSED', $6)`,
      [ctx.workspaceId, `gmail-${canonicalJobId}`, url, company, `gmail-${canonicalJobId}`, jobVersionId],
    );
  }
  return { canonicalJobId, jobVersionId, url, company, oldVersionId };
}

async function addTask(
  ctx: WorkspaceContext,
  options: {
    readonly type: string;
    readonly status: "DEAD_LETTER" | "BLOCKED_DEPENDENCY";
    readonly canonicalJobId: string;
    readonly jobVersionId: string;
    readonly blockedOn?: string;
    readonly reason?: string;
    readonly repairAction?: string | null;
    readonly attempts?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO pipeline_tasks (
       id, workspace_id, task_type, task_key, payload, status, attempt_count, max_attempts,
       last_error, dead_letter_reason, blocked_on, blocked_reason, repair_action
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 3, $8, $9, $10, $11, $12)`,
    [
      id, ctx.workspaceId, options.type, `${options.type}:${options.jobVersionId}:${id}`,
      JSON.stringify({ canonical_job_id: options.canonicalJobId, job_version_id: options.jobVersionId }),
      options.status, options.attempts ?? 3, options.reason ?? null,
      options.status === "DEAD_LETTER" ? options.reason ?? "failed" : null,
      options.blockedOn ?? null, options.status === "BLOCKED_DEPENDENCY" ? options.reason ?? null : null,
      options.repairAction ?? null,
    ],
  );
  return id;
}

async function bucketOf(ctx: WorkspaceContext, canonicalJobId: string): Promise<string | null> {
  const { rows } = await pool.query<{ status_bucket: string }>(
    `SELECT status_bucket FROM v_job_status_buckets_scoped WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [ctx.workspaceId, canonicalJobId],
  );
  return rows[0]?.status_bucket ?? null;
}

function streamlitQuery(name: string): string {
  const source = readFileSync(streamlitAppPath, "utf8");
  const query = new RegExp(`${name}\\s*=\\s*"""([\\s\\S]*?)"""`).exec(source)?.[1];
  if (!query) throw new Error(`Streamlit query ${name} was not found.`);
  let index = 0;
  return query.replace(/%s/g, () => `$${++index}`);
}

describe.skipIf(skipReal)("status buckets and technical-error support actions (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("splits Rejected, Unmatched and Removed, excludes archived jobs and partitions total_jobs", async () => {
    const ctx = await createWorkspace("buckets");
    const rejected = await createJob(ctx, { state: "HARD_REJECTED", gate: "HARD_REJECT", rejectionReason: "ONSITE_ONLY" });
    const archived = await createJob(ctx, { state: "HARD_REJECTED", gate: "HARD_REJECT", rejectionReason: "ONSITE_ONLY" });
    const unmatched = await createJob(ctx, { state: "UNMATCHED", gate: "PASS", outcome: "SKIP", rejectionReason: "NO_ACTIVE_LANE_MATCH" });
    const removed = await createJob(ctx, { state: "MANUALLY_REMOVED", gate: "PASS" });
    const processing = await createJob(ctx, { state: "PREQUALIFIED", gate: "PASS" });
    const verify = await createJob(ctx, { state: "NEEDS_VERIFICATION", gate: "NEEDS_VERIFICATION" });
    const skipped = await createJob(ctx, { state: "MATCHED", gate: "PASS", outcome: "SKIP" });
    const review = await createJob(ctx, { state: "MATCHED", gate: "PASS", outcome: "REVIEW" });
    const evaluated = await createJob(ctx, { state: "AI_EVALUATED", gate: "PASS", outcome: "REVIEW" });
    const staleTrack = await createJob(ctx, { state: "MATCHED", gate: "PASS", outcome: "TRACK" });
    // Archived the way runJobArchive records it (an archive run plus the archive columns). The run
    // is completed and dated in the past so it never becomes the "latest" run other suites read.
    const run = await pool.query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status, completed_at)
       VALUES (TIMESTAMPTZ '2000-01-02T00:00:00Z', TIMESTAMPTZ '2000-01-01T00:00:00Z', 'APPLY', 'SUCCEEDED',
               TIMESTAMPTZ '2000-01-02T00:01:00Z')
       RETURNING id::text`,
    );
    await pool.query(
      `UPDATE canonical_jobs
       SET archived_at = NOW(), archive_reason = 'HARD_REJECTED_PERMANENT',
           archive_age_basis = 'HARD_REJECTED_DECISION', archive_reference_at = NOW(), archive_run_id = $3
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, archived.canonicalJobId, run.rows[0]!.id],
    );

    expect(await bucketOf(ctx, rejected.canonicalJobId)).toBe("REJECTED");
    expect(await bucketOf(ctx, archived.canonicalJobId)).toBeNull();
    expect(await bucketOf(ctx, unmatched.canonicalJobId)).toBe("UNMATCHED");
    expect(await bucketOf(ctx, removed.canonicalJobId)).toBe("REMOVED");
    expect(await bucketOf(ctx, processing.canonicalJobId)).toBe("PROCESSING");
    expect(await bucketOf(ctx, verify.canonicalJobId)).toBe("NEEDS_VERIFICATION");
    expect(await bucketOf(ctx, skipped.canonicalJobId)).toBe("SKIP");
    expect(await bucketOf(ctx, review.canonicalJobId)).toBe("REVIEW_AWAITING_AI");
    expect(await bucketOf(ctx, evaluated.canonicalJobId)).toBe("REVIEW_EVALUATED_NOT_READY");
    // A TRACK decision without a current match is waiting for re-matching, not a Track job.
    expect(await bucketOf(ctx, staleTrack.canonicalJobId)).toBe("PROCESSING");

    const unmatchedRow = await pool.query(
      `SELECT * FROM v_job_status_buckets_scoped WHERE workspace_id = $1 AND canonical_job_id = $2`,
      [ctx.workspaceId, unmatched.canonicalJobId],
    );
    const parsedRow = JobStatusBucketRowSchema.parse(unmatchedRow.rows[0]);
    expect(parsedRow.status_reason).toBe("NO_ACTIVE_LANE_MATCH");

    const summaryRows = await pool.query(
      streamlitQuery("APPLICATION_WORKSPACE_SUMMARY_QUERY"),
      [ctx.workspaceId, "local_user"],
    );
    const summary = ApplicationWorkspaceSummarySchema.parse(summaryRows.rows[0]);
    expect(summary).toMatchObject({ rejected_count: 1, unmatched_count: 1, removed_count: 1, rejected_unmatched_count: 3 });

    const countRows = await pool.query(streamlitQuery("STATUS_BUCKET_COUNTS_QUERY"), [ctx.workspaceId]);
    const counts = JobStatusBucketCountsSchema.parse(countRows.rows[0]);
    expect(counts.total_jobs).toBe(summary.total_jobs);
    expect(counts).toMatchObject({
      rejected_count: 1, unmatched_count: 1, removed_count: 1, processing_count: 2,
      needs_verification_count: 1, skip_count: 1, review_awaiting_ai_count: 1,
      review_evaluated_not_ready_count: 1, track_count: 0, apply_now_count: 0,
    });

    const page = await pool.query(streamlitQuery("STATUS_BUCKET_JOBS_QUERY"), [ctx.workspaceId, "UNMATCHED", 25, 0]);
    expect(page.rows.map((row) => row.canonical_job_id)).toEqual([unmatched.canonicalJobId]);
    expect(page.rows[0].rejection_reason).toBe("NO_ACTIVE_LANE_MATCH");
  });

  it("does not count superseded-version embedding dead letters as technical errors", async () => {
    const ctx = await createWorkspace("stale");
    const job = await createJob(ctx, { state: "MATCHED", gate: "PASS", outcome: "SKIP", supersededVersion: true });
    await addTask(ctx, {
      type: "PUBLISH_EMBEDDING", status: "DEAD_LETTER", canonicalJobId: job.canonicalJobId,
      jobVersionId: job.oldVersionId!, reason: "No published JOB_VERSION embedding found.",
    });
    await addTask(ctx, {
      type: "PUBLISH_EMBEDDING", status: "DEAD_LETTER", canonicalJobId: job.canonicalJobId,
      jobVersionId: job.oldVersionId!, reason: "No published JOB_VERSION embedding found.",
      repairAction: "RECONCILED_STALE_SUPERSEDED_JOB_VERSION",
    });
    const { rows } = await pool.query(
      `SELECT technical_error_count, pipeline_display_category FROM v_canonical_shortlist_actions_scoped
       WHERE workspace_id = $1 AND canonical_job_id = $2`,
      [ctx.workspaceId, job.canonicalJobId],
    );
    expect(rows[0]).toEqual({ technical_error_count: 0, pipeline_display_category: "COMPLETED" });
    expect(await listSupportIssues(pool, ctx)).toEqual([]);

    // A dead letter of the current version is still an actionable technical error.
    await addTask(ctx, {
      type: "PUBLISH_EMBEDDING", status: "DEAD_LETTER", canonicalJobId: job.canonicalJobId,
      jobVersionId: job.jobVersionId, reason: "Provider timeout",
    });
    const issues = await listSupportIssues(pool, ctx);
    expect(issues.map((issue) => [issue.issue_class, issue.available_actions])).toEqual([
      ["TASK_DEAD_LETTER", ["RETRY", "DISMISS"]],
    ]);
  });

  it("offers fetch, paste and dismiss for an incomplete description and runs each through the pipeline", async () => {
    const ctx = await createWorkspace("description");
    const job = await createJob(ctx, { state: "PROCESSING_ERROR", gate: "PASS", outcome: "SKIP", gmailObservation: true });
    const reason = "DESCRIPTION_CONTENT_INCOMPLETE: DESCRIPTION_HAS_INSUFFICIENT_SUBSTANTIVE_CONTENT";
    await addTask(ctx, {
      type: "ROUTE_LANE", status: "BLOCKED_DEPENDENCY", canonicalJobId: job.canonicalJobId,
      jobVersionId: job.jobVersionId, blockedOn: "JOB_CONTENT", reason, attempts: 1,
    });

    const [issue] = await listSupportIssues(pool, ctx);
    expect(issue).toMatchObject({
      canonical_job_id: job.canonicalJobId,
      job_version_id: job.jobVersionId,
      issue_class: "DESCRIPTION_INCOMPLETE",
      issue_detail: reason,
      fetchable_source: true,
      available_actions: ["FETCH_DESCRIPTION", "PASTE_DESCRIPTION", "DISMISS"],
    });

    // Actions the row does not offer, and stale versions, are refused without side effects.
    await expect(performSupportAction(pool, ctx, job.canonicalJobId, {
      job_version_id: job.jobVersionId, issue_class: "DESCRIPTION_INCOMPLETE", action: "RETRY",
    })).rejects.toMatchObject({ status: 422, code: "ACTION_NOT_AVAILABLE" });
    await expect(performSupportAction(pool, ctx, job.canonicalJobId, {
      job_version_id: randomUUID(), issue_class: "DESCRIPTION_INCOMPLETE", action: "DISMISS",
    })).rejects.toMatchObject({ status: 409, code: "JOB_VERSION_CHANGED" });
    await expect(performSupportAction(pool, ctx, job.canonicalJobId, {
      job_version_id: job.jobVersionId, issue_class: "DESCRIPTION_INCOMPLETE", action: "PASTE_DESCRIPTION",
      description: "Too short to be a posting, but long enough to pass the request contract. ".repeat(3),
    })).rejects.toBeInstanceOf(SupportActionError);

    const fetched = await performSupportAction(pool, ctx, job.canonicalJobId, {
      job_version_id: job.jobVersionId, issue_class: "DESCRIPTION_INCOMPLETE", action: "FETCH_DESCRIPTION",
    });
    expect(fetched).toMatchObject({ outcome: "APPLIED", action: "FETCH_DESCRIPTION" });
    const fetchTask = await pool.query(
      `SELECT task_type, status, payload->>'force_refetch' AS force FROM pipeline_tasks WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, fetched.task_ids[0]],
    );
    expect(fetchTask.rows[0]).toEqual({ task_type: "FETCH_JOB_CONTENT", status: "PENDING", force: "true" });

    const pasted = await performSupportAction(pool, ctx, job.canonicalJobId, {
      job_version_id: job.jobVersionId, issue_class: "DESCRIPTION_INCOMPLETE", action: "PASTE_DESCRIPTION",
      description: COMPLETE_DESCRIPTION,
    });
    expect(pasted.outcome).toBe("APPLIED");
    const observationId = pasted.observation_id!;
    const normalizeTask = await pool.query(
      `SELECT status FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'NORMALIZE_OBSERVATION' AND payload->>'observation_id' = $2`,
      [ctx.workspaceId, observationId],
    );
    expect(normalizeTask.rows.map((row) => row.status)).toEqual(["PENDING"]);
    // The same text again is a no-op, not a second observation.
    const again = await performSupportAction(pool, ctx, job.canonicalJobId, {
      job_version_id: job.jobVersionId, issue_class: "DESCRIPTION_INCOMPLETE", action: "PASTE_DESCRIPTION",
      description: COMPLETE_DESCRIPTION,
    });
    expect(again.outcome).toBe("NO_CHANGE");

    // Normalization attaches the pasted posting to the same canonical job as a new version.
    const normalized = await runNormalization(pool, { context: ctx, observationIds: [observationId], limit: 1 });
    const detail = normalized.details.find((item) => item.observationId === observationId);
    expect(detail?.canonicalJobId).toBe(job.canonicalJobId);
    expect(detail?.versionId).not.toBe(job.jobVersionId);

    const audit = await pool.query(
      `SELECT action, outcome FROM job_support_actions WHERE workspace_id = $1 AND canonical_job_id = $2 ORDER BY created_at, id`,
      [ctx.workspaceId, job.canonicalJobId],
    );
    expect(audit.rows.map((row) => `${row.action}:${row.outcome}`).sort()).toEqual(
      ["FETCH_DESCRIPTION:APPLIED", "PASTE_DESCRIPTION:APPLIED", "PASTE_DESCRIPTION:NO_CHANGE"].sort(),
    );
    await expect(pool.query(`UPDATE job_support_actions SET outcome = 'NO_CHANGE' WHERE workspace_id = $1`, [ctx.workspaceId]))
      .rejects.toThrow(/append-only/);
  });

  it("retries dead letters without resetting attempts and dismisses into Removed, never Rejected", async () => {
    const ctx = await createWorkspace("retry");
    const failed = await createJob(ctx, { state: "MATCHED", gate: "PASS", outcome: "TRACK" });
    const taskId = await addTask(ctx, {
      type: "ROUTE_LANE", status: "DEAD_LETTER", canonicalJobId: failed.canonicalJobId,
      jobVersionId: failed.jobVersionId, reason: "Provider timeout", attempts: 3,
    });
    const dismissed = await createJob(ctx, { state: "PROCESSING_ERROR", gate: "PASS", outcome: "SKIP" });

    const retryAll = await retryAllRetryable(pool, ctx);
    expect(retryAll).toMatchObject({ considered: 1, retried: 1, unchanged: 0 });
    const task = await pool.query(
      `SELECT status, attempt_count, max_attempts FROM pipeline_tasks WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, taskId],
    );
    expect(task.rows[0]).toEqual({ status: "PENDING", attempt_count: 3, max_attempts: 3 + SUPPORT_RETRY_EXTRA_ATTEMPTS });
    // Idempotent: nothing left to retry.
    expect(await retryAllRetryable(pool, ctx)).toMatchObject({ considered: 0, retried: 0 });

    const [processingError] = await listSupportIssues(pool, ctx);
    expect(processingError).toMatchObject({
      canonical_job_id: dismissed.canonicalJobId,
      issue_class: "PROCESSING_ERROR",
      available_actions: ["PASTE_DESCRIPTION", "DISMISS"],
    });
    const result = await performSupportAction(pool, ctx, dismissed.canonicalJobId, {
      job_version_id: dismissed.jobVersionId, issue_class: "PROCESSING_ERROR", action: "DISMISS", note: "Not my field",
    });
    expect(result.outcome).toBe("APPLIED");
    expect(await bucketOf(ctx, dismissed.canonicalJobId)).toBe("REMOVED");
    const state = await pool.query(
      `SELECT processing_state, gate_decision FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, dismissed.canonicalJobId],
    );
    expect(state.rows[0]).toEqual({ processing_state: "MANUALLY_REMOVED", gate_decision: "PASS" });
    await expect(performSupportAction(pool, ctx, dismissed.canonicalJobId, {
      job_version_id: dismissed.jobVersionId, issue_class: "PROCESSING_ERROR", action: "DISMISS",
    })).rejects.toMatchObject({ status: 409, code: "ISSUE_NOT_OPEN" });

    const issuesRows = await pool.query(streamlitQuery("SUPPORT_ISSUES_QUERY"), [ctx.workspaceId]);
    expect(issuesRows.rows).toEqual([]);
  });

  it("refuses support actions for a reader", async () => {
    const ctx = await createWorkspace("reader");
    const job = await createJob(ctx, { state: "PROCESSING_ERROR", gate: "PASS" });
    await expect(performSupportAction(pool, { ...ctx, role: "READER" }, job.canonicalJobId, {
      job_version_id: job.jobVersionId, issue_class: "PROCESSING_ERROR", action: "DISMISS",
    })).rejects.toMatchObject({ status: 403 });
  });
});
