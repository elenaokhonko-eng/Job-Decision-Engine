import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { compareRankingPolicies } from "../../pipeline/rankingPolicyComparison.js";
import { materializeApplicationRankings } from "../../services/applicationRankingMaterializer.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Migration 122 (deterministic composite, AI terms display-only, Top 10 without an AI evaluation).
// Real PostgreSQL: an upgrade schema that holds pre-existing snapshots with evaluations (migrations
// up to 121, then 122) and a fresh schema (all migrations). Fixtures are synthetic.
const MIGRATION_122 = "122_ranking_deterministic_composite.sql";
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the ranking composite integration tests against its PostgreSQL service.");
}

const MIGRATIONS_DIR = path.resolve("migrations");
const AUTONOMY_QUOTE = "Work independently with minimal supervision.";
const VIEWS = [
  "v_apply_now_jobs_scoped",
  "v_top_ten_ready_jobs_scoped",
  "v_apply_now_jobs_stage3_scoped",
  "v_top_ten_ready_jobs_stage3_scoped",
] as const;

interface JobIds {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly matchRunId: string;
  readonly decisionId: string;
  readonly decisionFingerprint: string;
  readonly jobContentHash: string;
  readonly evaluationId: string | null;
}

let adminPool: pg.Pool | undefined;
const schemas: string[] = [];

async function newSchemaPool(prefix: string): Promise<{ pool: pg.Pool; schema: string }> {
  const schema = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema},public` });
  return { pool, schema };
}

async function migrate(pool: pg.Pool, migrationsDir?: string): Promise<WorkspaceContext> {
  const client = await pool.connect();
  try {
    await runMigrations(client, migrationsDir ? { migrationsDir } : {});
    return await resolveWorkspaceContext(client);
  } finally {
    client.release();
  }
}

function migrationsBefore122(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jde-migrations-pre122-"));
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (file.endsWith(".sql") && file < MIGRATION_122) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
  }
  return dir;
}

async function viewColumns(pool: pg.Pool): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const view of VIEWS) {
    const { rows } = await pool.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute
        WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`,
      [view],
    );
    result[view] = rows.map((row) => row.attname);
  }
  return result;
}

