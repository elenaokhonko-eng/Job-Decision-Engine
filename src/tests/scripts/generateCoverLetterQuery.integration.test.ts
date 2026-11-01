import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/generate_cover_letter.ts",
);

// The script runs on import, so the job query is read from its source text.
const scriptSource = readFileSync(scriptPath, "utf8");

function coverLetterJobQuery(): string {
  const query = /const jobRes = await pool\.query\(\s*`([\s\S]*?)`/.exec(scriptSource)?.[1];
  if (!query) throw new Error("generate_cover_letter.ts job query was not found.");
  if (query.includes("${")) throw new Error("generate_cover_letter.ts job query must not interpolate values.");
  return query;
}

function jobFieldsReadByScript(): string[] {
  return [...new Set([...scriptSource.matchAll(/\bjob\.([a-z_][a-z0-9_]*)/g)].map((match) => match[1]))].sort();
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";

describe.skipIf(skipReal)("generate_cover_letter.ts job query (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `cover_letter_query_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
  });

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

  it("returns every job field the script reads, including canonical_job_id", async () => {
    if (!client) throw new Error("The cover-letter query test client is not initialized.");
    const workspace = await resolveWorkspaceContext(client);
    const result = await client.query(coverLetterJobQuery(), [
      crypto.randomUUID(),
      null,
      workspace.workspaceId,
    ]);
    const returnedColumns = result.fields.map((field) => field.name);

    expect(returnedColumns).toContain("canonical_job_id");
    expect(jobFieldsReadByScript().filter((field) => !returnedColumns.includes(field))).toEqual([]);
  });
});
