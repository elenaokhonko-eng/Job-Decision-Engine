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
import { saveWorkspacePreferenceRevision } from "../../policy/workspacePreferenceRegistry.js";
import { STAGE3_SCHEMA_VERSION } from "../../policy/stage3Contracts.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { processSourcePage } from "../../../scripts/run_adapters.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the hard-gate on-site exception integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration database is not initialized.");
  return client;
}

function ctx(): WorkspaceContext {
  if (!context) throw new Error("The integration workspace is not initialized.");
  return context;
}

// Synthetic fixtures only. "Northwind Markets" is an invented employer standing in
// for a user-listed on-site exception employer.
// The description is long enough (over 1,000 characters) to count as COMPLETE.
const DESCRIPTION = [
  "Full-time role. Design and operate production machine learning platform services and LLM infrastructure.",
  "Build reliable data engineering pipelines and distributed systems for AI systems in Python.",
  "Responsibilities: implement model training and evaluation workflows, maintain feature stores, and improve inference latency for retrieval-augmented generation services.",
  "Write well-tested Python and TypeScript code, review pull requests, and document service interfaces and data contracts.",
  "Operate PostgreSQL and object storage for training data, monitor data quality, and automate data lineage checks.",
  "Deploy containerised services with Docker and Kubernetes, and keep continuous integration pipelines fast and reliable.",
  "Requirements: five or more years of professional software engineering experience with production machine learning systems.",
  "Strong knowledge of SQL, distributed data processing, and evaluation methods for large language models.",
  "Experience building observability for model performance and reliability is valued.",
  "Qualifications: a degree in computer science, mathematics, or a related field, or equivalent practical experience.",
].join(" ");

function item(id: string, title: string, companyName: string) {
  return {
    guid: id,
    id,
    title,
    companyName,
    description: DESCRIPTION,
    workplaceType: "ONSITE",
    employmentType: "Full Time",
    location: "Singapore",
    applicationLink: `https://himalayas.app/companies/synthetic/jobs/${id}`,
  };
}

function manifest(file: string): SourcePlugin {
  return SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", file), "utf8")));
}

