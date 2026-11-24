import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { reportAggregatorLeadsInRanking } from "../../ingestion/leadRankingCheck.js";
import { archiveJobsAsPostingNotConfirmable } from "../../services/jobArchive.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Must-be-zero check: no aggregator lead is in any ranking. Synthetic fixtures; real PostgreSQL, private schema.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the lead ranking check integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The lead ranking test client is not initialized.");
  return client;
}

interface Seed {
  readonly outcome: string | null;
  readonly observations: readonly { readonly source: string; readonly url: string; readonly payload?: Record<string, unknown> }[];
  readonly archived?: boolean;
}

async function seed(label: string, input: Seed): Promise<string> {
  const workspaceId = context!.workspaceId;
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, recommendation_outcome)
     VALUES ($1, 'Lead Rank Fixture Co', $2, $3, 'MATCHED', 'MATCHED', $4) RETURNING id`,
    [workspaceId, label, `https://example.test/rank/${randomUUID()}`, input.outcome],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, 1, $3, 'Synthetic posting.', NOW()) RETURNING id`,
    [workspaceId, canonicalJobId, `rank-${randomUUID()}`],
  );
  const jobVersionId = version.rows[0]!.id;
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`, [jobVersionId, workspaceId, canonicalJobId]);
  for (const observation of input.observations) {
    const id = randomUUID();
    await db().query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
       ) VALUES ($1, $2, $3, $4, $5, NOW(), 'Lead Rank Fixture Co', $6, 'Synthetic.', $7::jsonb, $8, 'PROCESSED', $9)`,
      [id, workspaceId, observation.source, `rank-${id}`, observation.url, label, JSON.stringify(observation.payload ?? {}), `raw-${id}`, jobVersionId],
    );
  }
  if (input.archived) {
    await archiveJobsAsPostingNotConfirmable(db(), { workspaceId, canonicalJobIds: [canonicalJobId], actor: "test:lead_rank", details: { rule: "test" } });
  }
  return canonicalJobId;
}

describe.skipIf(skipReal)("no aggregator lead is in any ranking (PostgreSQL)", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `lead_rank_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    const linkedin = "https://www.linkedin.com/jobs/view/4900000101";
    ids.rankedLinkedInLead = await seed("ranked-linkedin-lead", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: linkedin }] });
    ids.rankedMarkedLead = await seed("ranked-marked-lead", { outcome: "PRIORITY", observations: [{ source: "GMAIL_ALERT", url: "https://careers.example.com/x", payload: { lead_kind: "AGGREGATOR_LEAD" } }] });
    ids.rankedIndeedSubdomain = await seed("ranked-indeed-subdomain", { outcome: "TRACK", observations: [{ source: "GMAIL_ALERT", url: "https://sg.indeed.com/viewjob?jk=abc" }] });
    ids.unrankedLead = await seed("unranked-lead", { outcome: null, observations: [{ source: "GMAIL_ALERT", url: linkedin }] });
    ids.employerResolved = await seed("employer-resolved", { outcome: "REVIEW", observations: [
      { source: "GMAIL_ALERT", url: linkedin }, { source: "GREENHOUSE", url: "https://boards.greenhouse.io/x/jobs/1" }] });
    ids.ownerSaved = await seed("owner-saved", { outcome: "REVIEW", observations: [
      { source: "GMAIL_ALERT", url: linkedin }, { source: "LINKEDIN_SAVED", url: linkedin }] });
    ids.companyAlert = await seed("company-alert", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: "https://careers.example.com/jobs/4900000102" }] });
    ids.lookalikeHost = await seed("lookalike-host", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: "https://notlinkedin.com/jobs/view/1" }] });
    ids.archivedLead = await seed("archived-lead", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: linkedin }], archived: true });
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("reports exactly the ranked jobs backed only by an aggregator lead", async () => {
    const report = await reportAggregatorLeadsInRanking(db(), context!.workspaceId);
    expect(report.count).toBe(3);
    expect([...report.sample].sort()).toEqual([ids.rankedLinkedInLead, ids.rankedMarkedLead, ids.rankedIndeedSubdomain].sort());
  });

  it("is zero once the employer's posting is resolved or the lead is no longer ranked", async () => {
    for (const key of ["rankedLinkedInLead", "rankedMarkedLead", "rankedIndeedSubdomain"]) {
      await db().query(`UPDATE canonical_jobs SET recommendation_outcome = NULL, recommendation_eligibility = NULL WHERE id = $1`, [ids[key]]);
    }
    const report = await reportAggregatorLeadsInRanking(db(), context!.workspaceId);
    expect(report).toEqual({ count: 0, sample: [] });
  });
});
