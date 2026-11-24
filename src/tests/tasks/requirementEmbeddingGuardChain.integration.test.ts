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
import { moveJobToManualReviewForEmbeddings, runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
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

async function seedJobAndRequirements(requirementCount: number): Promise<{ canonicalJobId: string; jobVersionId: string }> {
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
  for (let index = 0; index < requirementCount; index += 1) {
    await database.query(
      `INSERT INTO job_requirements (
         workspace_id, canonical_job_id, job_version_id, requirement_set_id,
         requirement_key, requirement_type, importance, requirement_text,
         extractor_type, extractor_version, confidence, status
       ) VALUES ($1, $2, $3, $4, $5, 'DOMAIN', 'MUST', $6, 'DETERMINISTIC', 'deterministic-v1', 1, 'VALIDATED')`,
      [workspaceId, canonicalJobId, jobVersionId, requirementSetId, `domain-${index + 1}`, `Production fraud detection and machine learning systems ${index + 1}`],
    );
  }
  await database.query(
    `INSERT INTO requirement_extraction_runs (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       run_type, status, requirements_extracted, completed_at
     ) VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', $5, NOW())`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId, requirementCount],
  );
  await database.query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id, canonical_job_id, job_version_id, current_stage, stage_status
     ) VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
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


/** Publish embeddings for up to `limit` of the job's requirements that have none (simulates the embedding provider). */
async function publishRequirementEmbeddings(workspace: WorkspaceContext, jobVersionId: string, limit: number): Promise<number> {
  const database = getClient();
  await buildEmbeddingInputs(database, 100, {
    context: workspace, includeRequirements: true, includeProfileFacts: true, includeLanePrototypes: false, includeJobVersions: false,
  });
  const pending = await database.query<{ id: string }>(
    `SELECT ei.id::text AS id
       FROM embedding_inputs ei
       JOIN job_requirements jr ON jr.workspace_id = ei.workspace_id AND jr.id = ei.source_id
      WHERE ei.workspace_id = $1 AND ei.source_type = 'JOB_REQUIREMENT' AND ei.is_current = TRUE AND jr.job_version_id = $2
        AND NOT EXISTS (SELECT 1 FROM semantic_embeddings se WHERE se.embedding_input_id = ei.id AND se.embedding_space_id = $3)
      ORDER BY jr.requirement_key LIMIT $4`,
    [workspace.workspaceId, jobVersionId, primarySpaceId, limit],
  );
  if (pending.rows.length === 0) return 0;
  const result = await runEmbeddingBatch(
    primarySpaceId, `chain-requirements-${crypto.randomUUID()}`, "PRIMARY", 100,
    pending.rows.map((row) => row.id), undefined, undefined, database, { context: workspace },
  );
  return result.succeeded;
}

async function publishProfileFactEmbeddings(workspace: WorkspaceContext): Promise<void> {
  const database = getClient();
  await buildEmbeddingInputs(database, 100, {
    context: workspace, includeRequirements: false, includeProfileFacts: true, includeLanePrototypes: false, includeJobVersions: false,
  });
  const inputs = await database.query<{ id: string }>(
    `SELECT id::text AS id FROM embedding_inputs WHERE workspace_id = $1 AND source_type = 'PROFILE_FACT' AND is_current = TRUE
       AND NOT EXISTS (SELECT 1 FROM semantic_embeddings se WHERE se.embedding_input_id = embedding_inputs.id AND se.embedding_space_id = $2)`,
    [workspace.workspaceId, primarySpaceId],
  );
  if (inputs.rows.length === 0) return;
  await runEmbeddingBatch(primarySpaceId, `chain-facts-${crypto.randomUUID()}`, "PRIMARY", 100, inputs.rows.map((row) => row.id), undefined, undefined, database, { context: workspace });
}

