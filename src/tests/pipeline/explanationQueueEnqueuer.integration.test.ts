import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runExplanationQueueEnqueuer } from "../../pipeline/explanationQueueEnqueuer.js";
import { loadGlobalLanesConfig, loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { upsertLaneRevision } from "../../lanes/registry.js";
import { withMaximumAiInterpretationsPerRun } from "../../lanes/evaluationBudgetConfig.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) {
    throw new Error("The integration test database client is not initialized.");
  }
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) {
    throw new Error("The integration test workspace context is not initialized.");
  }
  return context;
}

async function seedBudgetFixture(): Promise<void> {
  const database = getClient();
  const workspace = getContext();
  await loadWorkspaceLanesConfig(database, { context: workspace, seedIfEmpty: true });
  const dbOnlyLane = await upsertLaneRevision(
    {
      laneKey: "DB_ONLY_BUDGET_TEST",
      content: {
        schema_version: "2.2.0",
        lane_key: "DB_ONLY_BUDGET_TEST",
        display_name: "Database only budget test",
        description: "Integration fixture lane that exists only in the workspace registry.",
        scope: {
          included_domain_concepts: { any: ["budget fixture"] },
          required_function_concepts: { any: ["test"] },
        },
        prototypes: [{ prototype_key: "db-only-test", text: "Database only budget fixture." }],
        routing: { minimum_semantic_score: 0.35 },
        budget: { maximum_ai_interpretations_per_run: 1 },
      },
    },
    database,
    { context: workspace, note: "budget enqueuer integration fixture" }
  );
  const workspaceLaneConfig = await loadWorkspaceLanesConfig(database, {
    context: workspace,
    seedIfEmpty: true,
  });
  const laneSnapshot = {
    source: workspaceLaneConfig.source,
    lanes_version: workspaceLaneConfig.config.version ?? null,
    active_lane_revisions: (workspaceLaneConfig.activeLaneRevisions ?? []).map((lane) => ({
      lane_key: lane.laneKey,
      lane_identity_id: lane.laneIdentityId,
      lane_revision_id: lane.laneRevisionId,
      revision_number: lane.revisionNumber,
      content_hash: lane.contentHash,
      activated_at: lane.activatedAt,
    })),
  };

  if (workspaceLaneConfig.source !== "LANE_REGISTRY_DB") {
    throw new Error("Budget integration requires the workspace lane registry to be active.");
  }
  const dbOnlyRevision = workspaceLaneConfig.activeLaneRevisions?.find(
    (lane) => lane.laneKey === "DB_ONLY_BUDGET_TEST"
  );
  if (!dbOnlyRevision || dbOnlyRevision.laneRevisionId !== dbOnlyLane.laneRevisionId) {
    throw new Error("Database-only lane revision was not present in the routing registry snapshot.");
  }
  if (Object.hasOwn(loadGlobalLanesConfig().lanes, "DB_ONLY_BUDGET_TEST")) {
    throw new Error("Database-only test lane unexpectedly exists in the global YAML registry.");
  }

  const activeProfile = await database.query<{ id: string }>(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
     VALUES ($1, 'budget_integration_profile', 'Budget Integration Profile')
     RETURNING id`,
    [getContext().workspaceId]
  );
  const profileVersion = await database.query<{ id: string }>(
    `INSERT INTO profile_versions (
       workspace_id, candidate_profile_id, version_number, schema_version,
       source_hash, status, effective_at
     )
     VALUES ($1, $2, 1, '2.2.0', 'budget-integration-profile-v1', 'ACTIVE', NOW())
     RETURNING id`,
    [getContext().workspaceId, activeProfile.rows[0].id]
  );
  const policySnapshot = await database.query<{ id: string }>(
    `INSERT INTO workspace_policy_snapshots (
       workspace_id, snapshot_hash, schema_version, resolved_snapshot
     )
     VALUES ($1, 'budget-integration-policy-v1', '2.2.0', $2::jsonb)
     RETURNING id`,
    [getContext().workspaceId, JSON.stringify({ fixture: "budget-integration" })]
  );

  for (let index = 1; index <= 6; index += 1) {
    const laneKey = index <= 4 ? "CORE_AI_DATA" : "DB_ONLY_BUDGET_TEST";
    const canonicalJob = await database.query<{ id: string }>(
      `INSERT INTO canonical_jobs (
         workspace_id, company_name, normalized_title, canonical_url,
         location_summary, workplace_type, employment_type,
         processing_status, processing_state, gate_decision, primary_lane,
         semantic_score, deterministic_match_score, recommendation_eligibility,
         recommendation_outcome
       )
       VALUES (
         $1, $2, $3, $4, 'Remote', 'REMOTE', 'PERMANENT',
         'MATCHED', 'MATCHED', 'PASS', $5, 0.80, 80.00,
         'ELIGIBLE', 'PRIORITY'
       )
       RETURNING id`,
      [
        getContext().workspaceId,
        `Budget Fixture Company ${index}`,
        `AI Platform Engineer ${index}`,
        `https://example.test/budget-${index}`,
        laneKey,
      ]
    );
    const canonicalJobId = canonicalJob.rows[0].id;
    const contentHash = `budget-integration-content-${index}`;
    const jobVersion = await database.query<{ id: string }>(
      `INSERT INTO job_versions (
         workspace_id, canonical_job_id, version_number, content_hash, description_text
       )
       VALUES ($1, $2, 1, $3, $4)
       RETURNING id`,
      [
        getContext().workspaceId,
        canonicalJobId,
        contentHash,
        `Build production AI platform services for fixture company ${index}.`,
      ]
    );
    const jobVersionId = jobVersion.rows[0].id;
    const requirementIdentity = await database.query<{ id: string }>(
      `INSERT INTO requirement_set_identities (
         workspace_id, canonical_job_id, identity_hash, job_content_hash,
         deterministic_extractor_version, quoted_extractor_version,
         quoted_prompt_hash, normalizer_hash, quoted_enabled
       )
       VALUES ($1, $2, $3, $4, 'deterministic-fixture-v1', 'quoted-fixture-v1',
               'quoted-prompt-fixture-v1', 'normalizer-fixture-v1', FALSE)
       RETURNING id`,
      [
        getContext().workspaceId,
        canonicalJobId,
        `budget-integration-identity-${index}`,
        contentHash,
      ]
    );
    const requirementSet = await database.query<{ id: string }>(
      `INSERT INTO requirement_sets (
         workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
         revision_number, source_type
       )
       VALUES ($1, $2, $3, $4, 1, 'EXTRACTED')
       RETURNING id`,
      [getContext().workspaceId, requirementIdentity.rows[0].id, canonicalJobId, jobVersionId]
    );
    const requirementSetId = requirementSet.rows[0].id;
    await database.query(
      `UPDATE job_versions
       SET active_requirement_set_id = $1
       WHERE id = $2 AND workspace_id = $3`,
      [requirementSetId, jobVersionId, getContext().workspaceId]
    );
    const contextFingerprint = `budget-integration-context-${index}`;
    const matchRun = await database.query<{ id: string }>(
      `INSERT INTO match_runs (
         workspace_id, canonical_job_id, job_version_id, profile_version_id,
         requirement_set_id, status, requirement_count, matched_count,
         coverage_score, overall_match_score, policy_version,
         job_content_hash, context_fingerprint, completed_at
       )
       VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 1, 1, 100.00, 80.00,
               'budget-fixture-v1', $6, $7, NOW())
       RETURNING id`,
      [
        getContext().workspaceId,
        canonicalJobId,
        jobVersionId,
        profileVersion.rows[0].id,
        requirementSetId,
        contentHash,
        contextFingerprint,
      ]
    );
    const matchRunId = matchRun.rows[0].id;
    const decision = await database.query<{ id: string }>(
      `INSERT INTO deterministic_decisions (
         workspace_id, canonical_job_id, job_version_id, match_run_id,
         policy_snapshot_id, decision_hash, schema_version, decision_json,
         recommendation_eligibility, recommendation_outcome, context_fingerprint
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2.2.0', $7::jsonb,
               'ELIGIBLE', 'PRIORITY', $8)
       RETURNING id`,
      [
        getContext().workspaceId,
        canonicalJobId,
        jobVersionId,
        matchRunId,
        policySnapshot.rows[0].id,
        `budget-integration-decision-${index}`,
        JSON.stringify({ fixture: "budget-integration", index }),
        contextFingerprint,
      ]
    );
    await database.query(
      `UPDATE canonical_jobs
       SET latest_job_version_id = $1,
           latest_match_run_id = $2,
           latest_deterministic_decision_id = $3
       WHERE id = $4 AND workspace_id = $5`,
      [jobVersionId, matchRunId, decision.rows[0].id, canonicalJobId, getContext().workspaceId]
    );

    const laneDecision = await database.query<{ id: string }>(
      `INSERT INTO lane_decisions (
         workspace_id, canonical_job_id, job_version_id, decision_hash,
         schema_version, model_version, lane_snapshot, decision_json
       )
       VALUES ($1, $2, $3, $4, '2.2.0', 'budget-fixture-v1', $5::jsonb, $6::jsonb)
       RETURNING id`,
      [
        getContext().workspaceId,
        canonicalJobId,
        jobVersionId,
        `budget-integration-lane-decision-${index}`,
        JSON.stringify(laneSnapshot),
        JSON.stringify({
          schema_version: "2.2.0",
          canonical_job_id: canonicalJobId,
          job_version_id: jobVersionId,
          primary_lane: laneKey,
          secondary_lanes: [],
          lane_confidence: "high",
          semantic_scores: {},
          lane_evidence: ["budget integration fixture"],
          evaluated_at: new Date().toISOString(),
        }),
      ]
    );
    await database.query(
      `UPDATE canonical_jobs
       SET latest_lane_decision_id = $1
       WHERE workspace_id = $2 AND id = $3`,
      [laneDecision.rows[0].id, getContext().workspaceId, canonicalJobId]
    );
  }
}