async function createProfile(pool: pg.Pool, workspace: WorkspaceContext): Promise<string> {
  const profile = await pool.query<{ id: string }>(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
     VALUES ($1, $2, 'Ranking Composite Fixture') RETURNING id`,
    [workspace.workspaceId, `ranking-composite-${crypto.randomUUID()}`],
  );
  const version = await pool.query<{ id: string }>(
    `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
     VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`,
    [workspace.workspaceId, profile.rows[0]?.id, `profile-${crypto.randomUUID()}`],
  );
  return version.rows[0]!.id;
}

/** A current READY Apply Now job (same shape as the document provenance fixture). */
async function createReadyJob(
  pool: pg.Pool,
  workspace: WorkspaceContext,
  profileVersionId: string,
  options: { laneConfidence: string; matchScore: number; withEvaluation: boolean },
): Promise<JobIds> {
  const ws = workspace.workspaceId;
  const canonical = await pool.query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url, location_summary, workplace_type,
       employment_type, primary_lane, processing_state, processing_status, gate_decision,
       recommendation_eligibility, recommendation_outcome, lane_confidence,
       deterministic_match_score, deterministic_match_coverage, recommendation_evidence_completeness
     ) VALUES ($1, 'Composite Fixture', 'Data Engineer', $2, 'Remote', 'REMOTE', 'PERMANENT', 'CORE_AI_DATA',
       'MATCHED', 'MATCHED', 'PASS', 'ELIGIBLE', 'REVIEW', $3, $4, 90, 0.95) RETURNING id`,
    [ws, `https://example.test/composite/${crypto.randomUUID()}`, options.laneConfidence, options.matchScore],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const jobContentHash = `job-content-${crypto.randomUUID()}`;
  const evidenceRevisionHash = "e".repeat(64);
  const description = [
    "About the role: Build and operate reliable data products used by research teams.",
    "Responsibilities: Design data services, deliver integrations, and support production releases.",
    "Requirements: Experience with SQL, cloud systems, and cross-functional technical delivery.",
  ].join(" ").repeat(8) + ` ${AUTONOMY_QUOTE}`;
  const version = await pool.query<{ id: string }>(
    `INSERT INTO job_versions (
       workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at,
       evidence_revision_hash, availability_status, availability_evidence, availability_verified_at, availability_recheck_at
     ) VALUES ($1, $2, 1, $3, $5, NOW(), $4, 'OPEN', $6::jsonb, '2098-01-01T00:00:00Z', '2099-01-01T00:00:00Z')
     RETURNING id`,
    [ws, canonicalJobId, jobContentHash, evidenceRevisionHash, description,
      JSON.stringify({ status: "OPEN", verification_method: "TEST_FIXTURE", reason_code: "SOURCE_CONFIRMED", evidence: [] })],
  );
  const jobVersionId = version.rows[0]!.id;
  await pool.query(`UPDATE job_versions SET first_seen_at = NOW(), last_seen_at = NOW() WHERE id = $1`, [jobVersionId]);
  const identity = await pool.query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version,
       quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-test-v1', 'quoted-test-v1', 'quoted-prompt-test-v1', 'normalizer-test-v1', FALSE)
     RETURNING id`,
    [ws, canonicalJobId, `identity-${crypto.randomUUID()}`, jobContentHash],
  );
  const requirementSet = await pool.query<{ id: string }>(
    `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type, created_by_user_id)
     VALUES ($1, $2, $3, $4, 1, 'EXTRACTED', $5) RETURNING id`,
    [ws, identity.rows[0]!.id, canonicalJobId, jobVersionId, workspace.userId],
  );
  const requirementSetId = requirementSet.rows[0]!.id;
  await pool.query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`, [requirementSetId, ws, jobVersionId]);
  const matchRun = await pool.query<{ id: string }>(
    `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id,
       job_content_hash, context_fingerprint, status, requirement_count, matched_count, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', 1, 1, NOW()) RETURNING id`,
    [ws, canonicalJobId, jobVersionId, profileVersionId, requirementSetId, jobContentHash, `match-context-${crypto.randomUUID()}`],
  );
  const matchRunId = matchRun.rows[0]!.id;
  await pool.query(
    `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, decision, rejection_codes, evidence_quotes, workability_facts)
     VALUES ($1, $2, $3, 'PASS', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [ws, canonicalJobId, jobVersionId],
  );
  await pool.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1, latest_match_run_id = $2, description_quality_status = 'COMPLETE'
      WHERE workspace_id = $3 AND id = $4`,
    [jobVersionId, matchRunId, ws, canonicalJobId],
  );
  await pool.query(
    `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, company_name, title,
       description_raw, raw_payload, raw_payload_hash, job_version_id)
     VALUES ($1, 'GREENHOUSE', $2, $3, 'Composite Fixture', 'Data Engineer', $4, $5::jsonb, $6, $7)`,
    [ws, `composite-${crypto.randomUUID()}`, `https://boards.greenhouse.io/example/jobs/${crypto.randomUUID()}`, description,
      JSON.stringify({ source_content_status: "COMPLETE" }), crypto.randomBytes(32).toString("hex"), jobVersionId],
  );
  const revisions = await pool.query<{ config_key: string; config_revision_id: string }>(
    `SELECT definition.config_key, active.config_revision_id
       FROM config_active_revisions active
       JOIN config_definitions definition ON definition.id = active.config_definition_id
      WHERE definition.workspace_id = $1 AND definition.config_key IN ('decision_policy', 'evidence_strength')`,
    [ws],
  );
  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, decision_policy_config_revision_id,
       evidence_strength_policy_config_revision_id, resolved_snapshot)
     VALUES ($1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [ws, `policy-${crypto.randomUUID()}`,
      revisions.rows.find((row) => row.config_key === "decision_policy")?.config_revision_id ?? null,
      revisions.rows.find((row) => row.config_key === "evidence_strength")?.config_revision_id ?? null],
  );
  const policySnapshotId = snapshot.rows[0]!.id;
  const reference = await pool.query<{ value: string }>(
    `SELECT 'availability_verification_v1:'
       || to_char(availability_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':'
       || to_char(availability_recheck_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value
       FROM job_versions WHERE workspace_id = $1 AND id = $2`,
    [ws, jobVersionId],
  );
  const readinessFingerprint = "f".repeat(64);
  const decisionFingerprint = `decision-context-${crypto.randomUUID()}`;
  const readiness = {
    schema_version: "application_readiness_v1", status: "READY", reason_codes: [],
    checks: [{
      key: "AVAILABILITY", status: "MET", importance: "MUST", reason_code: null,
      rationale: "Fixture availability evidence is current.", evidence_keys: [],
      policy_reference: reference.rows[0]?.value, assessed_at: "2098-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
    }],
    canonical_job_id: canonicalJobId, job_version_id: jobVersionId, profile_version_id: profileVersionId,
    requirement_set_id: requirementSetId, match_run_id: matchRunId, preference_context_id: null,
    policy_snapshot_id: policySnapshotId, policy_version: "fixture-policy-v1",
    qualification_comparator_version: "experience_scope_v2", evidence_revision_hash: evidenceRevisionHash,
    readiness_fingerprint: readinessFingerprint, evaluated_at: "2098-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
  };
  const decision = await pool.query<{ id: string }>(
    `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, match_run_id, policy_snapshot_id,
       decision_hash, decision_json, recommendation_eligibility, recommendation_outcome, context_fingerprint,
       created_by_user_id, preference_user_id, preference_context_id, readiness_json, evidence_revision_hash, readiness_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'ELIGIBLE', 'REVIEW', $7, $8, NULL, NULL, $9::jsonb, $10, $11) RETURNING id`,
    [ws, canonicalJobId, jobVersionId, matchRunId, policySnapshotId, `decision-hash-${crypto.randomUUID()}`,
      decisionFingerprint, workspace.userId, JSON.stringify(readiness), evidenceRevisionHash, readinessFingerprint],
  );
  const decisionId = decision.rows[0]!.id;
  await pool.query(`UPDATE canonical_jobs SET latest_deterministic_decision_id = $1 WHERE workspace_id = $2 AND id = $3`, [decisionId, ws, canonicalJobId]);

  let evaluationId: string | null = null;
  if (options.withEvaluation) {
    const evaluation = await pool.query<{ id: string }>(
      `INSERT INTO ai_evaluations (workspace_id, canonical_job_id, job_version_id, profile_version_id, match_run_id,
         deterministic_decision_id, job_content_hash, context_fingerprint, full_evaluation_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
      [ws, canonicalJobId, jobVersionId, profileVersionId, matchRunId, decisionId, jobContentHash, decisionFingerprint,
        JSON.stringify({ culture_evidence: [{ signal: "AUTONOMY", quote: AUTONOMY_QUOTE }], building_research_ratio: 70, interaction_load: 30 })],
    );
    evaluationId = evaluation.rows[0]!.id;
  }
  return { canonicalJobId, jobVersionId, matchRunId, decisionId, decisionFingerprint, jobContentHash, evaluationId };
}

/** A snapshot written the way the pre-122 materializer wrote it (requires an evaluation). */
async function insertOldSnapshot(pool: pg.Pool, workspaceId: string, profileVersionId: string, job: JobIds, policyVersion: number, score: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_ranking_snapshots (
       workspace_id, canonical_job_id, job_version_id, profile_version_id, match_run_id, deterministic_decision_id,
       ai_evaluation_id, ranking_policy_version, context_fingerprint, requirement_fit_score, requirement_coverage_score,
       evidence_completeness_score, lane_confidence_score, autonomy_score, overall_rank_score, ranking_confidence,
       is_top_ten_ready, policy_recheck_required
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 80, 90, 95, 100, 80, $10, 100, TRUE, FALSE) RETURNING id`,
    [workspaceId, job.canonicalJobId, job.jobVersionId, profileVersionId, job.matchRunId, job.decisionId,
      job.evaluationId, policyVersion, job.decisionFingerprint, score],
  );
  return rows[0]!.id;
}

