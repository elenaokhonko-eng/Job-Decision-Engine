import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GATE_VERSION } from "../../contracts/version.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { saveWorkspacePreferenceRevision } from "../../policy/workspacePreferenceRegistry.js";
import { seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// gate-2026-11.12: a stored GATE_STALE_POSTING rejection is picked up by the gate version seed and re-gated to PASS
// while the job is not archived; an archived one is not selected (real PostgreSQL, synthetic jobs only).
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the stale-posting re-gate integration test against its PostgreSQL service.");
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

describe.skipIf(skipReal)("hard gate: stored stale-posting rejection after the version bump (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `gate_stale_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    await saveWorkspacePreferenceRevision(client, context, {
      preferenceDomain: "stage3",
      schemaVersion: "3.0.0",
      activate: true,
      preferenceValue: { schema_version: "3.0.0", freshness: { max_posting_age_days: 60, stale_gate_disposition: "HARD_REJECT" } },
    });
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  async function seedStaleRejection(): Promise<{ jobId: string; versionId: string }> {
    const jobId = randomUUID();
    const versionId = randomUUID();
    const url = `https://example.test/gate-stale/${jobId}`;
    const description = COMPLETE_TEST_POSTING_DESCRIPTION;
    await db().query(
      `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, location, workplace_type,
                                   employment_type, processing_state, processing_status, gate_decision, description_quality_status)
       VALUES ($1, $2, 'Gate Stale Fixture', 'Data Engineer', $3, 'Remote', 'REMOTE', 'FULL_TIME', 'RAW_STAGED', 'RAW_STAGED', NULL, 'COMPLETE')`,
      [jobId, ctx().workspaceId, url],
    );
    await db().query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at,
                                 source_published_at, freshness_basis)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW() - INTERVAL '200 days', 'POSTED_AT')`,
      [versionId, ctx().workspaceId, jobId, `hash-${versionId}`, description],
    );
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);
    await insertCompletePostingEvidence(db(), {
      workspaceId: ctx().workspaceId, jobVersionId: versionId, companyName: "Gate Stale Fixture", title: "Data Engineer",
      sourceUrl: url, description,
    });
    await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId] });
    // Rewrite as the rejection an earlier gate version stored.
    await db().query(
      `UPDATE gate_decisions
          SET decision = 'HARD_REJECT', gate_version = 'gate-2026-11.10', rejection_codes = '["GATE_STALE_POSTING"]'::jsonb
        WHERE canonical_job_id = $1`,
      [jobId],
    );
    await db().query(
      `UPDATE canonical_jobs
          SET processing_state = 'HARD_REJECTED', processing_status = 'HARD_REJECTED', gate_decision = 'HARD_REJECT',
              rejection_reason = 'GATE_STALE_POSTING'
        WHERE id = $1`,
      [jobId],
    );
    return { jobId, versionId };
  }

  it("seeds a live HARD_REJECTED job and re-gates it to PASS; an archived one is not selected", async () => {
    const live = await seedStaleRejection();
    const archived = await seedStaleRejection();
    const archiveRunId = randomUUID();
    await db().query(
      `INSERT INTO job_archive_runs (id, run_started_at, cutoff_at, mode, status) VALUES ($1, NOW(), NOW() - INTERVAL '3 months', 'APPLY', 'SUCCEEDED')`,
      [archiveRunId],
    );
    await db().query(
      `UPDATE canonical_jobs
          SET archive_run_id = $2, archived_at = NOW(), archive_reason = 'HARD_REJECTED_PERMANENT', archive_age_basis = 'HARD_REJECTED_DECISION',
              archive_reference_at = NOW()
        WHERE id = $1`,
      [archived.jobId, archiveRunId],
    );

    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["APPLY_HARD_GATES"], includeTestFixtures: true });
    const tasks = (await db().query<{ job_version_id: string; version_refresh: string; gate_rule_version: string }>(
      `SELECT payload->>'job_version_id' AS job_version_id, payload->>'version_refresh' AS version_refresh,
              payload->>'gate_rule_version' AS gate_rule_version
         FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'APPLY_HARD_GATES'`,
      [ctx().workspaceId],
    )).rows;
    expect(tasks).toEqual([{ job_version_id: live.versionId, version_refresh: "true", gate_rule_version: GATE_VERSION }]);

    const summary = await runHardGates(db(), { context: ctx(), jobVersionIds: [live.versionId], reprocess: true, versionRefresh: true });
    expect(summary.errors).toBe(0);
    const job = (await db().query(
      `SELECT gate_decision, processing_state, rejection_reason FROM canonical_jobs WHERE id = $1`,
      [live.jobId],
    )).rows[0];
    expect(job).toMatchObject({ gate_decision: "PASS", processing_state: "PREQUALIFIED", rejection_reason: null });
  });
});
