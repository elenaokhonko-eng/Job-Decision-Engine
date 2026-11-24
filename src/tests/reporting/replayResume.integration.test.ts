import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { loadJobsOnExtractorVersion } from "../../reporting/replayResilience.js";

// Runs the real resume query against a migrated, disposable local Postgres. It refuses any non-local URL and
// rolls back everything it seeds.
const DB_URL = process.env.DATABASE_URL || "";
const enabled = Boolean(DB_URL) && isLocalPostgresConnectionString(DB_URL);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && !enabled) {
  throw new Error("REQUIRE_POSTGRES_INTEGRATION is set but DATABASE_URL is not a local Postgres.");
}

describe.skipIf(!enabled)("replay resume query (Postgres)", () => {
  let client: pg.Client;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  beforeAll(async () => {
    client = new pg.Client(pgConnectionConfig(DB_URL));
    await client.connect();
    await client.query("BEGIN");
    for (const id of [workspaceId, otherWorkspaceId]) {
      await client.query(`INSERT INTO workspaces (id, workspace_key, display_name) VALUES ($1, $2, 'fixture')`, [id, `resume-${id}`]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  });

  async function seedJob(options: { version: string | null; requirements: number; workspace?: string }): Promise<string> {
    const workspace = options.workspace ?? workspaceId;
    const jobId = randomUUID();
    const versionId = randomUUID();
    await client.query(
      `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, is_test_fixture)
       VALUES ($1, $2, 'Fixture Co', 'Fixture role', $3, TRUE)`,
      [jobId, workspace, `https://example.invalid/${jobId}`],
    );
    await client.query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text)
       VALUES ($1, $2, $3, $4, 'fixture description')`,
      [versionId, workspace, jobId, `hash-${versionId}`],
    );
    await client.query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);
    if (options.version === null) return jobId;
    const identity = await client.query<{ id: string }>(
      `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash,
                                               deterministic_extractor_version, quoted_extractor_version,
                                               quoted_prompt_hash, normalizer_hash)
       VALUES ($1, $2, $3, 'h', $4, 'v', 'p', 'n') RETURNING id`,
      [workspace, jobId, `identity-${jobId}`, options.version],
    );
    const set = await client.query<{ id: string }>(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
                                     revision_number, source_type)
       VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
      [workspace, identity.rows[0].id, jobId, versionId],
    );
    for (let index = 0; index < options.requirements; index += 1) {
      await client.query(
        `INSERT INTO job_requirements (workspace_id, canonical_job_id, job_version_id, requirement_set_id,
                                       requirement_key, requirement_type, importance, requirement_text,
                                       extractor_type, extractor_version, confidence)
         VALUES ($1, $2, $3, $4, $5, 'DOMAIN', 'MUST', 'fixture text', 'DETERMINISTIC', $6, 1)`,
        [workspace, jobId, versionId, set.rows[0].id, `fixture-${index}`, options.version],
      );
    }
    await client.query(`UPDATE job_versions SET active_requirement_set_id = $2 WHERE id = $1`, [versionId, set.rows[0].id]);
    return jobId;
  }

  it("returns only jobs whose active set is on the current extractor version and has requirements", async () => {
    const current = await seedJob({ version: "deterministic_vCURRENT", requirements: 2 });
    const old = await seedJob({ version: "deterministic_vOLD", requirements: 2 });
    const never = await seedJob({ version: null, requirements: 0 });
    const emptySet = await seedJob({ version: "deterministic_vCURRENT", requirements: 0 });
    const otherWorkspace = await seedJob({ version: "deterministic_vCURRENT", requirements: 1, workspace: otherWorkspaceId });

    const done = await loadJobsOnExtractorVersion(client, workspaceId, [current, old, never, emptySet, otherWorkspace], "deterministic_vCURRENT");
    expect([...done]).toEqual([current]);
  });

  it("returns an empty set for no ids", async () => {
    expect((await loadJobsOnExtractorVersion(client, workspaceId, [], "deterministic_vCURRENT")).size).toBe(0);
  });
});
