import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { load } from "js-yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { SourcePluginSchema } from "../../contracts/sourcePlugin.js";
import { HackerNewsWhoIsHiringAdapter } from "../../ingestion/adapters/hackerNewsWhoIsHiringAdapter.js";
import { loadSixLaneSourcePlanConfig } from "../../ingestion/discoveryPlanConfig.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { SourceBroker } from "../../ingestion/sourceBroker.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { resolveWorkspaceWorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { processSourcePage } from "../../../scripts/run_adapters.js";
import {
  HN_FIXTURE_BASE,
  HN_FIXTURE_COMMENTS,
  HN_FIXTURE_COMMENT_IDS,
  HN_FIXTURE_NOW,
  HN_FIXTURE_THREAD_ID,
  hnFetchStub,
  hnFixtureItems,
} from "../fixtures/hackerNewsWhoIsHiring.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run Hacker News source integration tests against its PostgreSQL service.");
}

const LANES = ["CORE_AI_DATA", "LEGAL_REGTECH", "HEALTH_BIO_PHARMA", "INVESTMENT_MARKETS_FINTECH"];

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The Hacker News integration test database is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The Hacker News integration test workspace is not initialized.");
  return context;
}

function manifest() {
  return SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", "hacker_news.yml"), "utf8")));
}

