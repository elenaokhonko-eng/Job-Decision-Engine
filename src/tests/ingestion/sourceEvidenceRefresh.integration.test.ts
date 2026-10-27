import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { GreenhouseAdapter } from "../../ingestion/adapters/greenhouseAdapter.js";
import { extractFreshnessEvidence } from "../../ingestion/freshnessEvidence.js";
import { refreshCanonicalJobSourceEvidence } from "../../ingestion/sourceEvidenceRefresh.js";
import { generateContentHash } from "../../services/criteria.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The source evidence refresh test client is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The source evidence refresh test workspace is not initialized.");
  return context;
}

describe.skipIf(skipReal)("single-version source evidence refresh (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `source_evidence_refresh_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
    vi.unstubAllGlobals();
  });

  it("refreshes missing evidence and rekeys a legacy posting fingerprint without duplicating its job or version", async () => {
    const database = getClient();
    const workspaceId = getContext().workspaceId;
    const canonicalJobId = randomUUID();
    const jobVersionId = randomUUID();
    const observationId = randomUUID();
    const postingUrl = `https://boards.greenhouse.io/refresh-board/jobs/${observationId}`;
    const description = "Design and operate data platform services and reliable production pipelines for engineering teams.";
    const sourceRecord = {
      id: observationId,
      title: "Technical Data Platform Lead",
      location: { name: "Singapore" },
      absolute_url: postingUrl,
      content: description,
      status: "active",
      published_at: "2026-10-20T00:00:00.000Z",
      validThrough: "2026-12-31T23:59:59.000Z",
    };
    const rawPayloadHash = createHash("sha256").update(JSON.stringify(sourceRecord)).digest("hex");
    const contentHash = generateContentHash("REFRESH-BOARD", sourceRecord.title, description);
    const postingIdentityHash = extractFreshnessEvidence({
      rawPayload: sourceRecord,
      sourceName: "GREENHOUSE",
      sourceExternalId: String(observationId),
      canonicalUrl: postingUrl,
      contentHash,
    }).postingIdentityHash;
    const legacyPostingIdentityHash = "b".repeat(64);

    await database.query(
      `INSERT INTO canonical_jobs (
         id, workspace_id, company_name, normalized_title, canonical_url, location,
         processing_state, processing_status, description_quality_status, version_count
       ) VALUES ($1, $2, 'REFRESH-BOARD', $3, $4, 'Singapore', 'PREQUALIFIED', 'PREQUALIFIED', 'COMPLETE', 1)`,
      [canonicalJobId, workspaceId, sourceRecord.title.toLowerCase(), postingUrl],
    );
    await database.query(
      `INSERT INTO job_versions (
         id, workspace_id, canonical_job_id, content_hash, description_text, observed_at,
         source_posting_identity_hash
       ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [jobVersionId, workspaceId, canonicalJobId, contentHash, description, legacyPostingIdentityHash],
    );
    await database.query(
      `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
      [jobVersionId, workspaceId, canonicalJobId],
    );
    await database.query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_plugin_key, source_external_id, source_url,
         retrieved_at, company_name, title, description_raw, location_raw, workplace_type_raw,
         employment_type_raw, compensation_raw, canonical_apply_url, raw_payload, raw_payload_hash,
         processing_status, job_version_id
       ) VALUES ($1, $2, 'GREENHOUSE', 'greenhouse', $3, $4, NOW() - INTERVAL '1 day',
                 'REFRESH-BOARD', $5, $6, 'Singapore', 'UNKNOWN', 'FULL_TIME', 'UNKNOWN',
                 $4, $7::jsonb, $8, 'PROCESSED', $9)`,
      [observationId, workspaceId, String(observationId), postingUrl, sourceRecord.title, description,
        JSON.stringify(sourceRecord), rawPayloadHash, jobVersionId],
    );
    const precondition = await database.query<{ job_version_id: string; missing_evidence: boolean }>(
      `SELECT job_version_id::text AS job_version_id,
              normalized_evidence IS NULL AS missing_evidence
       FROM raw_job_observations
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, observationId],
    );
    expect(precondition.rows).toEqual([{ job_version_id: jobVersionId, missing_evidence: true }]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [sourceRecord] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const result = await refreshCanonicalJobSourceEvidence(
      database,
      { canonicalJobId, jobVersionId, observationId },
      {
        adapter: new GreenhouseAdapter("refresh-board"),
        context: getContext(),
        now: () => new Date("2026-10-27T00:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      status: "REFRESHED",
      canonicalJobId,
      jobVersionId,
      observationId,
      readinessRecomputed: true,
    });
    expect(result.evidenceRevisionHash).toMatch(/^[a-f0-9]{64}$/);

    const persisted = await database.query<{
      latest_job_version_id: string;
      job_count: string;
      version_count: string;
      observation_count: string;
      observation_id: string;
      observation_job_version_id: string;
      observation_hash: string;
      normalized_evidence: Record<string, unknown>;
      evidence_revision_hash: string;
      availability_status: string;
      source_published_at: Date;
      source_expires_at: Date;
      source_posting_identity_hash: string;
    }>(
      `SELECT canonical.latest_job_version_id::text AS latest_job_version_id,
              (SELECT COUNT(*)::text FROM canonical_jobs WHERE workspace_id = $1 AND id = $2) AS job_count,
              (SELECT COUNT(*)::text FROM job_versions WHERE workspace_id = $1 AND canonical_job_id = $2) AS version_count,
              (SELECT COUNT(*)::text FROM raw_job_observations WHERE workspace_id = $1 AND job_version_id = $3) AS observation_count,
              observation.id::text AS observation_id,
              observation.job_version_id::text AS observation_job_version_id,
              observation.raw_payload_hash AS observation_hash,
              observation.normalized_evidence,
              version.evidence_revision_hash,
              version.availability_status,
              version.source_published_at,
              version.source_expires_at,
              version.source_posting_identity_hash
       FROM canonical_jobs canonical
       JOIN job_versions version
         ON version.workspace_id = canonical.workspace_id
        AND version.canonical_job_id = canonical.id
        AND version.id = canonical.latest_job_version_id
       JOIN raw_job_observations observation
         ON observation.workspace_id = version.workspace_id
        AND observation.job_version_id = version.id
       WHERE canonical.workspace_id = $1 AND canonical.id = $2 AND version.id = $3 AND observation.id = $4`,
      [workspaceId, canonicalJobId, jobVersionId, observationId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      latest_job_version_id: jobVersionId,
      job_count: "1",
      version_count: "1",
      observation_count: "1",
      observation_id: observationId,
      observation_job_version_id: jobVersionId,
      observation_hash: rawPayloadHash,
      evidence_revision_hash: result.evidenceRevisionHash,
      availability_status: "OPEN",
      source_posting_identity_hash: postingIdentityHash,
    });
    expect(persisted.rows[0]?.source_published_at.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(persisted.rows[0]?.source_expires_at.toISOString()).toBe("2026-12-31T23:59:59.000Z");
    expect(persisted.rows[0]?.normalized_evidence).toMatchObject({
      raw_payload_hash: rawPayloadHash,
      availability: { status: "OPEN" },
      dates: {
        published_at: { value: "2026-10-20T00:00:00.000Z" },
        expires_at: { value: "2026-12-31T23:59:59.000Z" },
      },
      compensation: { status: "UNKNOWN", components: [] },
    });

    const audit = await database.query<{
      reason_detail: string;
      reason_code: string;
      disposition: string;
      plan_key: string;
      run_status: string;
      total_fetched: number;
    }>(
      `SELECT disposition.reason_detail,
              disposition.reason_code,
              disposition.disposition,
              disposition.plan_key,
              source_run.status AS run_status,
              source_run.total_fetched
       FROM source_candidate_dispositions disposition
       JOIN source_runs source_run
         ON source_run.workspace_id = disposition.workspace_id
        AND source_run.id = disposition.source_run_id
       WHERE disposition.workspace_id = $1
         AND disposition.canonical_job_id = $2
         AND disposition.job_observation_id = $3
         AND disposition.reason_code = 'SOURCE_IDENTITY_FINGERPRINT_REKEYED'`,
      [workspaceId, canonicalJobId, observationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      reason_code: "SOURCE_IDENTITY_FINGERPRINT_REKEYED",
      disposition: "DUPLICATE",
      run_status: "COMPLETED",
      total_fetched: 1,
    });
    expect(audit.rows[0]?.plan_key).toContain(jobVersionId);
    expect(audit.rows[0]?.reason_detail).toContain(`job_version_id=${jobVersionId}`);

    const readiness = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM deterministic_decisions
       WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3
         AND evidence_revision_hash = $4 AND readiness_json IS NOT NULL`,
      [workspaceId, canonicalJobId, jobVersionId, result.evidenceRevisionHash],
    );
    expect(readiness.rows[0]?.count).toBe("1");
  });
});
