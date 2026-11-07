import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { load } from "js-yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { SourcePluginSchema, type SourcePlugin } from "../../contracts/index.js";
import { WorkableAdapter } from "../../ingestion/adapters/workableAdapter.js";
import { SmartRecruitersAdapter } from "../../ingestion/adapters/smartRecruitersAdapter.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { SourceBroker } from "../../ingestion/sourceBroker.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { processSourcePage } from "../../../scripts/run_adapters.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run Workable/SmartRecruiters integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The ATS integration test database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The ATS integration test workspace is not initialized.");
  return context;
}

function manifest(file: string): SourcePlugin {
  return SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", file), "utf8")));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Synthetic fixtures only.
const DESCRIPTION_HTML = [
  "<p>About the role: design and operate production data platform services and machine learning infrastructure.</p>",
  "<ul><li>Own distributed systems architecture reviews</li><li>Build reliable data engineering pipelines</li></ul>",
  "<p>Qualifications: professional platform engineering experience delivering production systems.</p>",
].join("");

const LANES = ["CORE_AI_DATA"];
const plans = new DiscoveryScoutPlanner().generateSearchPlans({ CORE_AI_DATA: ["Example Company"] });
const lanes = loadGlobalLanesConfig().lanes;

describe.skipIf(skipReal)("Workable and SmartRecruiters discovery staging (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `ats_workable_sr_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("stages Workable postings as WORKABLE observations with raw payload, hash and open ATS availability", async () => {
    const database = getClient();
    const plugin = manifest("workable.yml");
    const broker = new SourceBroker(database, getContext());
    await broker.startRun("WORKABLE_INTEGRATION");
    await broker.ensureSourcePluginRevision(plugin);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      name: "Example Company",
      jobs: [
        {
          shortcode: "SYNWK0001",
          title: "Synthetic Platform Architect",
          employment_type: "Full-time",
          telecommuting: true,
          url: "https://apply.workable.com/j/SYNWK0001",
          application_url: "https://apply.workable.com/j/SYNWK0001/apply",
          published_on: "2026-10-01",
          locations: [{ country: "Singapore", city: "Singapore", hidden: false }],
          description: DESCRIPTION_HTML,
        },
        {
          shortcode: "SYNWK0002",
          title: "Synthetic Office Coordinator",
          employment_type: "Full-time",
          telecommuting: false,
          url: "https://apply.workable.com/j/SYNWK0002",
          locations: [{ country: "Singapore", city: "Singapore", hidden: false }],
          description: "<p>Coordinate office supplies and visitor schedules.</p>",
        },
      ],
    })));

    const pageOptions = {
      broker,
      plugin,
      adapter: new WorkableAdapter("example-company"),
      checkpointTarget: "ats:example_workable",
      planVersion: `${plans.CORE_AI_DATA.planVersion}:integration`,
      laneKeys: LANES,
      employerLaneKeys: LANES,
      targetCompanyId: "example_workable",
      itemsPerRun: 50,
      plans,
      lanes,
    };
    const summary = await processSourcePage(pageOptions);
    expect(summary).toMatchObject({ success: true, discovered: 2, newlyStaged: 1, filtered: 1, quarantined: 0, nextCursor: null });

    const observations = await database.query<{
      source_name: string; source_plugin_key: string; source_external_id: string; source_url: string;
      canonical_apply_url: string; workplace_type_raw: string; description_raw: string; raw_payload_hash: string;
      raw_shortcode: string; availability_status: string | null;
    }>(
      `SELECT source_name, source_plugin_key, source_external_id, source_url, canonical_apply_url, workplace_type_raw,
              description_raw, raw_payload_hash, raw_payload->>'shortcode' AS raw_shortcode,
              normalized_evidence#>>'{availability,status}' AS availability_status
       FROM raw_job_observations WHERE workspace_id = $1 AND source_plugin_key = 'workable'`,
      [getContext().workspaceId],
    );
    expect(observations.rows).toHaveLength(1);
    const row = observations.rows[0];
    expect(row).toMatchObject({
      source_name: "WORKABLE",
      source_external_id: "SYNWK0001",
      source_url: "https://apply.workable.com/j/SYNWK0001",
      canonical_apply_url: "https://apply.workable.com/j/SYNWK0001/apply",
      workplace_type_raw: "REMOTE",
      raw_shortcode: "SYNWK0001",
      availability_status: "OPEN",
    });
    expect(row.raw_payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.description_raw).not.toContain("<");

    const dispositions = await database.query<{ source_external_id: string; disposition: string }>(
      `SELECT source_external_id, disposition FROM source_candidate_dispositions
       WHERE workspace_id = $1 AND source_plugin_key = 'workable' ORDER BY source_external_id`,
      [getContext().workspaceId],
    );
    expect(dispositions.rows).toEqual([
      { source_external_id: "SYNWK0001", disposition: "STAGED" },
      { source_external_id: "SYNWK0002", disposition: "FILTERED" },
    ]);

    // A second identical run stages nothing new.
    pageOptions.adapter = new WorkableAdapter("example-company");
    const replay = await processSourcePage(pageOptions);
    expect(replay).toMatchObject({ success: true, newlyStaged: 0 });
    await broker.endRun("COMPLETED");
  });

  it("stages SmartRecruiters postings and leaves the checkpoint in place when a detail request fails", async () => {
    const database = getClient();
    const plugin = manifest("smartrecruiters.yml");
    const broker = new SourceBroker(database, getContext());
    await broker.startRun("SMARTRECRUITERS_INTEGRATION");
    await broker.ensureSourcePluginRevision(plugin);
    const ids = ["900000000001", "900000000002", "900000000003"];
    let failDetail: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      const detail = url.pathname.match(/\/postings\/([^/]+)$/);
      if (detail) {
        const id = detail[1];
        if (id === failDetail) return new Response("", { status: 503, statusText: "Service Unavailable" });
        return jsonResponse({
          id,
          name: `Synthetic Data Platform Architect ${id}`,
          company: { identifier: "ExampleCo", name: "Example Company" },
          location: { city: "Singapore", country: "sg", remote: false, hybrid: true, fullLocation: "Singapore, , Singapore" },
          typeOfEmployment: { label: "Full-time" },
          releasedDate: "2026-10-02T00:00:00.000Z",
          postingUrl: `https://jobs.smartrecruiters.com/ExampleCo/${id}-synthetic`,
          applyUrl: `https://jobs.smartrecruiters.com/ExampleCo/${id}-synthetic?oga=true`,
          jobAd: { sections: { jobDescription: { title: "Job Description", text: DESCRIPTION_HTML } } },
        });
      }
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return jsonResponse({
        offset, limit, totalFound: ids.length,
        content: ids.slice(offset, offset + limit).map((id) => ({ id, name: `Synthetic Data Platform Architect ${id}` })),
      });
    }));
    const pageOptions = {
      broker,
      plugin,
      adapter: new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 }),
      checkpointTarget: "ats:example_sr",
      planVersion: `${plans.CORE_AI_DATA.planVersion}:integration`,
      laneKeys: LANES,
      employerLaneKeys: LANES,
      targetCompanyId: "example_sr",
      itemsPerRun: 2,
      plans,
      lanes,
    };

    const first = await processSourcePage(pageOptions);
    expect(first).toMatchObject({ success: true, discovered: 2, newlyStaged: 2, nextCursor: "offset:2" });

    failDetail = ids[2];
    pageOptions.adapter = new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 });
    const failed = await processSourcePage(pageOptions);
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("HTTP 503");
    expect(failed.nextCursor).toBe("offset:2");

    const checkpoint = await broker.loadSourceCheckpoint("smartrecruiters", `discovery:${pageOptions.planVersion}:ats:example_sr`);
    expect(checkpoint?.cursor).toBe("offset:2");
    const planRuns = await database.query<{ status: string }>(
      `SELECT runs.status FROM source_plan_runs runs JOIN source_plugins plugins ON plugins.id = runs.source_plugin_id
       WHERE runs.workspace_id = $1 AND plugins.source_key = 'smartrecruiters' ORDER BY runs.status`,
      [getContext().workspaceId],
    );
    // Plan runs are keyed per source run and plan, so the failed page leaves the plan run FAILED.
    expect(planRuns.rows.map((run) => run.status)).toEqual(["FAILED"]);

    failDetail = null;
    pageOptions.adapter = new SmartRecruitersAdapter("ExampleCo", { detailDelayMs: 0 });
    const resumed = await processSourcePage(pageOptions);
    expect(resumed).toMatchObject({ success: true, discovered: 1, newlyStaged: 1, nextCursor: null });

    const observations = await database.query<{ source_name: string; source_external_id: string; workplace_type_raw: string; raw_has_job_ad: boolean }>(
      `SELECT source_name, source_external_id, workplace_type_raw, raw_payload ? 'jobAd' AS raw_has_job_ad
       FROM raw_job_observations WHERE workspace_id = $1 AND source_plugin_key = 'smartrecruiters'
       ORDER BY source_external_id`,
      [getContext().workspaceId],
    );
    expect(observations.rows).toEqual(ids.map((id) => ({
      source_name: "SMARTRECRUITERS", source_external_id: id, workplace_type_raw: "HYBRID", raw_has_job_ad: true,
    })));
    const nonStaged = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM source_candidate_dispositions
       WHERE workspace_id = $1 AND source_plugin_key = 'smartrecruiters' AND disposition <> 'STAGED'`,
      [getContext().workspaceId],
    );
    expect(nonStaged.rows[0]?.count).toBe(0);
    await broker.endRun("COMPLETED");
  });
});
