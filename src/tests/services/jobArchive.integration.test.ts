import { createHash, randomUUID } from "node:crypto";
import express from "express";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiV2Router } from "../../api/v2/router.js";
import { buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runJobArchive, createArchiveHold } from "../../services/jobArchive.js";
import { validatePersistedDocumentCurrentness } from "../../documents/provenanceCurrentness.js";
import { pgConnectionConfig, isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { runMigrations } from "../../db/migrate.js";
import { claimPipelineTasks } from "../../tasks/pipelineTasks.js";
import { reconcileStalePendingPipelineTasks } from "../../tasks/pipelineTaskCurrentness.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { subtractCalendarMonths } from "../../services/jobArchivePolicy.js";

const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const runStartedAt = new Date("2026-10-27T19:15:00.000Z");
const oldPublicationDate = "2026-06-01T00:00:00.000Z";
const oldFirstObservation = "2026-06-02T00:00:00.000Z";
const longDescription = "A hands-on role building and maintaining production systems. ".repeat(8);

interface JobFixture {
  readonly workspaceId: string;
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly title: string;
}

interface CreateJobOptions {
  readonly title?: string;
  readonly sourcePublishedAt?: string | null;
  readonly repostedAt?: string | null;
  readonly firstSeenAt?: string;
  readonly sourcePostingIdentityHash?: string | null;
  readonly normalizedEvidence?: unknown;
  readonly observationAt?: string | null;
}

let pool: pg.Pool;

async function createWorkspace(label: string): Promise<WorkspaceContext> {
  const workspaceKey = `archive-${label}-${randomUUID()}`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (workspace_key, display_name)
     VALUES ($1, $2) RETURNING id::text`,
    [workspaceKey, `Archive ${label}`],
  );
  const workspaceId = inserted.rows[0]?.id;
  if (!workspaceId) throw new Error("Test workspace was not created.");
  const localUser = await pool.query<{ id: string }>(
    `SELECT id::text FROM workspace_users WHERE user_key = 'local_user' LIMIT 1`,
  );
  const userId = localUser.rows[0]?.id;
  if (!userId) throw new Error("Default workspace user is missing from the PostgreSQL fixture.");
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
     VALUES ($1, $2, 'OWNER', 'ACTIVE')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [workspaceId, userId],
  );
  return resolveWorkspaceContext(pool, { workspaceKey, userKey: "local_user" });
}

async function createJobFixture(
  context: WorkspaceContext,
  options: CreateJobOptions = {},
): Promise<JobFixture> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  const title = options.title ?? `Archive test role ${canonicalJobId.slice(0, 8)}`;
  const company = `Archive Test ${canonicalJobId.slice(0, 8)}`;
  const sourceUrl = `https://jobs.example.test/${canonicalJobId}`;
  const postingIdentity = options.sourcePostingIdentityHash ?? null;
  await pool.query(
    `INSERT INTO canonical_jobs (
       id, workspace_id, company_name, normalized_title, canonical_url, location,
       workplace_type, employment_type, processing_state, processing_status,
       primary_lane, is_test_fixture
     ) VALUES ($1, $2, $3, $4, $5, 'Singapore', 'REMOTE', 'FULL_TIME',
               'RAW_STAGED', 'RAW_STAGED', 'CORE_AI_DATA', FALSE)`,
    [canonicalJobId, context.workspaceId, company, title.toLowerCase(), sourceUrl],
  );
  await pool.query(
    `INSERT INTO job_versions (
       id, workspace_id, canonical_job_id, content_hash, description_text, observed_at,
       source_published_at, reposted_at, source_posting_identity_hash,
       first_seen_at, last_seen_at, freshness_basis, freshness_confidence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12)`,
    [
      jobVersionId,
      context.workspaceId,
      canonicalJobId,
      `content-${canonicalJobId}`,
      longDescription,
      options.firstSeenAt ?? oldFirstObservation,
      options.sourcePublishedAt ?? null,
      options.repostedAt ?? null,
      postingIdentity,
      options.firstSeenAt ?? oldFirstObservation,
      options.repostedAt ? "REPOSTED_AT" : options.sourcePublishedAt ? "POSTED_AT" : null,
      options.repostedAt || options.sourcePublishedAt ? 100 : null,
    ],
  );
  await pool.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [jobVersionId, context.workspaceId, canonicalJobId],
  );
  if (options.observationAt !== null) {
    await pool.query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash,
         processing_status, normalized_evidence, evidence_schema_version, job_version_id
       ) VALUES ($1, $2, 'GREENHOUSE', $3, $4, $5, $6, $7, $8, '{}'::jsonb,
                 $9, 'PROCESSED', $10::jsonb, $11, $12)`,
      [
        randomUUID(), context.workspaceId, `posting-${canonicalJobId}`, sourceUrl,
        options.observationAt ?? options.firstSeenAt ?? oldFirstObservation,
        company, title, longDescription, `raw-${canonicalJobId}`,
        options.normalizedEvidence === undefined ? null : JSON.stringify(options.normalizedEvidence),
        options.normalizedEvidence === undefined ? null : "job_source_evidence_v1",
        jobVersionId,
      ],
    );
  }
  return { workspaceId: context.workspaceId, canonicalJobId, jobVersionId, title };
}

function supportedDate(value: string, basis: "PUBLISHED_AT" | "GENUINE_REPOST_AT") {
  return {
    status: "SUPPORTED",
    value,
    basis,
    raw_value: value,
    timestamp_unit: "ISO_STRING",
    evidence: [{ quote_text: `${basis}: ${value}` }],
  };
}

function rawHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceEvidence(
  payload: Record<string, unknown>,
  sourceExternalId: string,
  retrievedAt: string,
  descriptionText: string,
) {
  const hash = rawHash(payload);
  return buildJobSourceEvidence({
    sourceName: "GREENHOUSE",
    sourcePluginKey: "greenhouse",
    sourcePluginRevisionId: null,
    sourceExternalId,
    sourceUrl: `https://jobs.example.test/${sourceExternalId}`,
    canonicalApplyUrl: `https://jobs.example.test/${sourceExternalId}`,
    retrievedAt,
    rawPayloadHash: hash,
    rawPayload: payload,
    companyName: "Repost Test Company",
    title: "Platform Engineer",
    locationRaw: "Singapore",
    workplaceTypeRaw: "REMOTE",
    employmentTypeRaw: "FULL_TIME",
    compensationRaw: "UNKNOWN",
    descriptionText,
  });
}