async function runPage(broker: SourceBroker, planVersion: string, items = hnFixtureItems()) {
  vi.stubGlobal("fetch", vi.fn(hnFetchStub(items).fetchImpl));
  const workability = await resolveWorkspaceWorkabilityPolicy(getClient(), { context: getContext() });
  return processSourcePage({
    broker,
    plugin: manifest(),
    adapter: new HackerNewsWhoIsHiringAdapter(HN_FIXTURE_BASE, {
      workabilityPolicy: workability.policy,
      now: () => HN_FIXTURE_NOW,
      retryDelayMs: 0,
    }),
    checkpointTarget: "feed:hacker_news",
    planVersion,
    laneKeys: LANES,
    employerLaneKeys: [],
    targetCompanyId: null,
    itemsPerRun: 200,
    plans: new DiscoveryScoutPlanner().generateSearchPlans(),
    lanes: loadGlobalLanesConfig().lanes,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(skipReal)("Hacker News who-is-hiring source (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `hacker_news_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("stages comments by HN id with raw payload and hash, records every skip, and is idempotent until a comment is edited", async () => {
    const database = getClient();
    const workspaceId = getContext().workspaceId;
    const broker = new SourceBroker(database, getContext());
    await broker.startRun("HACKER_NEWS_INTEGRATION");
    const revisionId = await broker.ensureSourcePluginRevision(manifest());
    const planVersion = `${loadSixLaneSourcePlanConfig().plan_version}:${revisionId}`;

    const first = await runPage(broker, planVersion);

    expect(first.success).toBe(true);
    expect(first.discovered).toBe(HN_FIXTURE_COMMENT_IDS.length);
    const observations = await database.query<{
      source_name: string;
      source_plugin_key: string;
      source_external_id: string;
      source_url: string;
      raw_payload: unknown;
      raw_payload_hash: string;
      processing_status: string;
    }>(
      `SELECT source_name, source_plugin_key, source_external_id, source_url, raw_payload, raw_payload_hash, processing_status
       FROM raw_job_observations WHERE workspace_id = $1 AND source_plugin_key = 'hacker_news' ORDER BY source_external_id`,
      [workspaceId],
    );
    expect(observations.rows.length).toBeGreaterThan(0);
    expect(first.newlyStaged).toBe(observations.rows.length);
    for (const row of observations.rows) {
      expect(row.source_name).toBe("HACKER_NEWS");
      expect(row.source_url).toBe(`https://news.ycombinator.com/item?id=${row.source_external_id}`);
      // The hash is over the provider item exactly as fetched, minus its volatile reply list.
      const { kids: _replies, ...item } = HN_FIXTURE_COMMENTS[Number(row.source_external_id)] ?? {};
      const expectedPayload = { hn_item: item, thread: { id: HN_FIXTURE_THREAD_ID, title: "Ask HN: Who is hiring? (November 2026)" } };
      expect(row.raw_payload_hash).toBe(createHash("sha256").update(JSON.stringify(expectedPayload)).digest("hex"));
      expect(row.raw_payload).toMatchObject({ hn_item: { id: Number(row.source_external_id) }, thread: { id: HN_FIXTURE_THREAD_ID } });
    }
    expect(observations.rows.map((row) => row.source_external_id)).toContain("4800101");

    const dispositions = await database.query<{ source_external_id: string; lane_key: string; disposition: string; reason_code: string | null; raw_payload_hash: string }>(
      `SELECT source_external_id, lane_key, disposition, reason_code, raw_payload_hash
       FROM source_candidate_dispositions WHERE workspace_id = $1 AND source_plugin_key = 'hacker_news'`,
      [workspaceId],
    );
    // Every fetched comment has one durable disposition per lane: nothing disappears.
    expect(dispositions.rows).toHaveLength(HN_FIXTURE_COMMENT_IDS.length * LANES.length);
    const reasons = new Map(dispositions.rows.filter((row) => row.disposition === "FILTERED").map((row) => [row.source_external_id, row.reason_code]));
    expect(Object.fromEntries([...reasons].filter(([id]) => ["4800105", "4800106", "4800107", "4800108", "4800109"].includes(id)))).toEqual({
      "4800105": "HN_NON_CONFORMING_POST",
      "4800106": "HN_COMMENT_DELETED",
      "4800107": "HN_COMMENT_DEAD",
      "4800108": "PREFILTER_ONSITE_ONLY",
      "4800109": "PREFILTER_WORK_TERRITORY_INCOMPATIBLE",
    });
    const stagedIds = new Set(dispositions.rows.filter((row) => row.disposition === "STAGED").map((row) => row.source_external_id));
    expect([...stagedIds].sort()).toEqual(observations.rows.map((row) => row.source_external_id));

    const checkpoint = await broker.loadSourceCheckpoint("hacker_news", `discovery:${planVersion}:feed:hacker_news`);
    expect(checkpoint?.cursor).toBe(`hn:${HN_FIXTURE_THREAD_ID}:4800111`);

    // Re-reading the unchanged thread (fresh plan version, so no cursor) stages nothing new.
    const replay = await runPage(broker, `${planVersion}:replay`);
    expect(replay).toMatchObject({ success: true, newlyStaged: 0 });

    // An edited comment is a new payload hash for the same HN comment id.
    const edited = hnFixtureItems();
    edited["item/4800101"] = {
      ...HN_FIXTURE_COMMENTS[4_800_101],
      text: "Quillfeather Labs | Staff ML Engineer, Data Platform Engineer | Singapore or REMOTE<p>Edited: we build a machine learning and data engineering platform with MLOps and LLM tooling for distributed systems teams.",
    };
    const afterEdit = await runPage(broker, `${planVersion}:edited`, edited);
    expect(afterEdit).toMatchObject({ success: true, newlyStaged: 1 });
    const versions = await database.query<{ title: string; raw_payload_hash: string }>(
      `SELECT title, raw_payload_hash FROM raw_job_observations
       WHERE workspace_id = $1 AND source_plugin_key = 'hacker_news' AND source_external_id = '4800101' ORDER BY retrieved_at, title`,
      [workspaceId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(new Set(versions.rows.map((row) => row.raw_payload_hash)).size).toBe(2);
    expect(versions.rows.map((row) => row.title)).toContain("Staff ML Engineer, Data Platform Engineer");
    await broker.endRun("COMPLETED");
  });

  it("records a failed plan run and keeps the cursor when the HN API fails", async () => {
    const database = getClient();
    const broker = new SourceBroker(database, getContext());
    await broker.startRun("HACKER_NEWS_FAILURE_INTEGRATION");
    const revisionId = await broker.ensureSourcePluginRevision(manifest());
    const planVersion = `${loadSixLaneSourcePlanConfig().plan_version}:${revisionId}:failure`;
    const failing = hnFetchStub(hnFixtureItems(), { respond: (requestPath) => requestPath === "item/4800103" ? new Response("", { status: 503 }) : undefined });
    vi.stubGlobal("fetch", vi.fn(failing.fetchImpl));

    const summary = await processSourcePage({
      broker,
      plugin: manifest(),
      adapter: new HackerNewsWhoIsHiringAdapter(HN_FIXTURE_BASE, { now: () => HN_FIXTURE_NOW, retryDelayMs: 0 }),
      checkpointTarget: "feed:hacker_news",
      planVersion,
      laneKeys: LANES,
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 200,
      plans: new DiscoveryScoutPlanner().generateSearchPlans(),
      lanes: loadGlobalLanesConfig().lanes,
    });

    expect(summary.success).toBe(false);
    expect(summary.error).toContain("HTTP 503");
    expect(await broker.loadSourceCheckpoint("hacker_news", `discovery:${planVersion}:feed:hacker_news`)).toBeNull();
    const planRuns = await database.query<{ status: string }>(
      `SELECT status FROM source_plan_runs WHERE workspace_id = $1 AND plan_version = $2`,
      [getContext().workspaceId, planVersion],
    );
    expect(planRuns.rows.map((row) => row.status)).toEqual(LANES.map(() => "FAILED"));
    await broker.endRun("FAILED");
  });
});
