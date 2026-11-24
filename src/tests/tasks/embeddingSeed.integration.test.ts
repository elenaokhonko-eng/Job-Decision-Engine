import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runEmbeddingBatchWithFallback } from "../../embeddings/batchCoordinator.js";
import { upsertLaneRevision } from "../../lanes/registry.js";
import { loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { runPipelineStageTaskWorker, seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { batchEmbeddingFromPerInput } from "../fixtures/embeddingBatchMock.js";
import { insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// Real PostgreSQL: profile versions, the lane router, the deterministic matcher, the
// recommendation decider, the explanation enqueuer, the seeder and the task worker all run against
// migrated tables. Only the embedding provider is replaced by a deterministic synthetic vector
// function. All jobs, employers and profile facts are synthetic.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const TEST_LANE = "ZEBRA_STRAND_TEST";
const ENV_KEYS = [
  "REQUIREMENTS_ENABLE_QUOTED",
  "EMBEDDING_PRIMARY_PROVIDER",
  "EMBEDDING_PRIMARY_DIMENSIONS",
  "EMBEDDING_FALLBACK_DIMENSIONS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

interface FixtureJob {
  canonicalJobId: string;
  jobVersionId: string;
  requirementSetId: string;
  contentHash: string;
}

if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the ROUTE_LANE seed tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let candidateProfileId = "";
let profileV1 = "";
let profileV2 = "";
let policySnapshotId = "";
const jobs: Record<"embedded" | "needs" | "archived" | "inflight", FixtureJob> = {} as never;

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration test database client is not initialized.");
  return client;
}

function ctx(): WorkspaceContext {
  if (!context) throw new Error("The integration test workspace context is not initialized.");
  return context;
}

// Synthetic, deterministic embedding: zebra text points one way, everything else another.
async function syntheticEmbedding(text: string): Promise<number[]> {
  return text.toLowerCase().includes("zebra") ? [1, 0, 0, 0] : [0, 1, 0, 0];
}

async function publishEmbeddings(): Promise<void> {
  const summary = await runEmbeddingBatchWithFallback(500, db(), { context: ctx() });
  expect(summary.primary.failed).toBe(0);
}

async function insertProfileVersion(versionNumber: number, status: "ACTIVE" | "DRAFT"): Promise<string> {
  const version = await db().query<{ id: string }>(
    `INSERT INTO profile_versions (
       workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at
     ) VALUES ($1, $2, $3, '2.2.0', $4, $5, NOW()) RETURNING id`,
    [ctx().workspaceId, candidateProfileId, versionNumber, `zebra-rematch-profile-v${versionNumber}`, status],
  );
  await db().query(
    `INSERT INTO profile_facts (
       workspace_id, profile_version_id, fact_key, fact_type, statement,
       structured_value, evidence_tier, verification_status
     ) VALUES ($1, $2, 'zebra-platform', 'SKILL',
       'Zebra telemetry platform engineering for production streaming systems',
       '{}'::jsonb, 'PROFESSIONAL_PRODUCTION', 'VERIFIED')`,
    [ctx().workspaceId, version.rows[0].id],
  );
  return version.rows[0].id;
}

async function seedRoutableJob(
  key: string,
  requirementTexts: readonly string[],
  facts: { workplaceType: string; location: string } = { workplaceType: "REMOTE", location: "Remote" },
  requirementStatus = "VALIDATED",
): Promise<FixtureJob> {
  const workspaceId = ctx().workspaceId;
  const description = [
    `About the role: zebra telemetry platform engineer (${key}) at a synthetic fixture employer.`,
    "Responsibilities: build and operate zebra telemetry ingestion services, review designs and support releases.",
    "Requirements: production platform engineering experience with streaming telemetry systems.",
  ].join(" ");
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location_summary, location, workplace_type, employment_type,
       processing_status, processing_state, gate_decision
     ) VALUES ($1, $2, $3, $4, $5, $5, $6, 'PERMANENT', 'PREQUALIFIED', 'PREQUALIFIED', 'PASS')
     RETURNING id`,
    [workspaceId, `Synthetic Zebra Rematch Fixture ${key}`, `Zebra Telemetry Platform Engineer ${key}`,
     `https://example.test/zebra-rematch-${key}`, facts.location, facts.workplaceType],
  );
  const canonicalJobId = canonical.rows[0].id;
  const contentHash = `zebra-rematch-content-${key}`;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text)
     VALUES ($1, $2, 1, $3, $4) RETURNING id`,
    [workspaceId, canonicalJobId, contentHash, description],
  );
  const jobVersionId = version.rows[0].id;
  await db().query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [jobVersionId, workspaceId, canonicalJobId],
  );
  await insertCompletePostingEvidence(db(), {
    workspaceId,
    jobVersionId,
    companyName: `Synthetic Zebra Rematch Fixture ${key}`,
    title: `Zebra Telemetry Platform Engineer ${key}`,
    sourceUrl: `https://example.test/zebra-rematch-${key}`,
    description,
  });

  const identity = await db().query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash,
       deterministic_extractor_version, quoted_extractor_version,
       quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-fixture-v1', 'quoted-fixture-v1',
               'quoted-prompt-fixture-v1', 'normalizer-fixture-v1', FALSE)
     RETURNING id`,
    [workspaceId, canonicalJobId, `zebra-rematch-identity-${key}`, contentHash],
  );
  const requirementSet = await db().query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
    [workspaceId, identity.rows[0].id, canonicalJobId, jobVersionId],
  );
  const requirementSetId = requirementSet.rows[0].id;
  await db().query(
    `UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [requirementSetId, workspaceId, jobVersionId],
  );
  for (const [index, text] of requirementTexts.entries()) {
    await db().query(
      `INSERT INTO job_requirements (
         workspace_id, canonical_job_id, job_version_id, requirement_set_id,
         requirement_key, requirement_type, importance, requirement_text,
         extractor_type, extractor_version, confidence, status
       ) VALUES ($1, $2, $3, $4, $5, 'FUNCTION', 'MUST', $6,
                 'DETERMINISTIC', 'deterministic-fixture-v1', 1, $7)`,
      [workspaceId, canonicalJobId, jobVersionId, requirementSetId, `function-${index + 1}`, text, requirementStatus],
    );
  }
  await db().query(
    `INSERT INTO requirement_extraction_runs (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       run_type, status, requirements_extracted, completed_at
     ) VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', $5, NOW())`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId, requirementTexts.length],
  );
  await db().query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id, canonical_job_id, job_version_id, current_stage, stage_status
     ) VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  return { canonicalJobId, jobVersionId, requirementSetId, contentHash };
}

