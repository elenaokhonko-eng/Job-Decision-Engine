import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runMigrations } from "../../db/migrate.js";
import {
  JobSourceEvidenceSchema,
  type JobSourceEvidence,
} from "../../contracts/jobSourceEvidence.js";
import { buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION } from "../fixtures/completePostingEvidence.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const DATABASE_MIGRATION = "087_accept_job_source_evidence_v2.sql";
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run job source evidence schema migration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The job source evidence migration test client is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The job source evidence migration test workspace is not initialized.");
  return context;
}

function buildEvidence(input: {
  schemaVersion: "job_source_evidence_v1" | "job_source_evidence_v2";
  sourceName: "GREENHOUSE" | "HIMALAYAS";
  externalId: string;
  sourceUrl: string;
}): { evidence: JobSourceEvidence; rawPayload: Record<string, unknown>; rawPayloadHash: string } {
  const rawPayload = {
    id: input.externalId,
    status: "active",
    title: "Platform Architect",
    companyName: "Schema Version Fixture Systems",
    description: COMPLETE_TEST_POSTING_DESCRIPTION,
  };
  const rawPayloadHash = createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");
  const evidence = buildJobSourceEvidence({
    sourceName: input.sourceName,
    sourcePluginKey: input.sourceName.toLowerCase(),
    sourcePluginRevisionId: null,
    sourceExternalId: input.externalId,
    sourceUrl: input.sourceUrl,
    canonicalApplyUrl: input.sourceUrl,
    retrievedAt: "2026-10-24T00:00:00.000Z",
    rawPayloadHash,
    rawPayload,
    ...(input.sourceName === "HIMALAYAS"
      ? { fullPostingHosts: ["himalayas.app"] }
      : {}),
    companyName: "Schema Version Fixture Systems",
    title: "Platform Architect",
    locationRaw: "Singapore",
    workplaceTypeRaw: "REMOTE",
    employmentTypeRaw: "FULL_TIME",
    compensationRaw: "UNKNOWN",
    descriptionText: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
  return {
    evidence: JobSourceEvidenceSchema.parse({ ...evidence, schema_version: input.schemaVersion }),
    rawPayload,
    rawPayloadHash,
  };
}

async function insertObservation(input: {
  sourceRunId: string;
  sourceName: "GREENHOUSE" | "HIMALAYAS";
  externalId: string;
  sourceUrl: string;
  evidence: JobSourceEvidence;
  rawPayload: Record<string, unknown>;
  rawPayloadHash: string;
}): Promise<string> {
  const id = randomUUID();
  await getClient().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_run_id, source_name, source_plugin_key,
       source_external_id, source_url, canonical_apply_url, retrieved_at,
       company_name, title, description_raw, location_raw, workplace_type_raw,
       employment_type_raw, compensation_raw, search_plan_version, raw_payload,
       raw_payload_hash, processing_status, normalized_evidence, evidence_schema_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, 'Singapore',
       'REMOTE', 'FULL_TIME', 'UNKNOWN', 'source-evidence-version-test-v1',
       $12::jsonb, $13, 'FETCH_COMPLETE', $14::jsonb, $15
     )`,
    [
      id,
      getContext().workspaceId,
      input.sourceRunId,
      input.sourceName,
      input.sourceName.toLowerCase(),
      input.externalId,
      input.sourceUrl,
      input.evidence.retrieved_at,
      "Schema Version Fixture Systems",
      "Platform Architect",
      COMPLETE_TEST_POSTING_DESCRIPTION,
      JSON.stringify(input.rawPayload),
      input.rawPayloadHash,
      JSON.stringify(input.evidence),
      input.evidence.schema_version,
    ],
  );
  return id;
}

async function insertCandidateDisposition(input: {
  sourceRunId: string;
  observationId: string | null;
  sourceName: "GREENHOUSE" | "HIMALAYAS";
  externalId: string;
  sourceUrl: string;
  evidence: JobSourceEvidence;
  rawPayload: Record<string, unknown>;
  rawPayloadHash: string;
}): Promise<string> {
  const result = await getClient().query<{ id: string }>(
    `INSERT INTO source_candidate_dispositions (
       workspace_id, source_run_id, source_plugin_key, plan_key, lane_key,
       source_external_id, source_url, raw_payload_hash, raw_payload,
       disposition, job_observation_id, normalized_evidence, evidence_schema_version
     ) VALUES ($1, $2, $3, $4, 'CORE_AI_DATA', $5, $6, $7, $8::jsonb,
       'STAGED', $9, $10::jsonb, $11)
     RETURNING id::text AS id`,
    [
      getContext().workspaceId,
      input.sourceRunId,
      input.sourceName.toLowerCase(),
      `schema-version:${input.externalId}`,
      input.externalId,
      input.sourceUrl,
      input.rawPayloadHash,
      JSON.stringify(input.rawPayload),
      input.observationId,
      JSON.stringify(input.evidence),
      input.evidence.schema_version,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Source candidate disposition fixture was not inserted.");
  return id;
}

describe.skipIf(skipReal)("job source evidence schema version migration (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `source_evidence_version_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);

    const migrationsRoot = path.resolve(process.cwd(), "migrations");
    const migrationFiles = (await fs.readdir(migrationsRoot)).filter((file) => file.endsWith(".sql")).sort();
    if (!migrationFiles.includes(DATABASE_MIGRATION)) {
      throw new Error(`Expected additive migration ${DATABASE_MIGRATION} was not found.`);
    }
    const baselineMigrationsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "source-evidence-v1-baseline-"));
    try {
      for (const file of migrationFiles.filter((candidate) => candidate.localeCompare(DATABASE_MIGRATION) < 0)) {
        await fs.copyFile(path.join(migrationsRoot, file), path.join(baselineMigrationsRoot, file));
      }
      const baselineApplied = await runMigrations(client, { migrationsDir: baselineMigrationsRoot });
      if (!baselineApplied.some((file) => file.startsWith("084_"))) {
        throw new Error("The v1 compatibility fixture did not apply the schema baseline through migration 084.");
      }
      context = await resolveWorkspaceContext(client);
    } finally {
      await fs.rm(baselineMigrationsRoot, { recursive: true, force: true });
    }
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
  });

  it("preserves v1 evidence and accepts v2 evidence in both constrained ledgers", async () => {
    const database = getClient();
    const workspace = getContext();
    const sourceRun = await database.query<{ id: string }>(
      `INSERT INTO source_runs (workspace_id, status, total_fetched, total_new)
       VALUES ($1, 'COMPLETED', 2, 2) RETURNING id::text AS id`,
      [workspace.workspaceId],
    );
    const sourceRunId = sourceRun.rows[0]?.id;
    if (!sourceRunId) throw new Error("Source-run fixture was not created.");

    const legacyInput = buildEvidence({
      schemaVersion: "job_source_evidence_v1",
      sourceName: "GREENHOUSE",
      externalId: `legacy-${randomUUID()}`,
      sourceUrl: `https://boards.greenhouse.io/schema-version/jobs/${randomUUID()}`,
    });
    const legacyObservationId = await insertObservation({
      sourceRunId,
      sourceName: "GREENHOUSE",
      externalId: legacyInput.evidence.source_external_id!,
      sourceUrl: legacyInput.evidence.employer_posting_url!,
      evidence: legacyInput.evidence,
      rawPayload: legacyInput.rawPayload,
      rawPayloadHash: legacyInput.rawPayloadHash,
    });
    const legacyDispositionId = await insertCandidateDisposition({
      sourceRunId,
      observationId: legacyObservationId,
      sourceName: "GREENHOUSE",
      externalId: legacyInput.evidence.source_external_id!,
      sourceUrl: legacyInput.evidence.employer_posting_url!,
      evidence: legacyInput.evidence,
      rawPayload: legacyInput.rawPayload,
      rawPayloadHash: legacyInput.rawPayloadHash,
    });

    const currentInput = buildEvidence({
      schemaVersion: "job_source_evidence_v2",
      sourceName: "HIMALAYAS",
      externalId: `current-${randomUUID()}`,
      sourceUrl: `https://himalayas.app/jobs/${randomUUID()}`,
    });
    await expect(insertObservation({
      sourceRunId,
      sourceName: "HIMALAYAS",
      externalId: currentInput.evidence.source_external_id!,
      sourceUrl: currentInput.evidence.employer_posting_url!,
      evidence: currentInput.evidence,
      rawPayload: currentInput.rawPayload,
      rawPayloadHash: currentInput.rawPayloadHash,
    })).rejects.toMatchObject({ code: "23514" });
    await expect(insertCandidateDisposition({
      sourceRunId,
      observationId: null,
      sourceName: "HIMALAYAS",
      externalId: currentInput.evidence.source_external_id!,
      sourceUrl: currentInput.evidence.employer_posting_url!,
      evidence: currentInput.evidence,
      rawPayload: currentInput.rawPayload,
      rawPayloadHash: currentInput.rawPayloadHash,
    })).rejects.toMatchObject({ code: "23514" });

    const applied = await runMigrations(database);
    expect(applied).toContain(DATABASE_MIGRATION);

    const preservedV1 = await database.query<{
      evidence_schema_version: string;
      normalized_evidence: { schema_version: string };
    }>(
      `SELECT evidence_schema_version, normalized_evidence FROM raw_job_observations
       WHERE workspace_id = $1 AND id = $2::uuid`,
      [workspace.workspaceId, legacyObservationId],
    );
    expect(preservedV1.rows[0]).toEqual({
      evidence_schema_version: "job_source_evidence_v1",
      normalized_evidence: legacyInput.evidence,
    });
    const preservedDisposition = await database.query<{
      evidence_schema_version: string;
      normalized_evidence: { schema_version: string };
    }>(
      `SELECT evidence_schema_version, normalized_evidence FROM source_candidate_dispositions
       WHERE workspace_id = $1 AND id = $2::uuid`,
      [workspace.workspaceId, legacyDispositionId],
    );
    expect(preservedDisposition.rows[0]).toEqual({
      evidence_schema_version: "job_source_evidence_v1",
      normalized_evidence: legacyInput.evidence,
    });

    const currentObservationId = await insertObservation({
      sourceRunId,
      sourceName: "HIMALAYAS",
      externalId: currentInput.evidence.source_external_id!,
      sourceUrl: currentInput.evidence.employer_posting_url!,
      evidence: currentInput.evidence,
      rawPayload: currentInput.rawPayload,
      rawPayloadHash: currentInput.rawPayloadHash,
    });
    const currentDispositionId = await insertCandidateDisposition({
      sourceRunId,
      observationId: currentObservationId,
      sourceName: "HIMALAYAS",
      externalId: currentInput.evidence.source_external_id!,
      sourceUrl: currentInput.evidence.employer_posting_url!,
      evidence: currentInput.evidence,
      rawPayload: currentInput.rawPayload,
      rawPayloadHash: currentInput.rawPayloadHash,
    });
    const persistedV2 = await database.query<{ evidence_schema_version: string; json_schema_version: string }>(
      `SELECT evidence_schema_version, normalized_evidence->>'schema_version' AS json_schema_version
       FROM raw_job_observations WHERE workspace_id = $1 AND id = $2::uuid
       UNION ALL
       SELECT evidence_schema_version, normalized_evidence->>'schema_version' AS json_schema_version
       FROM source_candidate_dispositions WHERE workspace_id = $1 AND id = $3::uuid`,
      [workspace.workspaceId, currentObservationId, currentDispositionId],
    );
    expect(persistedV2.rows).toEqual([
      { evidence_schema_version: "job_source_evidence_v2", json_schema_version: "job_source_evidence_v2" },
      { evidence_schema_version: "job_source_evidence_v2", json_schema_version: "job_source_evidence_v2" },
    ]);

    await expect(database.query(
      `UPDATE raw_job_observations
       SET evidence_schema_version = 'job_source_evidence_v1'
       WHERE workspace_id = $1 AND id = $2::uuid`,
      [workspace.workspaceId, currentObservationId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(database.query(
      `UPDATE source_candidate_dispositions
       SET evidence_schema_version = 'job_source_evidence_v1'
       WHERE workspace_id = $1 AND id = $2::uuid`,
      [workspace.workspaceId, currentDispositionId],
    )).rejects.toMatchObject({ code: "23514" });
  });
});
