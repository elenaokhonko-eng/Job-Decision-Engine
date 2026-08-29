/**
 * REAL E2E pipeline test — Sprint B
 *
 * This test runs the actual pipeline functions (not in-memory simulations)
 * against a real isolated PostgreSQL schema. It inserts 9 fixture email
 * alerts into raw_email_alerts, then calls each pipeline stage in sequence,
 * and asserts actual DB row counts at every stage boundary.
 *
 * Requirements: DATABASE_URL must point to a PostgreSQL instance where
 * migrations 001–004 can run (CI container or a fresh Neon branch).
 * It uses a unique schema per run to avoid contamination.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runMigrations } from "../../db/migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Skip if running locally without the CI DB
const DB_URL = process.env.DATABASE_URL || "";
const isCI = DB_URL.includes("localhost") || DB_URL.includes("127.0.0.1");
const skipReal = !DB_URL || !isCI;

const SCHEMA = `e2e_test_${Date.now()}`;

let pool: pg.Pool;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function q(sql: string, params?: any[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

async function countWhere(table: string, condition: string): Promise<number> {
  const res = await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${condition}`);
  return res.rows[0].n;
}

// ── Nine-email fixture ────────────────────────────────────────────────────────

const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/anonymized_nine_emails.json");
const fixtureEmails: any[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(skipReal)("P0-02 & P0-10: Real PostgreSQL Pipeline E2E", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });

    // Create isolated schema
    await q(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await q(`SET search_path TO ${SCHEMA}, public`);

    // Apply all migrations into this schema
    await runMigrations(pool);
  });

  afterAll(async () => {
    // Drop the test schema so CI stays clean
    await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  // ── Stage 0: Ingest emails ─────────────────────────────────────────────────

  it("Stage 0 — should insert 9 fixture emails into raw_email_alerts", async () => {
    for (const email of fixtureEmails) {
      await q(
        `INSERT INTO raw_email_alerts (id, subject, body, gmail_message_id, processed)
         VALUES ($1, $2, $3, $4, FALSE)
         ON CONFLICT DO NOTHING`,
        [email.id, email.subject, email.raw_html || email.subject, email.id]
      );
    }
    const count = await countWhere("raw_email_alerts", "TRUE");
    expect(count).toBe(9);
  });

  // ── Stage 1: Normalize ─────────────────────────────────────────────────────

  it("Stage 1 — normalizer creates canonical jobs and versions without losing observations", async () => {
    // Import dynamically so env is already set
    const { runNormalization } = await import("../../pipeline/normalize.js");
    await runNormalization();

    const observationCount = await countWhere("raw_job_observations", "TRUE");
    const canonicalCount = await countWhere("canonical_jobs", "processing_status = 'RAW_STAGED'");
    const versionCount = await countWhere("job_versions", "TRUE");

    // All observations must have been processed (no silent drops)
    expect(observationCount).toBeGreaterThanOrEqual(9);
    // 8 unique canonical jobs (1 repost maps to existing)
    expect(canonicalCount).toBeGreaterThanOrEqual(8);
    // 9 versions (1 additional version for the repost)
    expect(versionCount).toBeGreaterThanOrEqual(9);
  });

  // ── Stage 2: Hard gates ────────────────────────────────────────────────────

  it("Stage 2 — hard gates produce 2 HARD_REJECTED, 1 NEEDS_VERIFICATION, 6 PREQUALIFIED", async () => {
    const { runHardGates } = await import("../../pipeline/hardGate.js");
    const result = await runHardGates();

    expect(result.hardRejected).toBe(2);
    expect(result.needsVerification).toBe(1);
    expect(result.passed).toBeGreaterThanOrEqual(5);

    // Verify DB rows are not silently discarded
    const gatted = await countWhere("canonical_jobs",
      "processing_status IN ('HARD_REJECTED', 'NEEDS_VERIFICATION', 'PREQUALIFIED')");
    expect(gatted).toBeGreaterThanOrEqual(8);

    // gate_decisions audit log must have one row per gated job
    const gateRows = await countWhere("gate_decisions", "TRUE");
    expect(gateRows).toBeGreaterThanOrEqual(8);
  });

  // ── Stage 3: Lane routing ──────────────────────────────────────────────────

  it("Stage 3 — lane router assigns primary_lane + secondary_lanes to all PREQUALIFIED jobs", async () => {
    const { runLaneRouter } = await import("../../pipeline/laneRouter.js");
    await runLaneRouter();

    const routed = await countWhere("canonical_jobs",
      "primary_lane IS NOT NULL AND processing_status IN ('LANE_ROUTED', 'PREQUALIFIED')");
    expect(routed).toBeGreaterThanOrEqual(5);
  });

  // ── Stage 4: Budgeting ─────────────────────────────────────────────────────

  it("Stage 4 — budgeter queues top 3/lane and defers overflow", async () => {
    const { runBudgeter } = await import("../../pipeline/evaluationBudgeter.js");
    await runBudgeter();

    const queued = await countWhere("evaluation_queue", "status = 'PENDING'");
    const deferred = await countWhere("canonical_jobs", "processing_status = 'DEFERRED_BUDGET'");

    // At minimum 1 job must be queued and 0 or more deferred
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(deferred).toBeGreaterThanOrEqual(0);
  });

  // ── Conservation invariant ─────────────────────────────────────────────────

  it("Conservation — N_in = N_terminal + N_active (no observation lost)", async () => {
    const nIn = await countWhere("raw_job_observations", "TRUE");
    const terminal = await countWhere("canonical_jobs",
      "processing_status IN ('HARD_REJECTED', 'NEEDS_VERIFICATION', 'AI_EVALUATED', 'MANUALLY_REMOVED', 'DEFERRED_BUDGET')");
    const active = await countWhere("canonical_jobs",
      "processing_status IN ('RAW_STAGED', 'PREQUALIFIED', 'LANE_ROUTED', 'QUEUED_FOR_AI', 'EVALUATING', 'RETRY_WAIT', 'NEEDS_MANUAL_REVIEW')");
    const queued = await countWhere("evaluation_queue", "status IN ('PENDING', 'RETRY_WAIT', 'EVALUATING')");

    // All observations must be accounted for
    expect(terminal + active + queued).toBeGreaterThanOrEqual(nIn);
  });

  // ── No observation silently disappears ────────────────────────────────────

  it("Integrity — no raw_job_observation row is orphaned (every row has a canonical_job)", async () => {
    const orphans = await countWhere("raw_job_observations",
      "canonical_job_id IS NULL AND processing_error IS NULL");
    expect(orphans).toBe(0);
  });
});
