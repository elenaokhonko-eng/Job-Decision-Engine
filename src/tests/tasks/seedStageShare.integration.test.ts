import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import crypto from "crypto";
import pg from "pg";

import { GATE_VERSION } from "../../contracts/version.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runEmbeddingBatchWithFallback } from "../../embeddings/batchCoordinator.js";
import { upsertLaneRevision } from "../../lanes/registry.js";
import { loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { DECIDER_VERSION } from "../../pipeline/deciderVersion.js";
import { DETERMINISTIC_EXTRACTOR_VERSION } from "../../requirements/deterministicExtractors.js";
import { staleStageResults } from "../../tasks/integrityZeroChecks.js";
import {
  PIPELINE_STAGE_TASK_TYPES,
  runPipelineStageTaskWorker,
  seedRecoverablePipelineTasks,
} from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { openAiWorkForSuite, TEST_SCORE_POLICY } from "../fixtures/aiWorkSwitch.js";
import { batchEmbeddingFromPerInput } from "../fixtures/embeddingBatchMock.js";
import { insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// Real PostgreSQL. Seeding runs under the production settings (25 seeds per type, 15 s and 60 s budgets) with a
// simulated network delay on every query, because the fault only shows when the database is far from the worker:
// a seeding that does one round trip per row is cut after its first steps. All jobs and employers are invented.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const LATENCY_MS = Number(process.env.SEED_SIM_LATENCY_MS ?? 180);
/** Jobs processed end to end and then made stale by a version bump; more than the cap of 25. */
const SCORED_JOBS = Number(process.env.SEED_SIM_JOBS ?? 30);
const CAP = 25;
/** Set to also delay the drain's queries (a local measurement; too slow for CI). */
const DRAIN_LATENCY_MS = Number(process.env.SEED_SIM_DRAIN_LATENCY_MS ?? 0);
const TEST_LANE = "ZEBRA_SHARE_TEST";
const ENV_KEYS = [
  "REQUIREMENTS_ENABLE_QUOTED",
  "EMBEDDING_PRIMARY_PROVIDER",
  "EMBEDDING_PRIMARY_DIMENSIONS",
  "EMBEDDING_FALLBACK_DIMENSIONS",
  "SCORING_POLICY",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the seed share tests against its PostgreSQL service.");
}

interface FixtureJob {
  canonicalJobId: string;
  jobVersionId: string;
}

let pool: pg.Pool | undefined;
let workerPool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const scored: FixtureJob[] = [];

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration test database client is not initialized.");
  return client;
}
function ctx(): WorkspaceContext {
  if (!context) throw new Error("The integration test workspace context is not initialized.");
  return context;
}

/** The client as a worker far from its database sees it: every query waits one round trip. */
function distant(target: pg.PoolClient, latencyMs: number, counter?: { queries: number }): pg.PoolClient {
  return new Proxy(target, {
    get(inner, prop) {
      if (prop === "query") {
        return async (...args: unknown[]) => {
          if (counter) counter.queries += 1;
          await new Promise((resolve) => setTimeout(resolve, latencyMs));
          const at = Date.now();
          const out = await (inner.query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (process.env.SEED_SIM_TRACE) console.log(`[trace] ${Date.now() - at} ms ${String(args[0]).replace(/\s+/g, " ").slice(0, 130)}`);
          return out;
        };
      }
      const value = (inner as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

function distantPool(target: pg.Pool, latencyMs: number): pg.Pool {
  return {
    connect: async () => distant(await target.connect(), latencyMs),
  } as unknown as pg.Pool;
}

async function syntheticEmbedding(text: string): Promise<number[]> {
  return text.toLowerCase().includes("zebra") ? [1, 0, 0, 0] : [0, 1, 0, 0];
}

async function publishEmbeddings(): Promise<void> {
  const summary = await runEmbeddingBatchWithFallback(Math.max(2000, SCORED_JOBS * 4), db(), { context: ctx() });
  expect(summary.primary.failed).toBe(0);
}

type SeedState = "PREQUALIFIED" | "RAW_STAGED";

async function insertJob(key: string, options: { state?: SeedState; extracted?: boolean } = {}): Promise<FixtureJob> {
  const workspaceId = ctx().workspaceId;
  const state = options.state ?? "PREQUALIFIED";
  const description = [
    `About the role: zebra telemetry platform engineer (${key}) at an invented fixture employer.`,
    "Responsibilities: build and operate zebra telemetry ingestion services, review designs and support releases.",
    "Requirements: production platform engineering experience with streaming telemetry systems.",
  ].join(" ");
  const company = `Invented Zebra Employer ${key}`;
  const title = `Zebra Telemetry Platform Engineer ${key}`;
  const url = `https://example.test/zebra-share-${key}`;
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url, location_summary, location,
       workplace_type, employment_type, processing_status, processing_state, gate_decision
     ) VALUES ($1, $2, $3, $4, 'Remote', 'Remote', 'REMOTE', 'PERMANENT', $5, $5, 'PASS') RETURNING id`,
    [workspaceId, company, title, url, state],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const contentHash = `zebra-share-content-${key}`;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text)
     VALUES ($1, $2, 1, $3, $4) RETURNING id`,
    [workspaceId, canonicalJobId, contentHash, description],
  );
  const jobVersionId = version.rows[0]!.id;
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  await insertCompletePostingEvidence(db(), { workspaceId, jobVersionId, companyName: company, title, sourceUrl: url, description });
  if (options.extracted === false) return { canonicalJobId, jobVersionId };

  const identity = await db().query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version,
       quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, $5, 'quoted-fixture-v1', 'quoted-prompt-fixture-v1', 'normalizer-fixture-v1', FALSE)
     RETURNING id`,
    [workspaceId, canonicalJobId, `zebra-share-identity-${key}`, contentHash, DETERMINISTIC_EXTRACTOR_VERSION],
  );
  const set = await db().query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
    [workspaceId, identity.rows[0]!.id, canonicalJobId, jobVersionId],
  );
  const setId = set.rows[0]!.id;
  await db().query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`, [setId, jobVersionId]);
  await db().query(
    `INSERT INTO job_requirements (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type,
       importance, requirement_text, extractor_type, extractor_version, confidence, status
     ) VALUES ($1, $2, $3, $4, 'function-1', 'FUNCTION', 'MUST', 'Zebra telemetry platform engineering experience',
               'DETERMINISTIC', $5, 1, 'VALIDATED')`,
    [workspaceId, canonicalJobId, jobVersionId, setId, DETERMINISTIC_EXTRACTOR_VERSION],
  );
  await db().query(
    `INSERT INTO requirement_extraction_runs (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id, run_type, status, requirements_extracted, completed_at
     ) VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 1, NOW())`,
    [workspaceId, canonicalJobId, jobVersionId, setId],
  );
  await db().query(
    `INSERT INTO job_version_pipeline_state (workspace_id, canonical_job_id, job_version_id, current_stage, stage_status)
     VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  return { canonicalJobId, jobVersionId };
}

/** The production worker settings of a scheduled pass. */
const productionPass = (latencyMs = 0) => runPipelineStageTaskWorker(latencyMs ? distantPool(workerPool!, latencyMs) : workerPool!, {
  context: ctx(),
  maxTasks: 300,
  maxSeedPerType: CAP,
  concurrency: 4,
  seedTimeBudgetMs: 15_000,
  includeTestFixtures: false,
  heartbeatSeconds: 60,
});

const taskCounts = async () => Object.fromEntries((await db().query<{ task_type: string; n: number }>(
  `SELECT task_type, COUNT(*)::int AS n FROM pipeline_tasks WHERE workspace_id = $1 AND status = 'PENDING' GROUP BY task_type`,
  [ctx().workspaceId],
)).rows.map((row) => [row.task_type, row.n]));

const clearTasks = () => db().query(`DELETE FROM pipeline_task_attempts WHERE workspace_id = $1`, [ctx().workspaceId])
  .then(() => db().query(`DELETE FROM pipeline_tasks WHERE workspace_id = $1`, [ctx().workspaceId]));

/** A deterministic decision is immutable in production; the fixture rewrites its version to stand for a decider bump. */
async function bumpRuleVersions(): Promise<void> {
  const workspaceId = ctx().workspaceId;
  await db().query(`ALTER TABLE deterministic_decisions DISABLE TRIGGER USER`);
  await db().query(`UPDATE deterministic_decisions SET decider_version = 'recommendation_decider_v0',
            context_fingerprint = 'old-decider-' || id::text WHERE workspace_id = $1`, [workspaceId]);
  await db().query(`ALTER TABLE deterministic_decisions ENABLE TRIGGER USER`);
  await db().query(`UPDATE gate_decisions SET gate_version = 'gate-2000-01.1' WHERE workspace_id = $1`, [workspaceId]);
  // A real matcher policy change: switch to the other scoring policy.
  if (process.env.SCORING_POLICY) delete process.env.SCORING_POLICY;
  else process.env.SCORING_POLICY = "topk_capability_semantic_v1";
}

describe.skipIf(skipReal)("seeding reaches every stage when the database is far away", () => {
  openAiWorkForSuite();

  beforeAll(async () => {
    process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
    process.env.EMBEDDING_PRIMARY_PROVIDER = "gemini";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = "4";
    delete process.env.SCORING_POLICY;
    const agent = await import("../../services/agent.js");
    vi.spyOn(agent, "generateEmbedding").mockImplementation(syntheticEmbedding);
    vi.spyOn(agent, "generateEmbeddingWithProvider").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingWithProviderAndModel").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingsWithProviderAndModel").mockImplementation(batchEmbeddingFromPerInput(syntheticEmbedding));

    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `seed_share_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    workerPool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public`, max: 6 });
    context = await resolveWorkspaceContext(client);

    await loadWorkspaceLanesConfig(db(), { context: ctx(), seedIfEmpty: true });
    await upsertLaneRevision(
      {
        laneKey: TEST_LANE,
        content: {
          schema_version: "2.2.0",
          lane_key: TEST_LANE,
          display_name: "Zebra share test lane",
          description: "Invented lane for zebra telemetry platform engineering fixtures.",
          scope: { included_domain_concepts: { any: ["zebra telemetry"] }, required_function_concepts: { any: ["platform engineer"] } },
          prototypes: [{ prototype_key: "zebra-platform", text: "Zebra telemetry platform engineer." }],
          routing: { minimum_semantic_score: 0.35 },
          budget: { maximum_ai_interpretations_per_run: 1 },
        },
      },
      db(),
      { context: ctx(), note: "seed share fixture" },
    );
    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, 'zebra_share_profile', 'Zebra Share Profile') RETURNING id`,
      [ctx().workspaceId],
    );
    const profileVersion = await db().query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', 'zebra-share-profile-v1', 'ACTIVE', NOW()) RETURNING id`,
      [ctx().workspaceId, profile.rows[0]!.id],
    );
    await db().query(
      `INSERT INTO profile_facts (workspace_id, profile_version_id, fact_key, fact_type, statement, structured_value, evidence_tier, verification_status)
       VALUES ($1, $2, 'zebra-platform', 'SKILL', 'Zebra telemetry platform engineering for production streaming systems',
               '{}'::jsonb, 'PROFESSIONAL_PRODUCTION', 'VERIFIED')`,
      [ctx().workspaceId, profileVersion.rows[0]!.id],
    );

    // Scored jobs, processed by the real stage handlers.
    for (let index = 0; index < SCORED_JOBS; index += 1) {
      const job = await insertJob(`scored-${index}`);
      scored.push(job);
      await db().query(
        `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, $4, 'PASS')`,
        [ctx().workspaceId, job.canonicalJobId, job.jobVersionId, GATE_VERSION],
      );
    }
    await publishEmbeddings();
    for (let pass = 0; pass < 4 + Math.ceil(SCORED_JOBS / CAP) * 2; pass += 1) {
      const run = await productionPass();
      expect(run.failed, JSON.stringify(run.errors.slice(0, 3))).toBe(0);
      if (run.claimed === 0 && run.seeded?.inserted === 0) break;
    }
    const { rows } = await db().query<{ decided: number }>(
      `SELECT COUNT(*)::int AS decided FROM canonical_jobs c
         JOIN deterministic_decisions d ON d.id = c.latest_deterministic_decision_id AND d.decider_version = $2
        WHERE c.workspace_id = $1`,
      [ctx().workspaceId, DECIDER_VERSION],
    );
    expect(rows[0]!.decided).toBe(SCORED_JOBS);
  }, 3_600_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (workerPool) await workerPool.end();
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    if (pool) await pool.end();
  });

  it("after a version bump a pass re-scores every job within ceil(jobs / 25) passes and no stage result stays old", async () => {
    await bumpRuleVersions();
    const stale = async () => (await staleStageResults(db(), ctx().workspaceId));
    const before = await stale();
    expect(before.total).toBeGreaterThanOrEqual(SCORED_JOBS * 3);

    const passes: Array<Record<string, unknown>> = [];
    let remaining = before.total;
    while (remaining > 0 && passes.length < Math.ceil(SCORED_JOBS / CAP) + 3) {
      const run = await productionPass(DRAIN_LATENCY_MS);
      expect(run.failed, JSON.stringify(run.errors.slice(0, 3))).toBe(0);
      remaining = (await stale()).total;
      const secondsPerTask = Object.fromEntries(Object.entries(run.byType).map(([type, stage]) => [type, stage.secondsPerClaimedTask]));
      passes.push({ seeded: run.seeded?.byType, claimed: run.claimed, exit: run.exitReason, durationMs: run.durationMs, secondsPerTask, staleAfter: remaining });
    }
    console.log(`[seed-share] ${SCORED_JOBS} jobs: stale before ${before.total} ${JSON.stringify(before.detail)}, passes ${passes.length}\n${passes.map((pass) => JSON.stringify(pass)).join("\n")}`);
    expect(remaining).toBe(0);
    expect(passes.length).toBeLessThanOrEqual(Math.ceil(SCORED_JOBS / CAP) + 1);
  }, 3_600_000);

  it("with a 180 ms round trip every stage has tasks queued within the 15 s and the 60 s seed budget", async () => {
    const workspaceId = ctx().workspaceId;
    // Work for every seed step on top of the scored jobs (which are made stale again).
    await clearTasks();
    await bumpRuleVersions();
    await db().query(
      `UPDATE job_versions SET availability_status = 'OPEN', availability_verified_at = NOW() - INTERVAL '8 days',
              availability_recheck_at = NOW() - INTERVAL '1 day'
        WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, scored.map((job) => job.jobVersionId)],
    );
    // The fixture lane decides TRACK; the AI enqueue seed takes REVIEW and PRIORITY only. A full cap of them, as in production.
    await db().query(
      `UPDATE canonical_jobs SET recommendation_outcome = 'REVIEW', recommendation_requirement_score = 0.5, recommendation_score_policy = $3
        WHERE workspace_id = $1 AND latest_job_version_id = ANY($2::uuid[])`,
      [workspaceId, scored.map((job) => job.jobVersionId), TEST_SCORE_POLICY],
    );
    for (let index = 0; index < 3; index += 1) {
      await insertJob(`unextracted-${index}`, { state: "RAW_STAGED", extracted: false });
      await insertJob(`routable-${index}`);
    }
    await publishEmbeddings();
    for (let index = 0; index < 3; index += 1) await insertJob(`unembedded-${index}`);
    await db().query(
      `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title,
         description_raw, raw_payload, raw_payload_hash, processing_status)
       VALUES ($1, 'EMPLOYER_WEBSITE', 'zebra-share-pending', 'https://example.test/zebra-share-pending', NOW(), 'Invented Zebra Employer',
         'Zebra Telemetry Platform Engineer', 'x', '{}'::jsonb, $2, 'PENDING')`,
      [workspaceId, crypto.createHash("sha256").update("zebra-share-pending").digest("hex")],
    );

    const expectedTypes = PIPELINE_STAGE_TASK_TYPES.filter((type) => type !== "FETCH_JOB_CONTENT");
    for (const budgetMs of [15_000, 60_000]) {
      await clearTasks();
      const counter = { queries: 0 };
      const startedAt = Date.now();
      const summary = await seedRecoverablePipelineTasks(distant(db(), LATENCY_MS, counter), {
        context: ctx(), maxSeedPerType: CAP, timeBudgetMs: budgetMs,
      });
      const elapsedMs = Date.now() - startedAt;
      const queued = await taskCounts();
      console.log(`[seed-share] budget ${budgetMs} ms, latency ${LATENCY_MS} ms: ${elapsedMs} ms, ${counter.queries} round trips, queued ${JSON.stringify(queued)}`);
      for (const type of expectedTypes) expect(queued[type] ?? 0, `${type} at ${budgetMs} ms`).toBeGreaterThan(0);
      expect(queued.DECIDE_RECOMMENDATION).toBe(Math.min(CAP, SCORED_JOBS));
      expect(queued.MATCH_PROFILE_EVIDENCE).toBeGreaterThanOrEqual(Math.min(CAP, SCORED_JOBS));
      expect(queued.APPLY_HARD_GATES).toBeGreaterThanOrEqual(Math.min(CAP, SCORED_JOBS));
      expect(summary.inserted).toBe(Object.values(queued).reduce((sum, n) => sum + n, 0));
      expect(elapsedMs).toBeLessThan(budgetMs);
      expect(summary.timeBudgetExceeded).toBe(false);
    }
  }, 600_000);

  it("work already queued takes no slot of the cap, and blocked, gate-superseded and decider tasks are still reopened", async () => {
    await clearTasks();
    const seed = () => seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], maxSeedPerType: 2, timeBudgetMs: 60_000,
    });
    const decideTasks = async () => (await db().query<{ id: string; status: string; job: string }>(
      `SELECT id::text AS id, status, payload->>'job_version_id' AS job FROM pipeline_tasks
        WHERE workspace_id = $1 AND task_type = 'DECIDE_RECOMMENDATION' ORDER BY created_at, id`,
      [ctx().workspaceId],
    )).rows;

    expect((await seed()).byType.DECIDE_RECOMMENDATION).toEqual({ inserted: 2, existing: 0 });
    // The two oldest jobs are already queued: the next two are seeded, not the same two again.
    expect((await seed()).byType.DECIDE_RECOMMENDATION).toEqual({ inserted: 2, existing: 2 });
    const four = await decideTasks();
    expect(new Set(four.map((task) => task.job)).size).toBe(4);

    await db().query(`UPDATE pipeline_tasks SET status = 'BLOCKED_DEPENDENCY', blocked_on = 'MATCH_PROFILE_EVIDENCE' WHERE id = $1`, [four[0]!.id]);
    await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW(), repair_action = 'SUPERSEDED_BY_GATE_OUTCOME' WHERE id = $1`, [four[1]!.id]);
    // A decider reassessment that completed without stamping a decision under the current version.
    await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`, [four[2]!.id]);
    const reopened = await seed();
    const after = await decideTasks();
    for (const task of [four[0]!, four[1]!]) {
      expect(after.find((row) => row.id === task.id)?.status).toBe("PENDING");
    }
    // The two reopened tasks took the two slots; the next pass reaches the third.
    expect(reopened.byType.DECIDE_RECOMMENDATION?.inserted).toBe(0);
    await seed();
    expect((await decideTasks()).find((row) => row.id === four[2]!.id)?.status).toBe("PENDING");
  }, 180_000);
});