async function publishJobVersionEmbedding(workspace: WorkspaceContext, jobVersionId: string): Promise<void> {
  const database = getClient();
  await buildEmbeddingInputs(database, 100, {
    context: workspace, includeRequirements: false, includeProfileFacts: false, includeLanePrototypes: false, includeJobVersions: true,
  });
  const inputs = await database.query<{ id: string }>(
    `SELECT id::text AS id FROM embedding_inputs ei
      WHERE ei.workspace_id = $1 AND ei.source_type = 'JOB_VERSION' AND ei.source_id = $2::uuid AND ei.is_current = TRUE
        AND NOT EXISTS (SELECT 1 FROM semantic_embeddings se WHERE se.embedding_input_id = ei.id AND se.embedding_space_id = $3)`,
    [workspace.workspaceId, jobVersionId, primarySpaceId],
  );
  if (inputs.rows.length === 0) return;
  await runEmbeddingBatch(primarySpaceId, `chain-jobversion-${crypto.randomUUID()}`, "PRIMARY", 100, inputs.rows.map((row) => row.id), undefined, undefined, database, { context: workspace });
}

function dependenciesPublishing(workspace: WorkspaceContext, jobVersionId: string, perRound: number): PipelineStageWorkerDependencies {
  return {
    runLaneRouting: vi.fn(async () => ({ routed: 0, deferred: 0, skipped: 0, errors: 0 })),
    runDeterministicMatcher,
    runEmbeddingBatchWithFallback: vi.fn(async () => {
      await publishJobVersionEmbedding(workspace, jobVersionId);
      const succeeded = await publishRequirementEmbeddings(workspace, jobVersionId, perRound);
      return {
        seededSpaces: { primarySpaceId, fallbackSpaceId: primarySpaceId },
        inputBuild: { inserted: 0, fromRequirements: 0, fromProfileFacts: 0 },
        primary: { succeeded, failed: 0, processed: succeeded, failedInputIds: [], rateLimited: 0 },
      } as never;
    }),
  } as unknown as PipelineStageWorkerDependencies;
}

async function enqueueMatchTask(workspace: WorkspaceContext, canonicalJobId: string, jobVersionId: string, profileVersionId: string): Promise<string> {
  const result = await enqueuePipelineTask({
    taskType: "MATCH_PROFILE_EVIDENCE",
    taskKey: `MATCH_PROFILE_EVIDENCE:${jobVersionId}:deterministic_matcher_v1:${profileVersionId}`,
    payload: { canonical_job_id: canonicalJobId, job_version_id: jobVersionId, profile_version_id: profileVersionId },
  }, getClient(), { context: workspace });
  return result.taskId;
}

async function runWorker(workspace: WorkspaceContext, taskType: "MATCH_PROFILE_EVIDENCE" | "PUBLISH_EMBEDDING", dependencies: PipelineStageWorkerDependencies) {
  return runPipelineStageTaskWorker(getClient(), {
    context: workspace, seed: false, reconcileStalePending: false, taskTypes: [taskType], maxTasks: 1, heartbeatSeconds: 0,
  }, dependencies);
}

async function taskRow(taskId: string) {
  return (await getClient().query<{ status: string; blocked_on: string | null; repair_action: string | null; last_error: string | null }>(
    `SELECT status, blocked_on, repair_action, last_error FROM pipeline_tasks WHERE id = $1`, [taskId])).rows[0]!;
}

async function jobRow(canonicalJobId: string) {
  return (await getClient().query<{ processing_state: string; gate_decision: string | null; latest_match_run_id: string | null }>(
    `SELECT processing_state, gate_decision, latest_match_run_id::text AS latest_match_run_id FROM canonical_jobs WHERE id = $1`, [canonicalJobId])).rows[0]!;
}

