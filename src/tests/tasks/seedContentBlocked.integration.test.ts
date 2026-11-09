import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runEmbeddingBatchWithFallback } from "../../embeddings/batchCoordinator.js";
import { seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { batchEmbeddingFromPerInput } from "../fixtures/embeddingBatchMock.js";
import { insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// Real PostgreSQL: the seeder runs its production queries against migrated tables. Two synthetic
// prequalified jobs compete for one seed slot per task type; the older one is blocked on missing
// posting content. Only the embedding provider is replaced by a deterministic synthetic vector.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const ENV_KEYS = ["EMBEDDING_PRIMARY_PROVIDER", "EMBEDDING_PRIMARY_DIMENSIONS", "EMBEDDING_FALLBACK_DIMENSIONS"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const versions: Record<"blocked" | "free", string> = { blocked: "", free: "" };

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration test database client is not initialized.");
  return client;
}

function ctx(): WorkspaceContext {
  if (!context) throw new Error("The integration test workspace context is not initialized.");
  return context;
}

async function syntheticEmbedding(): Promise<number[]> {
  return [1, 0, 0, 0];
}

async function seedPrequalifiedJob(key: string, observedAt: string): Promise<string> {
  const workspaceId = ctx().workspaceId;
  const title = `Synthetic Seed Slot Engineer ${key}`;
  const url = `https://example.test/seed-slot-${key}`;
  const description = `About the role: synthetic seed slot platform engineer (${key}). Requirements: platform engineering.`;
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location_summary, workplace_type, employment_type,
       processing_status, processing_state, gate_decision
     ) VALUES ($1, $2, $3, $4, 'Remote', 'REMOTE', 'PERMANENT', 'PREQUALIFIED', 'PREQUALIFIED', 'PASS')
     RETURNING id`,
    [workspaceId, `Synthetic Seed Slot Fixture ${key}`, title, url],
  );
  const canonicalJobId = canonical.rows[0].id;
  const contentHash = `seed-slot-content-${key}`;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, 1, $3, $4, $5::timestamptz) RETURNING id`,
    [workspaceId, canonicalJobId, contentHash, description, observedAt],
  );
  const jobVersionId = version.rows[0].id;
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  await insertCompletePostingEvidence(db(), {
    workspaceId,
    jobVersionId,
    companyName: `Synthetic Seed Slot Fixture ${key}`,
    title,
    sourceUrl: url,
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
    [workspaceId, canonicalJobId, `seed-slot-identity-${key}`, contentHash],
  );
  const requirementSet = await db().query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
    [workspaceId, identity.rows[0].id, canonicalJobId, jobVersionId],
  );
  await db().query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`, [requirementSet.rows[0].id, jobVersionId]);
  await db().query(
    `INSERT INTO requirement_extraction_runs (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       run_type, status, requirements_extracted, completed_at
     ) VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 0, NOW())`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSet.rows[0].id],
  );
  await db().query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id, canonical_job_id, job_version_id, current_stage, stage_status
     ) VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  return jobVersionId;
}

async function tasksFor(taskType: string, jobVersionId: string) {
  const { rows } = await db().query<{ status: string; blocked_on: string | null }>(
    `SELECT status, blocked_on FROM pipeline_tasks
     WHERE workspace_id = $1 AND task_type = $2 AND payload->>'job_version_id' = $3`,
    [ctx().workspaceId, taskType, jobVersionId],
  );
  return rows;
}

async function blockOnJobContent(taskType: string, jobVersionId: string): Promise<void> {
  const updated = await db().query(
    `UPDATE pipeline_tasks SET status = 'BLOCKED_DEPENDENCY', blocked_on = 'JOB_CONTENT'
     WHERE workspace_id = $1 AND task_type = $2 AND payload->>'job_version_id' = $3`,
    [ctx().workspaceId, taskType, jobVersionId],
  );
  expect(updated.rowCount).toBe(1);
}

async function seedOneSlot(taskType: "EXTRACT_QUOTED_REQUIREMENTS" | "PUBLISH_EMBEDDING" | "ROUTE_LANE") {
  const summary = await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: [taskType], maxSeedPerType: 1 });
  return summary.byType[taskType];
}

describe.skipIf(skipReal)("seeding skips job versions blocked on missing posting content", () => {
  beforeAll(async () => {
    process.env.EMBEDDING_PRIMARY_PROVIDER = "gemini";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = "4";
    const agent = await import("../../services/agent.js");
    vi.spyOn(agent, "generateEmbedding").mockImplementation(syntheticEmbedding);
    vi.spyOn(agent, "generateEmbeddingWithProvider").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingWithProviderAndModel").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingsWithProviderAndModel").mockImplementation(batchEmbeddingFromPerInput(syntheticEmbedding));

    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `seed_content_blocked_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    // The blocked job is older, so without the exclusion it is selected first for the only slot.
    versions.blocked = await seedPrequalifiedJob("blocked", "2026-10-01T00:00:00Z");
    versions.free = await seedPrequalifiedJob("free", "2026-10-02T00:00:00Z");
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

  it.each(["EXTRACT_QUOTED_REQUIREMENTS", "PUBLISH_EMBEDDING"] as const)("gives the %s slot to the job that can progress", async (taskType) => {
    expect(await seedOneSlot(taskType)).toEqual({ inserted: 1, existing: 0 });
    expect(await tasksFor(taskType, versions.free)).toEqual([]);
    await blockOnJobContent(taskType, versions.blocked);

    expect(await seedOneSlot(taskType)).toEqual({ inserted: 1, existing: 0 });
    expect(await tasksFor(taskType, versions.blocked)).toEqual([{ status: "BLOCKED_DEPENDENCY", blocked_on: "JOB_CONTENT" }]);
    expect(await tasksFor(taskType, versions.free)).toEqual([{ status: "PENDING", blocked_on: null }]);
  });

  it("gives the ROUTE_LANE slot to the job that can progress", async () => {
    const embedded = await runEmbeddingBatchWithFallback(500, db(), { context: ctx() });
    expect(embedded.primary.failed).toBe(0);

    expect(await seedOneSlot("ROUTE_LANE")).toEqual({ inserted: 1, existing: 0 });
    expect(await tasksFor("ROUTE_LANE", versions.free)).toEqual([]);
    await blockOnJobContent("ROUTE_LANE", versions.blocked);

    expect(await seedOneSlot("ROUTE_LANE")).toEqual({ inserted: 1, existing: 0 });
    expect(await tasksFor("ROUTE_LANE", versions.blocked)).toEqual([{ status: "BLOCKED_DEPENDENCY", blocked_on: "JOB_CONTENT" }]);
    expect(await tasksFor("ROUTE_LANE", versions.free)).toEqual([{ status: "PENDING", blocked_on: null }]);
  });
});
