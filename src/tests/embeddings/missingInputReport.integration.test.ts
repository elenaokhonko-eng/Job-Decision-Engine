import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { reportJobsMissingRequirementInputs } from "../../embeddings/missingInputReport.js";

// Real PostgreSQL, synthetic jobs. Primary = gemini / gemini-embedding-001 / 768 (the default configuration).
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) throw new Error("CI must run the missing-input report tests against its PostgreSQL service.");

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const saved: Record<string, string | undefined> = {};
const KEYS = ["EMBEDDING_PRIMARY_PROVIDER", "EMBEDDING_PRIMARY_MODEL", "EMBEDDING_PRIMARY_DIMENSIONS"];

async function workspace(): Promise<string> {
  return (await db().query<{ id: string }>(`INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Report check') RETURNING id::text`, [`report-${randomUUID()}`])).rows[0]!.id;
}
async function space(ws: string, model: string, dimensions: number, fallback: boolean): Promise<string> {
  return (await db().query<{ id: string }>(
    `INSERT INTO embedding_spaces (workspace_id, space_key, provider, model, dimensions, is_fallback_space, active) VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id::text`,
    [ws, `s-${randomUUID()}`, fallback ? "openai" : "gemini", model, dimensions, fallback])).rows[0]!.id;
}
interface Job { canonicalJobId: string; requirementIds: string[] }
/** A live job whose ACTIVE set has one requirement per given status. */
async function job(ws: string, statuses: readonly string[], over: { outcome?: string; state?: string; fixture?: boolean; extraInactiveSet?: boolean } = {}): Promise<Job> {
  const key = randomUUID();
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, location_summary, location, workplace_type, employment_type,
                                 processing_status, processing_state, recommendation_outcome, is_test_fixture)
     VALUES ($1, $2, $3, $4, 'Remote', 'Remote', 'REMOTE', 'PERMANENT', $5, $5, $6, $7) RETURNING id::text`,
    [ws, `Synthetic ${key}`, `Synthetic title ${key}`, `https://example.test/${key}`, over.state ?? "MATCHED", over.outcome ?? null, over.fixture ?? false]);
  const canonicalJobId = canonical.rows[0]!.id;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text) VALUES ($1, $2, 1, $3, 'Synthetic description') RETURNING id::text`,
    [ws, canonicalJobId, `hash-${key}`]);
  const jobVersionId = version.rows[0]!.id;
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  const makeSet = async (revision: number, hashSuffix: string): Promise<string> => {
    const identity = await db().query<{ id: string }>(
      `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version, quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled)
       VALUES ($1, $2, $3, $4, 'd-v1', 'q-v1', 'p-v1', 'n-v1', FALSE) RETURNING id::text`, [ws, canonicalJobId, `id-${key}-${hashSuffix}`, `hash-${key}`]);
    return (await db().query<{ id: string }>(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
       VALUES ($1, $2, $3, $4, $5, 'EXTRACTED') RETURNING id::text`, [ws, identity.rows[0]!.id, canonicalJobId, jobVersionId, revision])).rows[0]!.id;
  };
  const insertRequirement = async (setId: string, index: number, status: string): Promise<string> => (await db().query<{ id: string }>(
    `INSERT INTO job_requirements (workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type, importance, requirement_text, extractor_type, extractor_version, confidence, status)
     VALUES ($1, $2, $3, $4, $5, 'FUNCTION', 'MUST', $6, 'DETERMINISTIC', 'd-v1', 1, $7) RETURNING id::text`,
    [ws, canonicalJobId, jobVersionId, setId, `function-${index}`, `Synthetic requirement ${index}`, status])).rows[0]!.id;
  if (over.extraInactiveSet) {
    const old = await makeSet(1, "old");
    await insertRequirement(old, 1, "VALIDATED"); // belongs to a superseded set, never counted
  }
  const activeSet = await makeSet(over.extraInactiveSet ? 2 : 1, "active");
  await db().query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`, [activeSet, jobVersionId]);
  const requirementIds: string[] = [];
  for (const [index, status] of statuses.entries()) requirementIds.push(await insertRequirement(activeSet, index + 1, status));
  return { canonicalJobId, requirementIds };
}
async function embed(ws: string, spaceId: string, requirementId: string): Promise<void> {
  const input = await db().query<{ id: string }>(
    `INSERT INTO embedding_inputs (workspace_id, input_key, source_type, source_id, content_text, content_hash) VALUES ($1, $2, 'JOB_REQUIREMENT', $3, 'Synthetic', $4) RETURNING id::text`,
    [ws, `i-${randomUUID()}`, requirementId, randomUUID()]);
  const batch = await db().query<{ id: string }>(
    `INSERT INTO embedding_batches (workspace_id, embedding_space_id, batch_key, run_type, status, item_count, success_count, failure_count, completed_at)
     VALUES ($1, $2, $3, 'PRIMARY', 'COMPLETED', 1, 1, 0, NOW()) RETURNING id::text`, [ws, spaceId, `b-${randomUUID()}`]);
  await db().query(`INSERT INTO embedding_batch_items (workspace_id, embedding_batch_id, embedding_input_id, status) VALUES ($1, $2, $3, 'COMPLETED')`, [ws, batch.rows[0]!.id, input.rows[0]!.id]);
  await db().query(
    `INSERT INTO semantic_embeddings (workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
     VALUES ($1, $2, $3, $4, 4, ARRAY[0.1, 0.2, 0.3, 0.4]::DOUBLE PRECISION[], $5)`, [ws, spaceId, input.rows[0]!.id, batch.rows[0]!.id, randomUUID()]);
}

describe.skipIf(skipReal)("missing requirement embedding report (PostgreSQL)", () => {
  beforeAll(async () => {
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `missing_report_${randomUUID().replaceAll("-", "")}`;
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

  it("counts only VALIDATED requirements of the ACTIVE set; EXTRACTED, REJECTED, superseded-set and fixture rows are ignored", async () => {
    const ws = await workspace();
    await space(ws, "gemini-embedding-001", 768, false);
    await job(ws, ["VALIDATED", "VALIDATED", "EXTRACTED", "REJECTED"], { outcome: "REVIEW", state: "MATCHED", extraInactiveSet: true });
    await job(ws, ["EXTRACTED", "REJECTED"], { outcome: "REVIEW", state: "MATCHED" }); // nothing the builder embeds
    await job(ws, ["VALIDATED"], { state: "RAW_STAGED", fixture: true }); // fixture
    const report = await reportJobsMissingRequirementInputs(db(), ws);
    expect(report.jobs).toBe(1);
    expect(report.requirements).toBe(2);
    expect(report.requirementsWithoutInput).toBe(2);
    expect(report.byOutcome).toEqual({ REVIEW: 1 });
    expect(report.byState).toEqual({ MATCHED: 1 });
    expect(report.byOutcomeAndState).toEqual({ "REVIEW/MATCHED": 1 });
  });

  it("is scoped to the primary space: a requirement embedded only in the fallback still counts, one embedded in the primary does not", async () => {
    const ws = await workspace();
    const primary = await space(ws, "gemini-embedding-001", 768, false);
    const fallback = await space(ws, "text-embedding-3-small", 1536, true);
    const done = await job(ws, ["VALIDATED"], { outcome: "PRIORITY", state: "MATCHED" });
    const fallbackOnly = await job(ws, ["VALIDATED", "VALIDATED"], { outcome: "TRACK", state: "UNMATCHED" });
    await embed(ws, primary, done.requirementIds[0]!);
    await embed(ws, fallback, fallbackOnly.requirementIds[0]!);
    await embed(ws, primary, fallbackOnly.requirementIds[1]!);
    const report = await reportJobsMissingRequirementInputs(db(), ws);
    expect(report.jobs).toBe(1);
    expect(report.requirements).toBe(1); // the fallback-only requirement
    expect(report.requirementsWithoutInput).toBe(0); // it has an input, only no primary vector
    expect(report.byOutcomeAndState).toEqual({ "TRACK/UNMATCHED": 1 });
  });
});