describe.skipIf(skipReal)("hard-gate on-site exceptions (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `onsite_exc_${randomUUID().replaceAll("-", "")}`;
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

  it("applies research and stage3-preference on-site exceptions with persisted evidence", async () => {
    await db().query("BEGIN");
    await saveWorkspacePreferenceRevision(db(), ctx(), {
      preferenceDomain: "stage3",
      schemaVersion: STAGE3_SCHEMA_VERSION,
      preferenceValue: { schema_version: STAGE3_SCHEMA_VERSION, mobility: { onsite_exception_employers: ["Northwind Markets"] } },
      activate: true,
    });
    await db().query("COMMIT");

    const plugin = manifest("himalayas.yml");
    const broker = new SourceBroker(db(), ctx());
    await broker.startRun("ONSITE_EXCEPTION_INTEGRATION");
    await broker.ensureSourcePluginRevision(plugin);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [
      item("syn-onsite-listed", "Senior AI Platform Engineer", "Northwind Markets Singapore"),
      item("syn-onsite-commercial", "Senior AI Platform Engineer", "Synthetic Retail Analytics"),
      item("syn-onsite-university", "Research Engineer (Machine Learning)", "Nanyang Technological University"),
    ] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const summary = await processSourcePage({
      broker,
      plugin,
      adapter: new HimalayasAdapter("https://himalayas.app/jobs/api"),
      checkpointTarget: "feed:himalayas",
      planVersion: `${plans.CORE_AI_DATA.planVersion}:integration`,
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 50,
      plans,
      lanes: loadGlobalLanesConfig().lanes,
      locationScope: loadDiscoveryLocationScope(),
      prescreen: false,
      dedupeFilteredPayload: false,
    });
    await broker.endRun("COMPLETED");
    expect(summary.success).toBe(true);

    await runNormalization(db(), { context: ctx() });
    const gateSummary = await runHardGates(db(), { context: ctx() });
    expect(gateSummary.errors).toBe(0);

    const { rows } = await db().query<{
      company_name: string;
      decision: string;
      rejection_codes: string[];
      evidence_quotes: string[];
      workability_policy_hash: string;
      processing_state: string;
    }>(
      `SELECT c.company_name, g.decision, g.rejection_codes, g.evidence_quotes, g.workability_policy_hash, c.processing_state
       FROM gate_decisions g JOIN canonical_jobs c ON c.id = g.canonical_job_id AND c.workspace_id = g.workspace_id
       WHERE g.workspace_id = $1
       ORDER BY c.company_name`,
      [ctx().workspaceId],
    );
    const byCompany = Object.fromEntries(rows.map((row) => [row.company_name, row]));
    expect(Object.keys(byCompany).sort()).toEqual([
      "Nanyang Technological University",
      "Northwind Markets Singapore",
      "Synthetic Retail Analytics",
    ]);

    const listed = byCompany["Northwind Markets Singapore"]!;
    expect(listed.decision).toBe("PASS");
    expect(listed.processing_state).toBe("PREQUALIFIED");
    expect(listed.evidence_quotes.join(" ")).toMatch(/ON-SITE EXCEPTION \(PREFERRED_EMPLOYER\)/);

    const university = byCompany["Nanyang Technological University"]!;
    expect(university.decision).toBe("PASS");
    expect(university.evidence_quotes.join(" ")).toMatch(/ON-SITE EXCEPTION \(RESEARCH_ROLE\)/);

    const commercial = byCompany["Synthetic Retail Analytics"]!;
    expect(commercial.decision).toBe("HARD_REJECT");
    expect(commercial.processing_state).toBe("HARD_REJECTED");
    expect(commercial.rejection_codes).toEqual(expect.arrayContaining(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"]));

    // One policy, including the stage3 exception list, gated every job in the run.
    expect(new Set(rows.map((row) => row.workability_policy_hash)).size).toBe(1);
    expect(rows[0]!.workability_policy_hash).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it("carries the exception through decision and readiness with the gate's policy hash", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const summary = await runRecommendationDecider(db(), { context: ctx() });
    expect(summary.errors).toBe(0);

    const { rows } = await db().query<{
      company_name: string;
      gate_hash: string;
      readiness_json: any;
    }>(
      `SELECT c.company_name,
              (SELECT g.workability_policy_hash FROM gate_decisions g
                WHERE g.workspace_id = c.workspace_id AND g.canonical_job_id = c.id
                ORDER BY g.created_at DESC, g.id DESC LIMIT 1) AS gate_hash,
              d.readiness_json
       FROM canonical_jobs c
       JOIN LATERAL (
         SELECT dd.readiness_json FROM deterministic_decisions dd
         WHERE dd.workspace_id = c.workspace_id AND dd.canonical_job_id = c.id
         ORDER BY dd.created_at DESC, dd.id DESC LIMIT 1
       ) d ON TRUE
       WHERE c.workspace_id = $1`,
      [ctx().workspaceId],
    );
    const readinessOf = (company: string) => {
      const row = rows.find((candidate) => candidate.company_name === company);
      expect(row, company).toBeDefined();
      const readiness = typeof row!.readiness_json === "string" ? JSON.parse(row!.readiness_json) : row!.readiness_json;
      const workMode = (readiness.checks as any[]).find((check) => check.key === "WORK_MODE");
      return { row: row!, readiness, workMode };
    };

    for (const [company, kind] of [
      ["Northwind Markets Singapore", "PREFERRED_EMPLOYER"],
      ["Nanyang Technological University", "RESEARCH_ROLE"],
    ] as const) {
      const { row, readiness, workMode } = readinessOf(company);
      expect(workMode.status, `${company} WORK_MODE`).toBe("MET");
      expect(workMode.evidence_keys).toContain(`onsite_exception:${kind}`);
      // Readiness cites the same effective policy hash that the gate stored.
      expect(workMode.policy_reference).toBe(`workability_policy:${row.gate_hash}`);
      expect(readiness.status, `${company} readiness`).not.toBe("BLOCKED");
    }

    const commercial = readinessOf("Synthetic Retail Analytics");
    expect(commercial.workMode.status).toBe("BLOCKED");
    expect(commercial.workMode.reason_code).toBe("WORK_MODE_INCOMPATIBLE");
  }, 120_000);
});
