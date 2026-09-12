/**
 * REAL E2E pipeline test — Sprint B
 *
 * Runs pipeline functions against a real isolated PostgreSQL instance (CI).
 * Seeds 9 fixture email alerts + raw observations, then runs stages and checks
 * conservation / no-loss invariants.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Skip if running locally without the CI DB
const DB_URL = process.env.DATABASE_URL || "";
const isCI = isLocalPostgresConnectionString(DB_URL);
const skipReal = !DB_URL || !isCI;

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let workspaceContext: WorkspaceContext | undefined;
let agent: typeof import("../../services/agent.js") | undefined;

const originalEnv = {
  REQUIREMENTS_ENABLE_QUOTED: process.env.REQUIREMENTS_ENABLE_QUOTED,
  EMBEDDING_PRIMARY_DIMENSIONS: process.env.EMBEDDING_PRIMARY_DIMENSIONS,
  EMBEDDING_FALLBACK_DIMENSIONS: process.env.EMBEDDING_FALLBACK_DIMENSIONS,
  EMBEDDING_PRIMARY_PROVIDER: process.env.EMBEDDING_PRIMARY_PROVIDER,
};

async function q(sql: string, params?: any[]): Promise<pg.QueryResult> {
  return getClient().query(sql, params);
}

async function countWhere(table: string, condition: string): Promise<number> {
  const res = await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${condition}`);
  return res.rows[0].n;
}

const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/anonymized_nine_emails.json");
const fixtureEmails: any[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function applyDeterministicTestEnv(): void {
  process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
  process.env.EMBEDDING_PRIMARY_PROVIDER = "gemini";
  process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
  process.env.EMBEDDING_FALLBACK_DIMENSIONS = "4";
}

function getContext(): WorkspaceContext {
  if (!workspaceContext) {
    throw new Error("Workspace context was not initialized.");
  }
  return workspaceContext;
}

function getClient(): pg.PoolClient {
  if (!client) {
    throw new Error("Test database client was not initialized.");
  }
  return client;
}

async function seedFixtureProfile(context: WorkspaceContext): Promise<void> {
  const profile = await q(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
     VALUES ($1, 'nine_email_e2e_profile', 'Nine Email E2E Candidate')
     ON CONFLICT (workspace_id, profile_key)
     DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW()
     RETURNING id`,
    [context.workspaceId]
  );
  const profileId = profile.rows[0].id;

  const version = await q(
    `INSERT INTO profile_versions (
       workspace_id, candidate_profile_id, version_number, schema_version,
       source_hash, status, effective_at
     )
     VALUES ($1, $2, 1, '2.2.0', 'nine-email-e2e-profile-v1', 'ACTIVE', NOW())
     ON CONFLICT (candidate_profile_id, version_number)
     DO UPDATE SET source_hash = EXCLUDED.source_hash,
                   status = 'ACTIVE',
                   effective_at = NOW()
     RETURNING id`,
    [context.workspaceId, profileId]
  );
  const profileVersionId = version.rows[0].id;

  const engagement = await q(
    `INSERT INTO profile_engagements (
       workspace_id, profile_version_id, engagement_key, organization_legal_name,
       role_title, engagement_type, experience_class, operating_model,
       start_date, is_current, summary, verification_status
     )
     VALUES (
       $1, $2, 'fixture-platform-work', 'Fixture Systems Lab',
       'Principal AI and Data Systems Architect', 'EMPLOYEE',
       'PROFESSIONAL_PRODUCTION', 'REMOTE', DATE '2018-01-01', TRUE,
       'Built production AI, data, legaltech, bioinformatics, and market-data platforms.',
       'VERIFIED'
     )
     ON CONFLICT (profile_version_id, engagement_key)
     DO UPDATE SET summary = EXCLUDED.summary,
                   verification_status = EXCLUDED.verification_status
     RETURNING id`,
    [context.workspaceId, profileVersionId]
  );
  const engagementId = engagement.rows[0].id;

  const facts = [
    {
      key: "ai_data_platforms",
      type: "PROJECT",
      statement:
        "Built production AI systems, LLM applications, machine learning pipelines, PyTorch services, MLOps infrastructure, SQL ETL, dashboards, and data warehouse platforms.",
      structured: { domains: ["AI", "LLM", "DATA_ENGINEERING", "DATA_PLATFORM"] },
    },
    {
      key: "legal_regtech",
      type: "PROJECT",
      statement:
        "Delivered Legal AI, LegalTech, RegTech compliance automation, contract analytics, and document intelligence platforms.",
      structured: { domains: ["LEGAL_AI", "LEGALTECH", "REGTECH", "COMPLIANCE_AUTOMATION"] },
    },
    {
      key: "bioinformatics_ai",
      type: "PROJECT",
      statement:
        "Built bioinformatics AI and genomics pipelines for biotech, pharmaceutical, drug discovery, and clinical data science workflows.",
      structured: { domains: ["BIOINFORMATICS", "GENOMICS", "BIOTECH", "PHARMA"] },
    },
    {
      key: "investment_markets",
      type: "PROJECT",
      statement:
        "Designed quantitative research systems, low-latency market data feeds, high-frequency execution infrastructure, algorithmic trading platforms, and capital markets analytics.",
      structured: { domains: ["QUANTITATIVE_RESEARCH", "MARKET_DATA", "TRADING_INFRASTRUCTURE", "CAPITAL_MARKETS"] },
    },
  ];

  for (const fact of facts) {
    await q(
      `INSERT INTO profile_facts (
         workspace_id, profile_version_id, engagement_id, fact_key, fact_type,
         statement, structured_value, evidence_tier, verification_status,
         start_date, is_current, confidentiality
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         'PROFESSIONAL_PRODUCTION', 'VERIFIED', DATE '2018-01-01', TRUE,
         'PRIVATE_REUSABLE'
       )
       ON CONFLICT (profile_version_id, fact_key)
       DO UPDATE SET statement = EXCLUDED.statement,
                     structured_value = EXCLUDED.structured_value,
                     evidence_tier = EXCLUDED.evidence_tier,
                     verification_status = EXCLUDED.verification_status,
                     confidentiality = EXCLUDED.confidentiality`,
      [
        context.workspaceId,
        profileVersionId,
        engagementId,
        fact.key,
        fact.type,
        fact.statement,
        JSON.stringify(fact.structured),
      ]
    );
  }

}

describe.skipIf(skipReal)("P0-02 & P0-10: Real PostgreSQL Pipeline E2E", () => {
  beforeAll(async () => {
    applyDeterministicTestEnv();

    pool = new pg.Pool(pgConnectionConfig(DB_URL));
    client = await pool.connect();
    schemaName = `nine_emails_e2e_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    await q(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await q(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    workspaceContext = await resolveWorkspaceContext(client);
    await seedFixtureProfile(workspaceContext);

    const fixtureCompanies = [
      "Global Cloud Tech",
      "Apex Legal Solutions",
      "BioGen Genomics",
      "Quantum Capital Markets",
      "Melbourne Financial",
      "Matrix Corp",
      "Stealth AI Labs",
      "CloudScale Data",
    ];
    await q("DELETE FROM canonical_jobs WHERE company_name = ANY($1)", [fixtureCompanies]);
    await q("DELETE FROM raw_job_observations WHERE source_name = 'gmail'");
    await q("DELETE FROM raw_email_alerts WHERE gmail_message_id LIKE 'fixture-email-%'");

    // Mock embeddings for deterministic offline CI runs
    agent = await import("../../services/agent.js");
    applyDeterministicTestEnv();
    const embedMock = async (text: string) => {
      const t = text.toLowerCase();
      if (t.includes("legal") || t.includes("regtech") || t.includes("compliance") || t.includes("law firm")) {
        return [0, 1, 0, 0];
      }
      if (t.includes("bioinformatics") || t.includes("genomic") || t.includes("biotech") || t.includes("pharma")) {
        return [0, 0, 1, 0];
      }
      if (
        t.includes("quantitative") ||
        t.includes("trading") ||
        t.includes("market data") ||
        t.includes("capital markets") ||
        t.includes("fintech")
      ) {
        return [0, 0, 0, 1];
      }
      if (
        t.includes("ai systems engineer") ||
        t.includes("pytorch") ||
        t.includes("core ai") ||
        t.includes("deep learning") ||
        t.includes("llm") ||
        t.includes("data pipeline") ||
        t.includes("cloudscale")
      ) {
        return [1, 0, 0, 0];
      }
      return [0.1, 0.1, 0.1, 0.1];
    };

    vi.spyOn(agent, "generateEmbedding").mockImplementation(embedMock);
    vi.spyOn(agent, "generateEmbeddingWithProvider").mockImplementation(embedMock as any);
    vi.spyOn(agent, "generateEmbeddingWithProviderAndModel").mockImplementation(embedMock as any);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    restoreEnv();
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) {
        await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      }
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  });

  it("Stage 0 — should insert 9 fixture emails into raw_email_alerts and observations", async () => {
    for (const email of fixtureEmails) {
      await q(
        `INSERT INTO raw_email_alerts (subject, body, gmail_message_id, processed)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT DO NOTHING`,
        [email.subject, email.raw_html || email.subject, email.id]
      );

      const contentHash = crypto.createHash("sha256").update(email.raw_html || email.subject).digest("hex");
      const company = email.subject.split(" at ")[1] || "Unknown Corp";
      const title =
        email.subject
          .replace("Job Alert: ", "")
          .replace("REPOST - ", "")
          .split(" at ")[0] || "Unknown Title";

      await q(
        `INSERT INTO raw_job_observations (
           source_name, source_external_id, source_url, company_name, title,
           description_raw, location_raw, workplace_type_raw, raw_payload_hash, processing_status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')`,
        [
          "gmail",
          email.id,
          `https://example.com/jobs/${email.id}`,
          company,
          title,
          email.raw_html || email.subject,
          email.id === "fixture-email-005" ? "Melbourne, Australia" : "Singapore",
          email.id === "fixture-email-005" ? "ON_SITE" : "REMOTE",
          contentHash,
        ]
      );
    }

    const alertCount = await countWhere("raw_email_alerts", "TRUE");
    const obsCount = await countWhere("raw_job_observations", "TRUE");
    expect(alertCount).toBe(9);
    expect(obsCount).toBe(9);
  });

  it("Stage 1 — normalizer creates canonical jobs and versions without losing observations", async () => {
    const { runNormalization } = await import("../../pipeline/normalize.js");
    await runNormalization(getClient(), { context: getContext() });

    const observationCount = await countWhere("raw_job_observations", "TRUE");
    const canonicalCount = await countWhere("canonical_jobs", "processing_status = 'RAW_STAGED'");
    const versionCount = await countWhere("job_versions", "TRUE");

    expect(observationCount).toBeGreaterThanOrEqual(9);
    expect(canonicalCount).toBe(8); // 1 repost maps to existing canonical job
    expect(versionCount).toBe(9);
  });

  it("Stage 2 — hard gates produce 2 HARD_REJECTED, 1 NEEDS_VERIFICATION, 5 PREQUALIFIED", async () => {
    const { runHardGates } = await import("../../pipeline/hardGate.js");
    const result = await runHardGates(getClient(), { context: getContext() });

    expect(result.hardRejected).toBe(2);
    expect(result.needsVerification).toBe(1);
    expect(result.passed).toBe(5);

    const gated = await countWhere(
      "canonical_jobs",
      "processing_status IN ('HARD_REJECTED', 'NEEDS_VERIFICATION', 'PREQUALIFIED')"
    );
    expect(gated).toBe(8);

    const gateRows = await countWhere("gate_decisions", "TRUE");
    expect(gateRows).toBe(8);
  });

  it("Stage 2.5 - deterministic requirements and published embeddings exist for eligible and recoverable jobs", async () => {
    const { runRequirementsExtraction } = await import("../../pipeline/requirementsExtractor.js");
    const { runEmbeddingBatchWithFallback } = await import("../../embeddings/batchCoordinator.js");
    const { loadWorkspaceLanesConfig } = await import("../../pipeline/laneConfigLoader.js");

    applyDeterministicTestEnv();
    const requirements = await runRequirementsExtraction(getClient(), { context: getContext() });
    await loadWorkspaceLanesConfig(getClient(), { context: getContext(), seedIfEmpty: true });
    const embeddings = await runEmbeddingBatchWithFallback(200, getClient(), { context: getContext() });

    // Requirement extraction also repairs late-state records so that a job
    // which advanced before this stage completed can be recovered. The fixture
    // therefore includes the five PREQUALIFIED jobs and the one
    // NEEDS_VERIFICATION job, while HARD_REJECTED jobs remain excluded.
    const requirementTargetCount = await countWhere(
      "canonical_jobs",
      `COALESCE(processing_state, processing_status) IN (
         'RAW_STAGED', 'PREQUALIFIED', 'NEEDS_VERIFICATION', 'LANE_ROUTED',
         'ROUTING_DEFERRED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING',
         'AI_EVALUATED', 'EVALUATED'
       )`
    );

    expect(requirements.errors).toBe(0);
    expect(requirements.processed).toBe(requirementTargetCount);
    expect(requirements.deterministicInserted).toBeGreaterThan(0);
    expect(embeddings.inputBuild.fromRequirements).toBeGreaterThan(0);
    expect(embeddings.inputBuild.fromProfileFacts).toBeGreaterThan(0);
    expect(embeddings.inputBuild.fromJobVersions).toBeGreaterThan(0);
    expect(embeddings.inputBuild.fromLanePrototypes).toBeGreaterThan(0);
    expect(embeddings.primary.failed).toBe(0);
    expect(embeddings.primary.succeeded).toBeGreaterThan(0);
  });

  it("Stage 3 — lane router assigns primary_lane + secondary_lanes to all PREQUALIFIED jobs", async () => {
    const { runLaneRouter } = await import("../../pipeline/laneRouter.js");
    await runLaneRouter(getClient(), { context: getContext() });

    const routed = await q(
      `SELECT primary_lane, secondary_lanes, routing_disposition,
              processing_state, processing_status
         FROM canonical_jobs
        WHERE primary_lane IS NOT NULL
          AND processing_status IN ('LANE_ROUTED', 'PREQUALIFIED')`
    );
    expect(routed.rows).toHaveLength(5);
    for (const row of routed.rows) {
      expect(row.primary_lane).not.toBe("UNCLASSIFIED");
      expect(row.routing_disposition).toBe("ROUTED");
      expect(row.processing_state).toBe("LANE_ROUTED");
      expect(row.processing_status).toBe("LANE_ROUTED");
      expect(row.secondary_lanes).toBeDefined();
    }

    // Regression guard for the real PostgreSQL parameter-type failure: a
    // successful route must persist both JSONB lane fields and lifecycle
    // disposition for every prequalified fixture job.
    const laneDecisions = await q(
      `SELECT COUNT(*)::int AS count
         FROM lane_decisions
        WHERE decision_json->>'primary_lane' <> 'UNCLASSIFIED'`
    );
    expect(Number(laneDecisions.rows[0].count)).toBe(5);
  });

  it("Stage 4 — deterministic decisions exist and eligible jobs are enqueueable (no DEFERRED_BUDGET)", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const { runExplanationQueueEnqueuer } = await import("../../pipeline/explanationQueueEnqueuer.js");

    const { runDeterministicMatcher } = await import("../../pipeline/deterministicMatcher.js");

    const matching = await runDeterministicMatcher(getClient(), { context: getContext() });
    const decisions = await runRecommendationDecider(getClient(), { context: getContext() });
    await runExplanationQueueEnqueuer(getClient(), { context: getContext() });

    const queued = await countWhere("evaluation_queue", "status = 'PENDING'");
    const deferred = await countWhere(
      "canonical_jobs",
      "processing_status = 'DEFERRED_BUDGET' OR processing_state = 'DEFERRED_BUDGET'"
    );
    const missingDecisions = await countWhere(
      "canonical_jobs",
      "processing_status != 'MANUALLY_REMOVED' AND recommendation_outcome IS NULL"
    );

    expect(matching.errors).toBe(0);
    expect(matching.matchedJobs).toBe(5);
    expect(decisions.errors).toBe(0);
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(deferred).toBe(0);
    expect(missingDecisions).toBe(0);
  });

  it("Conservation — no observation lost", async () => {
    const nIn = await countWhere("raw_job_observations", "TRUE");
    const totalJobs = await countWhere("canonical_jobs", "TRUE");

    expect(totalJobs).toBeGreaterThan(0);
    expect(nIn).toBe(9);
  });

  it("Integrity — every observation maps to a canonical job version", async () => {
    const unmapped = await countWhere("raw_job_observations", "job_version_id IS NULL");
    expect(unmapped).toBe(0);
  });
});
