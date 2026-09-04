/**
 * REAL E2E pipeline test — Sprint B
 *
 * Runs pipeline functions against a real isolated PostgreSQL instance (CI).
 * Seeds 9 fixture email alerts + raw observations, then runs stages and checks
 * conservation / no-loss invariants.
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

async function q(sql: string, params?: any[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

async function countWhere(table: string, condition: string): Promise<number> {
  const res = await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${condition}`);
  return res.rows[0].n;
}

const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/anonymized_nine_emails.json");
const fixtureEmails: any[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));

describe.skipIf(skipReal)("P0-02 & P0-10: Real PostgreSQL Pipeline E2E", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });

    await runMigrations(pool);

    const fixtureCompanies = [
      "Global Cloud Tech",
      "Apex Legal Solutions",
      "BioGen Genomics",
      "Quantum Capital Markets",
      "Melbourne Financial",
      "Matrix Corp",
      "Stealth AI Labs",
      "CloudScale Data",
    ];
    await q("DELETE FROM canonical_jobs WHERE company_name = ANY($1)", [fixtureCompanies]);
    await q("DELETE FROM raw_job_observations WHERE source_name = 'gmail'");
    await q("DELETE FROM raw_email_alerts WHERE gmail_message_id LIKE 'fixture-email-%'");

    // Mock embeddings for deterministic offline CI runs
    vi.spyOn(agent, "generateEmbedding").mockImplementation(async (text: string) => {
      const t = text.toLowerCase();
      if (
        t.includes("ai systems engineer") ||
        t.includes("pytorch") ||
        t.includes("core ai") ||
        t.includes("deep learning") ||
        t.includes("llm") ||
        t.includes("data pipeline") ||
        t.includes("cloudscale")
      ) {
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
      const title =
        email.subject
          .replace("Job Alert: ", "")
          .replace("REPOST - ", "")
          .split(" at ")[0] || "Unknown Title";

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
          contentHash,
        ]
      );
    }

    const alertCount = await countWhere("raw_email_alerts", "TRUE");
    const obsCount = await countWhere("raw_job_observations", "TRUE");
    expect(alertCount).toBe(9);
    expect(obsCount).toBe(9);
  });

  it("Stage 1 — normalizer creates canonical jobs and versions without losing observations", async () => {
    const { runNormalization } = await import("../../pipeline/normalize.js");
    await runNormalization();

    const observationCount = await countWhere("raw_job_observations", "TRUE");
    const canonicalCount = await countWhere("canonical_jobs", "processing_status = 'RAW_STAGED'");
    const versionCount = await countWhere("job_versions", "TRUE");

    expect(observationCount).toBeGreaterThanOrEqual(9);
    expect(canonicalCount).toBe(8); // 1 repost maps to existing canonical job
    expect(versionCount).toBe(9);
  });

  it("Stage 2 — hard gates produce 2 HARD_REJECTED, 1 NEEDS_VERIFICATION, 5 PREQUALIFIED", async () => {
    const { runHardGates } = await import("../../pipeline/hardGate.js");
    const result = await runHardGates();

    expect(result.hardRejected).toBe(2);
    expect(result.needsVerification).toBe(1);
    expect(result.passed).toBe(5);

    const gated = await countWhere(
      "canonical_jobs",
      "processing_status IN ('HARD_REJECTED', 'NEEDS_VERIFICATION', 'PREQUALIFIED')"
    );
    expect(gated).toBe(8);

    const gateRows = await countWhere("gate_decisions", "TRUE");
    expect(gateRows).toBe(8);
  });

  it("Stage 3 — lane router assigns primary_lane + secondary_lanes to all PREQUALIFIED jobs", async () => {
    const { runLaneRouter } = await import("../../pipeline/laneRouter.js");
    await runLaneRouter();

    const routed = await countWhere(
      "canonical_jobs",
      "primary_lane IS NOT NULL AND processing_status IN ('LANE_ROUTED', 'PREQUALIFIED')"
    );
    expect(routed).toBe(5);
  });

  it("Stage 4 — deterministic decisions exist and eligible jobs are enqueueable (no DEFERRED_BUDGET)", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const { runExplanationQueueEnqueuer } = await import("../../pipeline/explanationQueueEnqueuer.js");

    await runRecommendationDecider();
    await runExplanationQueueEnqueuer();

    const queued = await countWhere("evaluation_queue", "status = 'PENDING'");
    const deferred = await countWhere(
      "canonical_jobs",
      "processing_status = 'DEFERRED_BUDGET' OR processing_state = 'DEFERRED_BUDGET'"
    );
    const missingDecisions = await countWhere(
      "canonical_jobs",
      "processing_status != 'MANUALLY_REMOVED' AND recommendation_outcome IS NULL"
    );

    expect(queued).toBeGreaterThanOrEqual(1);
    expect(deferred).toBe(0);
    expect(missingDecisions).toBe(0);
  });

  it("Conservation — no observation lost", async () => {
    const nIn = await countWhere("raw_job_observations", "TRUE");
    const totalJobs = await countWhere("canonical_jobs", "TRUE");

    expect(totalJobs).toBeGreaterThan(0);
    expect(nIn).toBe(9);
  });

  it("Integrity — every observation maps to a canonical job version", async () => {
    const unmapped = await countWhere("raw_job_observations", "job_version_id IS NULL");
    expect(unmapped).toBe(0);
  });
});

