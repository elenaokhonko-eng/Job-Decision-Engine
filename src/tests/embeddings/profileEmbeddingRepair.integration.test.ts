import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

const { generateEmbeddingMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(async () => [1, 0, 0, 0]),
}));

vi.mock("../../services/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/agent.js")>();
  const { batchEmbeddingFromPerInput } = await import("../fixtures/embeddingBatchMock.js");
  return {
    ...actual,
    generateEmbeddingWithProviderAndModel: generateEmbeddingMock,
    generateEmbeddingsWithProviderAndModel: batchEmbeddingFromPerInput(generateEmbeddingMock as any),
  };
});

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { buildEmbeddingInputs } from "../../embeddings/inputBuilder.js";
import { repairProfileEmbeddings } from "../../embeddings/profileEmbeddingRepair.js";
import { runEmbeddingBatch } from "../../embeddings/batchCoordinator.js";
import { runDeterministicMatcher } from "../../pipeline/deterministicMatcher.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let primarySpaceId = "";
let distractorSpaceId = "";
let savedEmbeddingConfig: Record<string, string | undefined> = {};

function getClient(): pg.PoolClient {
  if (!client) throw new Error("Profile embedding repair integration client is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("Profile embedding repair integration workspace is not initialized.");
  return context;
}

async function seedJobAndRequirements(): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const database = getClient();
  const workspaceId = getContext().workspaceId;
  const user = await database.query<{ id: string }>(
    `SELECT id FROM workspace_users WHERE user_key = 'local_user' LIMIT 1`,
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error("Expected the migration bootstrap local user fixture.");

  const canonical = await database.query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location_summary, workplace_type, employment_type, primary_lane,
       processing_state, processing_status, profile_match_status
     ) VALUES ($1, 'Profile Repair Fixture', 'Machine Learning Engineer', $2,
       'Remote', 'REMOTE', 'FULL_TIME', 'CORE_AI_DATA', 'LANE_ROUTED', 'LANE_ROUTED', 'UNKNOWN')
     RETURNING id::text AS id`,
    [workspaceId, `https://example.test/profile-repair/${crypto.randomUUID()}`],
  );
  const canonicalJobId = canonical.rows[0]?.id;
  if (!canonicalJobId) throw new Error("Profile repair canonical job fixture was not created.");

  const jobVersion = await database.query<{ id: string }>(
    `INSERT INTO job_versions (
       workspace_id, canonical_job_id, version_number, content_hash,
       description_text, observed_at
     ) VALUES ($1, $2, 1, $3, $4, NOW())
     RETURNING id::text AS id`,
    [workspaceId, canonicalJobId, `profile-repair-job-${crypto.randomUUID()}`, COMPLETE_TEST_POSTING_DESCRIPTION],
  );
  const jobVersionId = jobVersion.rows[0]?.id;
  if (!jobVersionId) throw new Error("Profile repair job-version fixture was not created.");
  await database.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $3
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  await insertCompletePostingEvidence(database, {
    workspaceId,
    jobVersionId,
    companyName: "Profile Repair Fixture",
    title: "Machine Learning Engineer",
    sourceUrl: `https://example.test/profile-repair/${canonicalJobId}`,
    description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });

  const identity = await database.query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash,
       deterministic_extractor_version, quoted_extractor_version,
       quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-v1', 'quoted-v1',
       'quoted-prompt-v1', 'normalizer-v1', FALSE)
     RETURNING id::text AS id`,
    [workspaceId, canonicalJobId, `profile-repair-identity-${crypto.randomUUID()}`, `profile-repair-content-${crypto.randomUUID()}`],
  );
  const requirementSet = await database.query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
       revision_number, source_type, created_by_user_id
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED', $5)
     RETURNING id::text AS id`,
    [workspaceId, identity.rows[0]?.id, canonicalJobId, jobVersionId, userId],
  );
  const requirementSetId = requirementSet.rows[0]?.id;
  if (!requirementSetId) throw new Error("Profile repair requirement-set fixture was not created.");
  await database.query(
    `UPDATE job_versions SET active_requirement_set_id = $3
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, jobVersionId, requirementSetId],
  );
  const requirement = await database.query<{ id: string }>(
    `INSERT INTO job_requirements (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       requirement_key, requirement_type, importance, requirement_text,
       extractor_type, extractor_version, confidence, status
     ) VALUES ($1, $2, $3, $4, 'domain-1', 'DOMAIN', 'MUST',
       'Production fraud detection and machine learning systems',
       'DETERMINISTIC', 'deterministic-v1', 1, 'VALIDATED')
     RETURNING id::text AS id`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId],
  );
  await database.query(
    `INSERT INTO requirement_extraction_runs (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       run_type, status, requirements_extracted, completed_at
     ) VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 1, NOW())`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId],
  );
  await database.query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id, canonical_job_id, job_version_id, current_stage, stage_status
     ) VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  expect(requirement.rows[0]?.id).toBeTruthy();
  return { canonicalJobId, jobVersionId };
}

async function seedActiveProfile(): Promise<string> {
  const database = getClient();
  const workspaceId = getContext().workspaceId;
  const profile = await database.query<{ id: string }>(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
     VALUES ($1, $2, 'Profile Repair Fixture') RETURNING id::text AS id`,
    [workspaceId, `profile-repair-${crypto.randomUUID()}`],
  );
  const profileVersion = await database.query<{ id: string }>(
    `INSERT INTO profile_versions (
       workspace_id, candidate_profile_id, version_number, schema_version,
       source_hash, status, effective_at
     ) VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW())
     RETURNING id::text AS id`,
    [workspaceId, profile.rows[0]?.id, `profile-repair-${crypto.randomUUID()}`],
  );
  const profileVersionId = profileVersion.rows[0]?.id;
  if (!profileVersionId) throw new Error("Active profile-version fixture was not created.");
  await database.query(
    `INSERT INTO profile_facts (
       workspace_id, profile_version_id, fact_key, fact_type, statement,
       structured_value, evidence_tier, verification_status, confidentiality
     ) VALUES ($1, $2, 'fraud-domain', 'DOMAIN',
       'Production fraud detection and machine learning systems',
       '{"domains":["FRAUD_DETECTION"]}'::jsonb,
       'PROFESSIONAL_PRODUCTION', 'VERIFIED', 'PRIVATE_REUSABLE')`,
    [workspaceId, profileVersionId],
  );
  return profileVersionId;
}

