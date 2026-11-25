import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { GATE_VERSION } from "../../contracts/version.js";
import { DECIDER_VERSION, deciderVersionReassessmentReason } from "../../pipeline/deciderVersion.js";
import { findTasksCompletedWithoutResult } from "../../tasks/completedWithoutResult.js";
import { reportedDecisionCounts, runZeroChecks, staleStageResults, terminalOutcomeConflicts, zeroChecksExitCode } from "../../tasks/integrityZeroChecks.js";
import { reopenOutcomeConflictTasks } from "../../tasks/pipelineTasks.js";
import { OUTCOME_CONFLICT_REPAIR_ACTION, applyLiveJobScope } from "../../tasks/seedQueryScope.js";
import { runPipelineStageTaskWorker, seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// Live-job scope of the capped seeds, decider-version reassessment of terminal jobs, and the zero checks that
// guard both. Synthetic jobs only, in this test's own schema on local PostgreSQL.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the seed live-filter integration test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let snapshotId = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const ctx = (): WorkspaceContext => { if (!context) throw new Error("not initialised"); return context; };

interface JobOptions {
  state: string;
  gate?: string;
  outcome?: string | null;
  routingDisposition?: string | null;
  /** undefined: no decision row; null: a decision with no decider_version. */
  decider?: string | null;
  ageDays?: number;
  complete?: boolean;
}
interface JobIds { jobId: string; versionId: string }

/** Bulk insert of synthetic jobs (no posting evidence): enough for the seed queries. */
async function bulkJobs(count: number, options: JobOptions): Promise<JobIds[]> {
  const jobIds = Array.from({ length: count }, () => randomUUID());
  const versionIds = Array.from({ length: count }, () => randomUUID());
  const age = `${options.ageDays ?? 30} days`;
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status,
                                 gate_decision, recommendation_eligibility, recommendation_outcome, routing_disposition, updated_at)
     SELECT id, $2, 'Seed Fixture Co', 'fixture role', 'https://example.test/seed/' || id::text, $3, $3, $4, 'INELIGIBLE', $5, $6, NOW() - $7::interval
       FROM unnest($1::uuid[]) AS id`,
    [jobIds, ctx().workspaceId, options.state, options.gate ?? "HARD_REJECT", options.outcome === undefined ? "SKIP" : options.outcome, options.routingDisposition ?? null, age],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
     SELECT v.version_id, $3, v.job_id, 'h-' || v.version_id::text, 'Synthetic.', NOW() - $4::interval
       FROM unnest($1::uuid[], $2::uuid[]) AS v(job_id, version_id)`,
    [jobIds, versionIds, ctx().workspaceId, age],
  );
  await db().query(
    `UPDATE canonical_jobs c SET latest_job_version_id = v.version_id
       FROM unnest($1::uuid[], $2::uuid[]) AS v(job_id, version_id) WHERE c.id = v.job_id`,
    [jobIds, versionIds],
  );
  if (options.decider !== undefined) {
    await db().query(
      `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, decision_hash, decision_json,
                                            recommendation_eligibility, recommendation_outcome, decider_version)
       SELECT $3, v.job_id, v.version_id, $4, 'stale-' || v.job_id::text, '{}'::jsonb, 'INELIGIBLE', $5, $6
         FROM unnest($1::uuid[], $2::uuid[]) AS v(job_id, version_id)`,
      [jobIds, versionIds, ctx().workspaceId, snapshotId, options.outcome === undefined ? "SKIP" : options.outcome, options.decider],
    );
    await db().query(
      `UPDATE canonical_jobs c SET latest_deterministic_decision_id = d.id
         FROM deterministic_decisions d WHERE d.canonical_job_id = c.id AND c.id = ANY($1::uuid[])`,
      [jobIds],
    );
  }
  return jobIds.map((jobId, index) => ({ jobId, versionId: versionIds[index]! }));
}