async function primaryEmbeddingSpaceId(): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `SELECT id::text AS id FROM embedding_spaces
     WHERE workspace_id = $1 AND active = TRUE AND is_fallback_space = FALSE
     ORDER BY created_at ASC, id ASC LIMIT 1`,
    [ctx().workspaceId],
  );
  if (!rows[0]) throw new Error("The fixture expects a published primary embedding space.");
  return rows[0].id;
}



describe.skipIf(skipReal)("PUBLISH_EMBEDDING seed follows the active requirement set", () => {
  const embeddingCalls = { count: 0 };

  beforeAll(async () => {
    process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
    process.env.EMBEDDING_PRIMARY_PROVIDER = "gemini";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = "4";
    const counted = async (text: string) => { embeddingCalls.count += 1; return syntheticEmbedding(text); };
    const agent = await import("../../services/agent.js");
    vi.spyOn(agent, "generateEmbedding").mockImplementation(counted);
    vi.spyOn(agent, "generateEmbeddingWithProvider").mockImplementation(counted as any);
    vi.spyOn(agent, "generateEmbeddingWithProviderAndModel").mockImplementation(counted as any);
    vi.spyOn(agent, "generateEmbeddingsWithProviderAndModel")
      .mockImplementation(batchEmbeddingFromPerInput(counted));

    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `strand_check_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    await loadWorkspaceLanesConfig(db(), { context: ctx(), seedIfEmpty: true });
    await upsertLaneRevision(
      {
        laneKey: TEST_LANE,
        content: {
          schema_version: "2.2.0",
          lane_key: TEST_LANE,
          display_name: "Zebra strand test lane",
          description: "Synthetic lane for zebra telemetry platform engineering fixtures.",
          scope: {
            included_domain_concepts: { any: ["zebra telemetry"] },
            required_function_concepts: { any: ["platform engineer"] },
          },
          prototypes: [{ prototype_key: "zebra-platform", text: "Zebra telemetry platform engineer." }],
          routing: { minimum_semantic_score: 0.35 },
          budget: { maximum_ai_interpretations_per_run: 1 },
        },
      },
      db(),
      { context: ctx(), note: "strand check fixture" },
    );
    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, 'zebra_strand_profile', 'Zebra Strand Profile') RETURNING id`,
      [ctx().workspaceId],
    );
    candidateProfileId = profile.rows[0].id;
    profileV1 = await insertProfileVersion(1, "ACTIVE");
    const requirement = "Zebra telemetry platform engineering experience";
    jobs.embedded = await seedRoutableJob("embedded", [requirement]);
    await publishEmbeddings(); // inputs exist and are published for this job only so far
    jobs.needs = await seedRoutableJob("needs", [requirement]);
    jobs.archived = await seedRoutableJob("archived", [requirement]);
    jobs.inflight = await seedRoutableJob("inflight", [requirement]);
    const run = await db().query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`);
    await db().query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'POSTING_NOT_CONFIRMABLE', archive_age_basis = 'POSTING_LINK_UNVERIFIABLE', archive_reference_at = NOW(), archive_run_id = $2 WHERE id = $1`,
      [jobs.archived.canonicalJobId, run.rows[0]!.id]);
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status) VALUES ($1, 'PUBLISH_EMBEDDING', $2, $3::jsonb, 'PENDING')`,
      [ctx().workspaceId, `PUBLISH_EMBEDDING:${jobs.inflight.jobVersionId}:inflight`, JSON.stringify({ canonical_job_id: jobs.inflight.canonicalJobId, job_version_id: jobs.inflight.jobVersionId })]);
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  const seed = () => seedRecoverablePipelineTasks(db(), {
    context: ctx(), taskTypes: ["PUBLISH_EMBEDDING"], includeTestFixtures: true,
    jobVersionIds: Object.values(jobs).map((job) => job.jobVersionId),
  });
  const embedTasks = async () => (await db().query<{ task_key: string; payload: { job_version_id: string; embedding_requirement_set_id?: string } }>(
    `SELECT task_key, payload FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'PUBLISH_EMBEDDING' AND payload ? 'embedding_requirement_set_id' ORDER BY task_key`,
    [ctx().workspaceId],
  )).rows;

  it("a set whose requirements have no published input is reopened once; embedded, archived and in-flight jobs are skipped", async () => {
    await seed();
    const rows = await embedTasks();
    expect(rows.map((row) => Object.entries(jobs).find(([, j]) => j.jobVersionId === row.payload.job_version_id)?.[0])).toEqual(["needs"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.job_version_id).toBe(jobs.needs.jobVersionId);
    expect(rows[0]!.task_key).toContain(`:embed-${rows[0]!.payload.embedding_requirement_set_id}`);
  });

  it("the same set adds nothing, even after the task completed", async () => {
    await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE workspace_id = $1 AND task_type = 'PUBLISH_EMBEDDING' AND payload ? 'embedding_requirement_set_id'`, [ctx().workspaceId]);
    expect((await seed()).byType.PUBLISH_EMBEDDING?.inserted ?? 0).toBe(0);
    expect(await embedTasks()).toHaveLength(1);
  });

  const workerOptions = {
    seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0, minTimeToStartTaskMs: 0, maxTasks: 100,
  } as const;
  const runEmbeddingTasks = () => runPipelineStageTaskWorker(db(), { ...workerOptions, context: ctx(), taskTypes: ["PUBLISH_EMBEDDING"] });
  const missingInputs = async (jobVersionId: string) => Number((await db().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM job_requirements r JOIN job_versions jv ON jv.id = r.job_version_id AND r.requirement_set_id = jv.active_requirement_set_id
      WHERE r.job_version_id = $1 AND NOT EXISTS (
        SELECT 1 FROM embedding_inputs ei JOIN v_published_semantic_embeddings se ON se.embedding_input_id = ei.id
         WHERE ei.source_type = 'JOB_REQUIREMENT' AND ei.source_id = r.id AND ei.is_current)`, [jobVersionId])).rows[0]!.n);

  // Root cause of the earlier "task already exists": the older PUBLISH_EMBEDDING seed (job-version embeddings)
  // had queued a PENDING task for the same job version, and the seed correctly skips a job with a task in
  // flight (the task embeds the ACTIVE requirement set when it runs). The new set is reopened once that task is done.
  it("a new active requirement set (a re-extraction) reopens the job exactly once, after the in-flight task has run", async () => {
    const workspaceId = ctx().workspaceId;
    // While a task is in flight for the job it is skipped, and it covers the set that is active when it runs.
    expect((await seed()).byType.PUBLISH_EMBEDDING?.inserted ?? 0).toBe(0);
    const ran = await runEmbeddingTasks();
    expect(ran.failed).toBe(0);
    expect(await missingInputs(jobs.needs.jobVersionId)).toBe(0);

    const identity = await db().query<{ id: string }>(
      `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version, quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled)
       VALUES ($1, $2, $3, 'c', 'deterministic-fixture-v2', 'q', 'p', 'n', FALSE) RETURNING id`, [workspaceId, jobs.needs.canonicalJobId, crypto.randomUUID()]);
    const set = await db().query<{ id: string }>(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type) VALUES ($1, $2, $3, $4, 2, 'EXTRACTED') RETURNING id`,
      [workspaceId, identity.rows[0]!.id, jobs.needs.canonicalJobId, jobs.needs.jobVersionId]);
    const newSetId = set.rows[0]!.id;
    await db().query(
      `INSERT INTO job_requirements (workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type, importance, requirement_text, extractor_type, extractor_version, confidence, status)
       VALUES ($1, $2, $3, $4, 'function-1', 'FUNCTION', 'MUST', 'A brand new requirement text', 'DETERMINISTIC', 'deterministic-fixture-v2', 1, 'VALIDATED')`,
      [workspaceId, jobs.needs.canonicalJobId, jobs.needs.jobVersionId, newSetId]);
    await db().query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`, [newSetId, jobs.needs.jobVersionId]);
    expect(await missingInputs(jobs.needs.jobVersionId)).toBe(1);

    expect((await seed()).byType.PUBLISH_EMBEDDING?.inserted).toBe(1);
    const forJob = (await embedTasks()).filter((row) => row.payload.job_version_id === jobs.needs.jobVersionId);
    expect(forJob).toHaveLength(2); // one per requirement set, never two for the same set
    expect(forJob.map((row) => row.payload.embedding_requirement_set_id)).toContain(newSetId);
    // The same new set again adds nothing, whether the task is pending or completed.
    expect((await seed()).byType.PUBLISH_EMBEDDING?.inserted ?? 0).toBe(0);
    expect((await runEmbeddingTasks()).failed).toBe(0);
    expect(await missingInputs(jobs.needs.jobVersionId)).toBe(0);
    expect((await seed()).byType.PUBLISH_EMBEDDING?.inserted ?? 0).toBe(0);
    expect((await embedTasks()).filter((row) => row.payload.job_version_id === jobs.needs.jobVersionId)).toHaveLength(2);
  });

  it("the per-type cap is respected, and a job with a task in flight is skipped on the next pass", async () => {
    const extra = [await seedRoutableJob("cap-1", ["Zebra cap one"]), await seedRoutableJob("cap-2", ["Zebra cap two"]), await seedRoutableJob("cap-3", ["Zebra cap three"])];
    const scoped = extra.map((job) => job.jobVersionId);
    const capped = () => seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["PUBLISH_EMBEDDING"], includeTestFixtures: true, jobVersionIds: scoped, maxSeedPerType: 2,
    });
    const counts = async () => (await embedTasks()).filter((row) => scoped.includes(row.payload.job_version_id)).length;
    // The older job-version seed has its own cap and set-less task keys, so only the set-keyed tasks are counted.
    await capped();
    expect(await counts()).toBe(2);
    await capped();
    expect(await counts()).toBe(3); // the third job is reached; the two with a task in flight were skipped, not duplicated
    await capped();
    expect(await counts()).toBe(3);
  });

  const seedScoped = (versionIds: string[], extra: { maxSeedPerType?: number; includeTestFixtures?: boolean } = {}) =>
    seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["PUBLISH_EMBEDDING"], jobVersionIds: versionIds, includeTestFixtures: extra.includeTestFixtures ?? true, maxSeedPerType: extra.maxSeedPerType });
  const setKeyed = async (versionIds: string[]) => (await embedTasks()).filter((row) => versionIds.includes(row.payload.job_version_id)).length;

  it("requirements the builder never embeds (EXTRACTED, REJECTED) do not make a job a candidate", async () => {
    const remote = { workplaceType: "REMOTE", location: "Remote" };
    const extracted = await seedRoutableJob("status-extracted", ["Zebra extracted only"], remote, "EXTRACTED");
    const rejected = await seedRoutableJob("status-rejected", ["Zebra rejected only"], remote, "REJECTED");
    const ids = [extracted.jobVersionId, rejected.jobVersionId];
    await seedScoped(ids);
    console.log('DBG', JSON.stringify((await db().query(`select task_key, status from pipeline_tasks where payload->>'job_version_id' = ANY($1::text[])`, [ids])).rows), JSON.stringify((await db().query(`select status from job_requirements where job_version_id = ANY($1::uuid[])`, [ids])).rows));
    expect(await setKeyed(ids)).toBe(0);
  });

  it("an attempted set (any task state, failed or completed) leaves the candidate set, so fresh jobs are reached under the cap", async () => {
    const attempted = [await seedRoutableJob("att-1", ["Zebra attempted one"]), await seedRoutableJob("att-2", ["Zebra attempted two"])];
    const attemptedIds = attempted.map((job) => job.jobVersionId);
    await seedScoped(attemptedIds);
    expect(await setKeyed(attemptedIds)).toBe(2);
    // Both attempts end in different non-pending states; neither embedded anything.
    await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE task_key LIKE ANY($1::text[]) AND payload ? 'embedding_requirement_set_id'`, [[`%${attemptedIds[0]}%`]]);
    await db().query(`UPDATE pipeline_tasks SET status = 'DEAD_LETTER' WHERE task_key LIKE ANY($1::text[]) AND payload ? 'embedding_requirement_set_id'`, [[`%${attemptedIds[1]}%`]]);
    await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE payload->>'job_version_id' = ANY($1::text[]) AND status IN ('PENDING', 'RETRY_WAIT')`, [attemptedIds]);
    const fresh = [await seedRoutableJob("fresh-1", ["Zebra fresh one"]), await seedRoutableJob("fresh-2", ["Zebra fresh two"])];
    const freshIds = fresh.map((job) => job.jobVersionId);
    await seedScoped([...attemptedIds, ...freshIds], { maxSeedPerType: 2 });
    expect(await setKeyed(attemptedIds)).toBe(2); // not selected again
    expect(await setKeyed(freshIds)).toBe(2); // the cap went to the fresh jobs
  });

  it("test fixtures are excluded in SQL before the cap unless fixtures are included", async () => {
    const fixture = await seedRoutableJob("fixture", ["Zebra fixture requirement"]);
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1`, [fixture.canonicalJobId]);
    // The fixture is observed first; under a cap of 1 it must not consume the slot before a real job.
    await db().query(`UPDATE job_versions SET observed_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [fixture.jobVersionId]);
    const real = await seedRoutableJob("fixture-real", ["Zebra real behind fixture"]);
    await seedScoped([fixture.jobVersionId, real.jobVersionId], { includeTestFixtures: false, maxSeedPerType: 1 });
    expect(await setKeyed([fixture.jobVersionId])).toBe(0);
    expect(await setKeyed([real.jobVersionId])).toBe(1);
    await seedScoped([fixture.jobVersionId], { includeTestFixtures: true });
    expect(await setKeyed([fixture.jobVersionId])).toBe(1);
  });

  it("after PUBLISH_EMBEDDING completes, a task blocked on the missing embedding resumes and the ROUTE_LANE successor exists", async () => {
    const job = await seedRoutableJob("unblock", ["Zebra unblock requirement"]);
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, blocked_on, repair_action)
       VALUES ($1, 'MATCH_PROFILE_EVIDENCE', $2, $3::jsonb, 'BLOCKED_DEPENDENCY', 'REQUIREMENT_EMBEDDING_MISSING', 'PUBLISH_EMBEDDING')`,
      [ctx().workspaceId, `MATCH_PROFILE_EVIDENCE:${job.jobVersionId}:blocked-fixture`, JSON.stringify({ canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId })]);
    const scoped = [job.jobVersionId];
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["PUBLISH_EMBEDDING"], includeTestFixtures: true, jobVersionIds: scoped });
    expect(await missingInputs(job.jobVersionId)).toBe(1);
    expect((await runEmbeddingTasks()).failed).toBe(0);
    expect(await missingInputs(job.jobVersionId)).toBe(0);
    const blocked = await db().query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE workspace_id = $1 AND task_key = $2`, [ctx().workspaceId, `MATCH_PROFILE_EVIDENCE:${job.jobVersionId}:blocked-fixture`]);
    expect(blocked.rows[0]!.status).toBe("PENDING");
    const route = await db().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'ROUTE_LANE' AND payload->>'job_version_id' = $2`, [ctx().workspaceId, job.jobVersionId]);
    expect(Number(route.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});
