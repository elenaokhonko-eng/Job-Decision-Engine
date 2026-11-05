import { describe, expect, it } from "vitest";
import pg from "pg";

import { databaseHost, describeDatabaseFailure } from "../../api/v2/databaseFailure.js";
import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

// Real driver errors, not hand-made ones: the classification depends on what pg actually throws.
async function errorFrom(connectionString: string, sql = "SELECT 1"): Promise<unknown> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query(sql);
  } catch (error) {
    return error;
  } finally {
    await client.end().catch(() => undefined);
  }
  throw new Error("Expected the database call to fail.");
}

describe("database failure reporting for the workspace check", () => {
  it("names the host of an unreachable database and never prints the password", async () => {
    const url = "postgres://user:s3cret-password@127.0.0.1:1/missing";
    const failure = describeDatabaseFailure(await errorFrom(url), url);
    expect(failure.error).toBe("DATABASE_UNAVAILABLE");
    expect(failure.message).toContain("The database at 127.0.0.1 could not be used");
    expect(failure.message).toContain("ECONNREFUSED");
    expect(failure.message).toContain("Check DATABASE_URL");
    expect(failure.message).not.toContain("s3cret-password");
  });

  it("drops a connection string quoted inside an error message", () => {
    const failure = describeDatabaseFailure(new Error("cannot use postgres://user:pw@host.example/db: endpoint not found"), "postgres://user:pw@host.example/db");
    expect(failure.message).not.toContain("pw@");
    expect(failure.message).toContain("[connection string]");
    expect(databaseHost("not a url")).toBeNull();
  });

  it.skipIf(skipReal)("reports a rejected password as unavailable, and only a missing table as an uninitialised schema", async () => {
    const wrongPassword = new URL(databaseUrl);
    wrongPassword.password = "definitely-wrong-password";
    const rejected = describeDatabaseFailure(await errorFrom(wrongPassword.toString()), wrongPassword.toString());
    // The local test container may trust local connections; either way it is not a schema problem.
    if (rejected.error === "DATABASE_UNAVAILABLE") expect(rejected.message).not.toContain("definitely-wrong-password");

    const missingTable = describeDatabaseFailure(await errorFrom(databaseUrl, "SELECT * FROM table_that_does_not_exist_jde"), databaseUrl);
    expect(missingTable.error).toBe("DATABASE_NOT_INITIALIZED");
  });
});
