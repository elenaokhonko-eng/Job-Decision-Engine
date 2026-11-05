import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { sourceContentEvidencePredicate } from "../../pipeline/descriptionQuality.js";
import { resolveWorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts");

// Both generators run on import, so their job queries are read from source text.
// Each query takes ($1 canonical_job_id, $2 job_version_id | null, $3 workspace_id).
const GENERATOR_SCRIPTS = ["generate_cover_letter.ts", "generate_cv.ts"] as const;

function scriptSource(script: string): string {
  return readFileSync(path.join(scriptsDir, script), "utf8");
}

function generatorJobQuery(script: string): string {
  const template = /const jobRes = await pool\.query(?:<\w+>)?\(\s*`([\s\S]*?)`;?\s*,\s*\[/.exec(scriptSource(script))?.[1];
  if (!template) throw new Error(`${script} job query was not found.`);
  // The only interpolation allowed is the trusted source-content predicate, expanded with its literal arguments.
  const query = template.replace(
    /\$\{sourceContentEvidencePredicate\("([\w.]+)", "([\w.]+)"\)\}/g,
    (_match, workspaceExpression: string, jobVersionExpression: string) =>
      sourceContentEvidencePredicate(workspaceExpression, jobVersionExpression),
  );
  if (query.includes("${")) throw new Error(`${script} job query must not interpolate values.`);
  return query;
}

function jobFieldsReadByScript(script: string): string[] {
  const fields = [...scriptSource(script).matchAll(/\bjob\.([a-z_][a-z0-9_]*)/g)].map((match) => match[1]);
  return [...new Set(fields)].sort();
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";

describe.skipIf(skipReal)("document generator job queries (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `generator_job_query_${crypto.randomUUID().replaceAll("-", "")}`;
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

  it.each(GENERATOR_SCRIPTS)("%s returns every job field it reads, including canonical_job_id", async (script) => {
    if (!client) throw new Error("The generator job query test client is not initialized.");
    const workspace = await resolveWorkspaceContext(client);
    const result = await client.query(generatorJobQuery(script), [
      crypto.randomUUID(),
      null,
      workspace.workspaceId,
    ]);
    const returnedColumns = result.fields.map((field) => field.name);

    expect(jobFieldsReadByScript(script).length).toBeGreaterThan(0);
    expect(returnedColumns).toContain("canonical_job_id");
    expect(jobFieldsReadByScript(script).filter((field) => !returnedColumns.includes(field))).toEqual([]);
  });
});
