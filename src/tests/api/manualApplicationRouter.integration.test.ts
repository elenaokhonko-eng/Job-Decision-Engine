import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

import { createManualApplicationRouter } from "../../api/v2/manualApplicationRouter.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const routerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../api/v2/manualApplicationRouter.ts");

// loadCurrentInputs is private, so its job query is read from the router source.
function currentInputsJobQuery(): string {
  const query = /const jobResult = await client\.query<JobRow>\(\s*`([\s\S]*?)`/.exec(readFileSync(routerPath, "utf8"))?.[1];
  if (!query) throw new Error("manualApplicationRouter.ts current-inputs job query was not found.");
  return query;
}

let pool: pg.Pool | undefined;
let server: Server | undefined;
let baseUrl = "";
let schemaName = "";
let context: WorkspaceContext | undefined;

describe.skipIf(skipReal)("manual application router (PostgreSQL)", () => {
  beforeAll(async () => {
    schemaName = `manual_router_${crypto.randomUUID().replaceAll("-", "")}`;
    pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public` });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const client = await pool.connect();
    try {
      await runMigrations(client);
      context = await resolveWorkspaceContext(client);
    } finally {
      client.release();
    }
    const workspace = context;
    const app = express();
    app.use(createManualApplicationRouter({ pool, resolveContext: () => workspace }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (pool && schemaName) await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    await pool?.end();
    pool = undefined;
  });

  it("reads readiness columns from a view that exposes them", async () => {
    if (!pool || !context) throw new Error("The manual router test pool is not initialized.");
    const result = await pool.query(currentInputsJobQuery(), [
      context.workspaceId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      "a".repeat(64),
    ]);
    const columns = result.fields.map((field) => field.name);

    expect(columns).toEqual(expect.arrayContaining(["readiness_status", "readiness_reason_codes", "recommendation_outcome"]));
  });

  it("checks download membership without a read-only transaction error", async () => {
    const response = await fetch(`${baseUrl}/${crypto.randomUUID()}/documents/CV/DOCX`);
    const body = await response.json() as { error?: { code?: string } | string };

    expect(response.status).toBe(404);
    expect(JSON.stringify(body)).toContain("NOT_FOUND");
  });
});
