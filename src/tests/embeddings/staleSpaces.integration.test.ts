import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { deactivateStaleEmbeddingSpaces, embeddingSpacePreflight } from "../../embeddings/staleSpaces.js";
import { activeEmbeddingSpaceNotExactlyOne, runZeroChecks, zeroChecksExitCode } from "../../tasks/integrityZeroChecks.js";

// Real PostgreSQL, synthetic spaces. Primary = gemini / gemini-embedding-001 / 768 (the default configuration).
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) throw new Error("CI must run the embedding-space tests against its PostgreSQL service.");

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const saved: Record<string, string | undefined> = {};
const KEYS = ["EMBEDDING_PRIMARY_PROVIDER", "EMBEDDING_PRIMARY_MODEL", "EMBEDDING_PRIMARY_DIMENSIONS", "EMBEDDING_FALLBACK_PROVIDER", "EMBEDDING_FALLBACK_MODEL", "EMBEDDING_FALLBACK_DIMENSIONS"];

async function workspace(): Promise<string> {
  return (await db().query<{ id: string }>(`INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Space check') RETURNING id::text`, [`spaces-${randomUUID()}`])).rows[0]!.id;
}
async function space(ws: string, provider: string, model: string, dimensions: number, fallback: boolean): Promise<string> {
  return (await db().query<{ id: string }>(
    `INSERT INTO embedding_spaces (workspace_id, space_key, provider, model, dimensions, is_fallback_space, active) VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id::text`,
    [ws, `s-${randomUUID()}`, provider, model, dimensions, fallback])).rows[0]!.id;
}
async function publishInput(ws: string, spaceId: string): Promise<void> {
  const input = await db().query<{ id: string }>(
    `INSERT INTO embedding_inputs (workspace_id, input_key, source_type, source_id, content_text, content_hash) VALUES ($1, $2, 'JOB_VERSION', $3, 'Synthetic', $4) RETURNING id::text`,
    [ws, `i-${randomUUID()}`, randomUUID(), randomUUID()]);
  const batch = await db().query<{ id: string }>(
    `INSERT INTO embedding_batches (workspace_id, embedding_space_id, batch_key, run_type, status, item_count, success_count, failure_count, completed_at)
     VALUES ($1, $2, $3, 'PRIMARY', 'COMPLETED', 1, 1, 0, NOW()) RETURNING id::text`, [ws, spaceId, `b-${randomUUID()}`]);
  await db().query(`INSERT INTO embedding_batch_items (workspace_id, embedding_batch_id, embedding_input_id, status) VALUES ($1, $2, $3, 'COMPLETED')`, [ws, batch.rows[0]!.id, input.rows[0]!.id]);
  await db().query(
    `INSERT INTO semantic_embeddings (workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
     VALUES ($1, $2, $3, $4, 4, ARRAY[0.1, 0.2, 0.3, 0.4]::DOUBLE PRECISION[], $5)`, [ws, spaceId, input.rows[0]!.id, batch.rows[0]!.id, randomUUID()]);
}

describe.skipIf(skipReal)("stale embedding spaces (PostgreSQL)", () => {
  beforeAll(async () => {
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `stale_spaces_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
  }, 60_000);
  afterAll(async () => {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("one primary plus a fallback is clean; a deprecated second non-fallback space is a violation and is stale", async () => {
    const ws = await workspace();
    const primary = await space(ws, "gemini", "gemini-embedding-001", 768, false);
    await space(ws, "openai", "text-embedding-3-small", 1536, true);
    await publishInput(ws, primary);
    expect((await activeEmbeddingSpaceNotExactlyOne(db(), ws)).total).toBe(0);
    const stale = await space(ws, "gemini", "text-embedding-004", 768, false);
    const check = await activeEmbeddingSpaceNotExactlyOne(db(), ws);
    expect(check.total).toBeGreaterThan(0);
    expect(zeroChecksExitCode([check])).toBe(1);
    const preflight = await embeddingSpacePreflight(db(), ws);
    expect(preflight.staleSpaceIds).toEqual([stale]);
    expect(preflight.matcherCandidateIds).toHaveLength(2);
    expect(preflight.routerEqualsMatcher).toBe(true);
    expect((await runZeroChecks(db(), ws)).map((entry) => entry.name)).toContain("active_embedding_space_not_exactly_one");
  });

  it("dry run changes nothing; apply deactivates only the stale space; the primary, the fallback and a space holding published embeddings stay active", async () => {
    const ws = await workspace();
    const primary = await space(ws, "gemini", "gemini-embedding-001", 768, false);
    const fallback = await space(ws, "openai", "text-embedding-3-small", 1536, true);
    const stale = await space(ws, "gemini", "text-embedding-004", 768, false);
    const inUse = await space(ws, "gemini", "other-model", 768, false);
    await publishInput(ws, primary);
    await publishInput(ws, inUse);
    const dry = await deactivateStaleEmbeddingSpaces(db(), { workspaceId: ws });
    expect(dry).toEqual({ dryRun: true, spaceIds: [stale] });
    const active = async () => (await db().query<{ id: string }>(`SELECT id::text FROM embedding_spaces WHERE workspace_id = $1 AND active ORDER BY id`, [ws])).rows.map((row) => row.id).sort();
    expect(await active()).toEqual([primary, fallback, stale, inUse].sort());
    const applied = await deactivateStaleEmbeddingSpaces(db(), { workspaceId: ws, dryRun: false });
    expect(applied.spaceIds).toEqual([stale]);
    expect(await active()).toEqual([primary, fallback, inUse].sort());
    expect((await deactivateStaleEmbeddingSpaces(db(), { workspaceId: ws, dryRun: false })).spaceIds).toEqual([]);
  });

  it("the router and matcher candidates are reported as different when the router would also read a wrong-dimension space", async () => {
    const ws = await workspace();
    await space(ws, "gemini", "gemini-embedding-001", 768, false);
    await space(ws, "gemini", "gemini-embedding-001", 3072, false);
    const preflight = await embeddingSpacePreflight(db(), ws);
    expect(preflight.routerCandidateIds).toHaveLength(2);
    expect(preflight.matcherCandidateIds).toHaveLength(1);
    expect(preflight.routerEqualsMatcher).toBe(false);
  });
});
