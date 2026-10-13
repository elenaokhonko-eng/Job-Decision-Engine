import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runExplanationQueueEnqueuer } from "../../pipeline/explanationQueueEnqueuer.js";
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

  for (let index = 1; index <= 4; index += 1) {
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
         'MATCHED', 'MATCHED', 'PASS', 'CORE_AI_DATA', 0.80, 80.00,
         'ELIGIBLE', 'PRIORITY'
       )
       RETURNING id`,
      [
        getContext().workspaceId,
        `Budget Fixture Company ${index}`,
        `AI Platform Engineer ${index}`,
        `https://example.test/budget-${index}`,
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

  it("persists lane-cap deferrals and releases them on a later budget run", async () => {
    const database = getClient();
    const workspace = getContext();
    const firstBudgetRunId = "11111111-1111-4111-8111-111111111111";
    const secondBudgetRunId = "22222222-2222-4222-8222-222222222222";

    const first = await runExplanationQueueEnqueuer(database, {
      context: workspace,
      budgetRunId: firstBudgetRunId,
    });
    expect(first).toEqual({ enqueued: 3, updated: 3, deferred: 1 });

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
    expect(firstQueue.rows[0].count).toBe(3);
    expect(firstDeferrals.rows[0].count).toBe(1);
    expect(usage.rows[0]).toEqual({ budget_limit: 3, selected_count: 3 });

    const retry = await runExplanationQueueEnqueuer(database, {
      context: workspace,
      budgetRunId: firstBudgetRunId,
    });
    expect(retry).toEqual({ enqueued: 0, updated: 0, deferred: 0 });

    const laterRun = await runExplanationQueueEnqueuer(database, {
      context: workspace,
      budgetRunId: secondBudgetRunId,
    });
    expect(laterRun).toEqual({ enqueued: 1, updated: 1, deferred: 0 });

    const finalState = await database.query<{ processing_state: string; count: number }>(
      `SELECT processing_state, COUNT(*)::int AS count
       FROM canonical_jobs
       WHERE workspace_id = $1
       GROUP BY processing_state`,
      [workspace.workspaceId]
    );
    expect(finalState.rows).toEqual(
      expect.arrayContaining([
        { processing_state: "QUEUED_FOR_AI", count: 4 },
      ])
    );

    const totalQueue = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM evaluation_queue
       WHERE workspace_id = $1 AND status = 'PENDING'`,
      [workspace.workspaceId]
    );
    expect(totalQueue.rows[0].count).toBe(4);
  }, 60_000);
});
