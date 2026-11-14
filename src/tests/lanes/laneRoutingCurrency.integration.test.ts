import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runExplanationQueueEnqueuer } from "../../pipeline/explanationQueueEnqueuer.js";
import { loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { runLaneRouter } from "../../pipeline/laneRouter.js";
import { runEmbeddingBatchWithFallback } from "../../embeddings/batchCoordinator.js";
import { listActiveLaneRevisions, upsertLaneRevision } from "../../lanes/registry.js";
import { laneRoutingVersion } from "../../lanes/laneRoutingCurrency.js";
import {
  runPipelineStageTaskWorker,
  seedRecoverablePipelineTasks,
} from "../../tasks/stageTaskWorker.js";
import { DETERMINISTIC_MATCHER_POLICY_VERSION } from "../../pipeline/profileMatchCurrency.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { setLaneBudget } from "../../../scripts/workspace_lanes.js";
import { batchEmbeddingFromPerInput } from "../fixtures/embeddingBatchMock.js";

// Real PostgreSQL: lane revisions, routing currency, the enqueuer, the seeder and the task worker
// (including the real lane router) all run against migrated tables. Only the embedding provider
// is replaced by a deterministic synthetic vector function.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const TEST_LANE = "ZEBRA_ROUTING_TEST";
const ENV_KEYS = [
  "REQUIREMENTS_ENABLE_QUOTED",
  "EMBEDDING_PRIMARY_PROVIDER",
  "EMBEDDING_PRIMARY_DIMENSIONS",
  "EMBEDDING_FALLBACK_DIMENSIONS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const jobs: Array<{ canonicalJobId: string; jobVersionId: string }> = [];

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration test database client is not initialized.");
  return client;
}

function ctx(): WorkspaceContext {
  if (!context) throw new Error("The integration test workspace context is not initialized.");
  return context;
}

function testLaneContent(prototypeText: string, budget: number) {
  return {
    schema_version: "2.2.0",
    lane_key: TEST_LANE,
    display_name: "Zebra routing test lane",
    description: "Synthetic lane for zebra telemetry platform engineering fixtures.",
    scope: {
      included_domain_concepts: { any: ["zebra telemetry"] },
      required_function_concepts: { any: ["platform engineer"] },
    },
    prototypes: [{ prototype_key: "zebra-platform", text: prototypeText }],
    routing: { minimum_semantic_score: 0.35 },
    budget: { maximum_ai_interpretations_per_run: budget },
  };
}

// Synthetic, deterministic embedding: zebra text points one way, everything else another.
async function syntheticEmbedding(text: string): Promise<number[]> {
  return text.toLowerCase().includes("zebra") ? [1, 0, 0, 0] : [0, 1, 0, 0];
}

async function publishEmbeddings(): Promise<void> {
  const summary = await runEmbeddingBatchWithFallback(200, db(), { context: ctx() });
  expect(summary.primary.failed).toBe(0);
}

async function routedRevisionIds(canonicalJobId: string): Promise<Record<string, string>> {
  const { rows } = await db().query<{ lane_key: string; lane_revision_id: string }>(
    `SELECT revision.value->>'lane_key' AS lane_key,
            revision.value->>'lane_revision_id' AS lane_revision_id
     FROM canonical_jobs c
     JOIN lane_decisions ld ON ld.workspace_id = c.workspace_id AND ld.id = c.latest_lane_decision_id
     CROSS JOIN LATERAL jsonb_array_elements(ld.lane_snapshot->'active_lane_revisions') revision(value)
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [ctx().workspaceId, canonicalJobId],
  );
  return Object.fromEntries(rows.map((row) => [row.lane_key, row.lane_revision_id]));
}

async function jobState(canonicalJobId: string) {
  const { rows } = await db().query<{ processing_state: string; primary_lane: string; latest_lane_decision_id: string }>(
    `SELECT processing_state, primary_lane, latest_lane_decision_id
     FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
    [ctx().workspaceId, canonicalJobId],
  );
  return rows[0];
}

// The read-only production verification report shipped with the fix, run as-is.
async function routingCurrencyReport() {
  const reportSql = fs.readFileSync(
    path.resolve(process.cwd(), "scripts", "sql", "lane_routing_currency_report.sql"),
    "utf8",
  );
  await db().query("BEGIN READ ONLY");
  try {
    const { rows } = await db().query(reportSql);
    return rows[0];
  } finally {
    await db().query("ROLLBACK");
  }
}

async function queuedCount(canonicalJobId: string): Promise<number> {
  const { rows } = await db().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM evaluation_queue
     WHERE workspace_id = $1 AND canonical_job_id = $2 AND status = 'PENDING'`,
    [ctx().workspaceId, canonicalJobId],
  );
  return rows[0].count;
}

async function seedRoutedJob(index: number, profileVersionId: string, policySnapshotId: string) {
  const workspaceId = ctx().workspaceId;
  const description = [
    `About the role: zebra telemetry platform engineer role ${index} at a synthetic fixture employer.`,
    "Responsibilities: build and operate zebra telemetry ingestion services, review designs and support releases.",
    "Requirements: production platform engineering experience with streaming telemetry systems.",
  ].join(" ");
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location_summary, workplace_type, employment_type,
       processing_status, processing_state, gate_decision, description_quality_status
     ) VALUES ($1, $2, $3, $4, 'Remote', 'REMOTE', 'PERMANENT',
               'PREQUALIFIED', 'PREQUALIFIED', 'PASS', 'COMPLETE')
     RETURNING id`,
    [workspaceId, `Synthetic Zebra Fixture ${index}`, `Zebra Telemetry Platform Engineer ${index}`,
     `https://example.test/zebra-${index}`],
  );
  const canonicalJobId = canonical.rows[0].id;
  const contentHash = `zebra-routing-content-${index}`;
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
  await db().query(
    `INSERT INTO raw_job_observations (
       workspace_id, source_name, source_url, company_name, title, description_raw,
       raw_payload, raw_payload_hash, processing_status, job_version_id
     ) VALUES ($1, 'EMPLOYER_WEBSITE', $2, $3, $4, $5, '{}'::jsonb, $6, 'PROCESSED', $7)`,
    [workspaceId, `https://example.test/zebra-${index}`, `Synthetic Zebra Fixture ${index}`,
     `Zebra Telemetry Platform Engineer ${index}`, description, `zebra-observation-${index}`, jobVersionId],
  );

  const identity = await db().query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash,
       deterministic_extractor_version, quoted_extractor_version,
       quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-fixture-v1', 'quoted-fixture-v1',
               'quoted-prompt-fixture-v1', 'normalizer-fixture-v1', FALSE)
     RETURNING id`,
    [workspaceId, canonicalJobId, `zebra-identity-${index}`, contentHash],
  );
  const requirementSet = await db().query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
    [workspaceId, identity.rows[0].id, canonicalJobId, jobVersionId],
  );
  await db().query(
    `UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [requirementSet.rows[0].id, workspaceId, jobVersionId],
  );
  const contextFingerprint = `zebra-context-${index}`;
  const matchRun = await db().query<{ id: string }>(
    `INSERT INTO match_runs (
       workspace_id, canonical_job_id, job_version_id, profile_version_id,
       requirement_set_id, status, requirement_count, matched_count,
       coverage_score, overall_match_score, policy_version,
       job_content_hash, context_fingerprint, completed_at
     ) VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 1, 1, 100.00, 80.00,
               '${DETERMINISTIC_MATCHER_POLICY_VERSION}', $6, $7, NOW())
     RETURNING id`,
    [workspaceId, canonicalJobId, jobVersionId, profileVersionId, requirementSet.rows[0].id,
     contentHash, contextFingerprint],
  );
  const decision = await db().query<{ id: string }>(
    `INSERT INTO deterministic_decisions (
       workspace_id, canonical_job_id, job_version_id, match_run_id,
       policy_snapshot_id, decision_hash, schema_version, decision_json,
       recommendation_eligibility, recommendation_outcome, context_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, '2.2.0', $7::jsonb, 'ELIGIBLE', 'PRIORITY', $8)
     RETURNING id`,
    [workspaceId, canonicalJobId, jobVersionId, matchRun.rows[0].id, policySnapshotId,
     `zebra-decision-${index}`, JSON.stringify({ fixture: "zebra-routing", index }), contextFingerprint],
  );
  await db().query(
    `UPDATE canonical_jobs
     SET latest_match_run_id = $1, latest_deterministic_decision_id = $2
     WHERE workspace_id = $3 AND id = $4`,
    [matchRun.rows[0].id, decision.rows[0].id, workspaceId, canonicalJobId],
  );
  jobs.push({ canonicalJobId, jobVersionId });
}