/** A live job whose posting is complete, so the real decider processes it. */
async function decidableJob(options: JobOptions): Promise<JobIds> {
  const [created] = await bulkJobs(1, options);
  await insertCompletePostingEvidence(db(), {
    workspaceId: ctx().workspaceId,
    jobVersionId: created!.versionId,
    companyName: "Seed Fixture Co",
    title: "fixture role",
    sourceUrl: `https://example.test/seed/${created!.jobId}`,
    description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
  await db().query(`UPDATE job_versions SET description_text = $2 WHERE id = $1`, [created!.versionId, COMPLETE_TEST_POSTING_DESCRIPTION]);
  return created!;
}

async function archiveJobs(jobIds: string[]): Promise<void> {
  const run = await db().query<{ id: string }>(
    `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 day', 'DRY_RUN', 'SUCCEEDED') RETURNING id::text`,
  );
  await db().query(
    `UPDATE canonical_jobs SET archived_at = NOW(), archive_run_id = $2, archive_reason = 'fixture archive',
            archive_age_basis = 'HARD_REJECTED_DECISION', archive_reference_at = NOW() WHERE id = ANY($1::uuid[])`,
    [jobIds, run.rows[0]!.id],
  );
}

async function tasksFor(taskType: string, jobIds: string[]): Promise<number> {
  const rows = await db().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = $2 AND payload->>'canonical_job_id' = ANY($3::text[])`,
    [ctx().workspaceId, taskType, jobIds],
  );
  return rows.rows[0]?.n ?? 0;
}

describe("applyLiveJobScope", () => {
  it("adds the live-job terms right after the workspace filter, with the fixture term only when fixtures are excluded", () => {
    const sql = "SELECT c.id FROM canonical_jobs c WHERE c.workspace_id = $1 AND c.x = 1 ORDER BY c.id LIMIT $2";
    expect(applyLiveJobScope(sql, [1, 2], { includeTestFixtures: false }).sql).toBe(
      "SELECT c.id FROM canonical_jobs c WHERE c.workspace_id = $1 AND c.archived_at IS NULL AND c.is_test_fixture IS NOT TRUE AND c.x = 1 ORDER BY c.id LIMIT $2",
    );
    expect(applyLiveJobScope(sql, [1, 2], { includeTestFixtures: true }).sql).toContain("AND c.archived_at IS NULL AND c.x = 1");
    expect(applyLiveJobScope(sql, [1, 2], { includeTestFixtures: true }).sql).not.toContain("is_test_fixture");
  });

  it("refuses a seed query that has no canonical job anchor, so a new seed cannot skip the scope silently", () => {
    expect(() => applyLiveJobScope("SELECT 1 FROM raw_job_observations obs WHERE obs.workspace_id = $1 LIMIT $2", [1, 2], { includeTestFixtures: false }))
      .toThrow(/live-job scope/);
  });
});


/** A completed match run that is current for the job (active profile, requirement set, content hash). */
async function withCurrentMatch(job: JobIds): Promise<void> {
  const database = db();
  const workspaceId = ctx().workspaceId;
  let profile = await database.query<{ id: string }>(`SELECT id FROM profile_versions WHERE workspace_id = $1 AND status = 'ACTIVE' LIMIT 1`, [workspaceId]);
  if (profile.rows.length === 0) {
    const candidate = await database.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, 'seed_live_profile', 'Seed Live Profile') RETURNING id`, [workspaceId]);
    profile = await database.query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', 'seed-live-profile-v1', 'ACTIVE', NOW()) RETURNING id`, [workspaceId, candidate.rows[0]!.id]);
  }
  const contentHash = `h-${job.versionId}`;
  const identity = await database.query<{ id: string }>(
    `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version,
                                             quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled)
     VALUES ($1, $2, $3, $4, 'fixture-v1', 'fixture-v1', 'fixture-prompt', 'fixture-normalizer', FALSE) RETURNING id`,
    [workspaceId, job.jobId, `identity-${job.versionId}`, contentHash]);
  const set = await database.query<{ id: string }>(
    `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
     VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`, [workspaceId, identity.rows[0]!.id, job.jobId, job.versionId]);
  await database.query(`UPDATE job_versions SET active_requirement_set_id = $2 WHERE id = $1`, [job.versionId, set.rows[0]!.id]);
  const run = await database.query<{ id: string }>(
    `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, status, requirement_count,
                             matched_count, coverage_score, overall_match_score, policy_version, job_content_hash, context_fingerprint, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 1, 1, 100.00, 80.00, 'fixture-v1', $6, $7, NOW()) RETURNING id`,
    [workspaceId, job.jobId, job.versionId, profile.rows[0]!.id, set.rows[0]!.id, contentHash, `ctx-${job.versionId}`]);
  await database.query(`UPDATE canonical_jobs SET latest_match_run_id = $2 WHERE id = $1`, [job.jobId, run.rows[0]!.id]);
}