async function latestPolicyVersion(pool: pg.Pool, workspaceId: string): Promise<number> {
  const { rows } = await pool.query<{ v: number }>(`SELECT MAX(policy_version)::int AS v FROM ranking_policies WHERE workspace_id = $1`, [workspaceId]);
  return rows[0]!.v;
}

beforeAll(() => {
  if (!skipReal) adminPool = new pg.Pool(pgConnectionConfig(databaseUrl));
});

afterAll(async () => {
  if (!adminPool) return;
  for (const schema of schemas) await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

describe.skipIf(skipReal)("migration 122: deterministic ranking composite (PostgreSQL)", () => {
  let upgradePool: pg.Pool;
  let workspace: WorkspaceContext;
  let profileVersionId = "";
  let jobWithEvaluation: JobIds;
  let jobPending: JobIds;
  let jobLowLane: JobIds;
  let oldPolicyVersion = 0;
  let oldSnapshotId = "";
  let policyRowsBefore: unknown[] = [];
  let columnsBefore: Record<string, string[]> = {};
  let columnsAfter: Record<string, string[]> = {};

  beforeAll(async () => {
    const upgrade = await newSchemaPool("ranking_upgrade");
    upgradePool = upgrade.pool;
    workspace = await migrate(upgradePool, migrationsBefore122());
    profileVersionId = await createProfile(upgradePool, workspace);
    jobWithEvaluation = await createReadyJob(upgradePool, workspace, profileVersionId, { laneConfidence: "High", matchScore: 80, withEvaluation: true });
    jobPending = await createReadyJob(upgradePool, workspace, profileVersionId, { laneConfidence: "High", matchScore: 80, withEvaluation: false });
    jobLowLane = await createReadyJob(upgradePool, workspace, profileVersionId, { laneConfidence: "Low", matchScore: 80, withEvaluation: true });
    oldPolicyVersion = await latestPolicyVersion(upgradePool, workspace.workspaceId);
    oldSnapshotId = await insertOldSnapshot(upgradePool, workspace.workspaceId, profileVersionId, jobWithEvaluation, oldPolicyVersion, 77);
    policyRowsBefore = (await upgradePool.query(`SELECT * FROM ranking_policies ORDER BY workspace_id, policy_version`)).rows;
    columnsBefore = await viewColumns(upgradePool);
    await migrate(upgradePool); // applies only 122
    columnsAfter = await viewColumns(upgradePool);
  }, 240_000);

  afterAll(async () => {
    await upgradePool?.end();
  });

  it("appends one policy version with the four deterministic weights and leaves old policy rows untouched", async () => {
    const rowsAfter = (await upgradePool.query(`SELECT * FROM ranking_policies ORDER BY workspace_id, policy_version`)).rows;
    expect(rowsAfter.slice(0, policyRowsBefore.length)).toEqual(policyRowsBefore);
    expect(rowsAfter.length).toBe(policyRowsBefore.length + 1);
    const latest = rowsAfter[rowsAfter.length - 1] as { policy_version: number; weights: Record<string, number>; schema_version: string; minimum_ranking_confidence: string };
    expect(latest.policy_version).toBe(oldPolicyVersion + 1);
    expect(latest.weights).toEqual({
      requirementFit: 37.5, requirementCoverage: 15, evidenceCompleteness: 10, laneConfidence: 10,
      autonomy: 0, politicsRisk: 0, sensoryWorkloadRisk: 0, strategicValue: 0,
    });
    expect(Number(latest.minimum_ranking_confidence)).toBe(90);
  });

  it("keeps every existing view column, name and order, and only appends columns", () => {
    for (const view of VIEWS) {
      expect(columnsAfter[view]!.slice(0, columnsBefore[view]!.length)).toEqual(columnsBefore[view]);
    }
    expect(columnsAfter.v_top_ten_ready_jobs_scoped).toEqual(columnsBefore.v_top_ten_ready_jobs_scoped);
    expect(columnsAfter.v_top_ten_ready_jobs_scoped).toContain("is_top_ten_ready");
    for (const view of ["v_apply_now_jobs_stage3_scoped", "v_top_ten_ready_jobs_stage3_scoped"] as const) {
      expect(columnsAfter[view]!.slice(columnsBefore[view]!.length)).toEqual(expect.arrayContaining([
        "ai_notes_pending", "ai_label_autonomy_score", "ai_label_politics_risk_score",
        "ai_label_sensory_workload_risk_score", "ai_label_focus_protection_score",
        "ai_label_culture_priority_score", "ai_label_evidence",
      ]));
    }
  });

  it("keeps the pre-existing snapshot and its evaluation id; it is hidden until the new policy is materialised", async () => {
    const { rows } = await upgradePool.query(`SELECT ai_evaluation_id, ranking_policy_version FROM job_ranking_snapshots WHERE id = $1`, [oldSnapshotId]);
    expect(rows).toEqual([{ ai_evaluation_id: jobWithEvaluation.evaluationId, ranking_policy_version: oldPolicyVersion }]);
    const top = await upgradePool.query(`SELECT canonical_job_id FROM v_top_ten_ready_jobs_scoped WHERE workspace_id = $1`, [workspace.workspaceId]);
    expect(top.rows).toEqual([]);
  });

  it("re-materialises every eligible job under the new policy version, with no AI call", async () => {
    const started = Date.now();
    const result = await materializeApplicationRankings(upgradePool, workspace.workspaceId, { preferenceContext: null });
    const elapsedMs = Date.now() - started;
    expect(result).toMatchObject({ eligibleApplyNowJobs: 3, snapshotsInserted: 3, snapshotsAlreadyCurrent: 0, missingCurrentEvaluations: 1 });
    expect(elapsedMs).toBeLessThan(30_000);
    const again = await materializeApplicationRankings(upgradePool, workspace.workspaceId, { preferenceContext: null });
    expect(again).toMatchObject({ snapshotsInserted: 0, snapshotsAlreadyCurrent: 3 });
    const old = await upgradePool.query(`SELECT 1 FROM job_ranking_snapshots WHERE id = $1`, [oldSnapshotId]);
    expect(old.rowCount).toBe(1);
  });

  it("shows a job without a current AI evaluation in the Top 10 flagged AI notes pending, and AI labels as display-only", async () => {
    const { rows } = await upgradePool.query<{
      canonical_job_id: string; ai_evaluation_id: string | null; ai_notes_pending: boolean;
      ai_label_autonomy_score: string | null; ai_label_evidence: Array<{ signal: string; quote: string | null }>;
      overall_rank_score: string; is_top_ten_ready: boolean;
    }>(
      `SELECT canonical_job_id, ai_evaluation_id, ai_notes_pending, ai_label_autonomy_score, ai_label_evidence, overall_rank_score, is_top_ten_ready
         FROM v_top_ten_ready_jobs_stage3_scoped WHERE workspace_id = $1`,
      [workspace.workspaceId],
    );
    expect(rows).toHaveLength(3);
    const pending = rows.find((row) => row.canonical_job_id === jobPending.canonicalJobId)!;
    const evaluated = rows.find((row) => row.canonical_job_id === jobWithEvaluation.canonicalJobId)!;
    expect(pending).toMatchObject({ ai_evaluation_id: null, ai_notes_pending: true, ai_label_autonomy_score: null, is_top_ten_ready: true });
    expect(pending.ai_label_evidence).toEqual([]);
    expect(evaluated.ai_evaluation_id).toBe(jobWithEvaluation.evaluationId);
    expect(evaluated.ai_notes_pending).toBe(false);
    expect(evaluated.ai_label_evidence[0]).toMatchObject({ signal: "AUTONOMY", quote: AUTONOMY_QUOTE });
    expect(Number(evaluated.ai_label_autonomy_score)).toBeGreaterThan(0);
    // Same deterministic inputs: AI labels or their absence do not change the rank.
    expect(Number(evaluated.overall_rank_score)).toBe(Number(pending.overall_rank_score));
  });

  it("returns one Top 10 row per job when a snapshot with an evaluation and one without both exist", async () => {
    const policyVersion = await latestPolicyVersion(upgradePool, workspace.workspaceId);
    // Same context and policy version as the materialised snapshot, but ai_evaluation_id NULL.
    await upgradePool.query(
      `INSERT INTO job_ranking_snapshots (
         workspace_id, canonical_job_id, job_version_id, profile_version_id, match_run_id, deterministic_decision_id,
         ai_evaluation_id, ranking_policy_version, context_fingerprint, overall_rank_score, ranking_confidence,
         is_top_ten_ready, policy_recheck_required
       ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, 99, 100, TRUE, FALSE)`,
      [workspace.workspaceId, jobWithEvaluation.canonicalJobId, jobWithEvaluation.jobVersionId, profileVersionId,
        jobWithEvaluation.matchRunId, jobWithEvaluation.decisionId, policyVersion, jobWithEvaluation.decisionFingerprint],
    );
    for (const view of ["v_top_ten_ready_jobs_scoped", "v_top_ten_ready_jobs_stage3_scoped"]) {
      const { rows } = await upgradePool.query<{ canonical_job_id: string; ai_evaluation_id: string | null }>(
        `SELECT canonical_job_id, ai_evaluation_id FROM ${view} WHERE workspace_id = $1 AND canonical_job_id = $2`,
        [workspace.workspaceId, jobWithEvaluation.canonicalJobId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ai_evaluation_id).toBe(jobWithEvaluation.evaluationId);
    }
    const applyNow = await upgradePool.query(
      `SELECT canonical_job_id FROM v_apply_now_jobs_stage3_scoped WHERE workspace_id = $1 AND canonical_job_id = $2`,
      [workspace.workspaceId, jobWithEvaluation.canonicalJobId],
    );
    expect(applyNow.rowCount).toBe(1);
  });

  it("prevents a duplicate NULL-evaluation snapshot for the same context (NULLS NOT DISTINCT key)", async () => {
    const policyVersion = await latestPolicyVersion(upgradePool, workspace.workspaceId);
    const duplicate = () => upgradePool.query(
      `INSERT INTO job_ranking_snapshots (
         workspace_id, canonical_job_id, job_version_id, profile_version_id, match_run_id, deterministic_decision_id,
         ai_evaluation_id, ranking_policy_version, context_fingerprint, overall_rank_score, ranking_confidence,
         is_top_ten_ready, policy_recheck_required
       ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, 50, 100, TRUE, FALSE)`,
      [workspace.workspaceId, jobPending.canonicalJobId, jobPending.jobVersionId, profileVersionId,
        jobPending.matchRunId, jobPending.decisionId, policyVersion, jobPending.decisionFingerprint],
    );
    await expect(duplicate()).rejects.toMatchObject({ code: "23505" });
  });

  it("re-materialises when a new policy version is appended, and keeps the old version's snapshots", async () => {
    const before = await upgradePool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_ranking_snapshots`);
    const previous = await latestPolicyVersion(upgradePool, workspace.workspaceId);
    await upgradePool.query(
      `INSERT INTO ranking_policies (workspace_id, policy_version, schema_version, weights, minimum_ranking_confidence)
       SELECT workspace_id, policy_version + 1, schema_version, weights, minimum_ranking_confidence
         FROM ranking_policies WHERE workspace_id = $1 AND policy_version = $2`,
      [workspace.workspaceId, previous],
    );
    const result = await materializeApplicationRankings(upgradePool, workspace.workspaceId, { preferenceContext: null });
    expect(result).toMatchObject({ snapshotsInserted: 3, snapshotsAlreadyCurrent: 0 });
    const after = await upgradePool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_ranking_snapshots`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 3);
    const top = await upgradePool.query(`SELECT canonical_job_id, ranking_policy_version FROM v_top_ten_ready_jobs_scoped WHERE workspace_id = $1`, [workspace.workspaceId]);
    expect(top.rowCount).toBe(3);
    expect(new Set(top.rows.map((row: { ranking_policy_version: number }) => row.ranking_policy_version))).toEqual(new Set([previous + 1]));
  });

  it("compares old and new policy side by side without writing, marking rated rows and the lane confidence effect", async () => {
    const snapshotsBefore = await upgradePool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_ranking_snapshots`);
    const comparison = await compareRankingPolicies(upgradePool, workspace.workspaceId, {
      oldPolicyVersion,
      newPolicyVersion: oldPolicyVersion + 1,
      ratings: new Map([[jobWithEvaluation.canonicalJobId, "YES"], [jobPending.canonicalJobId, "NO"]]),
    });
    const snapshotsAfter = await upgradePool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_ranking_snapshots`);
    expect(snapshotsAfter.rows[0]!.n).toBe(snapshotsBefore.rows[0]!.n);

    expect(comparison.eligibleJobs).toBe(3);
    // Old policy needs a current AI evaluation: the pending job is not in the old Top 10.
    expect(comparison.oldTopTen.map((job) => job.canonicalJobId)).not.toContain(jobPending.canonicalJobId);
    expect(comparison.oldTopTen).toHaveLength(2);
    expect(comparison.newTopTen).toHaveLength(3);
    expect(comparison.enteredTopTen).toEqual([jobPending.canonicalJobId]);
    expect(comparison.leftTopTen).toEqual([]);
    const pending = comparison.newTopTen.find((job) => job.canonicalJobId === jobPending.canonicalJobId)!;
    expect(pending).toMatchObject({ aiNotesPending: true, rating: "NO" });
    expect(comparison.newTopTen.find((job) => job.canonicalJobId === jobWithEvaluation.canonicalJobId)?.rating).toBe("YES");
    // Low lane confidence costs (100 - 30) * 10 / 72.5 composite points on the new composite.
    const low = comparison.laneConfidenceEffect.find((row) => row.laneConfidence === "low")!;
    expect(low.jobs).toBe(1);
    expect(low.meanCompositePointsBelowHigh).toBeCloseTo(70 * 10 / 72.5, 2);
    expect(comparison.laneConfidenceEffect.find((row) => row.laneConfidence === "high")?.meanCompositePointsBelowHigh).toBe(0);
    // The Low-lane job ranks below the otherwise identical High-lane jobs.
    const ranks = Object.fromEntries(comparison.newTopTen.map((job) => [job.canonicalJobId, job.rank]));
    expect(ranks[jobLowLane.canonicalJobId]).toBe(3);
  });
});

describe.skipIf(skipReal)("migration 122 on a fresh schema (PostgreSQL)", () => {
  let freshPool: pg.Pool;
  let workspace: WorkspaceContext;

  beforeAll(async () => {
    const fresh = await newSchemaPool("ranking_fresh");
    freshPool = fresh.pool;
    workspace = await migrate(freshPool);
  }, 240_000);

  afterAll(async () => {
    await freshPool?.end();
  });

  it("records the migration, makes ai_evaluation_id nullable and keeps the NULL-safe unique key", async () => {
    const applied = await freshPool.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [MIGRATION_122]);
    expect(applied.rowCount).toBe(1);
    const column = await freshPool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'job_ranking_snapshots' AND column_name = 'ai_evaluation_id'`,
    );
    expect(column.rows[0]?.is_nullable).toBe("YES");
    const key = await freshPool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'job_ranking_snapshots'::regclass AND conname = 'job_ranking_snapshots_context_key'`,
    );
    expect(key.rows[0]?.definition).toContain("NULLS NOT DISTINCT");
    expect(key.rows[0]?.definition).toContain("ai_evaluation_id");
  });

  it("seeds the latest policy with the four deterministic weights and zero AI weights", async () => {
    const { rows } = await freshPool.query<{ weights: Record<string, number>; schema_version: string }>(
      `SELECT weights, schema_version FROM ranking_policies WHERE workspace_id = $1 ORDER BY policy_version DESC LIMIT 1`,
      [workspace.workspaceId],
    );
    expect(rows[0]?.schema_version).toBe("5.5.0");
    expect(rows[0]?.weights).toMatchObject({ requirementFit: 37.5, requirementCoverage: 15, evidenceCompleteness: 10, laneConfidence: 10, autonomy: 0, politicsRisk: 0, sensoryWorkloadRisk: 0, strategicValue: 0 });
  });

  it("seeds the same weights for a workspace created after the migration", async () => {
    const created = await freshPool.query<{ id: string }>(
      `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Fresh Workspace') RETURNING id`,
      [`fresh-${crypto.randomUUID()}`],
    );
    const { rows } = await freshPool.query<{ policy_version: number; weights: Record<string, number> }>(
      `SELECT policy_version, weights FROM ranking_policies WHERE workspace_id = $1`,
      [created.rows[0]!.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.weights.laneConfidence).toBe(10);
    expect(rows[0]!.weights.autonomy).toBe(0);
  });
});

