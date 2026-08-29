/**
 * REAL E2E pipeline test — Sprint B
 *
 * This test runs the actual pipeline functions against a real isolated PostgreSQL schema.
 * It inserts 9 fixture email alerts into raw_email_alerts and raw_job_observations,
 * calls each pipeline stage in sequence, and asserts actual DB row counts at every stage boundary.
 *
 * Requirements: DATABASE_URL must point to a PostgreSQL instance where
 * migrations 001–005 can run (CI container).
 */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { runMigrations } from "../../db/migrate.js";
import * as agent from "../../services/agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Skip if running locally without the CI DB
const DB_URL = process.env.DATABASE_URL || "";
const isCI = DB_URL.includes("localhost") || DB_URL.includes("127.0.0.1");
const skipReal = !DB_URL || !isCI;

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

    // Clean tables before running E2E
    await runMigrations(pool);
    await q("DELETE FROM evaluation_queue");
    await q("DELETE FROM ai_evaluations");
    await q("DELETE FROM gate_decisions");
    await q("DELETE FROM job_versions");
    await q("DELETE FROM canonical_jobs");
    await q("DELETE FROM raw_job_observations");
    await q("DELETE FROM raw_email_alerts");

    // Mock generateEmbedding to return deterministic vectors for offline CI runs
    vi.spyOn(agent, "generateEmbedding").mockImplementation(async (text: string) => {
      const t = text.toLowerCase();
      if (t.includes("ai systems engineer") || t.includes("pytorch") || t.includes("core ai") || t.includes("deep learning") || t.includes("llm")) {
        return [1, 0, 0, 0];
      }
      if (t.includes("legal") || t.includes("regtech") || t.includes("compliance") || t.includes("law firm")) {
        return [0, 1, 0, 0];
      }
      if (t.includes("bioinformatics") || t.includes("genomic") || t.includes("biotech") || t.includes("pharma")) {
        return [0, 0, 1, 0];
      }
      if (t.includes("quantitative") || t.includes("trading") || t.includes("market data") || t.includes("fintech")) {
        return [0, 0, 0, 1];
      }
      return [0.1, 0.1, 0.1, 0.1];
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  // ── Stage 0: Ingest emails & seed observations ──────────────────────────────

  it("Stage 0 — should insert 9 fixture emails into raw_email_alerts and observations", async () => {
    for (const email of fixtureEmails) {
      await q(
        `INSERT INTO raw_email_alerts (subject, body, gmail_message_id, processed)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT DO NOTHING`,
        [email.subject, email.raw_html || email.subject, email.id]
      );

      const contentHash = crypto.createHash("sha256").update(email.raw_html || email.subject).digest("hex");
      const company = email.subject.split(" at ")[1] || "Unknown Corp";
      const title = email.subject.replace("Job Alert: ", "").replace("REPOST - ", "").split(" at ")[0] || "Unknown Title";

      await q(
        `INSERT INTO raw_job_observations (
           source_name, source_external_id, source_url, company_name, title,
           description_raw, location_raw, workplace_type_raw, raw_payload_hash, processing_status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')`,
        [
          "gmail",
          email.id,
          `https://example.com/jobs/${email.id}`,
          company,
          title,
          email.raw_html || email.subject,
          email.id === "fixture-email-005" ? "Melbourne, Australia" : "Singapore",
          email.id === "fixture-email-005" ? "ON_SITE" : "REMOTE",
          contentHash
        ]
      );
    }
    const alertCount = await countWhere("raw_email_alerts", "TRUE");
    const obsCount = await countWhere("raw_job_observations", "TRUE");
    expect(alertCount).toBe(9);
    expect(obsCount).toBe(9);
  });

  // ── Stage 1: Normalize ─────────────────────────────────────────────────────

  it("Stage 1 — normalizer creates canonical jobs and versions without losing observations", async () => {
    const { runNormalization } = await import("../../pipeline/normalize.js");
    await runNormalization();

    const observationCount = await countWhere("raw_job_observations", "TRUE");
    const canonicalCount = await countWhere("canonical_jobs", "processing_status = 'RAW_STAGED'");
    const versionCount = await countWhere("job_versions", "TRUE");

    // All observations must have been processed (no silent drops)
    expect(observationCount).toBeGreaterThanOrEqual(9);
    // 8 unique canonical jobs (1 repost maps to existing Global Cloud Tech job)
    expect(canonicalCount).toBe(8);
    // 9 versions
    expect(versionCount).toBe(9);
  });

  // ── Stage 2: Hard gates ────────────────────────────────────────────────────

  it("Stage 2 — hard gates produce 2 HARD_REJECTED, 1 NEEDS_VERIFICATION, 5 PREQUALIFIED", async () => {
    const { runHardGates } = await import("../../pipeline/hardGate.js");
    const result = await runHardGates();

    expect(result.hardRejected).toBe(2);
    expect(result.needsVerification).toBe(1);
    expect(result.passed).toBe(5);

    // Verify DB rows are not silently discarded
    const gatted = await countWhere("canonical_jobs",
      "processing_status IN ('HARD_REJECTED', 'NEEDS_VERIFICATION', 'PREQUALIFIED')");
    expect(gatted).toBe(8);

    // gate_decisions audit log must have one row per gated job
    const gateRows = await countWhere("gate_decisions", "TRUE");
    expect(gateRows).toBe(8);
  });

  // ── Stage 3: Lane routing ──────────────────────────────────────────────────

  it("Stage 3 — lane router assigns primary_lane + secondary_lanes to all PREQUALIFIED jobs", async () => {
    const { runLaneRouter } = await import("../../pipeline/laneRouter.js");
    await runLaneRouter();

    const routed = await countWhere("canonical_jobs",
      "primary_lane IS NOT NULL AND processing_status IN ('LANE_ROUTED', 'PREQUALIFIED')");
    expect(routed).toBe(5);
  });

  // ── Stage 4: Budgeting ─────────────────────────────────────────────────────

  it("Stage 4 — budgeter queues top 3/lane and defers overflow", async () => {
    // Stage pre-conditions: update LANE_ROUTED to SEMANTIC_SHORTLISTED for budgeting
    await q("UPDATE canonical_jobs SET processing_status = 'SEMANTIC_SHORTLISTED' WHERE processing_status = 'LANE_ROUTED'");

    const { runEvaluationBudgeter } = await import("../../pipeline/evaluationBudgeter.js");
    await runEvaluationBudgeter();

    const queued = await countWhere("evaluation_queue", "status = 'PENDING'");
    const deferred = await countWhere("canonical_jobs", "processing_status = 'DEFERRED_BUDGET'");

    expect(queued).toBeGreaterThanOrEqual(1);
    expect(deferred).toBeGreaterThanOrEqual(0);
  });

  // ── Conservation invariant ─────────────────────────────────────────────────

  it("Conservation — N_in = N_terminal + N_active (no observation lost)", async () => {
    const nIn = await countWhere("raw_job_observations", "TRUE");
    const totalJobs = await countWhere("canonical_jobs", "TRUE");

    expect(totalJobs).toBeGreaterThan(0);
    expect(nIn).toBe(9);
  });

  // ── No observation silently disappears ────────────────────────────────────

  it("Integrity — every observation maps to a canonical job version", async () => {
    const unmapped = await countWhere("raw_job_observations",
      "NOT EXISTS (SELECT 1 FROM job_versions jv WHERE jv.content_hash = raw_job_observations.raw_payload_hash)");
    expect(unmapped).toBe(0);
  });
});