describe.skipIf(skipReal)("requirement-embedding guard: worker chain (PostgreSQL)", () => {
  beforeAll(async () => {
    for (const key of ["EMBEDDING_PRIMARY_PROVIDER", "EMBEDDING_PRIMARY_MODEL", "EMBEDDING_PRIMARY_DIMENSIONS"]) savedEmbeddingConfig[key] = process.env[key];
    process.env.EMBEDDING_PRIMARY_PROVIDER = "openai";
    process.env.EMBEDDING_PRIMARY_MODEL = "fixture-guard-chain";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `guard_chain_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const space = await client.query<{ id: string }>(
      `INSERT INTO embedding_spaces (workspace_id, space_key, provider, model, dimensions, normalization, distance_metric, is_fallback_space, active)
       VALUES ($1, $2, 'openai', 'fixture-guard-chain', 4, 'L2', 'COSINE', FALSE, TRUE) RETURNING id::text AS id`,
      [context.workspaceId, `guard-chain-${crypto.randomUUID()}`],
    );
    primarySpaceId = space.rows[0]?.id ?? "";
    await seedActiveProfile();
    await publishProfileFactEmbeddings(context);
  }, 120_000);

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

  async function activeProfileId(): Promise<string> {
    return (await getClient().query<{ id: string }>(`SELECT id::text AS id FROM profile_versions WHERE workspace_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [getContext().workspaceId])).rows[0]!.id;
  }

  it("partial embeddings: the MATCH task blocks, the repair publishes, the MATCH task is reactivated and matches with a COMPLETED run", async () => {
    const workspace = getContext();
    const { canonicalJobId, jobVersionId } = await seedJobAndRequirements(2);
    await publishRequirementEmbeddings(workspace, jobVersionId, 1);
    const matchTaskId = await enqueueMatchTask(workspace, canonicalJobId, jobVersionId, await activeProfileId());
    const deps = dependenciesPublishing(workspace, jobVersionId, 10);

    const blocked = await runWorker(workspace, "MATCH_PROFILE_EVIDENCE", deps);
    expect(blocked).toMatchObject({ claimed: 1, blocked: 1, failed: 0, deadLettered: 0 });
    expect(await taskRow(matchTaskId)).toMatchObject({ status: "BLOCKED_DEPENDENCY", repair_action: "PUBLISH_EMBEDDING" });
    expect((await taskRow(matchTaskId)).blocked_on).toContain("REQUIREMENT_EMBEDDING_MISSING");
    expect((await jobRow(canonicalJobId)).latest_match_run_id).toBeNull();
    expect((await getClient().query(`SELECT id FROM match_runs WHERE canonical_job_id = $1`, [canonicalJobId])).rows).toEqual([]);

    const publish = await runWorker(workspace, "PUBLISH_EMBEDDING", deps);
    expect(JSON.stringify(publish.errors)).toBe("[]");
    expect(publish).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect((await taskRow(matchTaskId)).status).toBe("PENDING");

    expect(await runWorker(workspace, "MATCH_PROFILE_EVIDENCE", deps)).toMatchObject({ claimed: 1, completed: 1, blocked: 0, failed: 0 });
    const run = await getClient().query(`SELECT status, requirement_count FROM match_runs WHERE canonical_job_id = $1`, [canonicalJobId]);
    expect(run.rows).toEqual([{ status: "COMPLETED", requirement_count: 2 }]);
    expect((await jobRow(canonicalJobId)).processing_state).toBe("MATCHED");
  }, 120_000);

  it("still partial after every round: re-blocks, three rounds without progress, then NEEDS_MANUAL_REVIEW (never HARD_REJECTED)", async () => {
    const workspace = getContext();
    const { canonicalJobId, jobVersionId } = await seedJobAndRequirements(2);
    await publishRequirementEmbeddings(workspace, jobVersionId, 1);
    const matchTaskId = await enqueueMatchTask(workspace, canonicalJobId, jobVersionId, await activeProfileId());
    const deps = dependenciesPublishing(workspace, jobVersionId, 0);

    for (let round = 1; round <= 3; round += 1) {
      expect(await runWorker(workspace, "MATCH_PROFILE_EVIDENCE", deps)).toMatchObject({ blocked: 1, failed: 0 });
      expect((await taskRow(matchTaskId)).status).toBe("BLOCKED_DEPENDENCY");
      expect(await runWorker(workspace, "PUBLISH_EMBEDDING", deps)).toMatchObject({ completed: 1 });
      expect((await taskRow(matchTaskId)).status).toBe("PENDING");
    }
    const exhausted = await runWorker(workspace, "MATCH_PROFILE_EVIDENCE", deps);
    expect(exhausted.blocked).toBe(0);
    const job = await jobRow(canonicalJobId);
    expect(job.processing_state).toBe("NEEDS_MANUAL_REVIEW");
    expect(job.gate_decision).not.toBe("HARD_REJECT");
    expect((await taskRow(matchTaskId)).last_error ?? "").toContain("REQUIREMENT_EMBEDDING_REPAIR_EXHAUSTED");
    expect((await getClient().query(`SELECT id FROM match_runs WHERE canonical_job_id = $1`, [canonicalJobId])).rows).toEqual([]);
  }, 180_000);

  it("a repair round that embedded something resets the counter: a job with many requirements finishes after more than three rounds", async () => {
    const workspace = getContext();
    const { canonicalJobId, jobVersionId } = await seedJobAndRequirements(9);
    await publishRequirementEmbeddings(workspace, jobVersionId, 1);
    const matchTaskId = await enqueueMatchTask(workspace, canonicalJobId, jobVersionId, await activeProfileId());
    const deps = dependenciesPublishing(workspace, jobVersionId, 2);

    let rounds = 0;
    for (; rounds < 8; rounds += 1) {
      const result = await runWorker(workspace, "MATCH_PROFILE_EVIDENCE", deps);
      if (result.completed === 1) break;
      expect(result).toMatchObject({ blocked: 1, failed: 0 });
      expect(await runWorker(workspace, "PUBLISH_EMBEDDING", deps)).toMatchObject({ completed: 1 });
      expect((await taskRow(matchTaskId)).status).toBe("PENDING");
    }
    expect(rounds).toBeGreaterThan(3);
    expect((await jobRow(canonicalJobId)).processing_state).toBe("MATCHED");
    const run = await getClient().query(`SELECT status, requirement_count FROM match_runs WHERE canonical_job_id = $1`, [canonicalJobId]);
    expect(run.rows).toEqual([{ status: "COMPLETED", requirement_count: 9 }]);
  }, 240_000);

  it("exhausted repair moves only matchable states to NEEDS_MANUAL_REVIEW: queued, running and evaluated jobs are left untouched", async () => {
    const workspace = getContext();
    const untouched = ["QUEUED_FOR_AI", "EVALUATING", "EVALUATED"];
    for (const state of untouched) {
      const { canonicalJobId, jobVersionId } = await seedJobAndRequirements(1);
      await getClient().query(`UPDATE canonical_jobs SET processing_state = $2, processing_status = $2 WHERE id = $1`, [canonicalJobId, state]);
      await moveJobToManualReviewForEmbeddings(getClient(), workspace, jobVersionId, 3);
      const job = (await getClient().query<{ processing_state: string; rejection_reason: string | null }>(
        `SELECT processing_state, rejection_reason FROM canonical_jobs WHERE id = $1`, [canonicalJobId])).rows[0]!;
      expect(job.processing_state).toBe(state);
      expect(job.rejection_reason).toBeNull();
    }
    for (const state of ["LANE_ROUTED", "MATCHED"]) {
      const { canonicalJobId, jobVersionId } = await seedJobAndRequirements(1);
      await getClient().query(`UPDATE canonical_jobs SET processing_state = $2, processing_status = $2 WHERE id = $1`, [canonicalJobId, state]);
      await moveJobToManualReviewForEmbeddings(getClient(), workspace, jobVersionId, 3);
      const job = (await getClient().query<{ processing_state: string; rejection_reason: string | null }>(
        `SELECT processing_state, rejection_reason FROM canonical_jobs WHERE id = $1`, [canonicalJobId])).rows[0]!;
      expect(job.processing_state).toBe("NEEDS_MANUAL_REVIEW");
      expect(job.rejection_reason).toContain("REQUIREMENT_EMBEDDING_REPAIR_EXHAUSTED");
    }
  }, 120_000);
});