async function insertObservation(
  context: WorkspaceContext,
  input: {
    readonly sourceExternalId: string;
    readonly sourceUrl: string;
    readonly retrievedAt: string;
    readonly description: string;
    readonly payload: Record<string, unknown>;
    readonly normalizedEvidence: unknown;
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash,
       processing_status, normalized_evidence, evidence_schema_version
     ) VALUES ($1, $2, 'GREENHOUSE', $3, $4, $5, 'Repost Test Company',
               'Platform Engineer', $6, $7::jsonb, $8, 'PENDING', $9::jsonb,
               'job_source_evidence_v1')`,
    [
      id, context.workspaceId, input.sourceExternalId, input.sourceUrl, input.retrievedAt,
      input.description, JSON.stringify(input.payload), rawHash(input.payload),
      JSON.stringify(input.normalizedEvidence),
    ],
  );
  return id;
}

async function readArchiveState(job: JobFixture): Promise<{ archived_at: Date | null; age_basis: string | null }> {
  const result = await pool.query<{ archived_at: Date | null; age_basis: string | null }>(
    `SELECT archived_at, archive_age_basis AS age_basis
     FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
    [job.workspaceId, job.canonicalJobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Archive fixture job ${job.canonicalJobId} was not found.`);
  return row;
}

describe.skipIf(skipReal)("daily job archiving PostgreSQL integration", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("uses a strict three-calendar-month cutoff, preserves unknown age, scopes workspaces, and is idempotent", async () => {
    const context = await createWorkspace("age-policy");
    const otherContext = await createWorkspace("workspace-isolation");
    const cutoffAt = subtractCalendarMonths(runStartedAt, 3);
    const olderThanCutoff = await createJobFixture(context, {
      sourcePublishedAt: new Date(cutoffAt.getTime() - 1).toISOString(),
      firstSeenAt: "2026-04-01T00:00:00.000Z",
    });
    const exactlyAtCutoff = await createJobFixture(context, {
      sourcePublishedAt: cutoffAt.toISOString(),
      firstSeenAt: "2026-04-01T00:00:00.000Z",
    });
    const observedAgeUnknownPublication = await createJobFixture(context, {
      sourcePublishedAt: null,
      firstSeenAt: new Date(cutoffAt.getTime() - 1).toISOString(),
      observationAt: new Date(cutoffAt.getTime() - 1).toISOString(),
    });
    const futureDate = await createJobFixture(context, {
      sourcePublishedAt: new Date(runStartedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      firstSeenAt: "2026-04-01T00:00:00.000Z",
    });
    const otherWorkspaceJob = await createJobFixture(otherContext, {
      sourcePublishedAt: "2026-01-01T00:00:00.000Z",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    });
    await pool.query(
      `INSERT INTO evaluation_queue (
         workspace_id, canonical_job_id, job_version_id, lane, status
       ) VALUES ($1, $2, $3, 'CORE_AI_DATA', 'PENDING')`,
      [context.workspaceId, olderThanCutoff.canonicalJobId, olderThanCutoff.jobVersionId],
    );

    const dryRun = await runJobArchive(pool, {
      mode: "DRY_RUN",
      workspaceId: context.workspaceId,
      runStartedAt,
      maxArchives: 10,
    });
    expect(dryRun.run_status).toBe("DRY_RUN");
    expect(dryRun.scanned_count).toBe(4);
    expect(dryRun.eligible_count).toBe(2);
    expect(dryRun.invalid_date_count).toBe(1);
    expect(dryRun.observed_age_publication_unknown_count).toBe(1);
    expect(dryRun.candidates.map((candidate) => candidate.canonical_job_id)).toEqual(
      expect.arrayContaining([olderThanCutoff.canonicalJobId, observedAgeUnknownPublication.canonicalJobId]),
    );
    expect(dryRun.candidates.some((candidate) => candidate.canonical_job_id === exactlyAtCutoff.canonicalJobId)).toBe(false);
    expect(dryRun.candidates.some((candidate) => candidate.canonical_job_id === futureDate.canonicalJobId)).toBe(false);
    const persistedDryRun = await pool.query<{ report_summary: { candidates?: unknown[] } }>(
      `SELECT report_summary FROM job_archive_runs WHERE id = $1`,
      [dryRun.run_id],
    );
    expect(persistedDryRun.rows[0]?.report_summary.candidates).toHaveLength(2);
    expect((await readArchiveState(olderThanCutoff)).archived_at).toBeNull();

    const applied = await runJobArchive(pool, {
      mode: "APPLY",
      workspaceId: context.workspaceId,
      runStartedAt,
      maxArchives: 10,
    });
    expect(applied.run_status).toBe("SUCCEEDED");
    expect(applied.archived_count).toBe(2);
    expect((await readArchiveState(olderThanCutoff)).age_basis).toBe("AUTHORITATIVE_PUBLICATION_DATE");
    expect((await readArchiveState(observedAgeUnknownPublication)).age_basis).toBe("OBSERVED_AGE_PUBLICATION_UNKNOWN");
    const skippedEvaluation = await pool.query<{ status: string; skipped_at: Date | null; skip_reason_code: string | null }>(
      `SELECT status, skipped_at, skip_reason_code
       FROM evaluation_queue WHERE canonical_job_id = $1`,
      [olderThanCutoff.canonicalJobId],
    );
    expect(skippedEvaluation.rows[0]).toMatchObject({
      status: "SKIPPED_ARCHIVED",
      skip_reason_code: "JOB_ARCHIVED",
    });
    expect(skippedEvaluation.rows[0]?.skipped_at).toBeInstanceOf(Date);
    expect((await readArchiveState(exactlyAtCutoff)).archived_at).toBeNull();
    expect((await readArchiveState(futureDate)).archived_at).toBeNull();
    expect((await readArchiveState(otherWorkspaceJob)).archived_at).toBeNull();

    const duplicateRun = await runJobArchive(pool, {
      mode: "APPLY",
      workspaceId: context.workspaceId,
      runStartedAt,
      maxArchives: 10,
    });
    expect(duplicateRun.run_status).toBe("SUCCEEDED");
    expect(duplicateRun.archived_count).toBe(0);
    const events = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM job_archive_events
       WHERE workspace_id = $1 AND canonical_job_id = ANY($2::uuid[]) AND action = 'ARCHIVED'`,
      [context.workspaceId, [olderThanCutoff.canonicalJobId, observedAgeUnknownPublication.canonicalJobId]],
    );
    expect(events.rows[0]?.count).toBe(2);
    const status = await pool.query<{ last_success_at: Date | null }>(
      `SELECT last_success_at FROM v_job_archive_operational_status`,
    );
    expect(status.rows[0]?.last_success_at).toBeInstanceOf(Date);
  });

  it("protects active applications, document tasks, running leases, and the pilot hold", async () => {
    const context = await createWorkspace("protection");
    const applicationJob = await createJobFixture(context, { sourcePublishedAt: oldPublicationDate });
    const documentJob = await createJobFixture(context, { sourcePublishedAt: oldPublicationDate });
    const runningLeaseJob = await createJobFixture(context, { sourcePublishedAt: oldPublicationDate });
    const pilotJob = await createJobFixture(context, { sourcePublishedAt: oldPublicationDate });
    const eligibleJob = await createJobFixture(context, { sourcePublishedAt: oldPublicationDate });

    await pool.query(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
       VALUES ($1, $2, $3, $4, 'APPLIED')`,
      [context.workspaceId, context.userId, applicationJob.canonicalJobId, applicationJob.jobVersionId],
    );
    await pool.query(
      `INSERT INTO pipeline_tasks (
         workspace_id, task_type, task_key, payload, context_fingerprint, status
       ) VALUES ($1, 'GENERATE_CV', $2, $3::jsonb, 'archive-test-document', 'PENDING')`,
      [context.workspaceId, `archive-doc-${randomUUID()}`, JSON.stringify({ canonical_job_id: documentJob.canonicalJobId, job_version_id: documentJob.jobVersionId })],
    );
    await pool.query(
      `INSERT INTO pipeline_tasks (
         workspace_id, task_type, task_key, payload, context_fingerprint, status,
         lease_id, lease_expires_at
       ) VALUES ($1, 'APPLY_HARD_GATES', $2, $3::jsonb, 'archive-test-lease', 'RUNNING', $4, $5)`,
      [context.workspaceId, `archive-lease-${randomUUID()}`, JSON.stringify({ canonical_job_id: runningLeaseJob.canonicalJobId, job_version_id: runningLeaseJob.jobVersionId }), randomUUID(), new Date(runStartedAt.getTime() + 60 * 60 * 1000)],
    );
    const client = await pool.connect();
    try {
      await createArchiveHold(client, {
        workspaceId: context.workspaceId,
        canonicalJobId: pilotJob.canonicalJobId,
        holdReason: "Preserve the selected live-job application pilot.",
        holdType: "AGENT2_PILOT",
        createdBy: `user:${context.userId}`,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
    } finally {
      client.release();
    }

    const report = await runJobArchive(pool, {
      mode: "APPLY",
      workspaceId: context.workspaceId,
      runStartedAt,
      maxArchives: 10,
    });
    expect(report.protected_count).toBe(4);
    expect(report.eligible_count).toBe(1);
    expect(report.archived_count).toBe(1);
    expect((await readArchiveState(eligibleJob)).archived_at).not.toBeNull();
    for (const protectedJob of [applicationJob, documentJob, runningLeaseJob, pilotJob]) {
      expect((await readArchiveState(protectedJob)).archived_at).toBeNull();
    }
  });

  it("skips archived worker and handoff requests, preserves application history, and restores for reassessment", async () => {
    const context = await createWorkspace("restore-guards");
    const job = await createJobFixture(context, { sourcePublishedAt: oldPublicationDate });
    await pool.query(
      `UPDATE canonical_jobs SET recommendation_outcome = 'REVIEW'
       WHERE workspace_id = $1 AND id = $2`,
      [context.workspaceId, job.canonicalJobId],
    );
    await pool.query(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
       VALUES ($1, $2, $3, $4, 'CLOSED')`,
      [context.workspaceId, context.userId, job.canonicalJobId, job.jobVersionId],
    );
    const archived = await runJobArchive(pool, {
      mode: "APPLY",
      workspaceId: context.workspaceId,
      runStartedAt,
      maxArchives: 10,
    });
    expect(archived.archived_count).toBe(1);

    const enqueueResult = await (async () => {
      const client = await pool.connect();
      try {
        const { enqueuePipelineTask } = await import("../../tasks/pipelineTasks.js");
        return await enqueuePipelineTask({
          taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
          taskKey: `archived-seed-${randomUUID()}`,
          payload: { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId },
        }, client, { context });
      } finally {
        client.release();
      }
    })();
    expect(enqueueResult.skippedReason).toBe("JOB_ARCHIVED");

    await pool.query(
      `INSERT INTO pipeline_tasks (
         workspace_id, task_type, task_key, payload, context_fingerprint, status
       ) VALUES ($1, 'EXTRACT_DETERMINISTIC_REQUIREMENTS', $2, $3::jsonb, 'archived-stale-task', 'PENDING')`,
      [context.workspaceId, `archived-pending-${randomUUID()}`, JSON.stringify({ canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId })],
    );
    const claimed = await claimPipelineTasks({
      taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      limit: 10,
      jobVersionIds: [job.jobVersionId],
    }, pool, { context });
    expect(claimed).toHaveLength(0);

    const client = await pool.connect();
    try {
      const reconciliation = await reconcileStalePendingPipelineTasks(client, context, {
        apply: true,
        taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"],
        limit: 10,
      });
      expect(reconciliation.decisions.some((decision) => decision.classification === "PROVEN_ARCHIVED")).toBe(true);
    } finally {
      client.release();
    }
    const skippedTask = await pool.query<{ status: string; last_error: string | null; repair_action: string | null }>(
      `SELECT status, last_error, repair_action FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_key LIKE 'archived-pending-%'`,
      [context.workspaceId],
    );
    expect(skippedTask.rows[0]?.status).toBe("COMPLETED");
    expect(skippedTask.rows[0]?.last_error).toBeNull();
    expect(skippedTask.rows[0]?.repair_action).toContain("SKIPPED_ARCHIVED_JOB");

    const documentCurrentness = await validatePersistedDocumentCurrentness(pool, context.workspaceId, {
      canonicalJobId: job.canonicalJobId,
      jobVersionId: job.jobVersionId,
      matchRunId: null,
      profileVersionId: null,
      deterministicDecisionId: null,
      contextFingerprint: null,
    });
    expect(documentCurrentness).toEqual({ current: false, reason: "JOB_ARCHIVED" });
    const activeApplications = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM v_application_tracker
       WHERE workspace_id = $1 AND user_id = $2 AND canonical_job_id = $3`,
      [context.workspaceId, context.userId, job.canonicalJobId],
    );
    expect(activeApplications.rows[0]?.count).toBe(1);
    const applyNow = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM v_apply_now_jobs_scoped
       WHERE workspace_id = $1 AND canonical_job_id = $2`,
      [context.workspaceId, job.canonicalJobId],
    );
    expect(applyNow.rows[0]?.count).toBe(0);

    const app = express();
    app.use("/api/v2", createApiV2Router({ pool, resolveContext: async () => context }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test API did not bind a TCP port.");
    try {
      const token = (process.env.JDEC_API_TOKEN || process.env.API_TOKEN || "").trim();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Workspace-Key": context.workspaceKey,
        "X-User-Key": context.userKey,
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const archiveList = await fetch(`http://127.0.0.1:${address.port}/api/v2/archive?limit=10`, { headers });
      expect(archiveList.status).toBe(200);
      const archiveListPayload = await archiveList.json();
      expect(archiveListPayload.jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          canonical_job_id: job.canonicalJobId,
          archive_age_basis: "AUTHORITATIVE_PUBLICATION_DATE",
          application_status: "CLOSED",
        }),
      ]));
      const handoff = await fetch(`http://127.0.0.1:${address.port}/api/v2/applications`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          canonical_job_id: job.canonicalJobId,
          job_version_id: job.jobVersionId,
          status: "INTENT",
        }),
      });
      expect(handoff.status).toBe(409);
      expect((await handoff.json()).reason).toBe("JOB_ARCHIVED");

      const restore = await fetch(`http://127.0.0.1:${address.port}/api/v2/archive/${job.canonicalJobId}/restore`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "Run a fresh availability and readiness review." }),
      });
      expect(restore.status).toBe(200);
      expect((await restore.json()).result.restored).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    const restoredState = await readArchiveState(job);
    expect(restoredState.archived_at).toBeNull();
    const refreshed = await pool.query<{
      latest_deterministic_decision_id: string | null;
      recommendation_outcome: string | null;
    }>(
      `SELECT latest_deterministic_decision_id::text, recommendation_outcome
       FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
      [context.workspaceId, job.canonicalJobId],
    );
    expect(refreshed.rows[0]?.latest_deterministic_decision_id).toBeNull();
    expect(refreshed.rows[0]?.recommendation_outcome).toBeNull();
    const restoreTask = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'APPLY_HARD_GATES'
         AND payload->>'canonical_job_id' = $2`,
      [context.workspaceId, job.canonicalJobId],
    );
    expect(restoreTask.rows[0]?.count).toBe(1);
    const postRestoreArchive = await runJobArchive(pool, {
      mode: "APPLY",
      workspaceId: context.workspaceId,
      runStartedAt: new Date(),
      maxArchives: 10,
    });
    expect(postRestoreArchive.protected_count).toBe(1);
    expect((await readArchiveState(job)).archived_at).toBeNull();
  });

  it("keeps repeated old ingestion archived and reactivates an evidenced genuine repost", async () => {
    const context = await createWorkspace("repost-normalization");
    const sourceExternalId = `repost-${randomUUID()}`;
    const sourceUrl = `https://jobs.example.test/${sourceExternalId}`;
    const firstPayload = { posted_at: oldPublicationDate, updated_at: "2026-10-20T00:00:00.000Z" };
    const firstDescription = longDescription;
    const firstEvidence = sourceEvidence(firstPayload, sourceExternalId, oldFirstObservation, firstDescription);
    const firstObservationId = await insertObservation(context, {
      sourceExternalId,
      sourceUrl,
      retrievedAt: oldFirstObservation,
      description: firstDescription,
      payload: firstPayload,
      normalizedEvidence: firstEvidence,
    });
    const firstNormalization = await runNormalization(pool, {
      context,
      observationIds: [firstObservationId],
      limit: 1,
    });
    expect(firstNormalization.totalProcessed).toBe(1);
    const canonicalJobId = firstNormalization.details[0]?.canonicalJobId;
    const jobVersionId = firstNormalization.details[0]?.versionId;
    if (!canonicalJobId || !jobVersionId) throw new Error("Initial normalization did not create canonical lineage.");
    const job: JobFixture = { workspaceId: context.workspaceId, canonicalJobId, jobVersionId, title: "Platform Engineer" };

    const archiveRun = await runJobArchive(pool, {
      mode: "APPLY",
      workspaceId: context.workspaceId,
      runStartedAt,
      maxArchives: 10,
    });
    expect(archiveRun.archived_count).toBe(1);

    const repeatPayload = { posted_at: oldPublicationDate, updated_at: "2026-10-25T00:00:00.000Z" };
    const repeatDescription = `${longDescription} Updated responsibilities, no new posting date.`;
    const repeatEvidence = sourceEvidence(repeatPayload, sourceExternalId, new Date().toISOString(), repeatDescription);
    const repeatedObservationId = await insertObservation(context, {
      sourceExternalId,
      sourceUrl,
      retrievedAt: new Date().toISOString(),
      description: repeatDescription,
      payload: repeatPayload,
      normalizedEvidence: repeatEvidence,
    });
    const repeatedNormalization = await runNormalization(pool, {
      context,
      observationIds: [repeatedObservationId],
      limit: 1,
    });
    expect(repeatedNormalization.totalProcessed).toBe(1);
    expect((await readArchiveState(job)).archived_at).not.toBeNull();
    const updatedJobVersionId = repeatedNormalization.details[0]?.versionId;
    if (!updatedJobVersionId) throw new Error("Updated-description observation did not create a version.");

    const repostDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const repostPayload = { posted_at: oldPublicationDate, reposted_at: repostDate };
    const repostEvidence = sourceEvidence(repostPayload, sourceExternalId, new Date().toISOString(), repeatDescription);
    const repostObservationId = await insertObservation(context, {
      sourceExternalId,
      sourceUrl,
      retrievedAt: new Date().toISOString(),
      description: repeatDescription,
      payload: repostPayload,
      normalizedEvidence: repostEvidence,
    });
    const repostNormalization = await runNormalization(pool, {
      context,
      observationIds: [repostObservationId],
      limit: 1,
    });
    expect(repostNormalization.totalProcessed).toBe(1);
    expect((await readArchiveState(job)).archived_at).toBeNull();
    const events = await pool.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM job_archive_events
       WHERE workspace_id = $1 AND canonical_job_id = $2
       ORDER BY event_at DESC, id DESC LIMIT 1`,
      [context.workspaceId, job.canonicalJobId],
    );
    expect(events.rows[0]).toMatchObject({
      action: "REPOST_REACTIVATED",
      reason: "GENUINE_REPOST_DATE_EXCEEDS_ARCHIVE_REFERENCE",
    });
    const version = await pool.query<{ reposted_at: Date | null; freshness_basis: string | null }>(
      `SELECT reposted_at, freshness_basis FROM job_versions WHERE workspace_id = $1 AND id = $2`,
      [context.workspaceId, updatedJobVersionId],
    );
    expect(version.rows[0]?.freshness_basis).toBe("REPOSTED_AT");
    expect(version.rows[0]?.reposted_at).toBeInstanceOf(Date);
  });
});