describe.skipIf(skipReal)("Explanation queue budget integration", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `budget_enqueue_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    await seedBudgetFixture();
  });

  afterAll(async () => {
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

  it("rejects a partially populated lane configuration snapshot", async () => {
    const database = getClient();
    const workspace = getContext();
    const budgetRunId = crypto.randomUUID();
    await database.query(
      `INSERT INTO ai_evaluation_budget_runs (id, workspace_id) VALUES ($1::uuid, $2::uuid)`,
      [budgetRunId, workspace.workspaceId]
    );

    await database.query("BEGIN");
    try {
      await expect(database.query(
        `UPDATE ai_evaluation_budget_runs
         SET lane_config_source = NULL,
             lane_config_version = 'lane-registry-v1',
             lane_config_hash = $2,
             lane_config_snapshot = '{}'::jsonb
         WHERE id = $1::uuid AND workspace_id = $3::uuid`,
        [budgetRunId, "a".repeat(64), workspace.workspaceId]
      )).rejects.toThrow(/ai_evaluation_budget_runs_lane_config_snapshot_check/i);
    } finally {
      await database.query("ROLLBACK");
    }
  });

  it("seeds an empty workspace lane registry before pinning its budget snapshot", async () => {
    const database = getClient();
    const suffix = crypto.randomUUID();
    const workspaceKey = `budget-seed-${suffix}`;
    const userKey = `budget-seed-user-${suffix}`;
    const workspaceInsert = await database.query<{ id: string }>(
      `INSERT INTO workspaces (workspace_key, display_name)
       VALUES ($1, 'Budget Seed Integration Workspace')
       RETURNING id`,
      [workspaceKey]
    );
    const userInsert = await database.query<{ id: string }>(
      `INSERT INTO workspace_users (user_key, display_name)
       VALUES ($1, 'Budget Seed Integration User')
       RETURNING id`,
      [userKey]
    );
    await database.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
      [workspaceInsert.rows[0].id, userInsert.rows[0].id]
    );
    const seedContext = await resolveWorkspaceContext(database, { workspaceKey, userKey });
    const budgetRunId = crypto.randomUUID();

    expect(await runExplanationQueueEnqueuer(database, {
      context: seedContext,
      budgetRunId,
    })).toEqual({ enqueued: 0, updated: 0, deferred: 0 });

    const seededConfig = await loadWorkspaceLanesConfig(database, {
      context: seedContext,
      seedIfEmpty: false,
    });
    expect(seededConfig.source).toBe("LANE_REGISTRY_DB");
    expect(seededConfig.activeLaneRevisions?.length).toBeGreaterThan(0);
    const pinnedRun = await database.query<{
      lane_config_source: string;
      lane_config_version: string;
      lane_config_snapshot: { source: string; version: string; budgets: Record<string, unknown> };
    }>(
      `SELECT lane_config_source, lane_config_version, lane_config_snapshot
       FROM ai_evaluation_budget_runs
       WHERE id = $1::uuid AND workspace_id = $2::uuid`,
      [budgetRunId, seedContext.workspaceId]
    );
    expect(pinnedRun.rows[0]).toMatchObject({
      lane_config_source: "LANE_REGISTRY_DB",
      lane_config_version: seededConfig.config.version,
      lane_config_snapshot: {
        source: "LANE_REGISTRY_DB",
        version: seededConfig.config.version,
      },
    });

    const laneToUpdate = seededConfig.activeLaneRevisions?.[0];
    if (!laneToUpdate) throw new Error("The seeded workspace has no active lane to update.");
    await upsertLaneRevision({
      laneKey: laneToUpdate.laneKey,
      content: withMaximumAiInterpretationsPerRun(laneToUpdate.content, 10),
    }, database, {
      context: seedContext,
      note: "integration test per-lane evaluation budget registry update",
    });
    const updatedBudgetRunId = crypto.randomUUID();
    await runExplanationQueueEnqueuer(database, {
      context: seedContext,
      budgetRunId: updatedBudgetRunId,
    });
    const updatedSnapshot = await database.query<{
      lane_config_snapshot: { budgets: Record<string, { budget_limit: number }> };
    }>(
      `SELECT lane_config_snapshot
       FROM ai_evaluation_budget_runs
       WHERE id = $1::uuid AND workspace_id = $2::uuid`,
      [updatedBudgetRunId, seedContext.workspaceId]
    );
    expect(updatedSnapshot.rows[0]?.lane_config_snapshot.budgets[laneToUpdate.laneKey]?.budget_limit).toBe(10);
  }, 60_000);

  it("rejects a stale route snapshot and rolls the budget transaction back", async () => {
    const database = getClient();
    const workspace = getContext();
    const budgetRunId = "33333333-3333-4333-8333-333333333333";
    const routed = await database.query<{
      id: string;
      canonical_job_id: string;
      primary_lane: string;
      latest_lane_decision_id: string;
      job_version_id: string;
      decision_json: Record<string, unknown>;
      lane_snapshot: unknown;
    }>(
      `SELECT ld.id, ld.canonical_job_id, ld.job_version_id, ld.decision_json, ld.lane_snapshot,
              c.primary_lane, c.latest_lane_decision_id
       FROM lane_decisions ld
       JOIN canonical_jobs c
         ON c.workspace_id = ld.workspace_id
        AND c.id = ld.canonical_job_id
        AND c.latest_lane_decision_id = ld.id
       WHERE ld.workspace_id = $1
         AND ld.decision_json->>'primary_lane' = 'DB_ONLY_BUDGET_TEST'
       ORDER BY ld.created_at ASC
       LIMIT 1`,
      [workspace.workspaceId]
    );
    const route = routed.rows[0];
    if (!route) throw new Error("The budget fixture has no DB-only lane decision.");

    const malformedSnapshot = { ...(route.lane_snapshot as Record<string, unknown>) };
    delete malformedSnapshot.active_lane_revisions;
    const unconfiguredLane = "UNCONFIGURED_BUDGET_TEST";
    const malformedDecisionJson = {
      ...route.decision_json,
      primary_lane: unconfiguredLane,
    };
    const malformedDecision = await database.query<{ id: string }>(
      `INSERT INTO lane_decisions (
         workspace_id, canonical_job_id, job_version_id, decision_hash,
         schema_version, model_version, lane_snapshot, decision_json
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2.2.0', 'budget-enqueue-test', $5::jsonb, $6::jsonb)
       RETURNING id`,
      [
        workspace.workspaceId,
        route.canonical_job_id,
        route.job_version_id,
        `malformed-budget-route-${crypto.randomUUID()}`,
        JSON.stringify(malformedSnapshot),
        JSON.stringify(malformedDecisionJson),
      ]
    );
    try {
      await database.query(
        `UPDATE canonical_jobs
         SET primary_lane = $1, latest_lane_decision_id = $2::uuid
         WHERE workspace_id = $3::uuid AND id = $4::uuid`,
        [unconfiguredLane, malformedDecision.rows[0].id, workspace.workspaceId, route.canonical_job_id]
      );
      await expect(runExplanationQueueEnqueuer(database, {
        context: workspace,
        budgetRunId,
        canonicalJobIds: [route.canonical_job_id],
      })).rejects.toThrow(/latest lane decision does not use the active lane revision/);

      const persistedRun = await database.query(
        `SELECT 1 FROM ai_evaluation_budget_runs WHERE id = $1::uuid`,
        [budgetRunId]
      );
      const queueRows = await database.query(
        `SELECT 1 FROM evaluation_queue WHERE budget_run_id = $1::uuid`,
        [budgetRunId]
      );
      const deferrals = await database.query(
        `SELECT 1 FROM evaluation_budget_deferrals WHERE budget_run_id = $1::uuid`,
        [budgetRunId]
      );
      expect(persistedRun.rows).toHaveLength(0);
      expect(queueRows.rows).toHaveLength(0);
      expect(deferrals.rows).toHaveLength(0);
    } finally {
      await database.query(
        `UPDATE canonical_jobs
         SET primary_lane = $1, latest_lane_decision_id = $2::uuid
         WHERE workspace_id = $3::uuid AND id = $4::uuid`,
        [route.primary_lane, route.latest_lane_decision_id, workspace.workspaceId, route.canonical_job_id]
      );
    }
  }, 60_000);

  it("persists lane-cap deferrals and releases them on a later budget run", async () => {
    const database = getClient();
    const workspace = getContext();
    const firstBudgetRunId = "11111111-1111-4111-8111-111111111111";
    const secondBudgetRunId = "22222222-2222-4222-8222-222222222222";

    const first = await runExplanationQueueEnqueuer(database, {
      context: workspace,
      budgetRunId: firstBudgetRunId,
    });
    expect(first).toEqual({ enqueued: 4, updated: 4, deferred: 2 });

    const yamlLanes = loadGlobalLanesConfig().lanes;
    const workspaceLanes = await loadWorkspaceLanesConfig(database, {
      context: workspace,
      seedIfEmpty: true,
    });
    const dbOnlyRevision = workspaceLanes.activeLaneRevisions?.find(
      (lane) => lane.laneKey === "DB_ONLY_BUDGET_TEST"
    );
    const routedDbOnlyRevision = await database.query<{ lane_revision_id: string }>(
      `SELECT revision.value->>'lane_revision_id' AS lane_revision_id
       FROM lane_decisions ld
       JOIN canonical_jobs c
         ON c.workspace_id = ld.workspace_id
        AND c.id = ld.canonical_job_id
        AND c.latest_lane_decision_id = ld.id
       CROSS JOIN LATERAL jsonb_array_elements(ld.lane_snapshot->'active_lane_revisions') revision(value)
       WHERE ld.workspace_id = $1
         AND ld.decision_json->>'primary_lane' = 'DB_ONLY_BUDGET_TEST'
         AND revision.value->>'lane_key' = 'DB_ONLY_BUDGET_TEST'
       ORDER BY ld.created_at ASC
       LIMIT 1`,
      [workspace.workspaceId]
    );
    expect(yamlLanes).not.toHaveProperty("DB_ONLY_BUDGET_TEST");
    expect(workspaceLanes.source).toBe("LANE_REGISTRY_DB");
    expect(dbOnlyRevision?.laneRevisionId).toBe(routedDbOnlyRevision.rows[0].lane_revision_id);

    const firstQueue = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM evaluation_queue
       WHERE workspace_id = $1 AND budget_run_id = $2 AND status = 'PENDING'`,
      [workspace.workspaceId, firstBudgetRunId]
    );
    const firstDeferrals = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM evaluation_budget_deferrals
       WHERE workspace_id = $1 AND budget_run_id = $2`,
      [workspace.workspaceId, firstBudgetRunId]
    );
    const usage = await database.query<{ budget_limit: number; selected_count: number }>(
      `SELECT budget_limit, selected_count
       FROM ai_evaluation_budget_usage
       WHERE workspace_id = $1 AND budget_run_id = $2 AND lane = 'CORE_AI_DATA'`,
      [workspace.workspaceId, firstBudgetRunId]
    );
    expect(firstQueue.rows[0].count).toBe(4);
    expect(firstDeferrals.rows[0].count).toBe(2);
    expect(usage.rows[0]).toEqual({ budget_limit: 3, selected_count: 3 });
    const dbOnlyUsage = await database.query<{ budget_limit: number; selected_count: number }>(
      `SELECT budget_limit, selected_count
       FROM ai_evaluation_budget_usage
       WHERE workspace_id = $1 AND budget_run_id = $2 AND lane = 'DB_ONLY_BUDGET_TEST'`,
      [workspace.workspaceId, firstBudgetRunId]
    );
    expect(dbOnlyUsage.rows[0]).toEqual({ budget_limit: 1, selected_count: 1 });

    const retry = await runExplanationQueueEnqueuer(database, {
      context: workspace,
      budgetRunId: firstBudgetRunId,
    });
    expect(retry).toEqual({ enqueued: 0, updated: 0, deferred: 0 });

    await database.query("BEGIN");
    try {
      await expect(database.query(
        `UPDATE ai_evaluation_budget_runs
         SET lane_config_snapshot = '{}'::jsonb
         WHERE id = $1::uuid AND workspace_id = $2::uuid`,
        [firstBudgetRunId, workspace.workspaceId]
      )).rejects.toThrow(/snapshots are immutable/i);
    } finally {
      await database.query("ROLLBACK");
    }

    const configBeforeChange = await loadWorkspaceLanesConfig(database, { context: workspace });
    const dbOnlyLane = configBeforeChange.activeLaneRevisions?.find(
      (lane) => lane.laneKey === "DB_ONLY_BUDGET_TEST"
    );
    if (!dbOnlyLane) throw new Error("The DB-only budget lane was not active for the retry snapshot test.");
    const changedLaneContent = {
      ...dbOnlyLane.content,
      budget: { ...dbOnlyLane.content.budget, maximum_ai_interpretations_per_run: 2 },
    };
    await upsertLaneRevision(
      { laneKey: "DB_ONLY_BUDGET_TEST", content: changedLaneContent },
      database,
      { context: workspace, note: "verify budget run rejects changed lane revision" }
    );
    try {
      await expect(runExplanationQueueEnqueuer(database, {
        context: workspace,
        budgetRunId: firstBudgetRunId,
      })).rejects.toThrow(/different lane configuration snapshot/);
    } finally {
      await upsertLaneRevision(
        { laneKey: "DB_ONLY_BUDGET_TEST", content: dbOnlyLane.content },
        database,
        { context: workspace, note: "restore budget fixture lane revision" }
      );
    }

    const laterRun = await runExplanationQueueEnqueuer(database, {
      context: workspace,
      budgetRunId: secondBudgetRunId,
    });
    expect(laterRun).toEqual({ enqueued: 2, updated: 2, deferred: 0 });

    const finalState = await database.query<{ processing_state: string; count: number }>(
      `SELECT processing_state, COUNT(*)::int AS count
       FROM canonical_jobs
       WHERE workspace_id = $1
       GROUP BY processing_state`,
      [workspace.workspaceId]
    );
    expect(finalState.rows).toEqual(
      expect.arrayContaining([
        { processing_state: "QUEUED_FOR_AI", count: 6 },
      ])
    );

    const totalQueue = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM evaluation_queue
       WHERE workspace_id = $1 AND status = 'PENDING'`,
      [workspace.workspaceId]
    );
    expect(totalQueue.rows[0].count).toBe(6);
  }, 60_000);

  it("supersedes a mismatched active duplicate and preserves the authoritative queue row", async () => {
    const database = getClient();
    const workspace = getContext();
    const currentQueue = await database.query<{
      id: string;
      canonical_job_id: string;
      job_version_id: string;
      profile_version_id: string;
      match_run_id: string;
      deterministic_decision_id: string;
      job_content_hash: string;
      context_fingerprint: string;
      lane: string;
      priority_score: number;
      budget_run_id: string | null;
    }>(
      `SELECT id, canonical_job_id, job_version_id, profile_version_id,
              match_run_id, deterministic_decision_id, job_content_hash,
              context_fingerprint, lane, priority_score, budget_run_id
       FROM evaluation_queue
       WHERE workspace_id = $1 AND status = 'PENDING'
       ORDER BY enqueued_at ASC, id ASC
       LIMIT 1`,
      [workspace.workspaceId],
    );
    const authoritative = currentQueue.rows[0];
    if (!authoritative) throw new Error("The budget fixture did not leave an authoritative active queue row.");

    const staleQueueId = crypto.randomUUID();
    await database.query(
      `INSERT INTO evaluation_queue (
         id, workspace_id, canonical_job_id, job_version_id, profile_version_id,
         match_run_id, deterministic_decision_id, job_content_hash,
         context_fingerprint, lane, priority_score, budget_run_id, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING')`,
      [
        staleQueueId,
        workspace.workspaceId,
        authoritative.canonical_job_id,
        authoritative.job_version_id,
        authoritative.profile_version_id,
        authoritative.match_run_id,
        authoritative.deterministic_decision_id,
        authoritative.job_content_hash,
        `stale-context-${crypto.randomUUID()}`,
        authoritative.lane,
        authoritative.priority_score,
        authoritative.budget_run_id,
      ],
    );

    const enqueued = await runExplanationQueueEnqueuer(database, {
      context: workspace,
      jobVersionIds: [authoritative.job_version_id],
      canonicalJobIds: [authoritative.canonical_job_id],
      limit: 1,
      budgetRunId: crypto.randomUUID(),
    });
    expect(enqueued.enqueued).toBe(0);

    const rows = await database.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM evaluation_queue
       WHERE workspace_id = $1
         AND job_version_id = $2
         AND status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT', 'SUPERSEDED')
       ORDER BY id`,
      [workspace.workspaceId, authoritative.job_version_id],
    );
    expect(rows.rows).toEqual(expect.arrayContaining([
      { id: authoritative.id, status: "PENDING" },
      { id: staleQueueId, status: "SUPERSEDED" },
    ]));
    expect(rows.rows).toHaveLength(2);

    const duplicateGroups = await database.query<{ job_version_id: string }>(
      `SELECT job_version_id
       FROM evaluation_queue
       WHERE workspace_id = $1
         AND job_version_id = $2
         AND profile_version_id = $3
         AND match_run_id = $4
         AND deterministic_decision_id = $5
         AND status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
       GROUP BY job_version_id, profile_version_id, match_run_id, deterministic_decision_id
       HAVING COUNT(*) > 1`,
      [
        workspace.workspaceId,
        authoritative.job_version_id,
        authoritative.profile_version_id,
        authoritative.match_run_id,
        authoritative.deterministic_decision_id,
      ],
    );
    expect(duplicateGroups.rows).toHaveLength(0);
  }, 60_000);
});