describe.skipIf(skipReal)("lane routing currency across lane revisions", () => {
  beforeAll(async () => {
    process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
    process.env.EMBEDDING_PRIMARY_PROVIDER = "gemini";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = "4";
    const agent = await import("../../services/agent.js");
    vi.spyOn(agent, "generateEmbedding").mockImplementation(syntheticEmbedding);
    vi.spyOn(agent, "generateEmbeddingWithProvider").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingWithProviderAndModel").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingsWithProviderAndModel")
      .mockImplementation(batchEmbeddingFromPerInput(syntheticEmbedding));

    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `lane_routing_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    await loadWorkspaceLanesConfig(db(), { context: ctx(), seedIfEmpty: true });
    await upsertLaneRevision(
      { laneKey: TEST_LANE, content: testLaneContent("Zebra telemetry platform engineer.", 1) },
      db(),
      { context: ctx(), note: "lane routing currency fixture" },
    );

    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, 'zebra_routing_profile', 'Zebra Routing Profile') RETURNING id`,
      [ctx().workspaceId],
    );
    const profileVersion = await db().query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at
       ) VALUES ($1, $2, 1, '2.2.0', 'zebra-routing-profile-v1', 'ACTIVE', NOW()) RETURNING id`,
      [ctx().workspaceId, profile.rows[0].id],
    );
    const policy = await db().query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, schema_version, resolved_snapshot)
       VALUES ($1, 'zebra-routing-policy-v1', '2.2.0', '{"fixture":"zebra-routing"}'::jsonb) RETURNING id`,
      [ctx().workspaceId],
    );
    for (const index of [1, 2]) await seedRoutedJob(index, profileVersion.rows[0].id, policy.rows[0].id);

    // Route both jobs with the real lane router under the initial lane revisions.
    await publishEmbeddings();
    await runLaneRouter(db(), { context: ctx(), jobVersionIds: jobs.map((job) => job.jobVersionId) });
    for (const job of jobs) {
      const state = await jobState(job.canonicalJobId);
      expect(state).toMatchObject({ processing_state: "LANE_ROUTED", primary_lane: TEST_LANE });
      await db().query(
        `UPDATE canonical_jobs
         SET processing_state = 'MATCHED', processing_status = 'MATCHED',
             recommendation_eligibility = 'ELIGIBLE', recommendation_outcome = 'PRIORITY'
         WHERE workspace_id = $1 AND id = $2`,
        [ctx().workspaceId, job.canonicalJobId],
      );
    }
  }, 120_000);

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

  it("hashes lane routing content deterministically and without the budget", async () => {
    const content = { b: 1, budget: { maximum_ai_interpretations_per_run: 7 }, a: [1, 2] };
    const { rows } = await db().query<{ hash: string }>(
      `SELECT lane_routing_content_hash($1::jsonb) AS hash`,
      [JSON.stringify(content)],
    );
    // PostgreSQL's canonical jsonb text sorts keys and uses ", " / ": " separators.
    const expected = crypto.createHash("sha256").update('{"a": [1, 2], "b": 1}', "utf8").digest("hex");
    expect(rows[0].hash).toBe(expected);

    const stored = await db().query<{ mismatched: number; missing: number }>(
      `SELECT COUNT(*) FILTER (WHERE routing_content_hash <> lane_routing_content_hash(content))::int AS mismatched,
              COUNT(*) FILTER (WHERE routing_content_hash IS NULL)::int AS missing
       FROM lane_revisions`,
    );
    expect(stored.rows[0]).toEqual({ mismatched: 0, missing: 0 });

    const budgetOnly = await db().query<{ same_routing: boolean; same_content: boolean }>(
      `SELECT lane_routing_content_hash($1::jsonb) = lane_routing_content_hash($2::jsonb) AS same_routing,
              $1::jsonb = $2::jsonb AS same_content`,
      [JSON.stringify(testLaneContent("p", 1)), JSON.stringify(testLaneContent("p", 10))],
    );
    expect(budgetOnly.rows[0]).toEqual({ same_routing: true, same_content: false });
    const routingChange = await db().query<{ same_routing: boolean }>(
      `SELECT lane_routing_content_hash($1::jsonb) = lane_routing_content_hash($2::jsonb) AS same_routing`,
      [JSON.stringify(testLaneContent("p", 1)), JSON.stringify(testLaneContent("q", 1))],
    );
    expect(routingChange.rows[0].same_routing).toBe(false);
  });

  it("backfills routing hashes for lane revisions that existed before migration 101", async () => {
    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), "migrations", "101_lane_revision_routing_content_hash.sql"),
      "utf8",
    );
    await db().query("BEGIN");
    try {
      // Recreate the pre-101 shape, add revisions the way production has them (rev 1 routed,
      // revs 2 and 3 budget-only, rev 4 a routing change), then apply the migration.
      await db().query("ALTER TABLE lane_revisions DROP COLUMN routing_content_hash");
      const identity = await db().query<{ id: string }>(
        `INSERT INTO lane_identities (workspace_id, lane_key, status) VALUES ($1, 'LEGACY_BACKFILL_TEST', 'ACTIVE')
         RETURNING id`,
        [ctx().workspaceId],
      );
      const contents = [
        testLaneContent("Legacy prototype.", 0),
        testLaneContent("Legacy prototype.", 1),
        testLaneContent("Legacy prototype.", 10),
        testLaneContent("Changed legacy prototype.", 10),
      ];
      for (const [offset, content] of contents.entries()) {
        await db().query(
          `INSERT INTO lane_revisions (lane_identity_id, revision_number, content_hash, content)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [identity.rows[0].id, offset + 1, `legacy-content-${offset + 1}`, JSON.stringify(content)],
        );
      }
      await db().query(migrationSql);
      const { rows } = await db().query<{ revision_number: number; routing_content_hash: string; recomputed: string }>(
        `SELECT revision_number, routing_content_hash, lane_routing_content_hash(content) AS recomputed
         FROM lane_revisions WHERE lane_identity_id = $1 ORDER BY revision_number`,
        [identity.rows[0].id],
      );
      expect(rows.map((row) => row.routing_content_hash)).toEqual(rows.map((row) => row.recomputed));
      expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.routing_content_hash))).toBe(true);
      expect(new Set(rows.slice(0, 3).map((row) => row.routing_content_hash)).size).toBe(1);
      expect(rows[3].routing_content_hash).not.toBe(rows[0].routing_content_hash);
    } finally {
      await db().query("ROLLBACK");
    }
    const restored = await db().query<{ missing: number }>(
      `SELECT COUNT(*) FILTER (WHERE routing_content_hash IS NULL)::int AS missing FROM lane_revisions`,
    );
    expect(restored.rows[0].missing).toBe(0);
  });

  it("keeps routed jobs eligible after budget-only set-budget revisions", async () => {
    const [jobA] = jobs;
    const before = await loadWorkspaceLanesConfig(db(), { context: ctx() });
    const routedBefore = await routedRevisionIds(jobA.canonicalJobId);

    const dryRun = await setLaneBudget(db(), "all", "3", { apply: false, context: ctx() });
    expect(dryRun.mode).toBe("DRY_RUN");
    expect(dryRun.changes.every((change) => change.appliedRevision === undefined)).toBe(true);
    expect((await listActiveLaneRevisions(db(), { context: ctx() })).map((lane) => lane.laneRevisionId).sort())
      .toEqual((before.activeLaneRevisions ?? []).map((lane) => lane.laneRevisionId).sort());

    // Two go-live budget changes, as in production: every lane gets two new revisions.
    for (const budget of ["3", "4"]) {
      const applied = await setLaneBudget(db(), "all", budget, { apply: true, context: ctx() });
      expect(applied.mode).toBe("APPLY");
      const changed = applied.changes.filter((change) => change.changed);
      expect(changed.length).toBeGreaterThan(0);
      for (const change of changed) {
        expect(change.appliedRevision).toBe(change.activeRevision + 1);
        expect(change.routingContentUnchanged).toBe(true);
      }
    }

    const after = await loadWorkspaceLanesConfig(db(), { context: ctx() });
    expect(after.config.version).not.toBe(before.config.version);
    expect(after.routingVersion).toBe(before.routingVersion);
    expect(after.config.lanes[TEST_LANE].maximum_ai_interpretations_per_run).toBe(4);
    // No routed revision id is the active one any more (the production symptom) ...
    for (const lane of after.activeLaneRevisions ?? []) {
      expect(routedBefore[lane.laneKey]).toBeDefined();
      expect(routedBefore[lane.laneKey]).not.toBe(lane.laneRevisionId);
    }

    // ... yet the verification report counts both jobs eligible by routing content ...
    expect(await routingCurrencyReport()).toEqual({
      qualifying_jobs: 2,
      eligible_by_revision_id_before_fix: 0,
      eligible_by_routing_content_after_fix: 2,
      needing_reroute_after_fix: 0,
    });

    // ... nothing needs re-routing, and the job is enqueued without re-routing.
    const seeded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["ROUTE_LANE"],
      includeTestFixtures: true,
    });
    expect(seeded.supersededLaneRouting).toBe(0);
    const enqueued = await runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [jobA.canonicalJobId],
      budgetRunId: crypto.randomUUID(),
    });
    expect(enqueued).toEqual({ enqueued: 1, updated: 1, deferred: 0 });
    expect(await queuedCount(jobA.canonicalJobId)).toBe(1);
    expect(await routedRevisionIds(jobA.canonicalJobId)).toEqual(routedBefore);
  }, 120_000);

  it("still pins the lane budget per AI budget run", async () => {
    const pinnedRunId = crypto.randomUUID();
    const unrelatedCanonicalJob = crypto.randomUUID();
    await runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [unrelatedCanonicalJob],
      budgetRunId: pinnedRunId,
    });

    await setLaneBudget(db(), TEST_LANE, "7", { apply: true, context: ctx() });
    await expect(runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [unrelatedCanonicalJob],
      budgetRunId: pinnedRunId,
    })).rejects.toThrow(/different lane configuration snapshot/);

    const laterRunId = crypto.randomUUID();
    await runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [unrelatedCanonicalJob],
      budgetRunId: laterRunId,
    });
    const { rows } = await db().query<{ id: string; budget_limit: number; usage_limit: number }>(
      `SELECT r.id::text AS id,
              (r.lane_config_snapshot->'budgets'->$2->>'budget_limit')::int AS budget_limit,
              u.budget_limit AS usage_limit
       FROM ai_evaluation_budget_runs r
       JOIN ai_evaluation_budget_usage u ON u.budget_run_id = r.id AND u.lane = $2
       WHERE r.workspace_id = $1 AND r.id = ANY($3::uuid[])`,
      [ctx().workspaceId, TEST_LANE, [pinnedRunId, laterRunId]],
    );
    const byRun = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byRun[pinnedRunId]).toMatchObject({ budget_limit: 4, usage_limit: 4 });
    expect(byRun[laterRunId]).toMatchObject({ budget_limit: 7, usage_limit: 7 });
  }, 60_000);

  it("re-routes jobs after a routing-content change and then enqueues them", async () => {
    const jobB = jobs[1];
    const active = (await listActiveLaneRevisions(db(), { context: ctx() }))
      .find((lane) => lane.laneKey === TEST_LANE);
    if (!active) throw new Error("The test lane is not active.");
    const changed = await upsertLaneRevision(
      {
        laneKey: TEST_LANE,
        content: {
          ...active.content,
          prototypes: [{ prototype_key: "zebra-platform", text: "Zebra telemetry platform engineer for fleets." }],
        },
      },
      db(),
      { context: ctx(), note: "routing-content change" },
    );
    expect(changed.routingContentHash).not.toBe(active.routingContentHash);
    const routing = await loadWorkspaceLanesConfig(db(), { context: ctx() });
    if (!routing.routingVersion || !routing.activeLaneRevisions) throw new Error("Registry routing version missing.");
    expect(routing.routingVersion).toBe(laneRoutingVersion(routing.activeLaneRevisions));

    // Job A is already queued; job B now needs a re-route.
    expect(await routingCurrencyReport()).toEqual({
      qualifying_jobs: 1,
      eligible_by_revision_id_before_fix: 0,
      eligible_by_routing_content_after_fix: 0,
      needing_reroute_after_fix: 1,
    });

    // The stale route is refused, never silently skipped.
    await expect(runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [jobB.canonicalJobId],
      budgetRunId: crypto.randomUUID(),
    })).rejects.toThrow(/does not use the active lane revision's routing content/);

    // An AI enqueue task blocks on a queued ROUTE_LANE re-route and is counted in the summary.
    const blocked = await runPipelineStageTaskWorker(db(), {
      context: ctx(),
      seed: true,
      includeTestFixtures: true,
      reconcileStalePending: false,
      taskTypes: ["ENQUEUE_EXPLANATION"],
      jobVersionIds: [jobB.jobVersionId],
      maxTasks: 5,
      heartbeatSeconds: 0,
      minTimeToStartTaskMs: 0,
    });
    expect(blocked.errors).toEqual([]);
    expect(blocked.blocked).toBe(1);
    expect(blocked.laneRoutingSuperseded).toBe(1);
    const enqueueTask = await db().query<{ status: string; blocked_on: string; repair_action: string }>(
      `SELECT status, blocked_on, repair_action FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'ENQUEUE_EXPLANATION' AND payload->>'job_version_id' = $2`,
      [ctx().workspaceId, jobB.jobVersionId],
    );
    expect(enqueueTask.rows).toEqual([{
      status: "BLOCKED_DEPENDENCY",
      blocked_on: `LANE_ROUTING_SUPERSEDED:${jobB.jobVersionId}`,
      repair_action: "ROUTE_LANE",
    }]);
    const rerouteTask = await db().query<{ task_key: string; status: string }>(
      `SELECT task_key, status FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'ROUTE_LANE' AND payload->>'job_version_id' = $2`,
      [ctx().workspaceId, jobB.jobVersionId],
    );
    expect(rerouteTask.rows).toEqual([{
      task_key: `ROUTE_LANE:${jobB.jobVersionId}:lane_router_v1:reroute-${routing.routingVersion}`,
      status: "PENDING",
    }]);

    // The seeder finds the same superseded route (and does not duplicate the re-route task).
    const seeded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["ROUTE_LANE"],
      includeTestFixtures: true,
      jobVersionIds: [jobB.jobVersionId],
    });
    expect(seeded.supersededLaneRouting).toBe(1);
    expect(seeded.byType.ROUTE_LANE).toEqual({ inserted: 0, existing: 1 });

    // Publish the new lane revision's prototype, then the real router re-routes the job, the
    // blocked enqueue task is reactivated and the job reaches the AI queue.
    await publishEmbeddings();
    const decisionBefore = (await jobState(jobB.canonicalJobId)).latest_lane_decision_id;
    const recovered = await runPipelineStageTaskWorker(db(), {
      context: ctx(),
      seed: false,
      includeTestFixtures: true,
      reconcileStalePending: false,
      taskTypes: ["ROUTE_LANE", "ENQUEUE_EXPLANATION"],
      jobVersionIds: [jobB.jobVersionId],
      maxTasks: 10,
      heartbeatSeconds: 0,
      minTimeToStartTaskMs: 0,
    });
    expect(recovered.errors).toEqual([]);
    expect(recovered.failed).toBe(0);
    expect(recovered.laneRoutingSuperseded).toBe(0);

    const stateAfter = await jobState(jobB.canonicalJobId);
    expect(stateAfter.latest_lane_decision_id).not.toBe(decisionBefore);
    expect(stateAfter.processing_state).toBe("QUEUED_FOR_AI");
    expect((await routedRevisionIds(jobB.canonicalJobId))[TEST_LANE]).toBe(changed.laneRevisionId);
    expect(await queuedCount(jobB.canonicalJobId)).toBe(1);
    const tasksAfter = await db().query<{ task_type: string; status: string }>(
      `SELECT task_type, status FROM pipeline_tasks
       WHERE workspace_id = $1 AND payload->>'job_version_id' = $2
       ORDER BY task_type, status`,
      [ctx().workspaceId, jobB.jobVersionId],
    );
    expect(tasksAfter.rows.every((task) => task.status === "COMPLETED")).toBe(true);
    expect(tasksAfter.rows.map((task) => task.task_type)).toEqual(
      expect.arrayContaining(["ENQUEUE_EXPLANATION", "ROUTE_LANE"]),
    );

    const reseeded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["ROUTE_LANE"],
      includeTestFixtures: true,
    });
    expect(reseeded.supersededLaneRouting).toBe(0);
  }, 180_000);
});
