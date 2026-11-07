import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { materializeApplicationRankings } from "../../services/applicationRankingMaterializer.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run application ranking materializer integration tests against its PostgreSQL service.");
}

let adminPool: pg.Pool | undefined;
let schemaPool: pg.Pool | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

describe.skipIf(skipReal)("application ranking materializer (PostgreSQL)", () => {
  beforeAll(async () => {
    schemaName = `ranking_materializer_${randomUUID().replaceAll("-", "")}`;
    adminPool = new pg.Pool(pgConnectionConfig(databaseUrl));
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    schemaPool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public` });
    const client = await schemaPool.connect();
    try {
      await runMigrations(client);
      context = await resolveWorkspaceContext(client);
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    await schemaPool?.end();
    if (adminPool && schemaName) await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  it("runs the current Apply Now context query against the migrated schema", async () => {
    if (!schemaPool || !context) throw new Error("The ranking materializer test database is not initialized.");

    const result = await materializeApplicationRankings(schemaPool, context.workspaceId, {
      dryRun: true,
      preferenceContext: null,
    });

    expect(result).toMatchObject({ dryRun: true, eligibleApplyNowJobs: 0, snapshotsInserted: 0 });
  });
});