async function addEvaluation(pool: pg.Pool, workspace: WorkspaceContext, profileVersionId: string, job: JobIds): Promise<string> {
  const evaluation = await pool.query<{ id: string }>(
    `INSERT INTO ai_evaluations (workspace_id, canonical_job_id, job_version_id, profile_version_id, match_run_id,
       deterministic_decision_id, job_content_hash, context_fingerprint, full_evaluation_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
    [workspace.workspaceId, job.canonicalJobId, job.jobVersionId, profileVersionId, job.matchRunId, job.decisionId,
      job.jobContentHash, job.decisionFingerprint,
      JSON.stringify({ culture_evidence: [{ signal: "AUTONOMY", quote: AUTONOMY_QUOTE }] })],
  );
  return evaluation.rows[0]!.id;
}

describe.skipIf(skipReal)("Top 10 never loses a job while its evaluation arrives (PostgreSQL)", () => {
  let pool: pg.Pool;
  let workspace: WorkspaceContext;
  let profileVersionId = "";

  beforeAll(async () => {
    pool = (await newSchemaPool("ranking_sequence")).pool;
    workspace = await migrate(pool);
    profileVersionId = await createProfile(pool, workspace);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
  });

  const topTenRows = async (jobId: string) => (await pool.query<{ ai_evaluation_id: string | null; ai_notes_pending: boolean }>(
    `SELECT ai_evaluation_id, ai_notes_pending FROM v_top_ten_ready_jobs_stage3_scoped
      WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [workspace.workspaceId, jobId],
  )).rows;
  const applyNowRows = async (jobId: string) => (await pool.query(
    `SELECT 1 FROM v_apply_now_jobs_stage3_scoped WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [workspace.workspaceId, jobId],
  )).rowCount;

  it("ranked without evaluation -> evaluation arrives -> materializer runs: exactly one Top 10 row at every step", async () => {
    const job = await createReadyJob(pool, workspace, profileVersionId, { laneConfidence: "High", matchScore: 80, withEvaluation: false });

    await materializeApplicationRankings(pool, workspace.workspaceId, { preferenceContext: null });
    expect(await topTenRows(job.canonicalJobId)).toEqual([{ ai_evaluation_id: null, ai_notes_pending: true }]);

    // The evaluation completes; the materializer has not run yet. The job must not vanish.
    const evaluationId = await addEvaluation(pool, workspace, profileVersionId, job);
    expect(await topTenRows(job.canonicalJobId)).toEqual([{ ai_evaluation_id: null, ai_notes_pending: true }]);
    expect(await applyNowRows(job.canonicalJobId)).toBe(1);

    const result = await materializeApplicationRankings(pool, workspace.workspaceId, { preferenceContext: null });
    expect(result).toMatchObject({ snapshotsInserted: 1, missingCurrentEvaluations: 0 });
    expect(await topTenRows(job.canonicalJobId)).toEqual([{ ai_evaluation_id: evaluationId, ai_notes_pending: false }]);
    expect(await applyNowRows(job.canonicalJobId)).toBe(1);
    const snapshots = await pool.query(`SELECT 1 FROM job_ranking_snapshots WHERE canonical_job_id = $1`, [job.canonicalJobId]);
    expect(snapshots.rowCount).toBe(2);
  });

  it("refuses an invalid latest policy with an explicit policyError and writes nothing", async () => {
    const before = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_ranking_snapshots`);
    // Total 100 with an AI weight: the table check admits it (old rows need that), the materializer must not.
    await pool.query(
      `INSERT INTO ranking_policies (workspace_id, policy_version, schema_version, weights, minimum_ranking_confidence)
       SELECT workspace_id, policy_version + 1, '5.5.0',
              '{"requirementFit":35,"requirementCoverage":15,"evidenceCompleteness":10,"laneConfidence":10,"autonomy":10,"politicsRisk":7.5,"sensoryWorkloadRisk":5,"strategicValue":7.5}'::jsonb,
              minimum_ranking_confidence
         FROM ranking_policies WHERE workspace_id = $1 ORDER BY policy_version DESC LIMIT 1`,
      [workspace.workspaceId],
    );
    const result = await materializeApplicationRankings(pool, workspace.workspaceId, { preferenceContext: null });
    expect(result.policyError).toMatch(/display-only/);
    expect(result.snapshotsInserted).toBe(0);
    const after = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_ranking_snapshots`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe.skipIf(skipReal)("ranking_policies_weights_chk after migration 122 (PostgreSQL)", () => {
  let pool: pg.Pool;
  let workspace: WorkspaceContext;
  let version = 100;

  beforeAll(async () => {
    pool = (await newSchemaPool("ranking_check")).pool;
    workspace = await migrate(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
  });

  const insertPolicy = (weights: Record<string, unknown>) => pool.query(
    `INSERT INTO ranking_policies (workspace_id, policy_version, schema_version, weights, minimum_ranking_confidence)
     VALUES ($1, $2, '5.5.0', $3::jsonb, 90)`,
    [workspace.workspaceId, version++, JSON.stringify(weights)],
  );
  const base = {
    requirementFit: 37.5, requirementCoverage: 15, evidenceCompleteness: 10, laneConfidence: 10,
    autonomy: 0, politicsRisk: 0, sensoryWorkloadRisk: 0, strategicValue: 0,
  };

  it("accepts the deterministic shape and a classic total-100 shape", async () => {
    await insertPolicy(base);
    await insertPolicy({ ...base, requirementFit: 100, requirementCoverage: 0, evidenceCompleteness: 0, laneConfidence: 0 });
    await insertPolicy({ ...base, requirementFit: 35, requirementCoverage: 15, evidenceCompleteness: 10, laneConfidence: 10, autonomy: 10, politicsRisk: 7.5, sensoryWorkloadRisk: 5, strategicValue: 7.5 });
  });

  it.each([
    ["deterministic total above 100", { ...base, requirementFit: 100.5 }],
    ["all weights zero", { ...base, requirementFit: 0, requirementCoverage: 0, evidenceCompleteness: 0, laneConfidence: 0 }],
    ["autonomy with a total that is not 100", { ...base, autonomy: 5 }],
    ["politicsRisk with a total that is not 100", { ...base, politicsRisk: 1 }],
    ["sensoryWorkloadRisk with a total that is not 100", { ...base, sensoryWorkloadRisk: 1 }],
    ["strategicValue with a total that is not 100", { ...base, strategicValue: 1 }],
    ["a missing key", Object.fromEntries(Object.entries(base).filter(([key]) => key !== "laneConfidence"))],
    ["an unknown key", { ...base, culturePriorityFit: 0 }],
    ["a negative weight", { ...base, requirementFit: -1, requirementCoverage: 52.5 }],
    ["a non-number weight", { ...base, requirementFit: "37.5" }],
  ])("rejects %s", async (_label, weights) => {
    await expect(insertPolicy(weights)).rejects.toMatchObject({ code: "23514" });
  });
});

describe.skipIf(skipReal)("migration 122 rollback (PostgreSQL)", () => {
  let pool: pg.Pool;
  let workspace: WorkspaceContext;
  let before: Record<string, string[]> = {};

  /** One CREATE OR REPLACE VIEW statement of a migration file, up to its terminating semicolon. */
  function viewStatement(file: string, view: string): string {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const marker = `CREATE OR REPLACE VIEW ${view} AS`;
    const start = text.lastIndexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start);
    const end = rest.search(/;[ \t]*\r?\n(?=\s*(CREATE|COMMENT|DROP|ALTER|INSERT|--|$))/);
    return rest.slice(0, end + 1);
  }

  beforeAll(async () => {
    pool = (await newSchemaPool("ranking_rollback")).pool;
    workspace = await migrate(pool, migrationsBefore122());
    before = await viewColumns(pool);
    await migrate(pool); // applies 122
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("runs the documented rollback steps and restores the previous views, nullability and active weights", async () => {
    const header = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_122), "utf8");
    expect(header).toContain("DROP VIEW IF EXISTS v_apply_now_jobs_stage3_scoped;");
    expect(header).toContain("needs human approval");
    expect((await viewColumns(pool)).v_apply_now_jobs_stage3_scoped).toContain("ai_notes_pending");

    // a. views
    await pool.query("DROP VIEW IF EXISTS v_apply_now_jobs_stage3_scoped");
    await pool.query("DROP VIEW IF EXISTS v_top_ten_ready_jobs_stage3_scoped");
    await pool.query(viewStatement("078_evidence_readiness_discovery.sql", "v_apply_now_jobs_scoped"));
    await pool.query(viewStatement("078_evidence_readiness_discovery.sql", "v_top_ten_ready_jobs_scoped"));
    await pool.query(viewStatement("104_apply_now_career_track.sql", "v_apply_now_jobs_stage3_scoped"));
    await pool.query(viewStatement("075_user_preference_lineage_freshness_company_policy.sql", "v_top_ten_ready_jobs_stage3_scoped"));
    // b. previous weights as a new, higher policy version
    await pool.query(
      `INSERT INTO ranking_policies (workspace_id, policy_version, schema_version, weights, minimum_ranking_confidence)
       SELECT workspace_id, policy_version + 1, '5.2.0',
              '{"requirementFit":37.5,"requirementCoverage":15,"evidenceCompleteness":10,"laneConfidence":10,"autonomy":10,"politicsRisk":7.5,"sensoryWorkloadRisk":5,"strategicValue":5}'::jsonb,
              minimum_ranking_confidence
         FROM ranking_policies WHERE workspace_id = $1 ORDER BY policy_version DESC LIMIT 1`,
      [workspace.workspaceId],
    );
    // c. nullability, valid while no NULL-evaluation snapshot exists
    await pool.query("ALTER TABLE job_ranking_snapshots ALTER COLUMN ai_evaluation_id SET NOT NULL");

    expect(await viewColumns(pool)).toEqual(before);
    const column = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'job_ranking_snapshots' AND column_name = 'ai_evaluation_id'`,
    );
    expect(column.rows[0]?.is_nullable).toBe("NO");
    const { rows } = await pool.query<{ weights: Record<string, number> }>(
      `SELECT weights FROM ranking_policies WHERE workspace_id = $1 ORDER BY policy_version DESC LIMIT 1`,
      [workspace.workspaceId],
    );
    expect(rows[0]?.weights.autonomy).toBe(10);
    for (const view of VIEWS) await pool.query(`SELECT * FROM ${view} LIMIT 1`);
  });
});
