import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { scopeSeedQuery } from "../../tasks/seedQueryScope.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("Scoped seed query test client is not initialized.");
  return client;
}

describe.skipIf(skipReal)("scoped seed query parameter rebasing (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    client = undefined;
    await pool?.end();
    pool = undefined;
  });

  it("executes a scoped seed query when LIMIT precedes later bind parameters", async () => {
    const scoped = scopeSeedQuery(
      `SELECT 'version-1'::text AS job_version_id
       WHERE $1::text = 'workspace'
         AND $3::text = 'provider'
         AND $4::text = 'embedding-model'
       LIMIT $2`,
      ["workspace", 1, "provider", "embedding-model"],
      { jobVersionIds: ["version-1"] },
      1,
    );

    const { rows } = await getClient().query(scoped.sql, scoped.params);

    expect(rows).toEqual([{ job_version_id: "version-1" }]);
  });
});
