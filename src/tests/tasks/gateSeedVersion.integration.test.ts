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
import { GATE_VERSION } from "../../contracts/version.js";
import { seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
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
const jobs: Record<"stale" | "current" | "archived" | "rawStaged", FixtureJob> = {} as never;

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
                 'DETERMINISTIC', 'deterministic-fixture-v1', 1, 'VALIDATED')`,
      [workspaceId, canonicalJobId, jobVersionId, requirementSetId, `function-${index + 1}`, text],
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



describe.skipIf(skipReal)("APPLY_HARD_GATES seed follows the gate version", () => {
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
    jobs.stale = await seedRoutableJob("stale", [requirement]);
    jobs.current = await seedRoutableJob("current", [requirement]);
    jobs.archived = await seedRoutableJob("archived", [requirement]);
    jobs.rawStaged = await seedRoutableJob("raw-staged", [requirement]);
    const gated = async (job: FixtureJob, version: string) => db().query(
      `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, $4, 'PASS')`,
      [ctx().workspaceId, job.canonicalJobId, job.jobVersionId, version],
    );
    await gated(jobs.stale, "gate-old-version");
    await gated(jobs.current, GATE_VERSION);
    await gated(jobs.archived, "gate-old-version");
    await gated(jobs.rawStaged, "gate-old-version");
    await db().query(`UPDATE canonical_jobs SET processing_state = 'RAW_STAGED', processing_status = 'RAW_STAGED' WHERE id = $1`, [jobs.rawStaged.canonicalJobId]);
    const run = await db().query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`,
    );
    await db().query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'POSTING_NOT_CONFIRMABLE', archive_age_basis = 'POSTING_LINK_UNVERIFIABLE',
              archive_reference_at = NOW(), archive_run_id = $2 WHERE id = $1`,
      [jobs.archived.canonicalJobId, run.rows[0]!.id],
    );
    // Embeddings for the jobs, requirements and lane prototypes exist before the re-gate, as in production.
    await publishEmbeddings();
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
    context: ctx(), taskTypes: ["APPLY_HARD_GATES"], includeTestFixtures: true,
    jobVersionIds: Object.values(jobs).map((job) => job.jobVersionId),
  });
  const gateTasks = async () => (await db().query<{ task_key: string; payload: { job_version_id: string; force_policy_recalculation?: boolean } }>(
    `SELECT task_key, payload FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'APPLY_HARD_GATES' ORDER BY task_key`,
    [ctx().workspaceId],
  )).rows;

  it("first deploy: only the live job gated under an older gate version is reopened, once, with a forced recalculation", async () => {
    // The raw-staged job is the normal first-gate seed's, not this one: it is counted separately.
    const first = await seed();
    const rows = await gateTasks();
    const forStale = rows.filter((row) => row.payload.job_version_id === jobs.stale.jobVersionId);
    expect(forStale).toHaveLength(1);
    expect(forStale[0]!.payload.force_policy_recalculation).toBe(true);
    expect(forStale[0]!.task_key).toContain(`gate-${GATE_VERSION}`);
    expect(rows.filter((row) => row.payload.job_version_id === jobs.current.jobVersionId)).toHaveLength(0);
    expect(rows.filter((row) => row.payload.job_version_id === jobs.archived.jobVersionId)).toHaveLength(0);
    expect(first.byType.APPLY_HARD_GATES?.inserted).toBeGreaterThanOrEqual(1);
  });

  it("the same gate version enqueues nothing more, even after the task completed", async () => {
    const before = (await gateTasks()).length;
    await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE workspace_id = $1 AND task_type = 'APPLY_HARD_GATES'`, [ctx().workspaceId]);
    await seed();
    expect((await gateTasks()).length).toBe(before);
  });

  it("a job whose latest gate result is under the old version is reopened again only by a new gate version", async () => {
    // The current job was gated under the current version, so it stays out; after a downgrade it is reopened once.
    await db().query(`UPDATE gate_decisions SET gate_version = 'gate-older-than-current' WHERE canonical_job_id = $1`, [jobs.current.canonicalJobId]);
    await seed();
    const rows = await gateTasks();
    expect(rows.filter((row) => row.payload.job_version_id === jobs.current.jobVersionId)).toHaveLength(1);
  });
});
