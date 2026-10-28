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
});