const taskRows = async (versionId: string) => (await db().query<{ status: string; repair_action: string | null; attempt_count: number; payload: Record<string, unknown> }>(
  `SELECT status, repair_action, COALESCE(attempt_count, 0) AS attempt_count, payload FROM pipeline_tasks WHERE payload->>'job_version_id' = $1`, [versionId])).rows;

const deciderTask = (job: JobIds, extra: Record<string, unknown> = {}) => db().query(
  `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status)
   VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'PENDING')`,
  [ctx().workspaceId, `DECIDE_RECOMMENDATION:${job.versionId}:t-${randomUUID()}`, JSON.stringify({ canonical_job_id: job.jobId, job_version_id: job.versionId, ...extra })],
);
const reassess = { repair_existing_state: true, reprocess_existing_state: true, reassessment_reason: deciderVersionReassessmentReason() };
const drain = (versionIds: string[], seed = true) => runPipelineStageTaskWorker(db(), {
  context: ctx(), seed, jobVersionIds: versionIds, taskTypes: ["DECIDE_RECOMMENDATION"],
  reconcileStalePending: false, maxTasks: 30, heartbeatSeconds: 0, seedTimeBudgetMs: 60_000,
});
const outcomeColumns = async (jobId: string) => (await db().query(
  `SELECT recommendation_outcome, recommendation_eligibility, recommendation_requirement_score, recommendation_coverage_score,
          recommendation_evidence_completeness, recommendation_decided_at, processing_state, processing_status, rejection_reason,
          gate_decision
     FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
const decisionCount = async (versionId: string) =>
  (await db().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE job_version_id = $1`, [versionId])).rows[0]!.n;
const staleIds = async (stage: string) => {
  const stale = await staleStageResults(db(), ctx().workspaceId);
  return { count: stale.detail?.[stage] ?? 0, sample: stale.sample.filter((entry) => entry.startsWith(`${stage}:`)) };
};