async function snapshotRepairWrites(taskId: string): Promise<Record<string, unknown>> {
  const database = getClient();
  const workspaceId = getContext().workspaceId;
  const { rows } = await database.query(
    `SELECT
       (SELECT COUNT(*)::int FROM embedding_inputs WHERE workspace_id = $1) AS embedding_inputs,
       (SELECT COUNT(*)::int FROM embedding_batches WHERE workspace_id = $1) AS embedding_batches,
       (SELECT COUNT(*)::int FROM embedding_batch_items WHERE workspace_id = $1) AS embedding_batch_items,
       (SELECT COUNT(*)::int FROM semantic_embeddings WHERE workspace_id = $1) AS semantic_embeddings,
       (SELECT status FROM pipeline_tasks WHERE workspace_id = $1 AND id = $2) AS task_status,
       (SELECT blocked_on FROM pipeline_tasks WHERE workspace_id = $1 AND id = $2) AS task_blocked_on,
       (SELECT repair_action FROM pipeline_tasks WHERE workspace_id = $1 AND id = $2) AS task_repair_action`,
    [workspaceId, taskId],
  );
  return rows[0] ?? {};
}

const workerDependencies = {
  runLaneRouting: vi.fn(async () => ({ routed: 0, deferred: 0, skipped: 0, errors: 0 })),
  runDeterministicMatcher,
} as unknown as PipelineStageWorkerDependencies;

