import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { load } from "js-yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { SourcePluginSchema, type SourcePlugin } from "../../contracts/index.js";
import { HimalayasAdapter } from "../../ingestion/adapters/himalayasAdapter.js";
import { loadDiscoveryLocationScope } from "../../ingestion/discoveryLocationScope.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { SourceBroker } from "../../ingestion/sourceBroker.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { BOARD_YIELD_SQL, summarizeBoardYield, type BoardYieldRow } from "../../reporting/boardYield.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { processSourcePage } from "../../../scripts/run_adapters.js";
import { releaseFilteredDispositionPayloads } from "../../../scripts/release_filtered_disposition_payloads.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the discovery pre-screen integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The pre-screen integration database is not initialized.");
  return client;
}

function ctx(): WorkspaceContext {
  if (!context) throw new Error("The pre-screen integration workspace is not initialized.");
  return context;
}

function manifest(file: string): SourcePlugin {
  return SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", file), "utf8")));
}

// Synthetic fixtures only.
const DESCRIPTION = [
  "Design and operate production machine learning platform services and LLM infrastructure.",
  "Build reliable data engineering pipelines and distributed systems for AI systems.",
  "Qualifications: professional platform engineering experience delivering production systems.",
].join(" ");

function himalayasItem(id: string, title: string, extra: Record<string, unknown>) {
  return {
    guid: id,
    id,
    title,
    companyName: "Example Company",
    description: DESCRIPTION,
    workplaceType: "REMOTE",
    employmentType: "Full Time",
    applicationLink: `https://himalayas.app/companies/example/jobs/${id}`,
    ...extra,
  };
}

const LANES = ["CORE_AI_DATA", "LEGAL_REGTECH"];
const plans = new DiscoveryScoutPlanner().generateSearchPlans();
const lanes = loadGlobalLanesConfig().lanes;

