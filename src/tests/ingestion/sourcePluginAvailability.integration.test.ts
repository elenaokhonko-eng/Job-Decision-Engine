import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { load } from "js-yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { SourcePluginSchema } from "../../contracts/sourcePlugin.js";
import { HimalayasAdapter } from "../../ingestion/adapters/himalayasAdapter.js";
import { SourceBroker } from "../../ingestion/sourceBroker.js";
import { refreshCanonicalJobSourceEvidence } from "../../ingestion/sourceEvidenceRefresh.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run source availability integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The source availability integration test database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The source availability integration test workspace is not initialized.");
  return context;
}

describe.skipIf(skipReal)("source plugin availability policy (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `source_plugin_availability_${randomUUID().replaceAll("-", "")}`;
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

  it("loads host rules from the active plugin revision and keeps alert-only postings UNKNOWN", async () => {
    const database = getClient();
    const sourcePlugin = SourcePluginSchema.parse(load(readFileSync(
      path.resolve(process.cwd(), "config", "source-plugins", "himalayas.yml"),
      "utf8",
    )));
    const broker = new SourceBroker(database, getContext());
    await broker.startRun("SOURCE_AVAILABILITY_INTEGRATION");
    const revisionId = await broker.ensureSourcePluginRevision(sourcePlugin);
    const retrievedAt = "2026-10-24T00:00:00.000Z";
    const description = [
      "About the role: design and operate production data and AI platform services for engineering teams.",
      "Responsibilities: build distributed services, maintain data pipelines, improve reliability, and document decisions.",
      "Qualifications: professional software engineering experience and a record of delivering production systems.",
    ].join(" ");
    const externalId = `himalayas-${randomUUID()}`;
    const boardUrl = `https://www.himalayas.app/jobs/${externalId}`;
    const boardPayload = { id: externalId, title: "Platform Architect", description };
    const board = await broker.processObservation({
      sourceName: "HIMALAYAS",
      sourcePluginKey: sourcePlugin.source_key,
      sourcePluginRevisionId: revisionId,
      sourceExternalId: externalId,
      sourceUrl: boardUrl,
      retrievedAt,
      companyName: "Fixture Systems",
      title: "Platform Architect",
      descriptionRaw: description,
      sourceLane: "CORE_AI_DATA",
      searchPlanVersion: "availability-postgres-v1",
      rawPayload: boardPayload,
    }, boardPayload);

    expect(board.normalizedEvidence?.description.completeness_status).toBe("COMPLETE");
    expect(board.normalizedEvidence?.availability).toMatchObject({
      status: "OPEN",
      verification_method: "VERIFIED_POSTING_RETRIEVAL",
      reason_code: "FULL_POSTING_RETRIEVED",
      verified_at: retrievedAt,
      expires_at: "2026-10-31T00:00:00.000Z",
    });

    if (!board.observationId) throw new Error("Himalayas fixture observation was not durably staged.");
    const normalized = await runNormalization(database, {
      context: getContext(),
      observationIds: [board.observationId],
    });
    expect(normalized.totalErrors).toBe(0);
    const version = await database.query<{ canonical_job_id: string; job_version_id: string }>(
      `SELECT version.canonical_job_id::text AS canonical_job_id,
              version.id::text AS job_version_id
       FROM job_versions version
       JOIN raw_job_observations observation
         ON observation.workspace_id = version.workspace_id AND observation.job_version_id = version.id
       WHERE observation.workspace_id = $1 AND observation.id = $2::uuid`,
      [getContext().workspaceId, board.observationId],
    );
    expect(version.rows).toHaveLength(1);

    const sourceRecord = {
      id: externalId,
      title: "Platform Architect",
      companyName: "Fixture Systems",
      description,
      jobUrl: boardUrl,
      applicationUrl: boardUrl,
      location: "Singapore",
      workplaceType: "REMOTE",
      employmentType: "FULL_TIME",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [sourceRecord] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    try {
      const refreshed = await refreshCanonicalJobSourceEvidence(
        database,
        {
          canonicalJobId: version.rows[0].canonical_job_id,
          jobVersionId: version.rows[0].job_version_id,
          observationId: board.observationId,
        },
        {
          adapter: new HimalayasAdapter(),
          context: getContext(),
          now: () => new Date("2026-10-28T00:00:00.000Z"),
        },
      );
      expect(refreshed.status).toBe("REFRESHED");
      const refreshedAvailability = await database.query<{
        availability_status: string;
        normalized_evidence: { availability: { status: string; verified_at: string; expires_at: string; reason_code: string } };
      }>(
        `SELECT version.availability_status, observation.normalized_evidence
         FROM job_versions version
         JOIN raw_job_observations observation
           ON observation.workspace_id = version.workspace_id AND observation.job_version_id = version.id
         WHERE version.workspace_id = $1 AND version.id = $2::uuid AND observation.id = $3::uuid`,
        [getContext().workspaceId, version.rows[0].job_version_id, board.observationId],
      );
      expect(refreshedAvailability.rows[0]).toMatchObject({
        availability_status: "OPEN",
        normalized_evidence: {
          availability: {
            status: "OPEN",
            reason_code: "FULL_POSTING_RETRIEVED",
            verified_at: "2026-10-28T00:00:00.000Z",
            expires_at: "2026-11-04T00:00:00.000Z",
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const alertPayload = { message_id: randomUUID(), body_text: description };
    const alertOnly = await broker.processObservation({
      sourceName: "GMAIL_ALERT",
      sourcePluginKey: "gmail_alert",
      sourceExternalId: `gmail-${randomUUID()}`,
      sourceUrl: "https://careers.example.test/jobs/alert-only",
      retrievedAt,
      companyName: "Fixture Systems",
      title: "Platform Architect",
      descriptionRaw: description,
      sourceLane: "CORE_AI_DATA",
      searchPlanVersion: "availability-postgres-v1",
      rawPayload: alertPayload,
    }, alertPayload);

    expect(alertOnly.normalizedEvidence?.availability).toMatchObject({
      status: "UNKNOWN",
      verification_method: "NONE",
      reason_code: "AVAILABILITY_NOT_VERIFIED",
    });
    await broker.endRun("COMPLETED");
  });
});
