import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { buildPipelineTaskContextFingerprint } from "../../pipeline/artifactContext.js";
import { GATE_VERSION } from "../../contracts/version.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { reconcileStalePendingPipelineTasks } from "../../tasks/pipelineTaskCurrentness.js";
import {
  runPipelineStageTaskWorker,
  seedRecoverablePipelineTasks,
  type PipelineStageWorkerDependencies,
} from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The pipeline currentness test client is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The pipeline currentness test workspace is not initialized.");
  return context;
}

async function insertJobVersions(): Promise<{ canonicalJobId: string; oldVersionId: string; latestVersionId: string }> {
  const database = getClient();
  const workspaceId = getContext().workspaceId;
  const canonicalJobId = crypto.randomUUID();
  const oldVersionId = crypto.randomUUID();
  const latestVersionId = crypto.randomUUID();
  await database.query(
    `INSERT INTO canonical_jobs (
       id, workspace_id, company_name, normalized_title, canonical_url,
       processing_state, processing_status
     ) VALUES ($1, $2, 'Pipeline Currentness Test', 'Fixture Role', $3, 'PREQUALIFIED', 'PREQUALIFIED')`,
    [canonicalJobId, workspaceId, `https://example.test/currentness/${canonicalJobId}`],
  );
  for (const [id, contentHash] of [
    [oldVersionId, `old-${crypto.randomUUID()}`],
    [latestVersionId, `latest-${crypto.randomUUID()}`],
  ]) {
    await database.query(
      `INSERT INTO job_versions (
         id, workspace_id, canonical_job_id, content_hash, description_text, observed_at
       ) VALUES ($1, $2, $3, $4, 'Currentness test fixture', NOW())`,
      [id, workspaceId, canonicalJobId, contentHash],
    );
  }
  await database.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [latestVersionId, workspaceId, canonicalJobId],
  );
  return { canonicalJobId, oldVersionId, latestVersionId };
}

