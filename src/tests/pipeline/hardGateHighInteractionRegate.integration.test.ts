import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GATE_VERSION } from "../../contracts/version.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// gate-2026-11.7: a job hard-rejected earlier for a bare customer-engagement duty phrase is re-gated by the version refresh
// and moves HARD_REJECT -> PASS (real PostgreSQL, synthetic job only).
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the high-interaction re-gate integration test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

const db = (): pg.PoolClient => {
  if (!client) throw new Error("The integration database is not initialized.");
  return client;
};
const ctx = (): WorkspaceContext => {
  if (!context) throw new Error("The integration workspace is not initialized.");
  return context;
};

const DESCRIPTION = `${COMPLETE_TEST_POSTING_DESCRIPTION}\n\nYou will own the customer journey for our contract-review solution.`;

describe.skipIf(skipReal)("hard gate: bare customer-engagement phrase, HARD_REJECT -> PASS on re-gate (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `gate_hi_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  async function seedRejectedJob(description: string = DESCRIPTION): Promise<string> {
    const jobId = randomUUID();
    const versionId = randomUUID();
    const url = `https://example.test/gate-hi/${jobId}`;
    await db().query(
      `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, location, workplace_type,
                                   employment_type, processing_state, processing_status, gate_decision, description_quality_status)
       VALUES ($1, $2, 'Gate HI Fixture', 'Legal Solutions Lead', $3, 'Remote', 'REMOTE', 'FULL_TIME', 'RAW_STAGED', 'RAW_STAGED', NULL, 'COMPLETE')`,
      [jobId, ctx().workspaceId, url],
    );
    await db().query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [versionId, ctx().workspaceId, jobId, `hash-${versionId}`, description],
    );
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);
    await insertCompletePostingEvidence(db(), {
      workspaceId: ctx().workspaceId, jobVersionId: versionId, companyName: "Gate HI Fixture", title: "Legal Solutions Lead",
      sourceUrl: url, description,
    });
    // Run the gate once to get a complete audit envelope, then rewrite it as the earlier gate version's rejection.
    await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId] });
    await db().query(
      `UPDATE gate_decisions
          SET decision = 'HARD_REJECT', gate_version = 'gate-2026-11.7', rejection_codes = '["GATE_HIGH_INTERACTION"]'::jsonb,
              evidence_quotes = '["Pre-sales / customer-engagement role duty: own the customer journey"]'::jsonb
        WHERE canonical_job_id = $1`,
      [jobId],
    );
    await db().query(
      `UPDATE canonical_jobs
          SET processing_state = 'HARD_REJECTED', processing_status = 'HARD_REJECTED', gate_decision = 'HARD_REJECT',
              rejection_reason = 'GATE_HIGH_INTERACTION', primary_lane = 'LEGAL_REGTECH', lane_confidence = 0.8,
              deterministic_match_score = 61, deterministic_match_coverage = 50
        WHERE id = $1`,
      [jobId],
    );
    return jobId;
  }

  it("the version refresh recomputes: PASS, state PREQUALIFIED, lane and match kept, new audit row at the current gate version", async () => {
    const jobId = await seedRejectedJob();
    const summary = await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId], reprocess: true, versionRefresh: true });
    expect(summary.errors).toBe(0);
    expect(summary.stamped).toBe(0);

    const job = (await db().query(
      `SELECT gate_decision, processing_state, rejection_reason, primary_lane, lane_confidence, deterministic_match_score,
              deterministic_match_coverage
         FROM canonical_jobs WHERE id = $1`,
      [jobId],
    )).rows[0];
    expect(job).toMatchObject({ gate_decision: "PASS", processing_state: "PREQUALIFIED", primary_lane: "LEGAL_REGTECH" });
    expect(Number(job.deterministic_match_score)).toBe(61);
    expect(Number(job.deterministic_match_coverage)).toBe(50);
    expect(job.rejection_reason).toBeNull();

    const rows = (await db().query(
      `SELECT decision, gate_version, rejection_codes FROM gate_decisions WHERE canonical_job_id = $1 ORDER BY created_at, id`,
      [jobId],
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ decision: "HARD_REJECT", gate_version: "gate-2026-11.7" });
    expect(rows[1]).toMatchObject({ decision: "PASS", gate_version: GATE_VERSION });
    expect(rows[1]!.rejection_codes).toEqual([]);
  });

  it("gate-2026-11.8: a job rejected at gate-2026-11.7 for generic commission boilerplate is re-gated to PASS; a commission-only job stays rejected", async () => {
    const boilerplate = `${COMPLETE_TEST_POSTING_DESCRIPTION}\n\nIn addition to base pay, we offer a performance-driven annual bonus or commission.`;
    const explicit = `${COMPLETE_TEST_POSTING_DESCRIPTION}\n\nThis is a commission-only sales position.`;
    const passJob = await seedRejectedJob(boilerplate);
    const rejectJob = await seedRejectedJob(explicit);
    const summary = await runHardGates(db(), { context: ctx(), canonicalJobIds: [passJob, rejectJob], reprocess: true, versionRefresh: true });
    expect(summary.errors).toBe(0);
    const rows = (await db().query(
      `SELECT id, gate_decision, processing_state FROM canonical_jobs WHERE id = ANY($1::uuid[])`,
      [[passJob, rejectJob]],
    )).rows;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(passJob)).toMatchObject({ gate_decision: "PASS", processing_state: "PREQUALIFIED" });
    expect(byId.get(rejectJob)).toMatchObject({ gate_decision: "HARD_REJECT", processing_state: "HARD_REJECTED" });
  });
});