describe.skipIf(skipReal)("profile embedding repair (PostgreSQL)", () => {
  beforeAll(async () => {
    for (const key of ["EMBEDDING_PRIMARY_PROVIDER", "EMBEDDING_PRIMARY_MODEL", "EMBEDDING_PRIMARY_DIMENSIONS"]) {
      savedEmbeddingConfig[key] = process.env[key];
    }
    process.env.EMBEDDING_PRIMARY_PROVIDER = "openai";
    process.env.EMBEDDING_PRIMARY_MODEL = "fixture-profile-repair";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";

    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `profile_repair_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const space = await client.query<{ id: string }>(
      `INSERT INTO embedding_spaces (
         workspace_id, space_key, provider, model, dimensions, normalization,
         distance_metric, is_fallback_space, active
       ) VALUES ($1, $2, 'openai', 'fixture-profile-repair', 4, 'L2',
         'COSINE', FALSE, TRUE)
       RETURNING id::text AS id`,
      [context.workspaceId, `profile-repair-${crypto.randomUUID()}`],
    );
    primarySpaceId = space.rows[0]?.id ?? "";
    if (!primarySpaceId) throw new Error("Primary embedding-space fixture was not created.");
    const distractor = await client.query<{ id: string }>(
      `INSERT INTO embedding_spaces (
         workspace_id, space_key, provider, model, dimensions, normalization,
         distance_metric, is_fallback_space, active, created_at
       ) VALUES ($1, $2, 'gemini', 'gemini-embedding-001', 768, 'L2',
         'COSINE', FALSE, TRUE, NOW() + INTERVAL '1 second')
       RETURNING id::text AS id`,
      [context.workspaceId, `profile-repair-distractor-${crypto.randomUUID()}`],
    );
    distractorSpaceId = distractor.rows[0]?.id ?? "";
    if (!distractorSpaceId) throw new Error("Distractor embedding-space fixture was not created.");
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
    for (const [key, value] of Object.entries(savedEmbeddingConfig)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("blocks a missing-profile route dependency, repairs primary embeddings, and resumes matching", async () => {
    const database = getClient();
    const workspace = getContext();
    const { canonicalJobId, jobVersionId } = await seedJobAndRequirements();
    const routeTask = await enqueuePipelineTask({
      taskType: "ROUTE_LANE",
      taskKey: `ROUTE_LANE:${jobVersionId}:lane_router_v1`,
      payload: { canonical_job_id: canonicalJobId, job_version_id: jobVersionId },
    }, database, { context: workspace });

    const blockedRun = await runPipelineStageTaskWorker(database, {
      context: workspace,
      seed: false,
      reconcileStalePending: false,
      taskTypes: ["ROUTE_LANE"],
      maxTasks: 1,
      heartbeatSeconds: 0,
    }, workerDependencies);
    expect(blockedRun).toMatchObject({ claimed: 1, blocked: 1, failed: 0, deadLettered: 0 });

    const blocked = await database.query<{
      status: string;
      blocked_on: string | null;
      repair_action: string | null;
    }>(`SELECT status, blocked_on, repair_action FROM pipeline_tasks WHERE id = $1`, [routeTask.taskId]);
    expect(blocked.rows[0]).toMatchObject({
      status: "BLOCKED_DEPENDENCY",
      blocked_on: "PROFILE_VERSION_ACTIVE",
      repair_action: "IMPORT_OR_ACTIVATE_PROFILE_AND_REPAIR_EMBEDDINGS",
    });
    const jobBeforeRepair = await database.query<{ processing_state: string }>(
      `SELECT processing_state FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
      [workspace.workspaceId, canonicalJobId],
    );
    expect(jobBeforeRepair.rows[0]?.processing_state).toBe("LANE_ROUTED");

    await seedActiveProfile();
    const beforeDryRun = await snapshotRepairWrites(routeTask.taskId);
    const dryRun = await repairProfileEmbeddings(database, { context: workspace });
    expect(dryRun).toMatchObject({
      status: "PROFILE_FACTS_UNEMBEDDED",
      dryRun: true,
      unembeddedProfileFacts: 1,
      blockedProfileTasks: 1,
      blockedTasksReactivated: 0,
    });
    expect(await snapshotRepairWrites(routeTask.taskId)).toEqual(beforeDryRun);

    const repaired = await repairProfileEmbeddings(database, { context: workspace, apply: true, batchSize: 10 });
    expect(repaired).toMatchObject({
      status: "READY",
      dryRun: false,
      primarySpaceId,
      primarySpace: { provider: "openai", model: "fixture-profile-repair", dimensions: 4 },
      primarySpaceMatches: 1,
      expectedProfileFacts: 1,
      embeddedProfileFacts: 1,
      unembeddedProfileFacts: 0,
      embeddingsPublished: 1,
      blockedTasksReactivated: 1,
    });
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);
    const profileSpaceCounts = await database.query<{ embedding_space_id: string; count: number }>(
      `SELECT se.embedding_space_id::text AS embedding_space_id, COUNT(*)::int AS count
       FROM semantic_embeddings se
       JOIN embedding_inputs ei ON ei.workspace_id = se.workspace_id AND ei.id = se.embedding_input_id
       WHERE se.workspace_id = $1 AND ei.source_type = 'PROFILE_FACT'
       GROUP BY se.embedding_space_id`,
      [workspace.workspaceId],
    );
    expect(profileSpaceCounts.rows).toEqual([{ embedding_space_id: primarySpaceId, count: 1 }]);
    const distractorEmbeddings = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM semantic_embeddings
       WHERE workspace_id = $1 AND embedding_space_id = $2`,
      [workspace.workspaceId, distractorSpaceId],
    );
    expect(distractorEmbeddings.rows[0]?.count).toBe(0);

    await buildEmbeddingInputs(database, 10, {
      context: workspace,
      includeRequirements: true,
      includeProfileFacts: false,
      includeLanePrototypes: false,
      includeJobVersions: false,
    });
    const requirementInputs = await database.query<{ id: string }>(
      `SELECT ei.id::text AS id
       FROM embedding_inputs ei
       JOIN job_requirements jr ON jr.workspace_id = ei.workspace_id AND jr.id = ei.source_id
       WHERE ei.workspace_id = $1 AND ei.source_type = 'JOB_REQUIREMENT' AND ei.is_current = TRUE
         AND jr.job_version_id = $2`,
      [workspace.workspaceId, jobVersionId],
    );
    const requirementBatch = await runEmbeddingBatch(
      primarySpaceId,
      `profile-repair-requirements-${crypto.randomUUID()}`,
      "PRIMARY",
      10,
      requirementInputs.rows.map((row) => row.id),
      undefined,
      undefined,
      database,
      { context: workspace },
    );
    expect(requirementBatch).toMatchObject({ succeeded: 1, failed: 0 });

    const resumedRoute = await runPipelineStageTaskWorker(database, {
      context: workspace,
      seed: false,
      reconcileStalePending: false,
      taskTypes: ["ROUTE_LANE"],
      maxTasks: 1,
      heartbeatSeconds: 0,
    }, workerDependencies);
    expect(resumedRoute).toMatchObject({ claimed: 1, completed: 1, blocked: 0, failed: 0 });
    const matchTask = await database.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status
       FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'MATCH_PROFILE_EVIDENCE'
         AND payload->>'job_version_id' = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [workspace.workspaceId, jobVersionId],
    );
    expect(matchTask.rows[0]?.status).toBe("PENDING");

    const resumedMatch = await runPipelineStageTaskWorker(database, {
      context: workspace,
      seed: false,
      reconcileStalePending: false,
      taskTypes: ["MATCH_PROFILE_EVIDENCE"],
      maxTasks: 1,
      heartbeatSeconds: 0,
    }, workerDependencies);
    expect(resumedMatch).toMatchObject({ claimed: 1, completed: 1, blocked: 0, failed: 0, deadLettered: 0 });
    const completedMatch = await database.query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE id = $1`,
      [matchTask.rows[0]?.id],
    );
    expect(completedMatch.rows[0]?.status).toBe("COMPLETED");
    const persistedMatch = await database.query<{
      processing_state: string;
      profile_match_status: string;
      latest_match_run_id: string | null;
    }>(
      `SELECT processing_state, profile_match_status, latest_match_run_id::text AS latest_match_run_id
       FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
      [workspace.workspaceId, canonicalJobId],
    );
    expect(persistedMatch.rows[0]).toMatchObject({
      processing_state: "MATCHED",
      profile_match_status: "POSITIVE_MATCH",
    });
    expect(persistedMatch.rows[0]?.latest_match_run_id).toBeTruthy();
  }, 60_000);
});