async function insertPendingTask(input: {
  taskType: string;
  taskKey: string;
  payload: Record<string, unknown>;
  fingerprintTaskType: string;
  fingerprintTaskVersion: string;
  contextFingerprint?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const payload = JSON.stringify(input.payload);
  const contextFingerprint = input.contextFingerprint ?? buildPipelineTaskContextFingerprint({
    workspaceId: getContext().workspaceId,
    taskType: input.fingerprintTaskType,
    taskVersion: input.fingerprintTaskVersion,
    payload: input.payload,
  });
  await getClient().query(
    `INSERT INTO pipeline_tasks (
       id, workspace_id, task_type, task_key, payload, context_fingerprint,
       status, available_at, lease_id, lease_expires_at, heartbeat_at, claimed_by,
       attempt_count, max_attempts, last_error, repair_action, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6,
       'PENDING', NOW() - INTERVAL '1 hour', $7, NOW() + INTERVAL '5 minutes', NOW(), 'test-worker',
       1, 8, 'preserve prior error', 'preserve prior repair action', NOW() - INTERVAL '1 hour', NOW()
     )`,
    [
      id,
      getContext().workspaceId,
      input.taskType,
      input.taskKey,
      payload,
      contextFingerprint,
      crypto.randomUUID(),
    ],
  );
  return id;
}

async function createEmbeddingSpace(): Promise<string> {
  const { rows } = await getClient().query<{ id: string }>(
    `INSERT INTO embedding_spaces (
       workspace_id, space_key, provider, model, dimensions, is_fallback_space, active
     ) VALUES ($1, $2, 'fixture', 'slow-embedding-fixture', 4, FALSE, TRUE)
     RETURNING id`,
    [getContext().workspaceId, `slow-embedding-${crypto.randomUUID()}`],
  );
  const spaceId = rows[0]?.id;
  if (!spaceId) throw new Error("Slow embedding fixture space was not created.");
  return spaceId;
}

async function publishJobEmbedding(embeddingSpaceId: string, jobVersionId: string): Promise<void> {
  const database = getClient();
  const workspaceId = getContext().workspaceId;
  const { rows: inputs } = await database.query<{ id: string }>(
    `INSERT INTO embedding_inputs (
       workspace_id, input_key, source_type, source_id, content_text, content_hash
     ) VALUES ($1, $2, 'JOB_VERSION', $3, 'Disposable slow-embedding fixture', $4)
     RETURNING id`,
    [workspaceId, `slow-embedding-input-${crypto.randomUUID()}`, jobVersionId, crypto.randomUUID()],
  );
  const embeddingInputId = inputs[0]?.id;
  if (!embeddingInputId) throw new Error("Slow embedding fixture input was not created.");

  const { rows: batches } = await database.query<{ id: string }>(
    `INSERT INTO embedding_batches (
       workspace_id, embedding_space_id, batch_key, run_type, status,
       item_count, success_count, failure_count, completed_at
     ) VALUES ($1, $2, $3, 'PRIMARY', 'COMPLETED', 1, 1, 0, NOW())
     RETURNING id`,
    [workspaceId, embeddingSpaceId, `slow-embedding-batch-${crypto.randomUUID()}`],
  );
  const embeddingBatchId = batches[0]?.id;
  if (!embeddingBatchId) throw new Error("Slow embedding fixture batch was not created.");

  await database.query(
    `INSERT INTO embedding_batch_items (
       workspace_id, embedding_batch_id, embedding_input_id, status
     ) VALUES ($1, $2, $3, 'COMPLETED')`,
    [workspaceId, embeddingBatchId, embeddingInputId],
  );
  await database.query(
    `INSERT INTO semantic_embeddings (
       workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id,
       vector_dimensions, embedding_values, vector_checksum
     ) VALUES ($1, $2, $3, $4, 4, ARRAY[0.1, 0.2, 0.3, 0.4]::DOUBLE PRECISION[], $5)`,
    [workspaceId, embeddingSpaceId, embeddingInputId, embeddingBatchId, crypto.randomUUID()],
  );
}

describe.skipIf(skipReal)("pending pipeline task currentness (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `pipeline_currentness_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("reassesses an already-decided job when current readiness evidence is missing", async ({ skip }) => {
    const database = getClient();
    const readinessView = await database.query<{ available: boolean }>(
      "SELECT to_regclass('v_application_readiness_current') IS NOT NULL AS available",
    );
    if (readinessView.rows[0]?.available !== true) skip();

    const versions = await insertJobVersions();
    await database.query(
      `UPDATE canonical_jobs
       SET processing_state = 'NEEDS_VERIFICATION',
           processing_status = 'NEEDS_VERIFICATION',
           gate_decision = 'PASS',
           recommendation_eligibility = 'ELIGIBLE',
           recommendation_outcome = 'REVIEW'
       WHERE workspace_id = $1 AND id = $2`,
      [getContext().workspaceId, versions.canonicalJobId],
    );

    const seeded = await seedRecoverablePipelineTasks(database, {
      context: getContext(),
      taskTypes: ["DECIDE_RECOMMENDATION"],
      jobVersionIds: [versions.latestVersionId],
      routingDeferredReplayVersion: "readiness-refresh-test",
      maxSeedPerType: 10,
    });
    expect(seeded.inserted).toBe(1);

    const task = await database.query<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, status, payload
       FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'DECIDE_RECOMMENDATION'
         AND payload->>'canonical_job_id' = $2
         AND payload->>'job_version_id' = $3
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [getContext().workspaceId, versions.canonicalJobId, versions.latestVersionId],
    );
    expect(task.rows[0]?.payload).toMatchObject({
      reprocess_existing_state: true,
      reassessment_reason: "APPLICATION_READINESS_REFRESH",
    });

    const reconciliation = await reconcileStalePendingPipelineTasks(database, getContext(), {
      apply: true,
      taskTypes: ["DECIDE_RECOMMENDATION"],
      jobVersionIds: [versions.latestVersionId],
      limit: 10,
    });
    expect(reconciliation.current).toBe(1);
    expect(reconciliation.reconciled).toBe(0);
    expect(task.rows[0]?.status).toBe("PENDING");
    const after = await database.query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE id = $1`,
      [task.rows[0]?.id],
    );
    expect(after.rows[0]?.status).toBe("PENDING");
  });

  it("dry-runs and reconciles stale or already-satisfied pending tasks without changing current work", async () => {
    const versions = await insertJobVersions();
    const staleTaskId = await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${versions.oldVersionId}:embedding_publication_v1`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.oldVersionId },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });
    const currentTaskId = await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${versions.latestVersionId}:embedding_publication_v1`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.latestVersionId },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });
    const staleRouteTaskId = await insertPendingTask({
      taskType: "ROUTE_LANE",
      taskKey: `ROUTE_LANE:${versions.oldVersionId}:lane_router_v1`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.oldVersionId },
      fingerprintTaskType: "ROUTE_LANE",
      fingerprintTaskVersion: "lane_router_v1",
    });
    const currentRouteTaskId = await insertPendingTask({
      taskType: "ROUTE_LANE",
      taskKey: `ROUTE_LANE:${versions.latestVersionId}:lane_router_v1`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.latestVersionId },
      fingerprintTaskType: "ROUTE_LANE",
      fingerprintTaskVersion: "lane_router_v1",
    });
    const unresolvedVersionId = crypto.randomUUID();
    const unresolvedTaskId = await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${unresolvedVersionId}:embedding_publication_v1`,
      payload: { canonical_job_id: crypto.randomUUID(), job_version_id: unresolvedVersionId },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });

    const observationId = crypto.randomUUID();
    await getClient().query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, company_name, title, description_raw,
         raw_payload_hash, processing_status, job_version_id
       ) VALUES ($1, $2, 'test', 'Test Co', 'Processed Role', 'Processed fixture', $3, 'PROCESSED', $4)`,
      [observationId, getContext().workspaceId, `hash-${observationId}`, versions.latestVersionId],
    );
    const satisfiedTaskId = await insertPendingTask({
      taskType: "NORMALIZE_OBSERVATION",
      taskKey: `NORMALIZE_OBSERVATION:${observationId}:normalizer_v1`,
      payload: { observation_id: observationId },
      fingerprintTaskType: "NORMALIZE_OBSERVATION",
      fingerprintTaskVersion: "normalizer_v1",
    });

    const seedSummary = await seedRecoverablePipelineTasks(getClient(), {
      context: getContext(),
      taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"],
      maxSeedPerType: 10,
    });
    expect(seedSummary.inserted).toBe(1);
    const staleSeedCount = await getClient().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM pipeline_tasks
       WHERE workspace_id = $1
         AND task_type = 'EXTRACT_DETERMINISTIC_REQUIREMENTS'
         AND payload->>'job_version_id' = $2`,
      [getContext().workspaceId, versions.oldVersionId],
    );
    expect(staleSeedCount.rows[0]?.count).toBe(0);

    await getClient().query(
      `INSERT INTO pipeline_task_attempts (
         workspace_id, task_id, attempt_number, status, started_at, finished_at,
         error_message, metadata
       ) VALUES ($1, $2, 1, 'FAILED', NOW() - INTERVAL '1 hour', NOW(), 'audit history', '{"source":"test"}'::jsonb)`,
      [getContext().workspaceId, staleTaskId],
    );

    const dryRun = await reconcileStalePendingPipelineTasks(getClient(), getContext(), {
      apply: false,
      taskTypes: ["PUBLISH_EMBEDDING", "ROUTE_LANE", "NORMALIZE_OBSERVATION"],
    });
    expect(dryRun).toMatchObject({
      scannedPending: 6,
      current: 2,
      unresolved: 1,
      wouldReconcile: 3,
      reconciled: 0,
    });
    expect(dryRun.byClassification).toMatchObject({
      PROVEN_SUPERSEDED: 2,
      PROVEN_SATISFIED: 1,
      CURRENT: 2,
      UNRESOLVED: 1,
    });

    const dryRunRows = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[staleTaskId, currentTaskId, satisfiedTaskId, staleRouteTaskId, currentRouteTaskId, unresolvedTaskId]],
    );
    expect(dryRunRows.rows).toHaveLength(6);
    expect(dryRunRows.rows.every((row) => row.status === "PENDING")).toBe(true);

    const applied = await reconcileStalePendingPipelineTasks(getClient(), getContext(), {
      apply: true,
      taskTypes: ["PUBLISH_EMBEDDING", "ROUTE_LANE", "NORMALIZE_OBSERVATION"],
    });
    expect(applied.reconciled).toBe(3);
    expect(applied.stalePendingReconciledThisRun).toBe(3);
    expect(applied.unresolved).toBe(1);
    expect(applied.byReason).toMatchObject({
      TASK_JOB_VERSION_IS_NOT_LATEST: 2,
      NORMALIZATION_ALREADY_PROCESSED: 1,
    });
    expect(applied.byTaskType).toMatchObject({
      PUBLISH_EMBEDDING: 1,
      ROUTE_LANE: 1,
      NORMALIZE_OBSERVATION: 1,
    });
    const reseedSummary = await seedRecoverablePipelineTasks(getClient(), {
      context: getContext(),
      taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"],
      maxSeedPerType: 10,
    });
    expect(reseedSummary.inserted).toBe(0);
    const staleSeedCountAfterReconcile = await getClient().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM pipeline_tasks
       WHERE workspace_id = $1
         AND task_type = 'EXTRACT_DETERMINISTIC_REQUIREMENTS'
         AND payload->>'job_version_id' = $2`,
      [getContext().workspaceId, versions.oldVersionId],
    );
    expect(staleSeedCountAfterReconcile.rows[0]?.count).toBe(0);

    const after = await getClient().query<{
      id: string;
      status: string;
      lease_id: string | null;
      lease_expires_at: string | null;
      heartbeat_at: string | null;
      claimed_by: string | null;
      completed_at: string | null;
      last_error: string | null;
      repair_action: string | null;
    }>(
      `SELECT id, status, lease_id, lease_expires_at, heartbeat_at, claimed_by,
              completed_at, last_error, repair_action
       FROM pipeline_tasks
       WHERE id = ANY($1::uuid[])`,
      [[staleTaskId, currentTaskId, satisfiedTaskId, staleRouteTaskId, currentRouteTaskId, unresolvedTaskId]],
    );
    const rowsById = new Map(after.rows.map((row) => [row.id, row]));
    for (const taskId of [staleTaskId, staleRouteTaskId, satisfiedTaskId]) {
      const row = rowsById.get(taskId);
      expect(row).toMatchObject({
        status: "COMPLETED",
        lease_id: null,
        lease_expires_at: null,
        heartbeat_at: null,
        claimed_by: null,
      });
      expect(row?.completed_at).not.toBeNull();
      expect(row?.last_error).toContain('"event":"PIPELINE_TASK_RECONCILED"');
      expect(row?.repair_action).toContain("RECONCILED_");
      expect(row?.last_error).toContain("preserve prior error");
      expect(row?.repair_action).toContain("preserve prior repair action");
    }
    expect(rowsById.get(currentTaskId)?.status).toBe("PENDING");
    expect(rowsById.get(currentRouteTaskId)?.status).toBe("PENDING");
    expect(rowsById.get(unresolvedTaskId)?.status).toBe("PENDING");
    await getClient().query(
      `UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = ANY($1::uuid[])`,
      [[currentTaskId, currentRouteTaskId, unresolvedTaskId]],
    );

    const workerStaleTaskId = await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${versions.oldVersionId}:embedding_publication_v1:repair`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.oldVersionId },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });
    const workerSummary = await runPipelineStageTaskWorker(getClient(), {
      context: getContext(),
      seed: false,
      taskTypes: ["PUBLISH_EMBEDDING"],
      maxTasks: 1,
      heartbeatSeconds: 0,
    });
    expect(workerSummary.stalePendingReconciliation.reconciled).toBe(0);
    expect(workerSummary.stalePendingReconciliation.unresolved).toBe(1);
    expect(workerSummary.claimed).toBe(1);
    expect(workerSummary.completed).toBe(1);
    const workerStaleStatus = await getClient().query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE id = $1`,
      [workerStaleTaskId],
    );
    expect(workerStaleStatus.rows[0]?.status).toBe("COMPLETED");

    const attempts = await getClient().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM pipeline_task_attempts
       WHERE workspace_id = $1 AND task_id = $2`,
      [getContext().workspaceId, staleTaskId],
    );
    expect(attempts.rows[0]?.count).toBe(1);
  });

  it("preserves alternate preference task keys and forced recalculation requests", async () => {
    const versions = await insertJobVersions();
    await getClient().query(
      `INSERT INTO gate_decisions (
         workspace_id, canonical_job_id, job_version_id, gate_version, decision
       ) VALUES ($1, $2, $3, $4, 'PASS')`,
      [getContext().workspaceId, versions.canonicalJobId, versions.latestVersionId, GATE_VERSION],
    );

    const basePayload = {
      canonical_job_id: versions.canonicalJobId,
      job_version_id: versions.latestVersionId,
    };
    const satisfiedTaskId = await insertPendingTask({
      taskType: "APPLY_HARD_GATES",
      taskKey: `APPLY_HARD_GATES:${versions.latestVersionId}:hard_gate_v1`,
      payload: basePayload,
      fingerprintTaskType: "APPLY_HARD_GATES",
      fingerprintTaskVersion: "hard_gate_v1",
    });
    const forcedPayload = {
      ...basePayload,
      force_policy_recalculation: true,
      preference_mode_key: "focused",
      preference_mode_updated_at: new Date().toISOString(),
    };
    const forcedTaskKey = `APPLY_HARD_GATES:${versions.latestVersionId}:hard_gate_v1:preference:focused:2`;
    const forcedTask = await enqueuePipelineTask({
      taskType: "APPLY_HARD_GATES",
      taskKey: forcedTaskKey,
      payload: forcedPayload,
      producer: "test.preference_mode_change",
      stageVersion: "hard_gate_v1",
      requestId: forcedTaskKey,
      triggerRevisionId: "2",
    }, getClient(), { context: getContext() });
    const legacyPreferenceUpdatedAt = "2026-10-24T00:00:00.000Z";
    const legacyPreferenceRevision = String(Date.parse(legacyPreferenceUpdatedAt));
    const legacyPreferenceTaskId = await insertPendingTask({
      taskType: "APPLY_HARD_GATES",
      taskKey: `APPLY_HARD_GATES:${versions.latestVersionId}:preference:focused:${legacyPreferenceRevision}`,
      payload: {
        ...basePayload,
        force_policy_recalculation: true,
        preference_mode_key: "focused",
        preference_mode_updated_at: legacyPreferenceUpdatedAt,
      },
      fingerprintTaskType: "APPLY_HARD_GATES",
      fingerprintTaskVersion: "hard_gate_v1",
      contextFingerprint: "legacy_pipeline_context_v1",
    });
    const unknownLegacyTaskId = await insertPendingTask({
      taskType: "APPLY_HARD_GATES",
      taskKey: `APPLY_HARD_GATES:${versions.latestVersionId}:preference:legacy-unproven:1`,
      payload: { ...basePayload, force_policy_recalculation: true },
      fingerprintTaskType: "APPLY_HARD_GATES",
      fingerprintTaskVersion: "hard_gate_v1",
      contextFingerprint: "legacy_pipeline_context_v1",
    });
    const unknownKeyTaskId = await insertPendingTask({
      taskType: "APPLY_HARD_GATES",
      taskKey: `APPLY_HARD_GATES:${versions.latestVersionId}:unrecognized-producer-key:1`,
      payload: basePayload,
      fingerprintTaskType: "APPLY_HARD_GATES",
      fingerprintTaskVersion: "hard_gate_v1",
    });
    const taskIds = [satisfiedTaskId, forcedTask.taskId, legacyPreferenceTaskId, unknownLegacyTaskId, unknownKeyTaskId];

    const summary = await reconcileStalePendingPipelineTasks(getClient(), getContext(), {
      apply: true,
      taskTypes: ["APPLY_HARD_GATES"],
      jobVersionIds: [versions.latestVersionId],
    });
    expect(summary).toMatchObject({
      scannedPending: 5,
      current: 2,
      unresolved: 2,
      wouldReconcile: 1,
      reconciled: 1,
    });
    const statuses = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [taskIds],
    );
    expect(new Map(statuses.rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [taskIds[0], "COMPLETED"],
      [taskIds[1], "PENDING"],
      [taskIds[2], "PENDING"],
      [taskIds[3], "PENDING"],
      [taskIds[4], "PENDING"],
    ]));
  });

  it("does not treat completed extraction as satisfying an explicit reprocess request", async () => {
    const versions = await insertJobVersions();
    const { rows: versionRows } = await getClient().query<{ content_hash: string }>(
      `SELECT content_hash FROM job_versions WHERE id = $1`,
      [versions.latestVersionId],
    );
    const contentHash = versionRows[0]?.content_hash;
    if (!contentHash) throw new Error("Requirement fixture job version has no content hash.");
    const { rows: identityRows } = await getClient().query<{ id: string }>(
      `INSERT INTO requirement_set_identities (
         workspace_id, canonical_job_id, identity_hash, job_content_hash,
         deterministic_extractor_version, quoted_extractor_version,
         quoted_prompt_hash, normalizer_hash
       ) VALUES ($1, $2, $3, $4, 'deterministic_v3', 'quoted_v1', 'quoted-hash', 'normalizer-hash')
       RETURNING id`,
      [getContext().workspaceId, versions.canonicalJobId, crypto.randomUUID(), contentHash],
    );
    const identityId = identityRows[0]?.id;
    if (!identityId) throw new Error("Requirement identity fixture was not created.");
    const { rows: requirementSetRows } = await getClient().query<{ id: string }>(
      `INSERT INTO requirement_sets (
         workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
         revision_number, source_type
       ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED')
       RETURNING id`,
      [getContext().workspaceId, identityId, versions.canonicalJobId, versions.latestVersionId],
    );
    const requirementSetId = requirementSetRows[0]?.id;
    if (!requirementSetId) throw new Error("Requirement set fixture was not created.");
    await getClient().query(
      `UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`,
      [requirementSetId, versions.latestVersionId],
    );
    await getClient().query(
      `INSERT INTO requirement_extraction_runs (
         workspace_id, canonical_job_id, job_version_id, run_type, status, requirement_set_id
       ) VALUES ($1, $2, $3, 'DETERMINISTIC', 'COMPLETED', $4)`,
      [getContext().workspaceId, versions.canonicalJobId, versions.latestVersionId, requirementSetId],
    );
    await getClient().query(
      `INSERT INTO job_version_pipeline_state (
         workspace_id, canonical_job_id, job_version_id, current_stage, stage_status
       ) VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
      [getContext().workspaceId, versions.canonicalJobId, versions.latestVersionId],
    );

    const basePayload = {
      canonical_job_id: versions.canonicalJobId,
      job_version_id: versions.latestVersionId,
    };
    const forcedTaskId = await insertPendingTask({
      taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      taskKey: `EXTRACT_DETERMINISTIC_REQUIREMENTS:${versions.latestVersionId}:deterministic_v3:repair`,
      payload: { ...basePayload, reprocess: true },
      fingerprintTaskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      fingerprintTaskVersion: "deterministic_v3",
    });
    const satisfiedTaskId = await insertPendingTask({
      taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      taskKey: `EXTRACT_DETERMINISTIC_REQUIREMENTS:${versions.latestVersionId}:deterministic_v3`,
      payload: basePayload,
      fingerprintTaskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      fingerprintTaskVersion: "deterministic_v3",
    });

    const summary = await reconcileStalePendingPipelineTasks(getClient(), getContext(), {
      apply: true,
      taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"],
      jobVersionIds: [versions.latestVersionId],
    });
    expect(summary).toMatchObject({ current: 1, wouldReconcile: 1, reconciled: 1 });
    const statuses = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [[forcedTaskId, satisfiedTaskId]],
    );
    expect(new Map(statuses.rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [forcedTaskId, "PENDING"],
      [satisfiedTaskId, "COMPLETED"],
    ]));
  });

  it("bounds reconciliation work and leaves unscanned obligations pending", async () => {
    const taskIds: string[] = [];
    const jobVersionIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const canonicalJobId = crypto.randomUUID();
      const jobVersionId = crypto.randomUUID();
      jobVersionIds.push(jobVersionId);
      taskIds.push(await insertPendingTask({
        taskType: "PUBLISH_EMBEDDING",
        taskKey: `PUBLISH_EMBEDDING:${jobVersionId}:embedding_publication_v1:budget-${index}`,
        payload: { canonical_job_id: canonicalJobId, job_version_id: jobVersionId },
        fingerprintTaskType: "PUBLISH_EMBEDDING",
        fingerprintTaskVersion: "embedding_publication_v1",
      }));
    }

    const summary = await reconcileStalePendingPipelineTasks(getClient(), getContext(), {
      apply: true,
      taskTypes: ["PUBLISH_EMBEDDING"],
      jobVersionIds,
      limit: 10,
      timeBudgetMs: 1,
    });
    expect(summary.scannedPending).toBe(10);
    expect(summary.deferredByBudget).toBeGreaterThan(0);
    expect(summary.reconciled).toBe(0);
    const statuses = await getClient().query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [taskIds],
    );
    expect(statuses.rows).toHaveLength(10);
    expect(statuses.rows.every((row) => row.status === "PENDING")).toBe(true);
  });

  it("does not reset a running lease when the same intent is enqueued again", async () => {
    const versions = await insertJobVersions();
    const taskKey = `PUBLISH_EMBEDDING:${versions.latestVersionId}:embedding_publication_v1:lease-test`;
    const enqueueInput = {
      taskType: "PUBLISH_EMBEDDING",
      taskKey,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.latestVersionId },
      producer: "test.running_lease",
      stageVersion: "embedding_publication_v1",
      requestId: taskKey,
    };
    const first = await enqueuePipelineTask(enqueueInput, getClient(), { context: getContext() });
    expect(first.inserted).toBe(true);
    const leaseId = crypto.randomUUID();
    await getClient().query(
      `UPDATE pipeline_tasks
       SET status = 'RUNNING', lease_id = $2, lease_expires_at = NOW() + INTERVAL '5 minutes',
           heartbeat_at = NOW(), claimed_by = 'lease-owner'
       WHERE workspace_id = $1 AND id = $3`,
      [getContext().workspaceId, leaseId, first.taskId],
    );

    const second = await enqueuePipelineTask(enqueueInput, getClient(), { context: getContext() });
    expect(second).toMatchObject({ taskId: first.taskId, inserted: false, reactivated: false });
    const running = await getClient().query<{
      status: string;
      lease_id: string | null;
      claimed_by: string | null;
      attempt_count: number;
    }>(
      `SELECT status, lease_id, claimed_by, attempt_count FROM pipeline_tasks WHERE id = $1`,
      [first.taskId],
    );
    expect(running.rows[0]).toMatchObject({
      status: "RUNNING",
      lease_id: leaseId,
      claimed_by: "lease-owner",
      attempt_count: 0,
    });
  });

  it("keeps tasks unresolved when the canonical latest-version pointer is missing", async () => {
    const versions = await insertJobVersions();
    await getClient().query(
      `UPDATE canonical_jobs SET latest_job_version_id = NULL WHERE workspace_id = $1 AND id = $2`,
      [getContext().workspaceId, versions.canonicalJobId],
    );
    const taskId = await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${versions.latestVersionId}:embedding_publication_v1`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.latestVersionId },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });

    const summary = await reconcileStalePendingPipelineTasks(getClient(), getContext(), {
      apply: true,
      taskTypes: ["PUBLISH_EMBEDDING"],
      jobVersionIds: [versions.latestVersionId],
    });
    expect(summary).toMatchObject({ unresolved: 1, wouldReconcile: 0, reconciled: 0 });
    const status = await getClient().query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE id = $1`,
      [taskId],
    );
    expect(status.rows[0]?.status).toBe("PENDING");
  });

  it("re-reads a changed latest-version pointer before reconciling", async () => {
    const versions = await insertJobVersions();
    const newerVersionId = crypto.randomUUID();
    await getClient().query(
      `INSERT INTO job_versions (
         id, workspace_id, canonical_job_id, content_hash, description_text, observed_at
       ) VALUES ($1, $2, $3, $4, 'Concurrent pointer fixture', NOW())`,
      [newerVersionId, getContext().workspaceId, versions.canonicalJobId, `new-${crypto.randomUUID()}`],
    );
    const staleTaskId = await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${versions.oldVersionId}:embedding_publication_v1`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: versions.oldVersionId },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });
    await getClient().query(
      `UPDATE pipeline_tasks SET created_at = NOW() - INTERVAL '5 hours' WHERE id = $1`,
      [staleTaskId],
    );
    await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${newerVersionId}:embedding_publication_v1`,
      payload: { canonical_job_id: versions.canonicalJobId, job_version_id: newerVersionId },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });

    const blocker = await pool?.connect();
    if (!blocker) throw new Error("The currentness race test requires a second PostgreSQL client.");
    let pointerUpdateOpen = false;
    try {
      await blocker.query(`SET search_path TO ${schemaName}, public`);
      await blocker.query("BEGIN");
      pointerUpdateOpen = true;
      await blocker.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
        [newerVersionId, getContext().workspaceId, versions.canonicalJobId],
      );
      const { rows: pidRows } = await getClient().query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`);
      const reconciliation = reconcileStalePendingPipelineTasks(getClient(), getContext(), {
        apply: true,
        taskTypes: ["PUBLISH_EMBEDDING"],
        jobVersionIds: [versions.oldVersionId, newerVersionId],
      });
      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await blocker.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
          [pidRows[0]?.pid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          observedLockWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true);
      await blocker.query("COMMIT");
      pointerUpdateOpen = false;
      const summary = await reconciliation;
      expect(summary).toMatchObject({ reconciled: 1, current: 1, unresolved: 0 });
      const staleStatus = await getClient().query<{ status: string }>(
        `SELECT status FROM pipeline_tasks WHERE id = $1`,
        [staleTaskId],
      );
      expect(staleStatus.rows[0]?.status).toBe("COMPLETED");
    } finally {
      if (pointerUpdateOpen) await blocker.query("ROLLBACK");
      blocker.release();
    }
  }, 15000);

  it("rotates past slow embedding work across bounded database-backed runs", async () => {
    const normalizationJob = await insertJobVersions();
    const embeddingSpaceId = await createEmbeddingSpace();
    const recommendationJob = await insertJobVersions();
    await getClient().query(
      `UPDATE canonical_jobs
       SET processing_state = 'HARD_REJECTED',
           processing_status = 'HARD_REJECTED',
           gate_decision = 'HARD_REJECT'
       WHERE workspace_id = $1 AND id = $2`,
      [getContext().workspaceId, recommendationJob.canonicalJobId],
    );
    const candidateProfile = await getClient().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, $2, 'Pipeline Fairness Test Profile')
       RETURNING id`,
      [getContext().workspaceId, `pipeline_fairness_${crypto.randomUUID()}`],
    );
    const candidateProfileId = candidateProfile.rows[0]?.id;
    if (!candidateProfileId) throw new Error("Pipeline fairness fixture profile was not created.");
    const oldProfile = await getClient().query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id, candidate_profile_id, version_number, schema_version,
         source_hash, status, effective_at
       ) VALUES ($1, $2, 5, '2.2.0', $3, 'RETIRED', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [getContext().workspaceId, candidateProfileId, `old-${crypto.randomUUID()}`],
    );
    const activeProfile = await getClient().query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id, candidate_profile_id, version_number, schema_version,
         source_hash, status, effective_at
       ) VALUES ($1, $2, 6, '2.2.0', $3, 'ACTIVE', NOW())
       RETURNING id`,
      [getContext().workspaceId, candidateProfileId, `active-${crypto.randomUUID()}`],
    );
    const oldProfileVersionId = oldProfile.rows[0]?.id;
    const activeProfileVersionId = activeProfile.rows[0]?.id;
    if (!oldProfileVersionId || !activeProfileVersionId) throw new Error("Pipeline fairness fixture profile versions were not created.");

    const insertObservation = async (jobVersionId: string): Promise<string> => {
      const observationId = crypto.randomUUID();
      await getClient().query(
        `INSERT INTO raw_job_observations (
           id, workspace_id, source_name, company_name, title, description_raw,
           raw_payload_hash, processing_status, job_version_id
         ) VALUES ($1, $2, 'test', 'Test Co', 'Queued Role', 'Queued fixture', $3, 'PENDING', $4)`,
        [observationId, getContext().workspaceId, `hash-${observationId}`, jobVersionId],
      );
      return observationId;
    };

    const firstObservationId = await insertObservation(normalizationJob.latestVersionId);
    const firstNormalizationTaskId = await insertPendingTask({
      taskType: "NORMALIZE_OBSERVATION",
      taskKey: `NORMALIZE_OBSERVATION:${firstObservationId}:normalizer_v1`,
      payload: { observation_id: firstObservationId },
      fingerprintTaskType: "NORMALIZE_OBSERVATION",
      fingerprintTaskVersion: "normalizer_v1",
    });
    const embeddingTaskId = await insertPendingTask({
      taskType: "PUBLISH_EMBEDDING",
      taskKey: `PUBLISH_EMBEDDING:${normalizationJob.latestVersionId}:embedding_publication_v1`,
      payload: {
        canonical_job_id: normalizationJob.canonicalJobId,
        job_version_id: normalizationJob.latestVersionId,
      },
      fingerprintTaskType: "PUBLISH_EMBEDDING",
      fingerprintTaskVersion: "embedding_publication_v1",
    });
    const decisionPayload = {
      canonical_job_id: recommendationJob.canonicalJobId,
      job_version_id: recommendationJob.latestVersionId,
      content_hash: `latest-placeholder`,
      active_requirement_set_id: null,
      profile_version_id: activeProfileVersionId,
      match_run_id: null,
      deterministic_decision_id: null,
      repair_existing_state: true,
    };
    const versionContent = await getClient().query<{ content_hash: string }>(
      `SELECT content_hash FROM job_versions WHERE id = $1`,
      [recommendationJob.latestVersionId],
    );
    decisionPayload.content_hash = versionContent.rows[0]?.content_hash ?? "";
    const decisionTaskKey = `DECIDE_RECOMMENDATION:${recommendationJob.latestVersionId}:recommendation_decider_v1:repair`;
    const staleDecisionTaskId = await insertPendingTask({
      taskType: "DECIDE_RECOMMENDATION",
      taskKey: decisionTaskKey,
      payload: { ...decisionPayload, profile_version_id: oldProfileVersionId },
      fingerprintTaskType: "DECIDE_RECOMMENDATION",
      fingerprintTaskVersion: "recommendation_decider_v1",
    });
    const currentDecisionTaskId = await insertPendingTask({
      taskType: "DECIDE_RECOMMENDATION",
      taskKey: decisionTaskKey,
      payload: decisionPayload,
      fingerprintTaskType: "DECIDE_RECOMMENDATION",
      fingerprintTaskVersion: "recommendation_decider_v1",
    });

    let normalizationCalls = 0;
    const workerDependencies = {
      runNormalization: vi.fn(async () => {
        normalizationCalls += 1;
        if (normalizationCalls === 1) {
          const arrivingObservationId = await insertObservation(normalizationJob.latestVersionId);
          await insertPendingTask({
            taskType: "NORMALIZE_OBSERVATION",
            taskKey: `NORMALIZE_OBSERVATION:${arrivingObservationId}:normalizer_v1`,
            payload: { observation_id: arrivingObservationId },
            fingerprintTaskType: "NORMALIZE_OBSERVATION",
            fingerprintTaskVersion: "normalizer_v1",
          });
        }
        return { totalDiscovered: 1, totalProcessed: 1, totalErrors: 0, details: [] };
      }),
      runRequirementsExtraction: vi.fn(async () => ({
        discovered: 0,
        processed: 0,
        deterministicInserted: 0,
        quotedInserted: 0,
        quotedFailed: 0,
        errors: 0,
        metrics: {
          quotedAttempted: 0,
          quotedSucceeded: 0,
          quotedValidationFailures: 0,
          quotedProviderFailures: 0,
          retryWaitTransitions: 0,
          quotedPassRate: 0,
          byProviderModel: {},
        },
        details: [],
      })),
      runHardGates: vi.fn(async () => ({ passed: 0, hardRejected: 0, needsVerification: 0, errors: 0 })),
      runEmbeddingBatchWithFallback: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5100));
        await publishJobEmbedding(embeddingSpaceId, normalizationJob.latestVersionId);
        return {
          seededSpaces: { primarySpaceId: embeddingSpaceId, fallbackSpaceId: crypto.randomUUID() },
          inputBuild: { inserted: 0, fromRequirements: 0, fromProfileFacts: 0, fromJobVersions: 0, fromLanePrototypes: 0 },
          primary: {
            batchId: null,
            embeddingSpaceId,
            processed: 0,
            processedInputIds: [],
            succeeded: 0,
            failed: 0,
            failedInputIds: [],
            runType: "PRIMARY",
            errors: [],
          },
        };
      }),
      runLaneRouting: vi.fn(async () => ({ routed: 0, deferred: 0 })),
      runDeterministicMatcher: vi.fn(async () => ({ matchedJobs: 0, skippedJobs: 0, errors: 0 })),
      runRecommendationDecider: vi.fn(async () => {
        await getClient().query(
          `UPDATE canonical_jobs
           SET recommendation_eligibility = 'INELIGIBLE',
               recommendation_outcome = 'SKIP'
           WHERE workspace_id = $1 AND id = $2`,
          [getContext().workspaceId, recommendationJob.canonicalJobId],
        );
        return { updated: 1, decisionsInserted: 1, errors: 0, policySnapshotId: "policy", policySnapshotHash: "hash" };
      }),
      runExplanationQueueEnqueuer: vi.fn(async () => ({ enqueued: 0, updated: 0, deferred: 0 })),
    } as PipelineStageWorkerDependencies;

    const taskTypes = ["PUBLISH_EMBEDDING", "NORMALIZE_OBSERVATION", "DECIDE_RECOMMENDATION"] as const;
    const slowEmbeddingRun = await runPipelineStageTaskWorker(getClient(), {
      context: getContext(),
      seed: false,
      taskTypes: [...taskTypes],
      jobVersionIds: [normalizationJob.latestVersionId, recommendationJob.latestVersionId],
      stageStartOffset: 0,
      stageQuantum: 1,
      maxTasks: 100,
      claimBatchSize: 1,
      heartbeatSeconds: 0,
      wallClockMs: 5000,
      minTimeToStartTaskMs: 0,
    }, workerDependencies);
    expect(slowEmbeddingRun.claimed).toBe(1);
    expect(slowEmbeddingRun.exitReason).toBe("WALL_CLOCK_BUDGET_REACHED");
    expect(slowEmbeddingRun.byType.PUBLISH_EMBEDDING?.claimed).toBe(1);
    expect(slowEmbeddingRun.stalePendingReconciliation.stalePendingReconciledThisRun).toBe(1);
    const afterSlowEmbedding = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [[embeddingTaskId, firstNormalizationTaskId, currentDecisionTaskId]],
    );
    expect(new Map(afterSlowEmbedding.rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [embeddingTaskId, "COMPLETED"],
      [firstNormalizationTaskId, "PENDING"],
      [currentDecisionTaskId, "PENDING"],
    ]));

    const normalizationRun = await runPipelineStageTaskWorker(getClient(), {
      context: getContext(),
      seed: false,
      taskTypes: [...taskTypes],
      jobVersionIds: [normalizationJob.latestVersionId, recommendationJob.latestVersionId],
      stageStartOffset: 1,
      stageQuantum: 1,
      maxTasks: 1,
      claimBatchSize: 1,
      heartbeatSeconds: 0,
      wallClockMs: 5000,
      minTimeToStartTaskMs: 0,
    }, workerDependencies);
    expect(normalizationRun.byType.NORMALIZE_OBSERVATION?.claimed).toBe(1);
    const afterNormalization = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [[firstNormalizationTaskId, currentDecisionTaskId]],
    );
    expect(new Map(afterNormalization.rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [firstNormalizationTaskId, "COMPLETED"],
      [currentDecisionTaskId, "PENDING"],
    ]));

    const recommendationRun = await runPipelineStageTaskWorker(getClient(), {
      context: getContext(),
      seed: false,
      taskTypes: [...taskTypes],
      jobVersionIds: [normalizationJob.latestVersionId, recommendationJob.latestVersionId],
      stageStartOffset: 2,
      stageQuantum: 1,
      maxTasks: 1,
      claimBatchSize: 1,
      heartbeatSeconds: 0,
      wallClockMs: 5000,
      minTimeToStartTaskMs: 0,
    }, workerDependencies);
    expect(recommendationRun.byType.DECIDE_RECOMMENDATION?.claimed).toBe(1);
    expect(workerDependencies.runEmbeddingBatchWithFallback).toHaveBeenCalledTimes(1);
    expect(workerDependencies.runRecommendationDecider).toHaveBeenCalledTimes(1);
    expect(slowEmbeddingRun.successorTasksCreated).toBeGreaterThanOrEqual(1);
    const decisionTaskStatuses = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [[staleDecisionTaskId, currentDecisionTaskId]],
    );
    expect(new Map(decisionTaskStatuses.rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [staleDecisionTaskId, "COMPLETED"],
      [currentDecisionTaskId, "COMPLETED"],
    ]));
  }, 20000);
});
