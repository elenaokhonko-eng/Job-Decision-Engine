import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { load } from "js-yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { SourcePluginSchema } from "../../contracts/sourcePlugin.js";
import { WorkdayAdapter } from "../../ingestion/adapters/workdayAdapter.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { SourceBroker } from "../../ingestion/sourceBroker.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { processSourcePage, workdaySearchTermsForLanes } from "../../../scripts/run_adapters.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run Workday source integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The Workday integration test database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The Workday integration test workspace is not initialized.");
  return context;
}

// Synthetic tenant and postings only.
const HOST = "fixturebank.wd3.myworkdayjobs.com";
const TENANT = "fixturebank";
const SITE = "FixtureCareers";
const API = `https://${HOST}/wday/cxs/${TENANT}/${SITE}`;
const LANE = "INVESTMENT_MARKETS_FINTECH";
const DESCRIPTION_HTML = [
  "<p>About the role: Fixture Bank is hiring a platform engineer for its synthetic market data and trading systems platform.</p>",
  "<p>Responsibilities: design investment technology services, run architecture reviews, and coordinate technical delivery with engineering squads.</p>",
  "<p>Requirements: experience building distributed market data platforms, strong stakeholder communication and a record of production delivery.</p>",
].join("");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubTenant(detailStatus = 200): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === "POST" && target === `${API}/jobs`) {
      const body = JSON.parse(String(init.body)) as { searchText: string; offset: number };
      if (body.searchText === "") {
        return json({ total: 1, jobPostings: [], facets: [{ facetParameter: "locationMainGroup", values: [
          { facetParameter: "locationCountry", values: [{ descriptor: "Singapore", id: "sg-country", count: 2 }] },
        ] }] });
      }
      if (body.searchText === "platform engineer" && body.offset === 0) {
        return json({ total: 2, jobPostings: [
          { title: "Platform Engineer, Market Data", externalPath: "/job/Singapore/Platform-Engineer_R100", locationsText: "Singapore" },
          { title: "Branch Teller", externalPath: "/job/Singapore/Branch-Teller_R200", locationsText: "Singapore" },
        ] });
      }
      return json({ total: 0, jobPostings: [] });
    }
    if (target === `${API}/job/Singapore/Platform-Engineer_R100`) {
      if (detailStatus !== 200) return json({}, detailStatus);
      return json({
        jobPostingInfo: {
          title: "Platform Engineer, Market Data",
          jobDescription: DESCRIPTION_HTML,
          location: "Singapore",
          timeType: "Full time",
          remoteType: "Hybrid",
          startDate: "2026-11-01",
          jobReqId: "R100",
          externalUrl: `https://${HOST}/${SITE}/job/Singapore/Platform-Engineer_R100`,
        },
        hiringOrganization: { name: "Fixture Bank Ltd" },
      });
    }
    if (target === `${API}/job/Singapore/Branch-Teller_R200`) {
      return json({
        jobPostingInfo: {
          title: "Branch Teller",
          jobDescription: "<p>Serve walk-in customers at a retail branch counter, handle cash deposits and withdrawals.</p>",
          location: "Singapore",
          timeType: "Full time",
          externalUrl: `https://${HOST}/${SITE}/job/Singapore/Branch-Teller_R200`,
        },
        hiringOrganization: { name: "Fixture Bank Ltd" },
      });
    }
    return json({}, 500);
  }));
}

