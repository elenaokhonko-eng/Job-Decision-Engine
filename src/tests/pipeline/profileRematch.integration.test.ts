import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runEmbeddingBatchWithFallback } from "../../embeddings/batchCoordinator.js";
import { upsertLaneRevision } from "../../lanes/registry.js";
import { runExplanationQueueEnqueuer } from "../../pipeline/explanationQueueEnqueuer.js";
import { loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { runLaneRouter } from "../../pipeline/laneRouter.js";
import {
  runPipelineStageTaskWorker,
  seedRecoverablePipelineTasks,
} from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { batchEmbeddingFromPerInput } from "../fixtures/embeddingBatchMock.js";
import { insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// Real PostgreSQL: profile versions, the lane router, the deterministic matcher, the
// recommendation decider, the explanation enqueuer, the seeder and the task worker all run against
// migrated tables. Only the embedding provider is replaced by a deterministic synthetic vector
// function. All jobs, employers and profile facts are synthetic.
const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const TEST_LANE = "ZEBRA_REMATCH_TEST";
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

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let candidateProfileId = "";
let profileV1 = "";
let profileV2 = "";
let policySnapshotId = "";
const jobs: Record<"reviewA" | "reviewB" | "trackStale" | "reviewCurrent" | "trackCurrent", FixtureJob> = {} as never;
const supersededMatchRunIds: Record<string, string> = {};

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

async function seedRoutableJob(key: string, requirementTexts: readonly string[]): Promise<FixtureJob> {
  const workspaceId = ctx().workspaceId;
  const description = [
    `About the role: zebra telemetry platform engineer (${key}) at a synthetic fixture employer.`,
    "Responsibilities: build and operate zebra telemetry ingestion services, review designs and support releases.",
    "Requirements: production platform engineering experience with streaming telemetry systems.",
  ].join(" ");
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location_summary, workplace_type, employment_type,
       processing_status, processing_state, gate_decision
     ) VALUES ($1, $2, $3, $4, 'Remote', 'REMOTE', 'PERMANENT', 'PREQUALIFIED', 'PREQUALIFIED', 'PASS')
     RETURNING id`,
    [workspaceId, `Synthetic Zebra Rematch Fixture ${key}`, `Zebra Telemetry Platform Engineer ${key}`,
     `https://example.test/zebra-rematch-${key}`],
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

/** A stored match + decision for a job, as an earlier pipeline run left it. */
async function recordMatchAndDecision(
  job: FixtureJob,
  profileVersionId: string,
  outcome: "REVIEW" | "TRACK",
  score: number,
): Promise<string> {
  const workspaceId = ctx().workspaceId;
  const fingerprint = `zebra-rematch-${job.canonicalJobId}-${profileVersionId}`;
  const matchRun = await db().query<{ id: string }>(
    `INSERT INTO match_runs (
       workspace_id, canonical_job_id, job_version_id, profile_version_id,
       requirement_set_id, status, requirement_count, matched_count,
       coverage_score, overall_match_score, policy_version,
       job_content_hash, context_fingerprint, embedding_space_id, completed_at
     ) VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 1, 1, 100.00, $6,
               'zebra-rematch-fixture-v1', $7, $8, $9, NOW())
     RETURNING id`,
    [workspaceId, job.canonicalJobId, job.jobVersionId, profileVersionId, job.requirementSetId,
     score, job.contentHash, fingerprint, await primaryEmbeddingSpaceId()],
  );
  const decision = await db().query<{ id: string }>(
    `INSERT INTO deterministic_decisions (
       workspace_id, canonical_job_id, job_version_id, match_run_id,
       policy_snapshot_id, decision_hash, schema_version, decision_json,
       recommendation_eligibility, recommendation_outcome, context_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, '2.2.0', $7::jsonb, 'ELIGIBLE', $8, $9)
     RETURNING id`,
    [workspaceId, job.canonicalJobId, job.jobVersionId, matchRun.rows[0].id, policySnapshotId,
     `zebra-rematch-decision-${fingerprint}`, JSON.stringify({ fixture: "zebra-rematch" }), outcome, fingerprint],
  );
  await db().query(
    `UPDATE canonical_jobs
     SET latest_match_run_id = $1, latest_deterministic_decision_id = $2,
         processing_state = 'MATCHED', processing_status = 'MATCHED',
         deterministic_match_score = $3, deterministic_match_coverage = 100.00,
         profile_match_status = 'POSITIVE_MATCH',
         recommendation_eligibility = 'ELIGIBLE', recommendation_outcome = $4
     WHERE workspace_id = $5 AND id = $6`,
    [matchRun.rows[0].id, decision.rows[0].id, score, outcome, workspaceId, job.canonicalJobId],
  );
  return matchRun.rows[0].id;
}

async function jobState(job: FixtureJob) {
  const { rows } = await db().query<{
    processing_state: string;
    recommendation_outcome: string | null;
    latest_match_run_id: string;
    match_profile_version_id: string;
    decision_match_run_id: string | null;
    latest_lane_decision_id: string;
  }>(
    `SELECT c.processing_state, c.recommendation_outcome, c.latest_match_run_id::text AS latest_match_run_id,
            mr.profile_version_id::text AS match_profile_version_id,
            dd.match_run_id::text AS decision_match_run_id,
            c.latest_lane_decision_id::text AS latest_lane_decision_id
     FROM canonical_jobs c
     JOIN match_runs mr ON mr.id = c.latest_match_run_id
     LEFT JOIN deterministic_decisions dd ON dd.id = c.latest_deterministic_decision_id
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [ctx().workspaceId, job.canonicalJobId],
  );
  return rows[0];
}

async function tasksFor(job: FixtureJob, taskType: string) {
  const { rows } = await db().query<{ task_key: string; status: string; blocked_on: string | null; repair_action: string | null }>(
    `SELECT task_key, status, blocked_on, repair_action FROM pipeline_tasks
     WHERE workspace_id = $1 AND task_type = $2 AND payload->>'job_version_id' = $3
     ORDER BY created_at, id`,
    [ctx().workspaceId, taskType, job.jobVersionId],
  );
  return rows;
}

async function activeQueueRows(job: FixtureJob) {
  const { rows } = await db().query<{ match_run_id: string; profile_version_id: string; budget_run_id: string }>(
    `SELECT match_run_id::text AS match_run_id, profile_version_id::text AS profile_version_id,
            budget_run_id::text AS budget_run_id
     FROM evaluation_queue
     WHERE workspace_id = $1 AND canonical_job_id = $2 AND status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')`,
    [ctx().workspaceId, job.canonicalJobId],
  );
  return rows;
}

async function budgetDeferrals(job: FixtureJob, budgetRunId: string): Promise<string[]> {
  const { rows } = await db().query<{ reason_code: string }>(
    `SELECT reason_code FROM evaluation_budget_deferrals
     WHERE workspace_id = $1 AND canonical_job_id = $2 AND budget_run_id = $3::uuid`,
    [ctx().workspaceId, job.canonicalJobId, budgetRunId],
  );
  return rows.map((row) => row.reason_code);
}

// The read-only production verification report shipped with the fix, run as-is.
async function profileMatchReport(): Promise<Record<string, Record<string, unknown>>> {
  const reportSql = fs.readFileSync(
    path.resolve(process.cwd(), "scripts", "sql", "profile_match_currency_report.sql"),
    "utf8",
  );
  await db().query("BEGIN READ ONLY");
  try {
    const { rows } = await db().query<Record<string, unknown>>(reportSql);
    return Object.fromEntries(rows.map((row) => [String(row.outcome), row]));
  } finally {
    await db().query("ROLLBACK");
  }
}

const workerOptions = {
  seed: false,
  includeTestFixtures: true,
  reconcileStalePending: false,
  heartbeatSeconds: 0,
  minTimeToStartTaskMs: 0,
} as const;

describe.skipIf(skipReal)("profile re-match after the active profile version changes", () => {
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
    schemaName = `profile_rematch_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
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
          display_name: "Zebra re-match test lane",
          description: "Synthetic lane for zebra telemetry platform engineering fixtures.",
          scope: {
            included_domain_concepts: { any: ["zebra telemetry"] },
            required_function_concepts: { any: ["platform engineer"] },
          },
          prototypes: [{ prototype_key: "zebra-platform", text: "Zebra telemetry platform engineer." }],
          routing: { minimum_semantic_score: 0.35 },
          // One AI evaluation per budget run, so the budget is visible with two re-matched jobs.
          budget: { maximum_ai_interpretations_per_run: 1 },
        },
      },
      db(),
      { context: ctx(), note: "profile re-match fixture" },
    );

    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, 'zebra_rematch_profile', 'Zebra Rematch Profile') RETURNING id`,
      [ctx().workspaceId],
    );
    candidateProfileId = profile.rows[0].id;
    profileV1 = await insertProfileVersion(1, "ACTIVE");
    const policy = await db().query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, schema_version, resolved_snapshot)
       VALUES ($1, 'zebra-rematch-policy-v1', '2.2.0', '{"fixture":"zebra-rematch"}'::jsonb) RETURNING id`,
      [ctx().workspaceId],
    );
    policySnapshotId = policy.rows[0].id;

    const zebraRequirement = "Zebra telemetry platform engineering experience";
    jobs.reviewA = await seedRoutableJob("review-a", [zebraRequirement]);
    jobs.reviewB = await seedRoutableJob("review-b", [zebraRequirement]);
    // One of three requirements is covered: a positive match that stays below the REVIEW threshold.
    jobs.trackStale = await seedRoutableJob("track-stale", [
      zebraRequirement,
      "Licensed ocean freight customs brokerage",
      "Commercial aviation airframe certification",
    ]);
    jobs.reviewCurrent = await seedRoutableJob("review-current", [zebraRequirement]);
    jobs.trackCurrent = await seedRoutableJob("track-current", [zebraRequirement]);

    // Route every job with the real lane router under the active lane revisions.
    await publishEmbeddings();
    await runLaneRouter(db(), { context: ctx(), jobVersionIds: Object.values(jobs).map((job) => job.jobVersionId) });
    for (const job of Object.values(jobs)) {
      const routed = await db().query<{ processing_state: string; primary_lane: string }>(
        `SELECT processing_state, primary_lane FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
        [ctx().workspaceId, job.canonicalJobId],
      );
      expect(routed.rows[0]).toEqual({ processing_state: "LANE_ROUTED", primary_lane: TEST_LANE });
    }

    // October: three jobs were matched and decided against profile v1.
    supersededMatchRunIds.reviewA = await recordMatchAndDecision(jobs.reviewA, profileV1, "REVIEW", 80);
    supersededMatchRunIds.reviewB = await recordMatchAndDecision(jobs.reviewB, profileV1, "REVIEW", 80);
    supersededMatchRunIds.trackStale = await recordMatchAndDecision(jobs.trackStale, profileV1, "TRACK", 30);
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

  it("seeds AI enqueue only for PRIORITY/REVIEW outcomes, never for TRACK", async () => {
    const seeded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["ENQUEUE_EXPLANATION", "MATCH_PROFILE_EVIDENCE"],
      includeTestFixtures: true,
      // The other two fixtures are still LANE_ROUTED and would get first-time matches.
      jobVersionIds: [jobs.reviewA.jobVersionId, jobs.reviewB.jobVersionId, jobs.trackStale.jobVersionId],
    });
    // Profile v1 is still active: nothing is superseded, and TRACK gets no enqueue task.
    expect(seeded.supersededProfileMatch).toBe(0);
    expect(seeded.byType.MATCH_PROFILE_EVIDENCE ?? { inserted: 0, existing: 0 }).toEqual({ inserted: 0, existing: 0 });
    expect(seeded.byType.ENQUEUE_EXPLANATION).toEqual({ inserted: 2, existing: 0 });
    expect(await tasksFor(jobs.reviewA, "ENQUEUE_EXPLANATION")).toHaveLength(1);
    expect(await tasksFor(jobs.reviewB, "ENQUEUE_EXPLANATION")).toHaveLength(1);
    expect(await tasksFor(jobs.trackStale, "ENQUEUE_EXPLANATION")).toEqual([]);

    // The enqueuer itself never selects a TRACK job, even when asked for it explicitly.
    expect(await runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [jobs.trackStale.canonicalJobId],
      budgetRunId: crypto.randomUUID(),
    })).toEqual({ enqueued: 0, updated: 0, deferred: 0 });
    expect(await activeQueueRows(jobs.trackStale)).toEqual([]);
  }, 60_000);

  it("reports and re-matches only jobs matched against a superseded profile version", async () => {
    // Go-live: a restored profile version becomes the only ACTIVE one.
    await db().query(
      `UPDATE profile_versions SET status = 'RETIRED' WHERE workspace_id = $1 AND id = $2`,
      [ctx().workspaceId, profileV1],
    );
    profileV2 = await insertProfileVersion(2, "ACTIVE");
    await publishEmbeddings();

    // Jobs matched after the switch are current and must be left alone.
    await recordMatchAndDecision(jobs.reviewCurrent, profileV2, "REVIEW", 80);
    await recordMatchAndDecision(jobs.trackCurrent, profileV2, "TRACK", 30);
    expect(await runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [jobs.reviewCurrent.canonicalJobId, jobs.trackCurrent.canonicalJobId],
      budgetRunId: crypto.randomUUID(),
    })).toEqual({ enqueued: 1, updated: 1, deferred: 0 });
    const currentQueued = await activeQueueRows(jobs.reviewCurrent);
    expect(currentQueued).toHaveLength(1);
    expect(currentQueued[0].profile_version_id).toBe(profileV2);

    // The production symptom: a stale-profile REVIEW job is silently not selected.
    expect(await runExplanationQueueEnqueuer(db(), {
      context: ctx(),
      canonicalJobIds: [jobs.reviewA.canonicalJobId],
      budgetRunId: crypto.randomUUID(),
    })).toEqual({ enqueued: 0, updated: 0, deferred: 0 });

    const report = await profileMatchReport();
    expect(Object.keys(report).sort()).toEqual(["ALL", "REVIEW", "TRACK"]);
    expect(report.REVIEW).toMatchObject({
      eligible_jobs: 3,
      ai_evaluated_outcome: 3,
      current_profile_match: 1,
      needs_rematch: 2,
      other_match_not_current: 0,
      decision_on_current_match: 1,
      rematch_task_queued: 0,
      enqueue_task_any: 2,
      enqueue_task_outstanding: 2,
      queued_or_evaluated_current: 1,
      enqueue_path_after_fix: 3,
      excluded_from_ai_by_outcome: 0,
    });
    expect(report.TRACK).toMatchObject({
      eligible_jobs: 2,
      ai_evaluated_outcome: 0,
      current_profile_match: 1,
      needs_rematch: 1,
      enqueue_task_any: 0,
      enqueue_path_after_fix: 0,
      excluded_from_ai_by_outcome: 2,
    });
    expect(report.ALL).toMatchObject({ eligible_jobs: 5, needs_rematch: 3, enqueue_path_after_fix: 3 });

    // An AI enqueue task that meets a stale-profile job queues a re-match and blocks on it.
    const blocked = await runPipelineStageTaskWorker(db(), {
      ...workerOptions,
      context: ctx(),
      taskTypes: ["ENQUEUE_EXPLANATION"],
      jobVersionIds: [jobs.reviewA.jobVersionId, jobs.reviewB.jobVersionId],
      maxTasks: 5,
    });
    expect(blocked.errors).toEqual([]);
    expect(blocked.blocked).toBe(2);
    expect(blocked.profileMatchSuperseded).toBe(2);
    expect(blocked.laneRoutingSuperseded).toBe(0);
    for (const key of ["reviewA", "reviewB"] as const) {
      expect(await tasksFor(jobs[key], "ENQUEUE_EXPLANATION")).toEqual([{
        task_key: expect.any(String),
        status: "BLOCKED_DEPENDENCY",
        blocked_on: `PROFILE_MATCH_SUPERSEDED:${jobs[key].jobVersionId}`,
        repair_action: "MATCH_PROFILE_EVIDENCE",
      }]);
      expect(await tasksFor(jobs[key], "MATCH_PROFILE_EVIDENCE")).toEqual([{
        task_key: `MATCH_PROFILE_EVIDENCE:${jobs[key].jobVersionId}:deterministic_matcher_v1:` +
          `rematch-${supersededMatchRunIds[key]}:profile:${profileV2}`,
        status: "PENDING",
        blocked_on: null,
        repair_action: null,
      }]);
    }

    // The seeder finds the same three superseded matches (TRACK included: a re-match is
    // deterministic and can promote it), does not duplicate queued re-matches, and leaves the
    // current jobs alone.
    const seeded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["MATCH_PROFILE_EVIDENCE"],
      includeTestFixtures: true,
    });
    expect(seeded.supersededProfileMatch).toBe(3);
    expect(seeded.byType.MATCH_PROFILE_EVIDENCE).toEqual({ inserted: 1, existing: 2 });
    expect(await tasksFor(jobs.trackStale, "MATCH_PROFILE_EVIDENCE")).toHaveLength(1);
    expect(await tasksFor(jobs.reviewCurrent, "MATCH_PROFILE_EVIDENCE")).toEqual([]);
    expect(await tasksFor(jobs.trackCurrent, "MATCH_PROFILE_EVIDENCE")).toEqual([]);

    const bounded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["MATCH_PROFILE_EVIDENCE"],
      includeTestFixtures: true,
      maxSeedPerType: 1,
    });
    expect(bounded.supersededProfileMatch).toBe(1);
    expect((await profileMatchReport()).ALL).toMatchObject({ needs_rematch: 3, rematch_task_queued: 3 });
  }, 120_000);

  it("re-matches through tasks, re-decides, then enqueues within the AI budget", async () => {
    const before = {
      reviewCurrent: await jobState(jobs.reviewCurrent),
      trackCurrent: await jobState(jobs.trackCurrent),
      reviewA: await jobState(jobs.reviewA),
    };
    const recovered = await runPipelineStageTaskWorker(db(), {
      ...workerOptions,
      context: ctx(),
      taskTypes: ["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"],
      maxTasks: 40,
    });
    expect(recovered.errors).toEqual([]);
    expect(recovered.failed).toBe(0);
    expect(recovered.deadLettered).toBe(0);
    expect(recovered.blocked).toBe(0);
    expect(recovered.profileMatchSuperseded).toBe(0);

    // Every stale job now has a match for profile v2 and a decision made from it. Lane routing
    // was not replayed.
    for (const key of ["reviewA", "reviewB", "trackStale"] as const) {
      const state = await jobState(jobs[key]);
      expect(state.match_profile_version_id).toBe(profileV2);
      expect(state.latest_match_run_id).not.toBe(supersededMatchRunIds[key]);
      expect(state.decision_match_run_id).toBe(state.latest_match_run_id);
    }
    expect((await jobState(jobs.reviewA)).latest_lane_decision_id).toBe(before.reviewA.latest_lane_decision_id);

    // The deterministic decider sets the outcomes: the covered jobs stay AI-eligible and the
    // partially covered job is not, so it is not sent to AI.
    const reviewA = await jobState(jobs.reviewA);
    const reviewB = await jobState(jobs.reviewB);
    // Fully covered, but workability evidence completeness (0.667) is below the PRIORITY bar.
    expect(reviewA.recommendation_outcome).toBe("REVIEW");
    expect(reviewB.recommendation_outcome).toBe("REVIEW");
    // The partially covered job (one of three requirements) falls below the REVIEW threshold and
    // its application readiness blocks it, so the deterministic decider records SKIP.
    expect((await jobState(jobs.trackStale)).recommendation_outcome).toBe("SKIP");
    expect(await tasksFor(jobs.trackStale, "ENQUEUE_EXPLANATION")).toEqual([]);
    expect(await activeQueueRows(jobs.trackStale)).toEqual([]);

    // The AI budget still applies: one evaluation per run for this lane, the other job is
    // deferred for budget (never rejected), and every enqueue task completed.
    const queuedA = await activeQueueRows(jobs.reviewA);
    const queuedB = await activeQueueRows(jobs.reviewB);
    expect(queuedA.length + queuedB.length).toBe(1);
    const [queued] = [...queuedA, ...queuedB];
    expect(queued.profile_version_id).toBe(profileV2);
    const deferredJob = queuedA.length === 1 ? jobs.reviewB : jobs.reviewA;
    expect(await budgetDeferrals(deferredJob, queued.budget_run_id)).toEqual(["AI_BUDGET_EXHAUSTED"]);
    const deferredState = await jobState(deferredJob);
    expect(deferredState.processing_state).toBe("MATCHED");
    for (const key of ["reviewA", "reviewB"] as const) {
      const enqueueTasks = await tasksFor(jobs[key], "ENQUEUE_EXPLANATION");
      expect(enqueueTasks.length).toBeGreaterThan(0);
      expect(enqueueTasks.every((task) => task.status === "COMPLETED")).toBe(true);
    }

    // Unchanged jobs were neither re-matched nor re-decided.
    expect(await jobState(jobs.reviewCurrent)).toEqual(before.reviewCurrent);
    expect(await jobState(jobs.trackCurrent)).toEqual(before.trackCurrent);
    expect(await tasksFor(jobs.reviewCurrent, "MATCH_PROFILE_EVIDENCE")).toEqual([]);
    expect(await tasksFor(jobs.trackCurrent, "DECIDE_RECOMMENDATION")).toEqual([]);

    // The SKIP job left the eligible set; nothing needs a re-match any more.
    const report = await profileMatchReport();
    expect(report.REVIEW).toMatchObject({
      eligible_jobs: 3,
      current_profile_match: 3,
      needs_rematch: 0,
      other_match_not_current: 0,
      decision_on_current_match: 3,
      queued_or_evaluated_current: 2,
      enqueue_path_after_fix: 3,
    });
    expect(report.TRACK).toMatchObject({ eligible_jobs: 1, needs_rematch: 0, excluded_from_ai_by_outcome: 1 });
    expect(report.ALL).toMatchObject({ eligible_jobs: 4, needs_rematch: 0 });
    const reseeded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["MATCH_PROFILE_EVIDENCE"],
      includeTestFixtures: true,
    });
    expect(reseeded.supersededProfileMatch).toBe(0);

    // A later budget run picks up the deferred job; the re-match is not repeated.
    const nextRun = await runPipelineStageTaskWorker(db(), {
      ...workerOptions,
      seed: true,
      context: ctx(),
      taskTypes: ["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"],
      jobVersionIds: [deferredJob.jobVersionId],
      maxTasks: 5,
    });
    expect(nextRun.errors).toEqual([]);
    expect(nextRun.failed).toBe(0);
    expect(nextRun.seeded?.byType.ENQUEUE_EXPLANATION).toEqual({ inserted: 1, existing: 0 });
    expect(nextRun.seeded?.supersededProfileMatch).toBe(0);
    const requeued = await activeQueueRows(deferredJob);
    expect(requeued).toHaveLength(1);
    expect(requeued[0].budget_run_id).not.toBe(queued.budget_run_id);
    expect((await jobState(deferredJob)).latest_match_run_id).toBe(deferredState.latest_match_run_id);
  }, 240_000);

  it("re-decides a job whose decision predates its current match before enqueueing it", async () => {
    // A job re-matched against the active profile whose decision was not redone (the production
    // jobs with a current-profile match but an older decision).
    const job = await seedRoutableJob("redecide", ["Zebra telemetry platform engineering experience"]);
    await publishEmbeddings();
    await runLaneRouter(db(), { context: ctx(), jobVersionIds: [job.jobVersionId] });
    const staleMatch = await recordMatchAndDecision(job, profileV2, "REVIEW", 80);
    const freshMatch = await db().query<{ id: string }>(
      `INSERT INTO match_runs (
         workspace_id, canonical_job_id, job_version_id, profile_version_id,
         requirement_set_id, status, requirement_count, matched_count,
         coverage_score, overall_match_score, policy_version,
         job_content_hash, context_fingerprint, embedding_space_id, completed_at
       ) VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 1, 1, 100.00, 80.00,
                 'zebra-rematch-fixture-v1', $6, 'zebra-rematch-fresh', $7, NOW())
       RETURNING id`,
      [ctx().workspaceId, job.canonicalJobId, job.jobVersionId, profileV2, job.requirementSetId, job.contentHash,
       await primaryEmbeddingSpaceId()],
    );
    await db().query(
      `UPDATE canonical_jobs SET latest_match_run_id = $1 WHERE workspace_id = $2 AND id = $3`,
      [freshMatch.rows[0].id, ctx().workspaceId, job.canonicalJobId],
    );
    expect(staleMatch).not.toBe(freshMatch.rows[0].id);

    const seeded = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["ENQUEUE_EXPLANATION"],
      includeTestFixtures: true,
      jobVersionIds: [job.jobVersionId],
    });
    expect(seeded.byType.ENQUEUE_EXPLANATION).toEqual({ inserted: 1, existing: 0 });
    const blocked = await runPipelineStageTaskWorker(db(), {
      ...workerOptions,
      context: ctx(),
      taskTypes: ["ENQUEUE_EXPLANATION"],
      jobVersionIds: [job.jobVersionId],
      maxTasks: 2,
    });
    expect(blocked.errors).toEqual([]);
    expect(blocked.decisionSuperseded).toBe(1);
    expect(await tasksFor(job, "ENQUEUE_EXPLANATION")).toEqual([expect.objectContaining({
      status: "BLOCKED_DEPENDENCY",
      blocked_on: `DECISION_SUPERSEDED:${job.jobVersionId}`,
      repair_action: "DECIDE_RECOMMENDATION",
    })]);
    expect(await tasksFor(job, "MATCH_PROFILE_EVIDENCE")).toEqual([]);

    // The real decider re-decides from the current match; the reactivated enqueue task then queues
    // the job in a new budget run.
    const resumed = await runPipelineStageTaskWorker(db(), {
      ...workerOptions,
      context: ctx(),
      taskTypes: ["DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"],
      jobVersionIds: [job.jobVersionId],
      maxTasks: 6,
    });
    expect(resumed.errors).toEqual([]);
    expect(resumed.failed).toBe(0);
    expect(resumed.blocked).toBe(0);
    const state = await jobState(job);
    expect(state.decision_match_run_id).toBe(freshMatch.rows[0].id);
    const enqueueTasks = await tasksFor(job, "ENQUEUE_EXPLANATION");
    expect(enqueueTasks.every((task) => task.status === "COMPLETED")).toBe(true);
    expect(state.recommendation_outcome).toBe("REVIEW");
    const queued = await activeQueueRows(job);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ match_run_id: freshMatch.rows[0].id, profile_version_id: profileV2 });
  }, 120_000);
});
