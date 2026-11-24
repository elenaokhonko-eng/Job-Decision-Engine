/**
 * Recommendation Decider integration (real PostgreSQL)
 *
 * Guards against legacy/stale canonical_jobs.gate_decision values (e.g. "FAIL")
 * crashing the deterministic decider. Unknown values must be treated as
 * "unknown gate decision" so the policy defaults to VERIFY/TRACK.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

const DB_URL = process.env.DATABASE_URL || "";
const isCI = isLocalPostgresConnectionString(DB_URL);
const skipReal = !DB_URL || !isCI;

let pool: pg.Pool;
let client: pg.PoolClient;
let schemaName = "";

async function q(sql: string, params?: any[]): Promise<pg.QueryResult> {
  return client.query(sql, params);
}

describe.skipIf(skipReal)("Recommendation Decider: legacy gate_decision normalization", () => {
  const JOB_ID = "91000000-0000-0000-0000-000000000001";
  const VERSION_ID = "92000000-0000-0000-0000-000000000001";

  const seed = async () => {
    await q(
      `INSERT INTO canonical_jobs (
         id, company_name, normalized_title, canonical_url,
         processing_state, processing_status, gate_decision
       )
       VALUES ($1, 'DeciderTestCo', 'Legacy Gate Decision', 'https://example.test/decider',
               'LANE_ROUTED', 'LANE_ROUTED', 'FAIL')
       ON CONFLICT (id)
       DO UPDATE SET processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED', gate_decision = 'FAIL'`,
      [JOB_ID]
    );

    await q(
      `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [VERSION_ID, JOB_ID, `recommendation-decider-legacy-${JOB_ID}`, COMPLETE_TEST_POSTING_DESCRIPTION]
    );

    await q(`DELETE FROM raw_job_observations WHERE job_version_id = $1`, [VERSION_ID]);
    const workspace = await q(`SELECT workspace_id::text AS workspace_id FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    await insertCompletePostingEvidence(client, {
      workspaceId: workspace.rows[0].workspace_id,
      jobVersionId: VERSION_ID,
      companyName: "DeciderTestCo",
      title: "Legacy Gate Decision",
      sourceUrl: "https://example.test/decider",
      description: COMPLETE_TEST_POSTING_DESCRIPTION,
    });

    await q(`UPDATE canonical_jobs SET latest_job_version_id = $1, updated_at = NOW() WHERE id = $2`, [
      VERSION_ID,
      JOB_ID,
    ]);
  };

  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(DB_URL));

    client = await pool.connect();
    schemaName = `rec_decider_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    await seed();
  });

  beforeEach(async () => {
    await seed();
  });

  afterAll(async () => {
    await client.query("RESET search_path").catch(() => undefined);
    if (schemaName) {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    }
    client.release();
    await pool.end();
  });

  it("does not crash on canonical_jobs.gate_decision='FAIL' and records a normalized decision", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const summary = await runRecommendationDecider(client);
    expect(summary.errors).toBe(0);

    const res = await q(
      `SELECT decision_json
       FROM deterministic_decisions
       WHERE canonical_job_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [JOB_ID]
    );
    expect(res.rows.length).toBe(1);

    const decisionJson = typeof res.rows[0].decision_json === "string"
      ? JSON.parse(res.rows[0].decision_json)
      : res.rows[0].decision_json;

    expect(decisionJson.inputs.gate_decision).toBe("PASS");
    expect(Array.isArray(decisionJson.trace?.notes)).toBe(true);
    expect(decisionJson.trace.notes).toContain("legacy_gate_decision:FAIL->PASS");
  });

  it("persists a new decision when availability and evidence change", async ({ skip }) => {
    const readinessView = await q(
      "SELECT to_regclass('v_application_readiness_current') IS NOT NULL AS available",
    );
    if (readinessView.rows[0]?.available !== true) skip();

    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const first = await runRecommendationDecider(client);
    expect(first.errors).toBe(0);
    const before = await q(
      `SELECT id, context_fingerprint, readiness_fingerprint, evidence_revision_hash
       FROM deterministic_decisions
       WHERE canonical_job_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [JOB_ID],
    );
    expect(before.rows).toHaveLength(1);

    await q(
      `UPDATE job_versions
       SET evidence_revision_hash = $2,
           availability_status = 'OPEN',
           availability_evidence = $3::jsonb,
           availability_verified_at = NOW() - INTERVAL '1 minute',
           availability_recheck_at = NOW() + INTERVAL '1 day'
       WHERE id = $1`,
      [
        VERSION_ID,
        "a".repeat(64),
        JSON.stringify({ status: "OPEN", verification_method: "TEST_FIXTURE", reason_code: "SOURCE_CONFIRMED", evidence: [] }),
      ],
    );

    const second = await runRecommendationDecider(client);
    expect(second.errors).toBe(0);
    expect(second.decisionsInserted).toBe(1);
    const after = await q(
      `SELECT id, context_fingerprint, readiness_fingerprint, evidence_revision_hash
       FROM deterministic_decisions
       WHERE canonical_job_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [JOB_ID],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].id).not.toBe(before.rows[0].id);
    expect(after.rows[0].context_fingerprint).not.toBe(before.rows[0].context_fingerprint);
    expect(after.rows[0].readiness_fingerprint).not.toBe(before.rows[0].readiness_fingerprint);
    expect(after.rows[0].evidence_revision_hash).toBe("a".repeat(64));
  });

  it("persists the role-shape downrank with its evidence and keeps the job (never a rejection)", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const latest = async () => {
      const res = await q(
        `SELECT decision_json FROM deterministic_decisions WHERE canonical_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [JOB_ID],
      );
      return typeof res.rows[0].decision_json === "string" ? JSON.parse(res.rows[0].decision_json) : res.rows[0].decision_json;
    };
    await q(`UPDATE canonical_jobs SET normalized_title = 'Forward Deployed Engineer' WHERE id = $1`, [JOB_ID]);
    expect((await runRecommendationDecider(client)).errors).toBe(0);
    const shaped = await latest();
    expect(shaped.trace.role_downrank.policy_version).toBe("role_shape_v1");
    expect(shaped.trace.role_downrank.signals.map((signal: { code: string }) => signal.code)).toContain("CUSTOMER_FACING_DELIVERY");
    expect(shaped.trace.role_downrank.total_penalty).toBeGreaterThan(0);
    expect(shaped.trace.notes).toContain("role_downrank:CUSTOMER_FACING_DELIVERY");
    // No current match exists for this fixture, so the policy has no scores: the concrete outcome is TRACK (the downrank does not reject or skip).
    expect(shaped.outputs.outcome).toBe("TRACK");
    const stored = await q(`SELECT recommendation_outcome FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    expect(stored.rows[0].recommendation_outcome).toBe(shaped.outputs.outcome);

    // Without the signal the trace records no penalty, and the new decision is a separate row (the fingerprint changed).
    await q(`UPDATE canonical_jobs SET normalized_title = 'Data Scientist' WHERE id = $1`, [JOB_ID]);
    const again = await runRecommendationDecider(client);
    expect(again.errors).toBe(0);
    expect(again.decisionsInserted).toBe(1);
    expect((await latest()).trace.role_downrank).toMatchObject({ total_penalty: 0, signals: [] });
  });

  it("fully satisfied is judged on the RAW score: raw 0.92 with a penalised 0.865 stays PRIORITY; raw 0.85 does not", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const workspace = await q(`SELECT workspace_id FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    const workspaceId = workspace.rows[0].workspace_id;
    const profile = await q(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, 'raw_fixture', 'Raw Fixture') RETURNING id`,
      [workspaceId],
    );
    const profileVersion = await q(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status)
       VALUES ($1, $2, 1, '2.3.0', $3, 'ACTIVE') RETURNING id`,
      [workspaceId, profile.rows[0].id, "e".repeat(64)],
    );
    const identity = await q(
      `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version, quoted_extractor_version, quoted_prompt_hash, normalizer_hash)
       VALUES ($1, $2, 'raw-identity', 'h', 'v', 'v', 'p', 'n') RETURNING id`,
      [workspaceId, JOB_ID],
    );
    const set = await q(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
       VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
      [workspaceId, identity.rows[0].id, JOB_ID, VERSION_ID],
    );
    await q(`UPDATE job_versions SET active_requirement_set_id = $2 WHERE id = $1`, [VERSION_ID, set.rows[0].id]);
    const hash = await q(`SELECT content_hash FROM job_versions WHERE id = $1`, [VERSION_ID]);
    const decide = async (rawScore: number, fingerprint: string) => {
      const run = await q(
        `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, job_content_hash, context_fingerprint,
                                 status, requirement_count, matched_count, coverage_score, overall_match_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', 8, 8, 100, $8) RETURNING id`,
        [workspaceId, JOB_ID, VERSION_ID, profileVersion.rows[0].id, set.rows[0].id, hash.rows[0].content_hash, fingerprint, rawScore],
      );
      await q(
        `UPDATE canonical_jobs SET latest_match_run_id = $2, deterministic_match_score = $3, deterministic_match_coverage = 100,
                profile_match_status = 'POSITIVE_MATCH', gate_decision = 'PASS', normalized_title = 'Forward Deployed Engineer',
                workplace_type = 'REMOTE', workability_facts = '{"employment_type":"PERMANENT"}'::jsonb WHERE id = $1`,
        [JOB_ID, run.rows[0].id, rawScore],
      );
      expect((await runRecommendationDecider(client)).errors).toBe(0);
      const res = await q(`SELECT decision_json FROM deterministic_decisions WHERE canonical_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [JOB_ID]);
      return typeof res.rows[0].decision_json === "string" ? JSON.parse(res.rows[0].decision_json) : res.rows[0].decision_json;
    };

    const full = await decide(92, "raw-92");
    expect(full.trace.role_downrank.raw_requirement_score).toBeCloseTo(0.92, 3);
    expect(full.outputs.recommendation_requirement_score).toBeLessThan(0.9);
    expect(full.outputs.outcome).toBe("PRIORITY");
    expect(full.trace.notes).not.toContain("priority_downgraded_semantic_pending");

    const notFull = await decide(85, "raw-85");
    expect(notFull.outputs.recommendation_requirement_score).toBeGreaterThanOrEqual(0.75);
    expect(notFull.outputs.outcome).toBe("REVIEW");
    expect(notFull.trace.notes).toContain("priority_downgraded_semantic_pending");
  });

  it("records the career-track assessment from the active profile's experience_by_track", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const latestTrack = async () => {
      const res = await q(
        `SELECT decision_json FROM deterministic_decisions
         WHERE canonical_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [JOB_ID],
      );
      const json = typeof res.rows[0].decision_json === "string" ? JSON.parse(res.rows[0].decision_json) : res.rows[0].decision_json;
      return json.trace.career_track;
    };

    await q(`UPDATE canonical_jobs SET normalized_title = 'software engineer ii' WHERE id = $1`, [JOB_ID]);
    expect((await runRecommendationDecider(client)).errors).toBe(0);
    const withoutProfile = await latestTrack();
    expect(withoutProfile).toMatchObject({ track: "GENERIC_SOFTWARE", level: "MID", candidate_years: null, tags: ["TRACK_EXPERIENCE_MISSING"] });

    const workspace = await q(`SELECT workspace_id FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    const workspaceId = workspace.rows[0].workspace_id;
    const profile = await q(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, 'track_fixture', 'Track Fixture') RETURNING id`,
      [workspaceId],
    );
    await q(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, experience_by_track)
       VALUES ($1, $2, 1, '2.3.0', $3, 'ACTIVE', $4::jsonb)`,
      [workspaceId, profile.rows[0].id, "b".repeat(64), JSON.stringify([
        { track: "HANDS_ON_AI_DATA", years: 1.5, label: "Synthetic hands-on track" },
        { track: "DATA_MANAGEMENT", years: 16, label: "Synthetic data track" },
      ])],
    );

    const second = await runRecommendationDecider(client);
    expect(second.errors).toBe(0);
    expect(second.decisionsInserted).toBe(1);
    const withProfile = await latestTrack();
    expect(withProfile).toMatchObject({
      track: "GENERIC_SOFTWARE",
      level: "MID",
      candidate_years: 1.5,
      fit: "FIT",
      tags: ["OFF_TRACK"],
      outcome_cap: "REVIEW",
    });
  });

  it("refuses a stored experience_by_track that is not an array", async () => {
    const workspace = await q(`SELECT workspace_id FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    const profile = await q(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, 'track_fixture_malformed', 'Track Fixture') RETURNING id`,
      [workspace.rows[0].workspace_id],
    );
    await expect(q(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, experience_by_track)
       VALUES ($1, $2, 1, '2.3.0', $3, 'DRAFT', '{"track":"PRODUCT"}'::jsonb)`,
      [workspace.rows[0].workspace_id, profile.rows[0].id, "c".repeat(64)],
    )).rejects.toThrow(/profile_versions_experience_by_track_array_check/);
  });
});