describe.skipIf(skipReal)("discovery pre-screen and FILTERED payload sharing (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `prescreen_${randomUUID().replaceAll("-", "")}`;
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

  async function runPage(items: unknown[], options: { prescreen: boolean; dedupe: boolean; target: string }) {
    const plugin = manifest("himalayas.yml");
    const broker = new SourceBroker(db(), ctx());
    await broker.startRun("PRESCREEN_INTEGRATION");
    await broker.ensureSourcePluginRevision(plugin);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: items }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })));
    const summary = await processSourcePage({
      broker,
      plugin,
      adapter: new HimalayasAdapter("https://himalayas.app/jobs/api"),
      checkpointTarget: options.target,
      planVersion: `${plans.CORE_AI_DATA.planVersion}:integration`,
      laneKeys: LANES,
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 50,
      plans,
      lanes,
      locationScope: loadDiscoveryLocationScope(),
      prescreen: options.prescreen,
      dedupeFilteredPayload: options.dedupe,
    });
    await broker.endRun("COMPLETED");
    return summary;
  }

  it("skips deny-listed titles and explicit out-of-territory fields and stores each FILTERED payload once", async () => {
    const summary = await runPage([
      himalayasItem("syn-intern-1", "Synthetic Machine Learning Intern", { locationRestrictions: [] }),
      himalayasItem("syn-us-1", "Synthetic Data Engineer", { locationRestrictions: ["United States"] }),
      himalayasItem("syn-sg-1", "Synthetic Data Engineer", { locationRestrictions: ["Singapore"] }),
    ], { prescreen: true, dedupe: true, target: "feed:himalayas" });

    expect(summary).toMatchObject({
      success: true,
      discovered: 3,
      newlyStaged: 1,
      skippedByReason: { PRESCREEN_TITLE_DENY: 1, GEO_FIELD_OUT_OF_SCOPE: 1 },
    });

    const observations = await db().query<{ source_external_id: string }>(
      `SELECT source_external_id FROM raw_job_observations WHERE workspace_id = $1 AND source_plugin_key = 'himalayas'`,
      [ctx().workspaceId],
    );
    expect(observations.rows.map((row) => row.source_external_id)).toEqual(["syn-sg-1"]);

    const rows = await db().query<{
      id: string; source_external_id: string; lane_key: string; disposition: string; reason_code: string;
      reason_detail: string; has_payload: boolean; raw_payload_disposition_id: string | null; raw_payload_hash: string;
      posting_title: string | null; posting_location: string | null;
    }>(
      `SELECT id, source_external_id, lane_key, disposition, reason_code, reason_detail,
              raw_payload IS NOT NULL AS has_payload, raw_payload_disposition_id, raw_payload_hash,
              posting_title, posting_location
       FROM source_candidate_dispositions
       WHERE workspace_id = $1 AND source_plugin_key = 'himalayas' AND plan_key LIKE 'feed:himalayas:%'
       ORDER BY source_external_id, created_at, id`,
      [ctx().workspaceId],
    );
    const byPosting = (id: string) => rows.rows.filter((row) => row.source_external_id === id);

    const intern = byPosting("syn-intern-1");
    expect(intern).toHaveLength(2);
    expect(intern.every((row) => row.disposition === "FILTERED" && row.reason_code === "PRESCREEN_TITLE_DENY")).toBe(true);
    expect(intern[0].reason_detail).toContain('"intern"');
    // First lane row holds the payload; the second points at it and keeps hash, title and location.
    expect(intern[0]).toMatchObject({ has_payload: true, raw_payload_disposition_id: null });
    expect(intern[1]).toMatchObject({
      has_payload: false,
      raw_payload_disposition_id: intern[0].id,
      raw_payload_hash: intern[0].raw_payload_hash,
      posting_title: "Synthetic Machine Learning Intern",
    });

    const usOnly = byPosting("syn-us-1");
    expect(usOnly.map((row) => row.reason_code)).toEqual(["GEO_FIELD_OUT_OF_SCOPE", "GEO_FIELD_OUT_OF_SCOPE"]);
    expect(usOnly[0].reason_detail).toContain("United States");
    expect(usOnly.filter((row) => row.has_payload)).toHaveLength(1);

    // The staged posting: its STAGED row keeps its payload, the FILTERED lane row holds its own once.
    const staged = byPosting("syn-sg-1");
    expect(staged.find((row) => row.disposition === "STAGED")).toMatchObject({ has_payload: true, raw_payload_disposition_id: null });
    expect(staged.filter((row) => row.disposition === "FILTERED").every((row) => row.has_payload)).toBe(true);
  });

  it("keeps today's behaviour with both flags off", async () => {
    const summary = await runPage([
      himalayasItem("syn-intern-2", "Synthetic Machine Learning Intern", { locationRestrictions: [] }),
      himalayasItem("syn-us-2", "Synthetic Platform Engineer", { locationRestrictions: ["United States"] }),
    ], { prescreen: false, dedupe: false, target: "feed:himalayas_off" });
    // Location "Unknown" and the remote flag keep both; the intern title is not screened.
    expect(summary).toMatchObject({ success: true, newlyStaged: 2, skippedByReason: {} });
    const rows = await db().query<{ shared: number; without_payload: number }>(
      `SELECT COUNT(*) FILTER (WHERE raw_payload_disposition_id IS NOT NULL)::int AS shared,
              COUNT(*) FILTER (WHERE raw_payload IS NULL)::int AS without_payload
       FROM source_candidate_dispositions WHERE workspace_id = $1 AND plan_key LIKE 'feed:himalayas_off:%'`,
      [ctx().workspaceId],
    );
    expect(rows.rows[0]).toEqual({ shared: 0, without_payload: 0 });
  });

  it("forbids a missing payload on non-FILTERED rows and on rows that neither share nor were released", async () => {
    const sample = await db().query<{ source_run_id: string }>(
      `SELECT source_run_id FROM source_candidate_dispositions WHERE workspace_id = $1 LIMIT 1`,
      [ctx().workspaceId],
    );
    const insert = (disposition: string) => db().query(
      `INSERT INTO source_candidate_dispositions (
         workspace_id, source_run_id, source_plugin_key, plan_key, raw_payload_hash, raw_payload, disposition
       ) VALUES ($1, $2, 'himalayas', 'feed:himalayas:CORE_AI_DATA', $3, NULL, $4)`,
      [ctx().workspaceId, sample.rows[0].source_run_id, "a".repeat(64), disposition],
    );
    await db().query("BEGIN");
    await db().query("SAVEPOINT constraint_check");
    await expect(insert("STAGED")).rejects.toThrow(/source_candidate_dispositions_payload_presence_chk/);
    await db().query("ROLLBACK TO SAVEPOINT constraint_check");
    await expect(insert("FILTERED")).rejects.toThrow(/source_candidate_dispositions_payload_presence_chk/);
    await db().query("ROLLBACK TO SAVEPOINT constraint_check");
    await db().query("ROLLBACK");
  });

  it("releases only FILTERED payloads older than the retention window, and only with --apply", async () => {
    await db().query(
      `UPDATE source_candidate_dispositions SET fetched_at = NOW() - INTERVAL '40 days'
       WHERE workspace_id = $1 AND source_external_id IN ('syn-intern-1', 'syn-sg-1')`,
      [ctx().workspaceId],
    );
    const dryRun = await releaseFilteredDispositionPayloads(db(), { apply: false, olderThanDays: 30, batchSize: 1 });
    // syn-intern-1: one holder row with payload; syn-sg-1: one FILTERED lane row. STAGED is never eligible.
    expect(dryRun).toMatchObject({ mode: "DRY_RUN", eligible_rows: 2, released_rows: 0 });
    expect(dryRun.eligible_payload_bytes).toBeGreaterThan(0);
    const unchanged = await db().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM source_candidate_dispositions WHERE workspace_id = $1 AND raw_payload_released_at IS NOT NULL`,
      [ctx().workspaceId],
    );
    expect(unchanged.rows[0].count).toBe(0);

    const applied = await releaseFilteredDispositionPayloads(db(), { apply: true, olderThanDays: 30, batchSize: 1 });
    expect(applied).toMatchObject({ mode: "APPLY", eligible_rows: 2, released_rows: 2 });
    const after = await db().query<{ source_external_id: string; disposition: string; has_payload: boolean; released: boolean; raw_payload_hash: string }>(
      `SELECT source_external_id, disposition, raw_payload IS NOT NULL AS has_payload,
              raw_payload_released_at IS NOT NULL AS released, raw_payload_hash
       FROM source_candidate_dispositions
       WHERE workspace_id = $1 AND source_external_id IN ('syn-intern-1', 'syn-sg-1')
       ORDER BY source_external_id, disposition`,
      [ctx().workspaceId],
    );
    expect(after.rows.every((row) => /^[a-f0-9]{64}$/.test(row.raw_payload_hash))).toBe(true);
    expect(after.rows.filter((row) => row.disposition === "STAGED")).toEqual([
      expect.objectContaining({ has_payload: true, released: false }),
    ]);
    expect(after.rows.filter((row) => row.disposition === "FILTERED").every((row) => !row.has_payload)).toBe(true);
    // Observations keep their payloads.
    const observation = await db().query<{ has_payload: boolean }>(
      `SELECT raw_payload IS NOT NULL AS has_payload FROM raw_job_observations WHERE workspace_id = $1 AND source_external_id = 'syn-sg-1'`,
      [ctx().workspaceId],
    );
    expect(observation.rows).toEqual([{ has_payload: true }]);
  });

  it("reports board yield per source and board from the canonical tables", async () => {
    await runNormalization(db(), { context: ctx() });
    await runHardGates(db(), { context: ctx() });
    const { rows } = await db().query<BoardYieldRow>(BOARD_YIELD_SQL, [ctx().workspaceId, 7]);
    const summary = summarizeBoardYield(rows);
    const himalayas = summary.boards.filter((row) => row.source === "HIMALAYAS");
    expect(himalayas.map((row) => row.board).sort()).toEqual(["feed:himalayas", "feed:himalayas_off"]);
    expect(himalayas.reduce((total, row) => total + row.staged, 0)).toBe(3);
    for (const row of himalayas) {
      expect(row.hard_rejected + row.passed_gates).toBeLessThanOrEqual(row.staged);
      expect(row).toMatchObject({ evaluated: 0, priority_review: 0, zero_pass_flag: false });
    }
  });
});