describe.skipIf(skipReal)("seed live filter, decider reassessment and stale-stage zero checks (PostgreSQL)", () => {
  // Every test gets its own schema, so no test depends on rows another one left behind.
  beforeEach(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `seed_live_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [context.workspaceId, `snap-${randomUUID()}`],
    );
    snapshotId = snapshot.rows[0]!.id;
  }, 120_000);

  afterEach(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("(a) more archived older stale jobs than the cap never starve the live stale job: one pass seeds its EXTRACT and DECIDE tasks", async () => {
    const stale = { state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" };
    const archived = await bulkJobs(205, { ...stale, ageDays: 40 });
    const fixtures = await bulkJobs(10, { ...stale, ageDays: 41 });
    await archiveJobs(archived.map((job) => job.jobId));
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = ANY($1::uuid[])`, [fixtures.map((job) => job.jobId)]);
    const live = await decidableJob({ ...stale, ageDays: 1 });

    const summary = await seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS", "DECIDE_RECOMMENDATION"], maxSeedPerType: 5, timeBudgetMs: 60_000,
    });
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [live.jobId])).toBe(1);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [live.jobId])).toBe(1);
    const others = [...archived, ...fixtures].map((job) => job.jobId);
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", others)).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", others)).toBe(0);
    expect(summary.skippedArchived).toBe(0);
    expect(summary.existing).toBe(0);
  }, 120_000);

  it("B3: live stale jobs the decider skips (incomplete posting), older than the cap, do not starve a decidable job: it is seeded in one pass", async () => {
    const stale = { state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" };
    const incomplete = await bulkJobs(8, { ...stale, ageDays: 40 });
    const live = await decidableJob({ ...stale, ageDays: 1 });
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], maxSeedPerType: 5, timeBudgetMs: 60_000 });
    expect(await tasksFor("DECIDE_RECOMMENDATION", incomplete.map((job) => job.jobId))).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [live.jobId])).toBe(1);
  }, 120_000);

  it("a seed row the enqueue refuses as archived is counted as skippedArchived, never as existing", async () => {
    // A live job whose latest version belongs to an archived job: the seed selects it, the enqueue guard refuses it.
    const [archivedOwner] = await bulkJobs(1, { state: "LANE_ROUTED", gate: "PASS", outcome: null, ageDays: 40 });
    await archiveJobs([archivedOwner!.jobId]);
    const [liveJob] = await bulkJobs(1, { state: "LANE_ROUTED", gate: "PASS", outcome: null, ageDays: 40 });
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [liveJob!.jobId, archivedOwner!.versionId]);
    const summary = await seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"], maxSeedPerType: 5, timeBudgetMs: 60_000,
    });
    expect(summary.skippedArchived).toBeGreaterThanOrEqual(1);
    expect(summary.existing).toBe(0);
    expect(summary.inserted).toBe(0);
  }, 60_000);

  it("includeTestFixtures=true reaches a stale fixture job through the seed; false does not", async () => {
    const fixture = await decidableJob({ state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" });
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1`, [fixture.jobId]);
    const types = ["EXTRACT_DETERMINISTIC_REQUIREMENTS", "DECIDE_RECOMMENDATION"] as const;
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: [...types], timeBudgetMs: 60_000 });
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [fixture.jobId])).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [fixture.jobId])).toBe(0);
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: [...types], includeTestFixtures: true, timeBudgetMs: 60_000 });
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [fixture.jobId])).toBe(1);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [fixture.jobId])).toBe(1);
  }, 60_000);

  it("a live job whose only task is BLOCKED_DEPENDENCY stays in scope and does not starve the live job behind it", async () => {
    const stale = { state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" };
    const archived = await bulkJobs(20, { ...stale, ageDays: 40 });
    await archiveJobs(archived.map((job) => job.jobId));
    const blocked = await decidableJob({ ...stale, ageDays: 5 });
    const behind = await decidableJob({ ...stale, ageDays: 1 });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, blocked_on)
       VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'BLOCKED_DEPENDENCY', 'MATCH_PROFILE_EVIDENCE')`,
      [ctx().workspaceId, `DECIDE_RECOMMENDATION:${blocked.versionId}:blocked`, JSON.stringify({ canonical_job_id: blocked.jobId, job_version_id: blocked.versionId })],
    );
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], maxSeedPerType: 3, timeBudgetMs: 60_000 });
    expect(await tasksFor("DECIDE_RECOMMENDATION", [blocked.jobId])).toBeGreaterThanOrEqual(1);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [behind.jobId])).toBe(1);
  }, 120_000);

  it("every capped seed query carries the live-job scope before its LIMIT (all selectAndEnqueue seeds)", async () => {
    const recorded: string[] = [];
    const proxy = new Proxy(db(), {
      get(target, prop) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (/LIMIT\s+\$\d+\s*$/.test(text) && /FROM canonical_jobs c\b/.test(text)) recorded.push(text);
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as pg.PoolClient;
    await seedRecoverablePipelineTasks(proxy, { context: ctx(), timeBudgetMs: 60_000 });
    // All selectAndEnqueue seeds except NORMALIZE_OBSERVATION select canonical jobs; the re-route seed needs a registry routing version.
    expect(recorded.length).toBeGreaterThanOrEqual(12);
    for (const text of recorded) {
      expect(text).toMatch(/WHERE c\.workspace_id = \$1 AND c\.archived_at IS NULL AND c\.is_test_fixture IS NOT TRUE/);
    }
  }, 120_000);

  it("B1: stale decisions the DECIDE seed cannot reach (UNMATCHED without a match run, LANE_ROUTED, PREQUALIFIED) are reported, never failed; the reachable HARD_REJECTED job drains to zero", async () => {
    const stale = { outcome: "SKIP", decider: "recommendation_decider_v1" };
    const unmatched = await decidableJob({ ...stale, state: "UNMATCHED", gate: "PASS", routingDisposition: "POLICY_NO_MATCH" });
    const laneRouted = await decidableJob({ ...stale, state: "LANE_ROUTED", gate: "PASS" });
    const prequalified = await decidableJob({ ...stale, state: "PREQUALIFIED", gate: "PASS" });
    const rejected = await decidableJob({ ...stale, state: "HARD_REJECTED", gate: "HARD_REJECT" });
    const noDecision = await decidableJob({ state: "UNMATCHED", gate: "PASS", outcome: "SKIP", routingDisposition: "POLICY_NO_MATCH" });
    const all = [unmatched, laneRouted, prequalified, rejected, noDecision];

    const before = await staleIds("decider");
    expect(before.sample).toEqual([`decider:${rejected.jobId}`]);
    const run = await drain(all.map((job) => job.versionId));
    expect(run.failed).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [unmatched, laneRouted, prequalified, noDecision].map((job) => job.jobId))).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [rejected.jobId])).toBe(1);

    expect((await staleIds("decider")).count).toBe(0);
    const reported = await reportedDecisionCounts(db(), ctx().workspaceId);
    expect(reported.unseeded_stale_decisions).toMatchObject({ UNMATCHED: 1, LANE_ROUTED: 1, PREQUALIFIED: 1 });
    expect(reported.outcome_without_latest_decision.UNMATCHED).toBe(1);
  }, 180_000);

  it("(b) a reachable HARD_REJECTED job with an old or NULL decider version ends with a stamped decision; its outcome columns are identical and a second run does not re-run it", async () => {
    const old = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: "recommendation_decider_v1" });
    const nul = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: null });
    const ids = [old, nul];
    const beforeColumns = await Promise.all(ids.map((job) => outcomeColumns(job.jobId)));
    expect((await staleIds("decider")).count).toBe(2);

    expect((await drain(ids.map((job) => job.versionId))).failed).toBe(0);
    for (const [index, job] of ids.entries()) {
      const row = await db().query<{ decider_version: string | null }>(
        `SELECT d.decider_version FROM canonical_jobs c JOIN deterministic_decisions d ON d.id = c.latest_deterministic_decision_id WHERE c.id = $1`, [job.jobId]);
      expect(row.rows[0]!.decider_version).toBe(DECIDER_VERSION);
      expect(await outcomeColumns(job.jobId)).toEqual(beforeColumns[index]);
    }
    expect((await staleIds("decider")).count).toBe(0);
    const missing = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(missing.byTaskType.DECIDE_RECOMMENDATION ?? 0).toBe(0);

    // Repeat: the version-scoped task key holds, so nothing is queued or decided again.
    const decisionsAfterFirst = await Promise.all(ids.map((job) => decisionCount(job.versionId)));
    const seeded = await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: ids.map((job) => job.versionId), timeBudgetMs: 60_000 });
    expect(seeded.inserted).toBe(0);
    await drain(ids.map((job) => job.versionId));
    expect(await Promise.all(ids.map((job) => decisionCount(job.versionId)))).toEqual(decisionsAfterFirst);
  }, 180_000);

  it("N1: a terminal job whose stored outcome the decider would change is closed with a repair action, untouched, and flagged by terminal_outcome_conflict", async () => {
    // Stored REVIEW on a HARD_REJECTED job and on an UNMATCHED job: the decider recomputes SKIP for both.
    const rejectedReview = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "REVIEW", decider: "recommendation_decider_v1" });
    const unmatchedReview = await decidableJob({ state: "UNMATCHED", gate: "PASS", outcome: "REVIEW", routingDisposition: "POLICY_NO_MATCH", decider: "recommendation_decider_v1" });
    const conflicted = [rejectedReview, unmatchedReview];
    // Agreeing fixtures: stored SKIP, and the decider recomputes SKIP.
    const staleGate = await decidableJob({ state: "HARD_REJECTED", gate: "PASS", outcome: "SKIP", decider: "recommendation_decider_v1" });
    await db().query(`UPDATE canonical_jobs SET gate_decision = NULL WHERE id = $1`, [staleGate.jobId]);
    const all = [...conflicted, staleGate];
    const before = await Promise.all(all.map((job) => outcomeColumns(job.jobId)));
    const decisionsBefore = await Promise.all(all.map((job) => decisionCount(job.versionId)));
    for (const job of all) await deciderTask(job, reassess);

    // Several drains: a retry or an engine-error path would show up as a changed state or extra attempts.
    for (let pass = 0; pass < 3; pass += 1) await drain(all.map((job) => job.versionId), false);

    for (const [index, job] of conflicted.entries()) {
      const tasks = await taskRows(job.versionId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe("COMPLETED");
      expect(tasks[0]!.repair_action).toBe(OUTCOME_CONFLICT_REPAIR_ACTION);
      expect(Number(tasks[0]!.attempt_count)).toBeLessThanOrEqual(1);
      const recorded = tasks[0]!.payload.outcome_conflict as { decider_version: string; details: Array<Record<string, unknown>> };
      expect(recorded.decider_version).toBe(DECIDER_VERSION);
      const detail = recorded.details[0]!;
      expect(detail).toMatchObject({ canonical_job_id: job.jobId, stored_outcome: "REVIEW", recomputed_outcome: "SKIP" });
      expect(Array.isArray(detail.recomputed_notes)).toBe(true);
      expect(detail).toHaveProperty("outcome_rule_id");
      expect(await outcomeColumns(job.jobId)).toEqual(before[index]); // state, status, rejection_reason, outcome, scores, decided_at
      expect(await decisionCount(job.versionId)).toBe(decisionsBefore[index]);
    }
    // The agreeing HARD_REJECTED job (NULL canonical gate_decision) is stamped and completes normally.
    const stamped = await taskRows(staleGate.versionId);
    expect(stamped[0]!.status).toBe("COMPLETED");
    expect(stamped[0]!.repair_action).toBeNull();
    expect(await decisionCount(staleGate.versionId)).toBe(decisionsBefore[2]! + 1);
    expect(await outcomeColumns(staleGate.jobId)).toEqual(before[2]);

    // The new check flags exactly the conflicted jobs; the task is not "completed without result"; the stale-decision arm does not double count them.
    const conflictCheck = await terminalOutcomeConflicts(db(), ctx().workspaceId);
    expect([...conflictCheck.sample].sort()).toEqual(conflicted.map((job) => job.jobId).sort());
    expect(zeroChecksExitCode(await runZeroChecks(db(), ctx().workspaceId))).toBe(1);
    const missing = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(missing.byTaskType.DECIDE_RECOMMENDATION ?? 0).toBe(0);
    expect((await staleIds("decider")).count).toBe(0);
  }, 180_000);

  it("N3: a conflict that persists under the same decider version stays excluded from the seed (no cap slot) and is flagged once", async () => {
    const job = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "REVIEW", decider: "recommendation_decider_v1" });
    await deciderTask(job, reassess);
    await drain([job.versionId], false);
    expect((await terminalOutcomeConflicts(db(), ctx().workspaceId)).sample).toEqual([job.jobId]);
    const seeded = await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], maxSeedPerType: 5, timeBudgetMs: 60_000 });
    expect(seeded.inserted + seeded.existing).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [job.jobId])).toBe(1);
    expect((await terminalOutcomeConflicts(db(), ctx().workspaceId)).total).toBe(1);
  }, 120_000);

  it("N3: a conflict closed under an older decider version does not block the current one: the seed reassesses, the job is stamped, the check clears", async () => {
    const agreeing = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: "recommendation_decider_v1" });
    const stillConflicting = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "REVIEW", decider: "recommendation_decider_v1" });
    for (const job of [agreeing, stillConflicting]) {
      // A conflict closed under the previous decider version (its reassessment key carries that version).
      await db().query(
        `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, repair_action, completed_at)
         VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'COMPLETED', $4, NOW())`,
        [ctx().workspaceId, `DECIDE_RECOMMENDATION:${job.versionId}:old`, JSON.stringify({
          canonical_job_id: job.jobId, job_version_id: job.versionId, reassessment_reason: "DECIDER_VERSION:recommendation_decider_v1",
          outcome_conflict: { decider_version: "recommendation_decider_v1", details: [] },
        }), OUTCOME_CONFLICT_REPAIR_ACTION],
      );
    }
    expect((await terminalOutcomeConflicts(db(), ctx().workspaceId)).total).toBe(0);
    await drain([agreeing.versionId, stillConflicting.versionId]);
    const stamped = await db().query<{ decider_version: string }>(
      `SELECT d.decider_version FROM canonical_jobs c JOIN deterministic_decisions d ON d.id = c.latest_deterministic_decision_id WHERE c.id = $1`, [agreeing.jobId]);
    expect(stamped.rows[0]!.decider_version).toBe(DECIDER_VERSION);
    // The job whose stored outcome still disagrees is closed again under the current version and flagged; the other cleared.
    expect((await terminalOutcomeConflicts(db(), ctx().workspaceId)).sample).toEqual([stillConflicting.jobId]);
  }, 180_000);

  it("N3: an operator who corrects the stored outcome reopens the closed task; the next drain stamps the job and the check clears; an uncorrected one is closed again", async () => {
    const corrected = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "REVIEW", decider: "recommendation_decider_v1" });
    const uncorrected = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "REVIEW", decider: "recommendation_decider_v1" });
    for (const job of [corrected, uncorrected]) await deciderTask(job, reassess);
    await drain([corrected.versionId, uncorrected.versionId], false);
    expect((await terminalOutcomeConflicts(db(), ctx().workspaceId)).total).toBe(2);

    await db().query(`UPDATE canonical_jobs SET recommendation_outcome = 'SKIP' WHERE id = $1`, [corrected.jobId]);
    expect(await reopenOutcomeConflictTasks(db(), ctx(), { jobVersionIds: [corrected.versionId, uncorrected.versionId] })).toBe(2);
    await drain([corrected.versionId, uncorrected.versionId], false);

    expect((await taskRows(corrected.versionId))[0]!.repair_action).toBeNull();
    expect((await terminalOutcomeConflicts(db(), ctx().workspaceId)).sample).toEqual([uncorrected.jobId]);
    expect((await taskRows(uncorrected.versionId))[0]!.repair_action).toBe(OUTCOME_CONFLICT_REPAIR_ACTION);
    // Nothing else is reopened.
    expect(await reopenOutcomeConflictTasks(db(), ctx(), { jobVersionIds: [corrected.versionId] })).toBe(0);
  }, 180_000);

  it("N4: terminal_outcome_conflict is a post-phase check: zero in the pre phase (the drain must still run), failing in the post phase", async () => {
    const job = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "REVIEW", decider: "recommendation_decider_v1" });
    await deciderTask(job, reassess);
    await drain([job.versionId], false);
    const pre = await runZeroChecks(db(), ctx().workspaceId, { phase: "pre" });
    expect(pre.map((check) => check.name)).not.toContain("terminal_outcome_conflict");
    expect(zeroChecksExitCode(pre)).toBe(0);
    const post = await runZeroChecks(db(), ctx().workspaceId, { phase: "post" });
    expect(post.find((check) => check.name === "terminal_outcome_conflict")?.total).toBe(1);
    expect(zeroChecksExitCode(post)).toBe(1);
    // check_integrity.ts calls runZeroChecks with the default phase, which is post.
    expect(zeroChecksExitCode(await runZeroChecks(db(), ctx().workspaceId))).toBe(1);
  }, 120_000);

  it("an UNMATCHED job with no routing disposition and gate PASS keeps its stored outcome: closed as a conflict if the decider would change it, otherwise stamped", async () => {
    const job = await decidableJob({ state: "UNMATCHED", gate: "PASS", outcome: "SKIP", routingDisposition: null, decider: "recommendation_decider_v1" });
    const before = await outcomeColumns(job.jobId);
    await deciderTask(job, reassess);
    await drain([job.versionId], false);
    const tasks = await taskRows(job.versionId);
    expect(tasks[0]!.status).toBe("COMPLETED");
    expect(await outcomeColumns(job.jobId)).toEqual(before);
    // A job without a disposition and without a match recomputes a non-SKIP outcome: that must be a recorded conflict, never a promoted recommendation.
    expect(tasks[0]!.repair_action).toBe(OUTCOME_CONFLICT_REPAIR_ACTION);
    expect((await terminalOutcomeConflicts(db(), ctx().workspaceId)).sample).toContain(job.jobId);
  }, 120_000);

  it("N2: PREQUALIFIED and RAW_STAGED stale jobs (with a current match) older than the cap do not starve a decidable job", async () => {
    const stale = { outcome: "REVIEW", decider: "recommendation_decider_v1", gate: "PASS" };
    const noop: JobIds[] = [];
    for (const state of ["PREQUALIFIED", "PREQUALIFIED", "PREQUALIFIED", "RAW_STAGED", "RAW_STAGED", "RAW_STAGED"]) {
      const job = await decidableJob({ ...stale, state, ageDays: 40 });
      await withCurrentMatch(job);
      noop.push(job);
    }
    const live = await decidableJob({ ...stale, state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", ageDays: 1 });
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], maxSeedPerType: 5, timeBudgetMs: 60_000 });
    expect(await tasksFor("DECIDE_RECOMMENDATION", noop.map((job) => job.jobId))).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [live.jobId])).toBe(1);
    expect((await staleIds("decider")).sample).toEqual([`decider:${live.jobId}`]);
  }, 180_000);

  it("preserve mode leaves what the readiness view and the readiness refresh arm see for a terminal job current, never stale", async () => {
    const job = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: "recommendation_decider_v1" });
    await deciderTask(job, reassess);
    expect((await drain([job.versionId], false)).failed).toBe(0);
    const view = await db().query<{ reasons: string[] | null }>(
      `SELECT readiness_reason_codes AS reasons FROM v_application_readiness_current WHERE workspace_id = $1 AND canonical_job_id = $2`, [ctx().workspaceId, job.jobId]);
    expect(view.rows).toHaveLength(1);
    // A terminal job reads BLOCKED from its state; the stamped decision only refreshes the evidence, so no stale-readiness reason appears.
    for (const code of ["READINESS_EVIDENCE_STALE", "READINESS_FINGERPRINT_STALE", "READINESS_CONTEXT_STALE"]) expect(view.rows[0]!.reasons ?? []).not.toContain(code);
  }, 120_000);

  it("reconcile_pipeline reports reported_counts next to zero_checks (wiring guard)", () => {
    const source = readFileSync(new URL("../../../scripts/reconcile_pipeline.ts", import.meta.url), "utf8");
    expect(source).toMatch(/reported_counts:\s*await reportedDecisionCounts\(client, ctx\.workspaceId\)/);
    expect(source).toMatch(/reported_counts: ReportedDecisionCounts/);
  });

  it("a terminal job with a decision is not re-run by a task that is only reprocess_existing_state (a rematch successor)", async () => {
    const job = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: DECIDER_VERSION });
    const before = await decisionCount(job.versionId);
    await deciderTask(job, { reprocess_existing_state: true, repair_existing_state: true });
    const run = await drain([job.versionId], false);
    expect(run.failed).toBe(0);
    expect(await decisionCount(job.versionId)).toBe(before);
  }, 120_000);

  it("(d) a terminal job with a decision completes as a legitimate no-op and is not flagged; one without a decision runs the decider; a real missing result is flagged", async () => {
    const decided = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: DECIDER_VERSION });
    const undecided = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP" });
    for (const job of [decided, undecided]) await deciderTask(job);
    const decidedBefore = await decisionCount(decided.versionId);
    expect((await drain([decided.versionId, undecided.versionId], false)).failed).toBe(0);
    expect(await decisionCount(decided.versionId)).toBe(decidedBefore);
    expect(await decisionCount(undecided.versionId)).toBeGreaterThanOrEqual(1);
    const report = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(report.sample.map((row) => row.jobVersionId)).not.toContain(decided.versionId);
    expect(report.sample.map((row) => row.jobVersionId)).not.toContain(undecided.versionId);

    const orphan = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP" });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, completed_at) VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'COMPLETED', NOW())`,
      [ctx().workspaceId, `DECIDE_RECOMMENDATION:${orphan.versionId}:orphan`, JSON.stringify({ canonical_job_id: orphan.jobId, job_version_id: orphan.versionId })],
    );
    expect((await findTasksCompletedWithoutResult(db(), ctx().workspaceId)).sample.map((row) => row.jobVersionId)).toContain(orphan.versionId);
  }, 120_000);

  it("gate stage: reported for an older gate version; not reported at the running version, or with a gate task in flight", async () => {
    const job = await decidableJob({ state: "NEEDS_VERIFICATION", gate: "NEEDS_VERIFICATION", outcome: "TRACK", decider: DECIDER_VERSION });
    await db().query(
      `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, 'gate-2020-01.1', 'NEEDS_VERIFICATION')`,
      [ctx().workspaceId, job.jobId, job.versionId],
    );
    expect((await staleIds("gate")).sample).toEqual([`gate:${job.jobId}`]);
    expect((await staleIds("decider")).count).toBe(0);

    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status) VALUES ($1, 'APPLY_HARD_GATES', $2, $3::jsonb, 'PENDING')`,
      [ctx().workspaceId, `APPLY_HARD_GATES:${job.versionId}:inflight`, JSON.stringify({ canonical_job_id: job.jobId, job_version_id: job.versionId })],
    );
    expect((await staleIds("gate")).count).toBe(0);
    await db().query(`DELETE FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'APPLY_HARD_GATES'`, [ctx().workspaceId]);
    expect((await staleIds("gate")).count).toBe(1);
    await db().query(`UPDATE gate_decisions SET gate_version = $2 WHERE job_version_id = $1`, [job.versionId, GATE_VERSION]);
    expect((await staleIds("gate")).count).toBe(0);
  }, 120_000);
});
