import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { isCurrentCanonicalJobVersion } from "../../tasks/canonicalJobVersion.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let canonicalJobId = "";
let oldJobVersionId = "";
let latestJobVersionId = "";

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The canonical job version test client is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The canonical job version test workspace is not initialized.");
  return context;
}

describe.skipIf(skipReal)("current canonical job version lookup (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `current_job_version_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    canonicalJobId = crypto.randomUUID();
    oldJobVersionId = crypto.randomUUID();
    latestJobVersionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO canonical_jobs (
         id, workspace_id, company_name, normalized_title, canonical_url,
         processing_state, processing_status
       ) VALUES ($1, $2, 'Version Test Co', 'Version Fixture', $3, 'PREQUALIFIED', 'PREQUALIFIED')`,
      [canonicalJobId, getContext().workspaceId, `https://example.test/${canonicalJobId}`],
    );
    for (const [id, contentHash] of [
      [oldJobVersionId, `old-${crypto.randomUUID()}`],
      [latestJobVersionId, `latest-${crypto.randomUUID()}`],
    ]) {
      await client.query(
        `INSERT INTO job_versions (
           id, workspace_id, canonical_job_id, content_hash, description_text, observed_at
         ) VALUES ($1, $2, $3, $4, 'Version safety fixture', NOW())`,
        [id, getContext().workspaceId, canonicalJobId, contentHash],
      );
    }
    await client.query(
      `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
      [latestJobVersionId, getContext().workspaceId, canonicalJobId],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("distinguishes a stale version from the canonical current version", async () => {
    const database = getClient();
    const workspaceId = getContext().workspaceId;

    await expect(isCurrentCanonicalJobVersion(database, workspaceId, canonicalJobId, oldJobVersionId)).resolves.toBe(false);
    await expect(isCurrentCanonicalJobVersion(database, workspaceId, canonicalJobId, latestJobVersionId)).resolves.toBe(true);
    await expect(isCurrentCanonicalJobVersion(database, workspaceId, crypto.randomUUID(), latestJobVersionId)).resolves.toBe(false);
  });
});
