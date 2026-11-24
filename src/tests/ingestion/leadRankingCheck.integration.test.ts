import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { LEAD_RANKING_SAMPLE_SIZE, reportAggregatorLeadsInRanking } from "../../ingestion/leadRankingCheck.js";
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
  readonly eligibility?: string | null;
  readonly fixture?: boolean;
  readonly observations: readonly { readonly source: string; readonly url: string; readonly payload?: Record<string, unknown> }[];
  readonly archived?: boolean;
}

async function seed(workspaceId: string, label: string, input: Seed): Promise<string> {
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, recommendation_outcome, recommendation_eligibility, is_test_fixture)
     VALUES ($1, 'Lead Rank Fixture Co', $2, $3, 'MATCHED', 'MATCHED', $4, $5, $6) RETURNING id`,
    [workspaceId, label, `https://example.test/rank/${randomUUID()}`, input.outcome, input.eligibility ?? null, input.fixture === true],
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

async function newWorkspace(): Promise<string> {
  const key = `lead-rank-${randomUUID()}`;
  const inserted = await db().query<{ id: string }>(
    `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Lead rank') RETURNING id::text`, [key]);
  return inserted.rows[0]!.id;
}

const LINKEDIN = "https://www.linkedin.com/jobs/view/4900000101";

describe.skipIf(skipReal)("no aggregator lead is in any ranking (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `lead_rank_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("reports exactly the ranked jobs backed only by an aggregator lead or a board feed (each test has its own workspace)", async () => {
    const ws = await newWorkspace();
    const violations = [
      await seed(ws, "ranked-linkedin-lead", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] }),
      await seed(ws, "ranked-marked-lead", { outcome: "PRIORITY", observations: [{ source: "GMAIL_ALERT", url: "https://careers.example.com/x", payload: { lead_kind: "AGGREGATOR_LEAD" } }] }),
      await seed(ws, "ranked-indeed-subdomain", { outcome: "TRACK", observations: [{ source: "GMAIL_ALERT", url: "https://sg.indeed.com/viewjob?jk=abc" }] }),
      // A board feed is not the employer's own posting, so an alert plus a feed observation is still a lead.
      await seed(ws, "ranked-lead-plus-board-feed", { outcome: "REVIEW", observations: [
        { source: "GMAIL_ALERT", url: LINKEDIN }, { source: "HIMALAYAS", url: "https://himalayas.app/jobs/x" }] }),
    ];
    // Not violations.
    await seed(ws, "verify-eligibility-no-outcome", { outcome: null, eligibility: "VERIFY", observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] });
    await seed(ws, "eligible-no-outcome", { outcome: null, eligibility: "ELIGIBLE", observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] });
    await seed(ws, "ineligible-skip-near-miss", { outcome: "SKIP", eligibility: "INELIGIBLE", observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] });
    await seed(ws, "unranked-lead", { outcome: null, observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] });
    await seed(ws, "employer-resolved", { outcome: "REVIEW", observations: [
      { source: "GMAIL_ALERT", url: LINKEDIN }, { source: "GREENHOUSE", url: "https://boards.greenhouse.io/x/jobs/1" }] });
    await seed(ws, "owner-saved-linkedin", { outcome: "REVIEW", observations: [
      { source: "GMAIL_ALERT", url: LINKEDIN }, { source: "LINKEDIN_SAVED", url: LINKEDIN }] });
    await seed(ws, "owner-saved-mcf", { outcome: "REVIEW", observations: [
      { source: "GMAIL_ALERT", url: "https://www.mycareersfuture.gov.sg/job/a/b" }, { source: "MCF_SAVED", url: "https://www.mycareersfuture.gov.sg/job/a/b" }] });
    await seed(ws, "owner-manual", { outcome: "REVIEW", observations: [
      { source: "GMAIL_ALERT", url: LINKEDIN }, { source: "MANUAL_IMPORT", url: "https://example.test/manual" }] });
    await seed(ws, "company-alert", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: "https://careers.example.com/jobs/4900000102" }] });
    await seed(ws, "lookalike-host", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: "https://notlinkedin.com/jobs/view/1" }] });
    await seed(ws, "archived-lead", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }], archived: true });
    await seed(ws, "test-fixture-lead", { outcome: "REVIEW", fixture: true, observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] });

    const report = await reportAggregatorLeadsInRanking(db(), ws);
    expect(report.count).toBe(4);
    expect(report.sample.length).toBeLessThanOrEqual(LEAD_RANKING_SAMPLE_SIZE);
    expect([...report.sample].sort()).toEqual([...violations].sort());
  });

  it("is zero once the employer's posting is resolved or the lead is no longer ranked", async () => {
    const ws = await newWorkspace();
    const lead = await seed(ws, "ranked-lead", { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] });
    expect((await reportAggregatorLeadsInRanking(db(), ws)).count).toBe(1);
    await db().query(`UPDATE canonical_jobs SET recommendation_outcome = NULL WHERE id = $1`, [lead]);
    expect(await reportAggregatorLeadsInRanking(db(), ws)).toEqual({ count: 0, sample: [] });
  });

  it("caps the sample at the documented size", async () => {
    const ws = await newWorkspace();
    for (let index = 0; index < LEAD_RANKING_SAMPLE_SIZE + 2; index += 1) {
      await seed(ws, `many-${index}`, { outcome: "REVIEW", observations: [{ source: "GMAIL_ALERT", url: LINKEDIN }] });
    }
    const report = await reportAggregatorLeadsInRanking(db(), ws);
    expect(report.count).toBe(LEAD_RANKING_SAMPLE_SIZE + 2);
    expect(report.sample).toHaveLength(LEAD_RANKING_SAMPLE_SIZE);
  });
});
