import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

const { generateEmbeddingMock } = vi.hoisted(() => ({
  // Deterministic fixture vector derived from the input text (never random):
  // the same text always maps to the same unit vector, so routing and matching
  // are reproducible.
  generateEmbeddingMock: vi.fn(async (text: string) => {
    const digest = crypto.createHash("sha256").update(text).digest();
    const raw = [0, 1, 2, 3].map((index) => 1 + digest[index] / 255);
    const norm = Math.sqrt(raw.reduce((total, value) => total + value * value, 0));
    return raw.map((value) => value / norm);
  }),
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
import { loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { archivedJobForPipelineTask } from "../../tasks/jobArchiveGuard.js";
import { CLAIM_PIPELINE_TASKS_SQL, claimPipelineTasks, enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageTaskType } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION } from "../fixtures/completePostingEvidence.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const PROFILE_FACTS = 60;
const JOBS = 6;

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const savedEnv: Record<string, string | undefined> = {};
const queryLog: string[] = [];
let counting = false;

function db(): pg.PoolClient {
  if (!client) throw new Error("Worker throughput client is not initialized.");
  return client;
}

function workspace(): WorkspaceContext {
  if (!context) throw new Error("Worker throughput workspace is not initialized.");
  return context;
}

async function countQueries<T>(action: () => Promise<T>): Promise<{ result: T; queries: string[] }> {
  queryLog.length = 0;
  counting = true;
  try {
    const result = await action();
    return { result, queries: [...queryLog] };
  } finally {
    counting = false;
  }
}

async function seedProfile(): Promise<void> {
  const profile = await db().query<{ id: string }>(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
     VALUES ($1, $2, 'Throughput Fixture') RETURNING id::text AS id`,
    [workspace().workspaceId, `throughput-${crypto.randomUUID()}`],
  );
  const version = await db().query<{ id: string }>(
    `INSERT INTO profile_versions (
       workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at
     ) VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id::text AS id`,
    [workspace().workspaceId, profile.rows[0]?.id, `throughput-${crypto.randomUUID()}`],
  );
  await db().query(
    `INSERT INTO profile_facts (
       workspace_id, profile_version_id, fact_key, fact_type, statement,
       structured_value, evidence_tier, verification_status, confidentiality
     )
     SELECT $1, $2, 'skill-' || n, 'SKILL', 'Production machine learning engineering skill ' || n,
            '{"skills":["PYTHON"]}'::jsonb, 'PROFESSIONAL_PRODUCTION', 'VERIFIED', 'PRIVATE_REUSABLE'
     FROM generate_series(1, $3::int) AS n`,
    [workspace().workspaceId, version.rows[0]?.id, PROFILE_FACTS],
  );
}

async function seedCompletePostingObservation(index: number): Promise<void> {
  const id = crypto.randomUUID();
  const url = `https://boards.example.test/throughput/${id}`;
  const title = `Machine Learning Engineer ${index}`;
  const company = `Throughput Fixture ${index}`;
  const description = `${COMPLETE_TEST_POSTING_DESCRIPTION} Fully remote role. Python, SQL and machine learning experience required.`;
  const contentHash = crypto.createHash("sha256").update(description).digest("hex");
  const rawPayload = {
    source_content_status: "COMPLETE",
    source_provider: "GREENHOUSE",
    content_hash: contentHash,
    source_evidence: { requestedUrl: url, resolvedUrl: url, responseHash: contentHash },
    posting: { title, companyName: company },
  };
  await db().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, location_raw, workplace_type_raw,
       raw_payload, raw_payload_hash, processing_status
     ) VALUES ($1, $2, 'GREENHOUSE', $3, $4, NOW(), $5, $6, $7, 'Remote', 'REMOTE',
       $8::jsonb, $9, 'PENDING')`,
    [
      id, workspace().workspaceId, `greenhouse-${id}`, url, company, title, description,
      JSON.stringify(rawPayload),
      crypto.createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"),
    ],
  );
  await enqueuePipelineTask({
    taskType: "NORMALIZE_OBSERVATION",
    taskKey: `NORMALIZE_OBSERVATION:${id}:throughput`,
    payload: { observation_id: id },
  }, db(), { context: workspace() });
}

async function runStage(taskType: PipelineStageTaskType, maxTasks: number) {
  return countQueries(() => runPipelineStageTaskWorker(db(), {
    context: workspace(),
    seed: false,
    reconcileStalePending: false,
    taskTypes: [taskType],
    maxTasks,
    heartbeatSeconds: 0,
  }));
}

let archiveRunId = "";

/** Inserts `count` synthetic jobs (canonical job, version, observation). */
async function insertSyntheticJobs(count: number, archived: boolean): Promise<Array<{
  canonicalJobId: string;
  jobVersionId: string;
  observationId: string;
}>> {
  if (archived && !archiveRunId) {
    const run = await db().query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status)
       VALUES (NOW(), NOW() - INTERVAL '90 days', 'APPLY', 'SUCCEEDED') RETURNING id::text AS id`,
    );
    archiveRunId = run.rows[0]?.id ?? "";
  }
  const { rows } = await db().query<{ canonical_job_id: string; job_version_id: string; observation_id: string }>(
    `WITH jobs AS (
       INSERT INTO canonical_jobs (
         workspace_id, company_name, normalized_title, canonical_url, location_summary,
         workplace_type, employment_type, processing_state, processing_status,
         archived_at, archive_reason, archive_age_basis, archive_reference_at, archive_run_id
       )
       SELECT $1, 'Synthetic ' || n, 'Synthetic Title ' || n,
              'https://synthetic.example.test/' || gen_random_uuid(), 'Remote', 'REMOTE', 'FULL_TIME',
              'PREQUALIFIED', 'PREQUALIFIED',
              CASE WHEN $3 THEN NOW() END,
              CASE WHEN $3 THEN 'AGE_LIMIT' END,
              CASE WHEN $3 THEN 'OBSERVED_AGE_PUBLICATION_UNKNOWN' END,
              CASE WHEN $3 THEN NOW() - INTERVAL '120 days' END,
              CASE WHEN $3 THEN $4::uuid END
       FROM generate_series(1, $2::int) AS n
       RETURNING id, workspace_id
     ), versions AS (
       INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
       SELECT workspace_id, id, 1, md5(id::text), 'Synthetic description ' || id, NOW()
       FROM jobs
       RETURNING id, canonical_job_id, workspace_id
     ), observations AS (
       INSERT INTO raw_job_observations (
         workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title,
         description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
       )
       SELECT workspace_id, 'GMAIL_ALERT', 'synthetic-' || id, 'https://synthetic.example.test/alert/' || id, NOW(),
              'Synthetic', 'Synthetic Title', 'Synthetic description', '{}'::jsonb, md5('obs' || id::text),
              'PROCESSED', id
       FROM versions
       RETURNING id, job_version_id
     )
     SELECT versions.canonical_job_id::text AS canonical_job_id,
            versions.id::text AS job_version_id,
            observations.id::text AS observation_id
     FROM versions
     JOIN observations ON observations.job_version_id = versions.id`,
    [workspace().workspaceId, count, archived, archived ? archiveRunId : null],
  );
  return rows.map((row) => ({
    canonicalJobId: row.canonical_job_id,
    jobVersionId: row.job_version_id,
    observationId: row.observation_id,
  }));
}

async function insertPendingTask(taskType: string, payload: Record<string, unknown>): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, context_fingerprint, status, available_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'PENDING', NOW() - INTERVAL '1 minute')
     RETURNING id::text AS id`,
    [workspace().workspaceId, taskType, `${taskType}:${crypto.randomUUID()}`, JSON.stringify(payload), crypto.randomUUID()],
  );
  return rows[0]?.id ?? "";
}

/** Shared buffers touched by one statement: a deterministic cost measure, unlike wall clock. */
async function statementBuffers(sql: string, params: unknown[]): Promise<number> {
  await db().query("BEGIN");
  try {
    const { rows } = await db().query<{ "QUERY PLAN": Array<{ Plan: Record<string, number> }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      params,
    );
    const plan = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
    if (!plan) throw new Error("EXPLAIN returned no plan.");
    return Number(plan["Shared Hit Blocks"] ?? 0) + Number(plan["Shared Read Blocks"] ?? 0);
  } finally {
    await db().query("ROLLBACK");
  }
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
}

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/**
 * EXPLAIN ANALYZE inside a rolled-back transaction. `setup` runs first in the
 * same transaction, e.g. to reproduce a production plan.
 */
async function analyzedPlan(sql: string, params: unknown[], setup: string[] = []): Promise<PlanNode> {
  await db().query("BEGIN");
  try {
    for (const statement of setup) await db().query(statement);
    const { rows } = await db().query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
      params,
    );
    const plan = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
    if (!plan) throw new Error("EXPLAIN returned no plan.");
    return plan;
  } finally {
    await db().query("ROLLBACK");
  }
}

describe.skipIf(skipReal)("pipeline worker throughput (PostgreSQL)", () => {
  beforeAll(async () => {
    for (const key of ["EMBEDDING_PRIMARY_PROVIDER", "EMBEDDING_PRIMARY_MODEL", "EMBEDDING_PRIMARY_DIMENSIONS"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.EMBEDDING_PRIMARY_PROVIDER = "openai";
    process.env.EMBEDDING_PRIMARY_MODEL = "fixture-throughput";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";

    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `worker_throughput_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    await loadWorkspaceLanesConfig(client, { context, seedIfEmpty: true });
    await seedProfile();

    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      if (counting) {
        const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string } | undefined)?.text ?? "");
        queryLog.push(sql.replace(/\s+/g, " ").trim());
      }
      return original(...args);
    };
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
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("drains every deterministic stage with a bounded number of queries per claimed task", async () => {
    for (let index = 0; index < JOBS; index += 1) await seedCompletePostingObservation(index);

    const perTask: Record<string, number> = {};
    const stages: PipelineStageTaskType[] = [
      "NORMALIZE_OBSERVATION",
      "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      "APPLY_HARD_GATES",
    ];
    for (const stage of stages) {
      const { result, queries } = await runStage(stage, 50);
      expect(result).toMatchObject({ claimed: JOBS, completed: JOBS, failed: 0, blocked: 0, deadLettered: 0 });
      perTask[stage] = queries.length / result.claimed;
    }

    // The first embedding task also publishes the profile facts and lane
    // prototypes; the remaining tasks are the steady state a production run sees.
    const warm = await runStage("PUBLISH_EMBEDDING", 1);
    expect(warm.result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const steady = await runStage("PUBLISH_EMBEDDING", 50);
    expect(steady.result).toMatchObject({ claimed: JOBS - 1, completed: JOBS - 1, failed: 0, blocked: 0 });
    perTask.PUBLISH_EMBEDDING = steady.queries.length / steady.result.claimed;
    // Unchanged profile facts and lane prototypes are verified with one locking
    // read per source type, not one round trip per fact (was PROFILE_FACTS + lanes per task).
    const inputLockReads = steady.queries.filter((sql) =>
      sql.startsWith("SELECT source_id::text AS source_id, content_hash FROM embedding_inputs") ||
      sql.startsWith("SELECT content_hash FROM embedding_inputs"),
    );
    expect(inputLockReads.length / steady.result.claimed).toBeLessThanOrEqual(4);

    for (const stage of [
      "ROUTE_LANE",
      "MATCH_PROFILE_EVIDENCE",
      "DECIDE_RECOMMENDATION",
      "ENQUEUE_EXPLANATION",
    ] as PipelineStageTaskType[]) {
      const { result, queries } = await runStage(stage, 50);
      expect(result).toMatchObject({ claimed: JOBS, completed: JOBS, failed: 0, blocked: 0, deadLettered: 0 });
      perTask[stage] = queries.length / result.claimed;
    }

    // Query budgets per claimed task (claim, guards, stage work, completion and
    // successor enqueue). They pin the per-task round-trip count so per-row
    // loops cannot creep back in unnoticed.
    expect(Object.keys(perTask)).toHaveLength(8);
    for (const [stage, queries] of Object.entries(perTask)) {
      expect(queries, stage).toBeLessThanOrEqual(stage === "PUBLISH_EMBEDDING" ? 65 : 45);
    }
    console.info("Worker queries per claimed task:", JSON.stringify(perTask));
  }, 300_000);

  it("never scans canonical_jobs once per task when no job is archived", async () => {
    const taskType = "FETCH_JOB_CONTENT";
    const live = await insertSyntheticJobs(60, false);
    for (const job of live) await insertPendingTask(taskType, { observation_id: job.observationId });
    await db().query("ANALYZE");
    const archived = await db().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM canonical_jobs WHERE archived_at IS NOT NULL`,
    );
    expect(archived.rows[0]?.count).toBe(0);

    // Production (no archived jobs) planned the old predicate as a sequential
    // scan of canonical_jobs repeated for every task row, because the
    // `id::text = payload->>...` comparison cannot use an index. Dropping the
    // partial archived_at index inside the rolled-back transaction reproduces
    // that plan shape locally; the keyed predicate must still touch
    // canonical_jobs by key or at most once per statement.
    for (const setup of [[], [`DROP INDEX ${schemaName}.idx_canonical_jobs_archived_workspace`]]) {
      const claimPlan = await analyzedPlan(
        CLAIM_PIPELINE_TASKS_SQL,
        [workspace().workspaceId, taskType, 1, 300, "throughput-test", null, null],
        setup,
      );
      const healthPlan = await analyzedPlan(
        `SELECT task_type, status, task_count FROM v_pipeline_task_queue_health WHERE workspace_id = $1`,
        [workspace().workspaceId],
        setup,
      );
      for (const plan of [claimPlan, healthPlan]) {
        const repeatedSeqScans = planNodes(plan).filter((node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "canonical_jobs" &&
          (node["Actual Loops"] ?? 0) > 1,
        );
        expect(repeatedSeqScans).toEqual([]);
      }
    }
  }, 120_000);

  it("rebuilds unchanged embedding inputs with a constant number of queries", async () => {
    const { result, queries } = await countQueries(() => buildEmbeddingInputs(db(), 500, {
      context: workspace(),
      includeRequirements: false,
      includeJobVersions: false,
      includeProfileFacts: true,
      includeLanePrototypes: true,
    }));
    expect(result).toMatchObject({ inserted: 0, fromProfileFacts: 0, fromLanePrototypes: 0 });
    const lockingReads = queries.filter((sql) => sql.includes("FROM embedding_inputs") && sql.includes("FOR UPDATE"));
    expect(lockingReads).toHaveLength(2);
    expect(queries.length).toBeLessThanOrEqual(8);
  });

  it("excludes archived targets from claims, queue health and the worker guard by every payload key", async () => {
    const [archived] = await insertSyntheticJobs(1, true);
    const [active] = await insertSyntheticJobs(1, false);
    const taskType = "EXTRACT_QUOTED_REQUIREMENTS";
    const byCanonical = await insertPendingTask(taskType, { canonical_job_id: archived.canonicalJobId });
    const byVersion = await insertPendingTask(taskType, { job_version_id: archived.jobVersionId });
    const byObservation = await insertPendingTask(taskType, { observation_id: archived.observationId });
    const control = await insertPendingTask(taskType, {
      canonical_job_id: active.canonicalJobId,
      job_version_id: active.jobVersionId,
    });
    const malformed = await insertPendingTask(taskType, { job_version_id: "not-a-uuid" });

    for (const payload of [
      { canonical_job_id: archived.canonicalJobId },
      { job_version_id: archived.jobVersionId },
      { observation_id: archived.observationId },
    ]) {
      expect(await archivedJobForPipelineTask(db(), workspace().workspaceId, taskType, payload))
        .toMatchObject({ canonicalJobId: archived.canonicalJobId });
    }
    expect(await archivedJobForPipelineTask(db(), workspace().workspaceId, taskType, {
      canonical_job_id: active.canonicalJobId,
      job_version_id: active.jobVersionId,
      observation_id: active.observationId,
    })).toBeNull();

    const health = await db().query<{ task_count: number }>(
      `SELECT task_count FROM v_pipeline_task_queue_health
       WHERE workspace_id = $1 AND task_type = $2 AND status = 'PENDING'`,
      [workspace().workspaceId, taskType],
    );
    expect(health.rows[0]?.task_count).toBe(2);

    const claimed = await claimPipelineTasks({ taskType, limit: 50, claimedBy: "throughput-test" }, db(), {
      context: workspace(),
    });
    expect(claimed.map((task) => task.taskId).sort()).toEqual([control, malformed].sort());
    const statuses = await db().query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM pipeline_tasks WHERE id = ANY($1::uuid[])`,
      [[byCanonical, byVersion, byObservation]],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
  });

  it("keeps claim and queue-health cost flat as the archive grows", async () => {
    const taskType = "FETCH_JOB_CONTENT";
    const live = await insertSyntheticJobs(40, false);
    for (const job of live) await insertPendingTask(taskType, { observation_id: job.observationId });
    await insertSyntheticJobs(25, true);
    await db().query("ANALYZE");

    const claimParams = [workspace().workspaceId, taskType, 1, 300, "throughput-test", null, null];
    const healthSql = `SELECT task_type, status, task_count FROM v_pipeline_task_queue_health WHERE workspace_id = $1`;
    const claimSmall = await statementBuffers(CLAIM_PIPELINE_TASKS_SQL, claimParams);
    const healthSmall = await statementBuffers(healthSql, [workspace().workspaceId]);

    await insertSyntheticJobs(500, true);
    await db().query("ANALYZE");
    const claimLarge = await statementBuffers(CLAIM_PIPELINE_TASKS_SQL, claimParams);
    const healthLarge = await statementBuffers(healthSql, [workspace().workspaceId]);

    // Twenty times more archived jobs. The previous text-compare predicate
    // probed every archived job (and scanned observations) for every candidate
    // task, i.e. cost ~ tasks x archived jobs (tens of thousands of buffers
    // here). Keyed lookups cost a small constant per task whatever the archive
    // size; the bound allows ~15 buffers per task.
    const totalTasks = await db().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pipeline_tasks WHERE workspace_id = $1`,
      [workspace().workspaceId],
    );
    const taskCount = totalTasks.rows[0]?.count ?? 0;
    const pendingOfType = await db().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = $2 AND status = 'PENDING'`,
      [workspace().workspaceId, taskType],
    );
    const candidates = pendingOfType.rows[0]?.count ?? 0;
    expect(candidates).toBeGreaterThanOrEqual(live.length);
    console.info("Archive scaling buffers:", JSON.stringify({ claimSmall, claimLarge, healthSmall, healthLarge, taskCount, candidates }));
    for (const claimBuffers of [claimSmall, claimLarge]) {
      expect(claimBuffers).toBeLessThanOrEqual(15 * candidates + 150);
    }
    for (const healthBuffers of [healthSmall, healthLarge]) {
      expect(healthBuffers).toBeLessThanOrEqual(15 * taskCount + 300);
    }
  }, 120_000);
});