describe.skipIf(skipReal)("Workday source (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `workday_source_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  async function runPage(broker: SourceBroker, plugin: ReturnType<typeof SourcePluginSchema.parse>, revisionId: string) {
    const plans = new DiscoveryScoutPlanner().generateSearchPlans({ [LANE]: ["Fixture Bank"] });
    const adapter = new WorkdayAdapter({
      config: { companyName: "Fixture Bank", host: HOST, tenant: TENANT, site: SITE },
      // Only the term the fixture tenant answers, plus the real lane terms (which return nothing).
      searchTerms: ["platform engineer", ...workdaySearchTermsForLanes([LANE], plans)],
      limits: { requestDelayMs: 0, searchTermsPerRun: 50 },
      sleep: async () => undefined,
    });
    return processSourcePage({
      broker,
      plugin,
      adapter,
      checkpointTarget: `ats:${TENANT}`,
      planVersion: `${plans[LANE].planVersion}:${revisionId}`,
      laneKeys: [LANE],
      employerLaneKeys: [LANE],
      targetCompanyId: "fixture_bank",
      itemsPerRun: 8,
      plans,
      lanes: loadGlobalLanesConfig().lanes,
    });
  }

  it("stages Workday postings as WORKDAY observations with retrieval evidence and records lane dispositions", async () => {
    const database = getClient();
    const plugin = SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", "workday.yml"), "utf8")));
    const broker = new SourceBroker(database, getContext());
    await broker.startRun("WORKDAY_INTEGRATION");
    const revisionId = await broker.ensureSourcePluginRevision(plugin);

    stubTenant();
    const summary = await runPage(broker, plugin, revisionId);

    expect(summary).toMatchObject({ success: true, discovered: 2, newlyStaged: 1, filtered: 1, nextCursor: null });
    const observations = await database.query<{
      id: string;
      source_name: string;
      source_plugin_key: string;
      source_external_id: string;
      source_url: string;
      company_name: string;
      title: string;
      description_raw: string;
      workplace_type_raw: string;
      availability: { status: string; verification_method: string };
    }>(
      `SELECT id::text, source_name, source_plugin_key, source_external_id, source_url, company_name, title,
              description_raw, workplace_type_raw, normalized_evidence->'availability' AS availability
       FROM raw_job_observations WHERE workspace_id = $1 AND source_name = 'WORKDAY'`,
      [getContext().workspaceId],
    );
    expect(observations.rows).toHaveLength(1);
    const staged = observations.rows[0];
    expect(staged).toMatchObject({
      source_name: "WORKDAY",
      source_plugin_key: "workday",
      source_external_id: `workday:${TENANT}:${SITE}/job/Singapore/Platform-Engineer_R100`,
      source_url: `https://${HOST}/${SITE}/job/Singapore/Platform-Engineer_R100`,
      company_name: "Fixture Bank",
      title: "Platform Engineer, Market Data",
      workplace_type_raw: "HYBRID",
      availability: { status: "OPEN", verification_method: "VERIFIED_POSTING_RETRIEVAL" },
    });
    expect(staged.description_raw).toContain("Responsibilities: design investment technology services");
    expect(staged.description_raw).not.toContain("<p>");

    const dispositions = await database.query<{ disposition: string; source_external_id: string }>(
      `SELECT disposition, source_external_id FROM source_candidate_dispositions
       WHERE workspace_id = $1 AND source_plugin_key = 'workday' ORDER BY source_external_id`,
      [getContext().workspaceId],
    );
    expect(dispositions.rows).toEqual([
      { disposition: "FILTERED", source_external_id: `workday:${TENANT}:${SITE}/job/Singapore/Branch-Teller_R200` },
      { disposition: "STAGED", source_external_id: `workday:${TENANT}:${SITE}/job/Singapore/Platform-Engineer_R100` },
    ]);

    const normalized = await runNormalization(database, { context: getContext(), observationIds: [staged.id] });
    expect(normalized.totalErrors).toBe(0);

    // A second run of the same postings stages nothing new.
    stubTenant();
    const replay = await runPage(broker, plugin, revisionId);
    expect(replay).toMatchObject({ success: true, newlyStaged: 0 });
    await broker.endRun("COMPLETED");
  });

  it("records a blocked tenant as a failed source plan run without advancing the checkpoint", async () => {
    const database = getClient();
    const plugin = SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", "workday.yml"), "utf8")));
    const broker = new SourceBroker(database, getContext());
    const runId = await broker.startRun("WORKDAY_BLOCKED_INTEGRATION");
    const revisionId = await broker.ensureSourcePluginRevision(plugin);
    const checkpointBefore = await database.query<{ checkpoint: unknown }>(
      `SELECT checkpoint FROM source_checkpoints WHERE workspace_id = $1 AND checkpoint_key LIKE '%:ats:${TENANT}'`,
      [getContext().workspaceId],
    );
    expect(checkpointBefore.rows).toHaveLength(1);

    stubTenant(429);
    const summary = await runPage(broker, plugin, revisionId);

    expect(summary.success).toBe(false);
    expect(summary.error).toContain("rate limited");
    const planRuns = await database.query<{ status: string }>(
      `SELECT status FROM source_plan_runs WHERE workspace_id = $1 AND source_run_id = $2::uuid`,
      [getContext().workspaceId, runId],
    );
    expect(planRuns.rows.map((row) => row.status)).toEqual(["FAILED"]);
    const checkpointAfter = await database.query<{ checkpoint: unknown }>(
      `SELECT checkpoint FROM source_checkpoints WHERE workspace_id = $1 AND checkpoint_key LIKE '%:ats:${TENANT}'`,
      [getContext().workspaceId],
    );
    expect(checkpointAfter.rows).toEqual(checkpointBefore.rows);
    await broker.endRun("FAILED");
  });
});
