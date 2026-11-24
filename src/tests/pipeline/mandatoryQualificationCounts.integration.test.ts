import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { loadMandatoryQualificationCounts } from "../../pipeline/recommendationDecider.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Which MUST requirements block a job. NO_MATCH is the matcher's starting value ("no evidence
// found"); only a degree or credential the matcher compared and found short blocks. Real PostgreSQL;
// fixtures are synthetic.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

type MatchType = "EXACT" | "SEMANTIC" | "NO_MATCH" | "UNKNOWN";
interface Req {
  readonly type: "CUSTOM" | "DEGREE" | "CREDENTIAL" | "DOMAIN" | "FUNCTION" | "EXPERIENCE_YEARS" | "WORK_MODE";
  readonly match: MatchType;
  readonly qualificationCode?: string;
  readonly importance?: "MUST" | "PREFERRED";
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let profileVersionId = "";

function db(): pg.PoolClient {
  if (!client) throw new Error("The mandatory-qualification test client is not initialized.");
  return client;
}

async function seedJob(requirements: readonly Req[]) {
  const database = db();
  const { workspaceId, userId } = context!;
  const canonical = await database.query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url)
     VALUES ($1, 'Mandatory Fixture Co', 'Mandatory Fixture', $2) RETURNING id`,
    [workspaceId, `https://example.test/mandatory/${crypto.randomUUID()}`],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const contentHash = `content-${crypto.randomUUID()}`;
  const version = await database.query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, 1, $3, 'Synthetic fixture.', NOW()) RETURNING id`,
    [workspaceId, canonicalJobId, contentHash],
  );
  const jobVersionId = version.rows[0]!.id;
  const identity = await database.query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version,
       quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'det-v1', 'quoted-v1', 'prompt-v1', 'norm-v1', FALSE) RETURNING id`,
    [workspaceId, canonicalJobId, `identity-${crypto.randomUUID()}`, contentHash],
  );
  const set = await database.query<{ id: string }>(
    `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type, created_by_user_id)
     VALUES ($1, $2, $3, $4, 1, 'EXTRACTED', $5) RETURNING id`,
    [workspaceId, identity.rows[0]!.id, canonicalJobId, jobVersionId, userId],
  );
  const requirementSetId = set.rows[0]!.id;
  await database.query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`, [requirementSetId, jobVersionId]);
  const run = await database.query<{ id: string }>(
    `INSERT INTO match_runs (
       workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id,
       job_content_hash, context_fingerprint, status, requirement_count, matched_count, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', $8, 0, NOW()) RETURNING id`,
    [workspaceId, canonicalJobId, jobVersionId, profileVersionId, requirementSetId, contentHash, `ctx-${crypto.randomUUID()}`, requirements.length],
  );
  const matchRunId = run.rows[0]!.id;
  let index = 0;
  for (const requirement of requirements) {
    index += 1;
    const created = await database.query<{ id: string }>(
      `INSERT INTO job_requirements (
         workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type, importance,
         requirement_text, quote_text, extractor_type, extractor_version, confidence, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Synthetic requirement.', 'synthetic', 'DETERMINISTIC', 'det-v1', 1, 'VALIDATED')
       RETURNING id`,
      [workspaceId, canonicalJobId, jobVersionId, requirementSetId, `req-${index}`, requirement.type, requirement.importance ?? "MUST"],
    );
    await database.query(
      `INSERT INTO requirement_evidence_matches (workspace_id, match_run_id, requirement_id, match_type, match_score, rationale, evidence)
       VALUES ($1, $2, $3, $4, 0, 'synthetic', $5::jsonb)`,
      [
        workspaceId, matchRunId, created.rows[0]!.id, requirement.match,
        JSON.stringify(requirement.qualificationCode ? { match_qualification_code: requirement.qualificationCode } : {}),
      ],
    );
  }
  const rows = await loadMandatoryQualificationCounts(database, {
    workspaceId, canonicalJobId, matchRunId, jobVersionId, requirementSetId,
  });
  const counts = rows[0]!;
  return {
    total: Number(counts.total_mandatory),
    matched: Number(counts.matched_mandatory),
    blocked: Number(counts.blocked_mandatory),
    unresolved: Number(counts.unresolved_mandatory),
  };
}

describe.skipIf(skipReal)("mandatory qualification counts (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `mandatory_counts_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const profile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Fixture Candidate') RETURNING id`,
      [context.workspaceId, `mandatory-${crypto.randomUUID()}`],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`,
      [context.workspaceId, profile.rows[0]!.id, `profile-${crypto.randomUUID()}`],
    );
    profileVersionId = version.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("does not block a job with many unmatched free-text MUST requirements", async () => {
    const counts = await seedJob([
      ...Array.from({ length: 12 }, () => ({ type: "CUSTOM", match: "NO_MATCH" }) as const),
      { type: "CUSTOM", match: "EXACT" },
      { type: "DOMAIN", match: "NO_MATCH" },
      { type: "FUNCTION", match: "NO_MATCH" },
      { type: "EXPERIENCE_YEARS", match: "NO_MATCH" },
    ]);
    expect(counts).toMatchObject({ total: 16, matched: 1, blocked: 0, unresolved: 0 });
  });

  it("does not block a mandatory degree the matcher found short: it is counted as a flagged degree gap", async () => {
    const counts = await seedJob([
      { type: "DEGREE", match: "NO_MATCH", qualificationCode: "MATCH_QUALIFICATION_DEGREE_GAP" },
      { type: "CUSTOM", match: "NO_MATCH" },
    ]);
    expect(counts.blocked).toBe(0);
  });

  it("still blocks a mandatory credential the profile explicitly lacks", async () => {
    const counts = await seedJob([
      { type: "CREDENTIAL", match: "NO_MATCH", qualificationCode: "MATCH_QUALIFICATION_MANDATORY_CERT_MISSING" },
    ]);
    expect(counts.blocked).toBe(1);
  });

  it("does not block on an optional credential gap, and ignores non-MUST requirements", async () => {
    const counts = await seedJob([
      { type: "CREDENTIAL", match: "NO_MATCH", qualificationCode: "MATCH_QUALIFICATION_PREFERRED_CERT_GAP" },
      { type: "DEGREE", match: "NO_MATCH", qualificationCode: "MATCH_QUALIFICATION_DEGREE_GAP", importance: "PREFERRED" },
    ]);
    expect(counts).toMatchObject({ total: 1, blocked: 0 });
  });

  it("keeps workability requirement types out of the count", async () => {
    const counts = await seedJob([
      { type: "WORK_MODE", match: "NO_MATCH" },
      { type: "CUSTOM", match: "SEMANTIC" },
    ]);
    expect(counts).toMatchObject({ total: 1, matched: 1, blocked: 0 });
  });

  it("keeps unresolved requirements separate from blocked ones", async () => {
    const counts = await seedJob([
      { type: "CUSTOM", match: "UNKNOWN" },
      { type: "DEGREE", match: "UNKNOWN" },
    ]);
    expect(counts).toMatchObject({ blocked: 0, unresolved: 2 });
  });
});
