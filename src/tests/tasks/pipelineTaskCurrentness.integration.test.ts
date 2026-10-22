import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { buildPipelineTaskContextFingerprint } from "../../pipeline/artifactContext.js";
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
}): Promise<string> {
  const id = crypto.randomUUID();
  const payload = JSON.stringify(input.payload);
  const contextFingerprint = buildPipelineTaskContextFingerprint({
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
      scannedPending: 5,
      current: 1,
      unresolved: 1,
      wouldReconcile: 3,
      reconciled: 0,
    });
    expect(dryRun.byClassification).toMatchObject({
      SUPERSEDED_JOB_VERSION: 2,
      ALREADY_SATISFIED: 1,
      CURRENT: 1,
      UNRESOLVED: 1,
    });

    const dryRunRows = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[staleTaskId, currentTaskId, satisfiedTaskId, staleRouteTaskId, unresolvedTaskId]],
    );
    expect(dryRunRows.rows.map((row) => row.status)).toEqual(["PENDING", "PENDING", "PENDING", "PENDING", "PENDING"]);

    const applied = await reconcileStalePendingPipelineTasks(getClient(), getContext(), {
      apply: true,
      taskTypes: ["PUBLISH_EMBEDDING", "ROUTE_LANE", "NORMALIZE_OBSERVATION"],
    });
    expect(applied.reconciled).toBe(3);
    expect(applied.stalePendingReconciledThisRun).toBe(3);
    expect(applied.unresolved).toBe(1);
    expect(applied.byReason).toMatchObject({
      SUPERSEDED_JOB_VERSION: 2,
      ALREADY_SATISFIED: 1,
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
      [[staleTaskId, currentTaskId, satisfiedTaskId, staleRouteTaskId, unresolvedTaskId]],
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
    expect(rowsById.get(unresolvedTaskId)?.status).toBe("PENDING");
    await getClient().query(
      `UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = ANY($1::uuid[])`,
      [[currentTaskId, unresolvedTaskId]],
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
    expect(workerSummary.stalePendingReconciliation.reconciled).toBe(1);
    expect(workerSummary.claimed).toBe(0);
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

  it("services recommendation work while normalization continues to arrive", async () => {
    const normalizationJob = await insertJobVersions();
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
    await insertPendingTask({
      taskType: "NORMALIZE_OBSERVATION",
      taskKey: `NORMALIZE_OBSERVATION:${firstObservationId}:normalizer_v1`,
      payload: { observation_id: firstObservationId },
      fingerprintTaskType: "NORMALIZE_OBSERVATION",
      fingerprintTaskVersion: "normalizer_v1",
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
      runEmbeddingBatchWithFallback: vi.fn(async () => ({
        seededSpaces: { primarySpaceId: "primary", fallbackSpaceId: "fallback" },
        inputBuild: { inserted: 0, fromRequirements: 0, fromProfileFacts: 0, fromJobVersions: 0, fromLanePrototypes: 0 },
        primary: {
          batchId: null,
          embeddingSpaceId: "primary",
          processed: 0,
          processedInputIds: [],
          succeeded: 0,
          failed: 0,
          failedInputIds: [],
          runType: "PRIMARY",
          errors: [],
        },
      })),
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

    const summary = await runPipelineStageTaskWorker(getClient(), {
      context: getContext(),
      seed: false,
      taskTypes: ["NORMALIZE_OBSERVATION", "DECIDE_RECOMMENDATION"],
      stageQuantum: 1,
      maxTasks: 3,
      claimBatchSize: 1,
      heartbeatSeconds: 0,
    }, workerDependencies);

    expect(summary.claimed).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.byType.NORMALIZE_OBSERVATION?.claimed).toBe(2);
    expect(summary.byType.DECIDE_RECOMMENDATION?.claimed).toBe(1);
    expect(summary.stalePendingReconciliation.stalePendingReconciledThisRun).toBe(1);
    expect(summary.stalePendingReconciliation.byReason).toMatchObject({ SUPERSEDED_PROFILE_VERSION: 1 });
    expect(workerDependencies.runRecommendationDecider).toHaveBeenCalledTimes(1);
    expect(workerDependencies.runEmbeddingBatchWithFallback).not.toHaveBeenCalled();
    expect(summary.successorTasksCreated).toBe(1);
    const decisionTaskStatuses = await getClient().query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [[staleDecisionTaskId, currentDecisionTaskId]],
    );
    expect(new Map(decisionTaskStatuses.rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [staleDecisionTaskId, "COMPLETED"],
      [currentDecisionTaskId, "COMPLETED"],
    ]));
  });
});
