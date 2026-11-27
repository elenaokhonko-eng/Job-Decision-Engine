/**
 * Recommendation Decider integration (real PostgreSQL)
 *
 * Guards against legacy/stale canonical_jobs.gate_decision values (e.g. "FAIL")
 * crashing the deterministic decider. Unknown values must be treated as
 * "unknown gate decision" so the policy defaults to VERIFY/TRACK.
 */
import { DECIDER_VERSION } from "../../pipeline/deciderVersion.js";
import { ROLE_SHAPE_POLICY_VERSION } from "../../pipeline/roleShape.js";
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
    expect(shaped.trace.role_downrank.policy_version).toBe(ROLE_SHAPE_POLICY_VERSION);
    expect(shaped.trace.role_downrank.signals.map((signal: { code: string }) => signal.code)).toContain("CUSTOMER_FACING_DELIVERY");
    expect(shaped.trace.role_downrank.total_penalty).toBeGreaterThan(0);
    expect(shaped.trace.notes).toContain("role_downrank:CUSTOMER_FACING_DELIVERY");
    // No current match exists for this fixture, so the policy has no scores: the concrete outcome is TRACK (the downrank does not reject or skip).
    expect(shaped.outputs.outcome).toBe("TRACK");
    expect(shaped.trace.evidence_confidence).toMatchObject({ level: "NORMAL", requirement_count: null });
    const stored = await q(`SELECT recommendation_outcome FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    expect(stored.rows[0].recommendation_outcome).toBe(shaped.outputs.outcome);

    // Without the signal the trace records no penalty, and the new decision is a separate row (the fingerprint changed).
    await q(`UPDATE canonical_jobs SET normalized_title = 'Data Scientist' WHERE id = $1`, [JOB_ID]);
    const again = await runRecommendationDecider(client);
    expect(again.errors).toBe(0);
    expect(again.decisionsInserted).toBe(1);
    expect((await latest()).trace.role_downrank).toMatchObject({ total_penalty: 0, signals: [] });
  });

  it("a re-gate that flips the gate outcome on an identical match context writes a NEW decision row (the old one is not returned by the conflict clause); flipping back reuses the first row", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const linked = async () => (await q(`SELECT latest_deterministic_decision_id::text AS id, recommendation_eligibility AS eligibility FROM canonical_jobs WHERE id = $1`, [JOB_ID])).rows[0];
    await q(`UPDATE canonical_jobs SET gate_decision = 'PASS', rejection_reason = NULL WHERE id = $1`, [JOB_ID]);
    const first = await runRecommendationDecider(client);
    expect(first.errors).toBe(0);
    const passRow = await linked();
    expect(passRow.id).toBeTruthy();

    await q(`UPDATE canonical_jobs SET gate_decision = 'NEEDS_VERIFICATION', rejection_reason = 'GATE_UNKNOWN_WORK_MODE, NEEDS_VERIFICATION', processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED' WHERE id = $1`, [JOB_ID]);
    const flipped = await runRecommendationDecider(client);
    expect(flipped.errors).toBe(0);
    expect(flipped.decisionsInserted).toBe(1);
    const verifyRow = await linked();
    expect(verifyRow.id).not.toBe(passRow.id);

    await q(`UPDATE canonical_jobs SET gate_decision = 'PASS', rejection_reason = NULL, processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED' WHERE id = $1`, [JOB_ID]);
    const back = await runRecommendationDecider(client);
    expect(back.errors).toBe(0);
    expect(back.decisionsInserted).toBe(0);
    expect((await linked()).id).toBe(passRow.id);
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

  it("records LOW confidence for a thin posting, keeps the score, and never leaves PRIORITY standing", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const workspace = await q(`SELECT workspace_id FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    const workspaceId = workspace.rows[0].workspace_id;
    const profile = await q(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, 'thin_fixture', 'Thin Fixture') RETURNING id`,
      [workspaceId],
    );
    const profileVersion = await q(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status)
       VALUES ($1, $2, 1, '2.3.0', $3, 'ACTIVE') RETURNING id`,
      [workspaceId, profile.rows[0].id, "c".repeat(64)],
    );
    const identity = await q(
      `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version, quoted_extractor_version, quoted_prompt_hash, normalizer_hash)
       VALUES ($1, $2, 'thin-identity', 'h', 'v', 'v', 'p', 'n') RETURNING id`,
      [workspaceId, JOB_ID],
    );
    const set = await q(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
       VALUES ($1, $2, $3, $4, 2, 'EXTRACTED') RETURNING id`,
      [workspaceId, identity.rows[0].id, JOB_ID, VERSION_ID],
    );
    await q(`UPDATE job_versions SET active_requirement_set_id = $2 WHERE id = $1`, [VERSION_ID, set.rows[0].id]);
    const hash = await q(`SELECT content_hash FROM job_versions WHERE id = $1`, [VERSION_ID]);
    const run = await q(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, job_content_hash, context_fingerprint,
                               status, requirement_count, matched_count, coverage_score, overall_match_score)
       VALUES ($1, $2, $3, $4, $5, $6, 'thin-context', 'COMPLETED', 2, 2, 100, 95) RETURNING id`,
      [workspaceId, JOB_ID, VERSION_ID, profileVersion.rows[0].id, set.rows[0].id, hash.rows[0].content_hash],
    );
    await q(
      `UPDATE canonical_jobs SET latest_match_run_id = $2, deterministic_match_score = 95, deterministic_match_coverage = 100,
              profile_match_status = 'POSITIVE_MATCH', gate_decision = 'PASS', normalized_title = 'Data Scientist',
              workplace_type = 'REMOTE', workability_facts = '{"employment_type":"PERMANENT"}'::jsonb WHERE id = $1`,
      [JOB_ID, run.rows[0].id],
    );
    expect((await runRecommendationDecider(client)).errors).toBe(0);
    const res = await q(`SELECT decision_json FROM deterministic_decisions WHERE canonical_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [JOB_ID]);
    const json = typeof res.rows[0].decision_json === "string" ? JSON.parse(res.rows[0].decision_json) : res.rows[0].decision_json;
    expect(json.trace.evidence_confidence).toMatchObject({ level: "LOW", reason: "THIN_POSTING", requirement_count: 2 });
    expect(json.trace.notes).toContain("thin_posting_low_confidence");
    // The score is untouched by thinness; and the outcome is never PRIORITY on two requirements.
    expect(json.outputs.recommendation_requirement_score).toBeCloseTo(0.95, 2);
    expect(json.outputs.outcome).not.toBe("PRIORITY");
    // Two requirements is thin, yet the policy alone would have made this PRIORITY (score, coverage and evidence all above
    // the thresholds): the cap is what holds it at REVIEW, so it is not dead code.
    expect(json.trace.notes).toContain("priority_downgraded_thin_posting");
    expect(json.outputs.outcome).toBe("REVIEW");
  });

  it("a MUST degree the match found short is labelled and downranked 0.06 only: readiness is exactly what it would be without the flag", async () => {
    const { runRecommendationDecider, loadDegreeGapQuote } = await import("../../pipeline/recommendationDecider.js");
    const workspace = await q(`SELECT workspace_id FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    const workspaceId = workspace.rows[0].workspace_id;
    const profile = await q(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, 'degree_fixture', 'Degree Fixture') RETURNING id`,
      [workspaceId],
    );
    const profileVersion = await q(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status)
       VALUES ($1, $2, 1, '2.3.0', $3, 'ACTIVE') RETURNING id`,
      [workspaceId, profile.rows[0].id, "d".repeat(64)],
    );
    const identity = await q(
      `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version, quoted_extractor_version, quoted_prompt_hash, normalizer_hash)
       VALUES ($1, $2, 'degree-identity', 'h', 'v', 'v', 'p', 'n') RETURNING id`,
      [workspaceId, JOB_ID],
    );
    const set = await q(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
       VALUES ($1, $2, $3, $4, 3, 'EXTRACTED') RETURNING id`,
      [workspaceId, identity.rows[0].id, JOB_ID, VERSION_ID],
    );
    await q(`UPDATE job_versions SET active_requirement_set_id = $2 WHERE id = $1`, [VERSION_ID, set.rows[0].id]);
    const quote = "A doctoral degree in a quantitative subject is required.";
    const requirement = await q(
      `INSERT INTO job_requirements (workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type, importance,
                                     requirement_text, quote_text, extractor_type, extractor_version, confidence)
       VALUES ($1, $2, $3, $4, 'R-001', 'DEGREE', 'MUST', 'Role requires a degree qualification.', $5, 'DETERMINISTIC', 'v', 1) RETURNING id`,
      [workspaceId, JOB_ID, VERSION_ID, set.rows[0].id, quote],
    );
    const hash = await q(`SELECT content_hash FROM job_versions WHERE id = $1`, [VERSION_ID]);
    const run = await q(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, job_content_hash, context_fingerprint,
                               status, requirement_count, matched_count, coverage_score, overall_match_score)
       VALUES ($1, $2, $3, $4, $5, $6, 'degree-context', 'COMPLETED', 4, 3, 75, 70) RETURNING id`,
      [workspaceId, JOB_ID, VERSION_ID, profileVersion.rows[0].id, set.rows[0].id, hash.rows[0].content_hash],
    );
    await q(
      `INSERT INTO requirement_evidence_matches (workspace_id, match_run_id, requirement_id, match_type, match_score, evidence)
       VALUES ($1, $2, $3, 'NO_MATCH', 0, $4::jsonb)`,
      [workspaceId, run.rows[0].id, requirement.rows[0].id, JSON.stringify({ match_qualification_code: "MATCH_QUALIFICATION_DEGREE_GAP" })],
    );
    await q(
      `UPDATE canonical_jobs SET latest_match_run_id = $2, deterministic_match_score = 70, deterministic_match_coverage = 75,
              profile_match_status = 'POSITIVE_MATCH', gate_decision = 'PASS', normalized_title = 'Research Scientist',
              workplace_type = 'REMOTE', workability_facts = '{"employment_type":"PERMANENT"}'::jsonb WHERE id = $1`,
      [JOB_ID, run.rows[0].id],
    );
    // Scoped like the counts query: another workspace or job version never matches, and only the latest evidence row counts.
    expect(await loadDegreeGapQuote(client, { workspaceId: crypto.randomUUID(), matchRunId: run.rows[0].id, requirementSetId: set.rows[0].id, jobVersionId: VERSION_ID })).toBeNull();
    expect(await loadDegreeGapQuote(client, { workspaceId, matchRunId: run.rows[0].id, requirementSetId: set.rows[0].id, jobVersionId: crypto.randomUUID() })).toBeNull();
    expect(await loadDegreeGapQuote(client, { workspaceId, matchRunId: run.rows[0].id, requirementSetId: set.rows[0].id, jobVersionId: VERSION_ID })).toBe(quote);

    expect((await runRecommendationDecider(client)).errors).toBe(0);
    const res = await q(`SELECT decision_json, readiness_json FROM deterministic_decisions WHERE canonical_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [JOB_ID]);
    const parse = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as any;
    const decision = parse(res.rows[0].decision_json);
    const readiness = parse(res.rows[0].readiness_json);
    const downrank = decision.trace.role_downrank;
    expect(downrank.signals).toEqual([expect.objectContaining({ code: "DEGREE_GAP_FLAGGED", penalty: 0.06, quote })]);
    expect(downrank.raw_requirement_score).toBeCloseTo(0.7, 3);
    expect(decision.outputs.recommendation_requirement_score).toBeCloseTo(0.7 * 0.94, 3);
    expect(decision.trace.notes).toContain(`degree_asked_for: ${quote}`);
    // Migration 121: the same decision writes the read-model columns next to the adjusted score.
    const stored = await q(
      `SELECT recommendation_requirement_score, recommendation_score_policy, recommendation_degree_asked_for, recommendation_role_signals, recommendation_evidence_confidence
         FROM canonical_jobs WHERE id = $1`,
      [JOB_ID],
    );
    expect(Number(stored.rows[0].recommendation_requirement_score)).toBeCloseTo(0.7 * 0.94, 3);
    expect(stored.rows[0].recommendation_score_policy?.endsWith(`|${ROLE_SHAPE_POLICY_VERSION}`)).toBe(true);
    expect(stored.rows[0].recommendation_degree_asked_for).toBe(quote);
    expect(stored.rows[0].recommendation_role_signals).toEqual([expect.objectContaining({ code: "DEGREE_GAP_FLAGGED", penalty: 0.06, quote })]);
    expect(stored.rows[0].recommendation_evidence_confidence).toBe("NORMAL");

    // decider_version is written in the INSERT of the decision (rows are immutable), outside decision_hash.
    const stamped = await q(`SELECT decider_version FROM deterministic_decisions WHERE canonical_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [JOB_ID]);
    expect(stamped.rows[0].decider_version).toBe(DECIDER_VERSION);
    const check = readiness.checks.find((entry: { key: string }) => entry.key === "MANDATORY_QUALIFICATIONS");
    expect(check.status).toBe("MET");
    expect(check.reason_code).not.toBe("DEGREE_GAP_FLAGGED");
    expect(readiness.blockers ?? []).not.toContain("MANDATORY_QUALIFICATIONS");

    // Same job with the gap removed: overall readiness and the qualification check are identical, so the flag changed nothing but rank and label.
    await q(`UPDATE requirement_evidence_matches SET match_type = 'EXACT', evidence = '{}'::jsonb WHERE match_run_id = $1`, [run.rows[0].id]);
    const second = await runRecommendationDecider(client);
    expect(second).toMatchObject({ errors: 0, decisionsInserted: 1 });
    const clean = await q(`SELECT decision_json, readiness_json FROM deterministic_decisions WHERE canonical_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [JOB_ID]);
    const cleanReadiness = parse(clean.rows[0].readiness_json);
    const countRows = await q(`SELECT COUNT(*)::int n FROM deterministic_decisions WHERE canonical_job_id = $1`, [JOB_ID]);
    expect(parse(clean.rows[0].decision_json).trace.role_downrank.signals).toEqual([]);
    expect(cleanReadiness.status).toBe(readiness.status);
    expect(cleanReadiness.checks.find((entry: { key: string }) => entry.key === "MANDATORY_QUALIFICATIONS").status).toBe("MET");
    expect(decision.outputs.outcome).not.toBe("SKIP");
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

    // The new profile makes the stored match stale, and the decider keeps a stored score instead of deciding again.
    // This case is about the career track, so the job starts without a score.
    await q(`UPDATE canonical_jobs SET recommendation_requirement_score = NULL, recommendation_coverage_score = NULL WHERE id = $1`, [JOB_ID]);
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
