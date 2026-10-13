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

type GateStatus = "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";
type FixtureLane =
  | "CORE_AI_DATA"
  | "LEGAL_REGTECH"
  | "HEALTH_BIO_PHARMA"
  | "INVESTMENT_MARKETS_FINTECH"
  | "UNCLASSIFIED";
type FixtureAction = "PRIORITY_APPLY" | "APPLY_AFTER_VERIFICATION" | "HARD_REJECT";
type RecommendationOutcome = "PRIORITY" | "REVIEW" | "TRACK" | "SKIP";
type LifecycleStatus = "QUEUED_FOR_AI" | "DEFERRED_BUDGET" | "HARD_REJECTED";

interface NineEmailFixture {
  readonly id: string;
  readonly subject: string;
  readonly raw_html?: string;
  readonly location_raw: string;
  readonly workplace_type_raw: string;
  readonly employment_type_raw: string;
  readonly expected_lane: FixtureLane;
  readonly expected_gate: GateStatus;
  readonly expected_rejection_codes?: readonly string[];
  readonly expected_action: FixtureAction;
  readonly expected_recommendation_outcome: RecommendationOutcome;
  readonly expected_status: LifecycleStatus;
  readonly expected_duplicate_canonical_id?: string;
  readonly expected_version: number;
}

interface PipelineFixtureRow {
  readonly fixture_id: string;
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly gate_decision: GateStatus;
  readonly processing_state: LifecycleStatus;
  readonly processing_status: LifecycleStatus;
  readonly primary_lane: FixtureLane | null;
  readonly recommendation_outcome: RecommendationOutcome;
  readonly recommendation_eligibility: "ELIGIBLE" | "VERIFY" | "INELIGIBLE" | null;
  readonly version_count: number;
}

const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/anonymized_nine_emails.json");
// The fixture is the deterministic external-data boundary for this E2E test.
const fixtureEmails = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as NineEmailFixture[];
const actionToOutcome: Readonly<Record<FixtureAction, RecommendationOutcome>> = {
  PRIORITY_APPLY: "PRIORITY",
  APPLY_AFTER_VERIFICATION: "REVIEW",
  HARD_REJECT: "SKIP",
};

const expectedEligibleLaneBudgets: Readonly<Record<Exclude<FixtureLane, "UNCLASSIFIED">, number>> = {
  CORE_AI_DATA: 3,
  LEGAL_REGTECH: 3,
  HEALTH_BIO_PHARMA: 3,
  INVESTMENT_MARKETS_FINTECH: 3,
};

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
      key: "ai_systems_domain",
      type: "DOMAIN",
      statement:
        "AI systems technical domain expertise across distributed LLM training and inference.",
      structured: { domains: ["AI_SYSTEMS"] },
    },
    {
      key: "ai_data_platforms",
      type: "PROJECT",
      statement:
        "Built production AI systems, distributed LLM training and inference pipelines, machine learning pipelines, Python and PyTorch services, C++ systems, MLOps infrastructure, SQL ETL, dashboards, and data warehouse platforms.",
      structured: { domains: ["AI_SYSTEMS", "AI", "LLM", "DATA_ENGINEERING", "DATA_PLATFORM"] },
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
        t.includes("junior data pipeline") ||
        t.includes("data_pipeline_associate")
      ) {
        return [0.6, 0.3, 0.3, 0.3];
      }
      if (
        t.includes("ai systems engineer") ||
        t.includes("ai scientist") ||
        t.includes("systems architect") ||
        t.includes("pytorch") ||
        t.includes("core ai") ||
        t.includes("deep learning") ||
        t.includes("llm") ||
        t.includes("data pipeline") ||
        t.includes("cloudscale") ||
        t.includes('"domain_key":"ai_systems"')
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
           description_raw, location_raw, workplace_type_raw, employment_type_raw,
           raw_payload_hash, processing_status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING')`,
        [
          "gmail",
          email.id,
          `https://example.com/jobs/${email.id}`,
          company,
          title,
          email.raw_html || email.subject,
          email.location_raw,
          email.workplace_type_raw,
          email.employment_type_raw,
          contentHash,
        ]
      );
    }

    const alertCount = await countWhere("raw_email_alerts", "gmail_message_id LIKE 'fixture-email-%'");
    const obsCount = await countWhere(
      "raw_job_observations",
      "source_name = 'gmail' AND source_external_id LIKE 'fixture-email-%'"
    );
    expect(alertCount).toBe(9);
    expect(obsCount).toBe(9);
  });

  it("Stage 1 — normalizer creates canonical jobs and versions without losing observations", async () => {
    const { runNormalization } = await import("../../pipeline/normalize.js");
    await runNormalization(getClient(), { context: getContext() });

    const observationCount = await countWhere(
      "raw_job_observations",
      "source_name = 'gmail' AND source_external_id LIKE 'fixture-email-%'"
    );
    const canonicalCount = await countWhere("canonical_jobs", "processing_status = 'RAW_STAGED'");
    const versionCount = await countWhere("job_versions", "TRUE");
    const conservation = await q(
      `SELECT COUNT(*)::int AS observation_count,
              COUNT(rjo.job_version_id)::int AS linked_observation_count,
              COUNT(jv.id)::int AS resolved_version_count,
              COUNT(DISTINCT jv.canonical_job_id)::int AS canonical_count
         FROM raw_job_observations rjo
         LEFT JOIN job_versions jv ON jv.id = rjo.job_version_id
        WHERE rjo.source_name = 'gmail'
          AND rjo.source_external_id LIKE 'fixture-email-%'`
    );

    expect(observationCount).toBe(9);
    expect(canonicalCount).toBe(8); // 1 repost maps to existing canonical job
    expect(versionCount).toBe(9);
    expect(Number(conservation.rows[0].observation_count)).toBe(9);
    expect(Number(conservation.rows[0].linked_observation_count)).toBe(9);
    expect(Number(conservation.rows[0].resolved_version_count)).toBe(9);
    expect(Number(conservation.rows[0].canonical_count)).toBe(8);
  });

  it("Stage 2 — hard gates produce 3 HARD_REJECTED, 0 NEEDS_VERIFICATION, 5 PREQUALIFIED", async () => {
    const { runHardGates } = await import("../../pipeline/hardGate.js");
    const result = await runHardGates(getClient(), { context: getContext() });

    expect(result.hardRejected).toBe(3);
    expect(result.needsVerification).toBe(0);
    expect(result.passed).toBe(5);

    const gated = await countWhere(
      "canonical_jobs",
      "processing_status IN ('HARD_REJECTED', 'NEEDS_VERIFICATION', 'PREQUALIFIED')"
    );
    expect(gated).toBe(8);

    const gateRows = await countWhere("gate_decisions", "TRUE");
    expect(gateRows).toBe(8);
    const gateRowsWithoutRunIdentity = await countWhere(
      "gate_decisions",
      "pipeline_run_id IS NULL"
    );
    expect(gateRowsWithoutRunIdentity).toBe(0);
  });

  it("Stage 2.5 - deterministic requirements and published embeddings exist for eligible and recoverable jobs", async () => {
    const { runRequirementsExtraction } = await import("../../pipeline/requirementsExtractor.js");
    const { runEmbeddingBatchWithFallback } = await import("../../embeddings/batchCoordinator.js");
    const { loadLanesConfig, loadWorkspaceLanesConfig } = await import("../../pipeline/laneConfigLoader.js");

    applyDeterministicTestEnv();
    const requirements = await runRequirementsExtraction(getClient(), { context: getContext() });
    await loadWorkspaceLanesConfig(getClient(), { context: getContext(), seedIfEmpty: true });

    const configuredLanes = loadLanesConfig().lanes;
    const expectedFixtureLanes = [...new Set(
      fixtureEmails
        .filter((fixture) => fixture.expected_gate === "PASS")
        .map((fixture) => fixture.expected_lane)
    )].sort();
    expect(expectedFixtureLanes).toEqual(Object.keys(expectedEligibleLaneBudgets).sort());
    for (const [lane, budget] of Object.entries(expectedEligibleLaneBudgets)) {
      expect(configuredLanes[lane]?.maximum_ai_interpretations_per_run, lane).toBe(budget);
    }

    const embeddings = await runEmbeddingBatchWithFallback(200, getClient(), { context: getContext() });

    // The fixture includes five PREQUALIFIED jobs; all three unknown or
    // unworkable workplace cases are HARD_REJECTED before this stage.
    const requirementTargetCount = await countWhere(
      "canonical_jobs",
      `COALESCE(processing_state, processing_status) IN (
         'RAW_STAGED', 'PREQUALIFIED', 'NEEDS_VERIFICATION', 'LANE_ROUTED',
         'ROUTING_DEFERRED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING',
         'AI_EVALUATED', 'EVALUATED'
       )`
    );

    expect(requirementTargetCount).toBe(5);
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
    const rejectedWithLane = await countWhere(
      "canonical_jobs",
      "processing_status = 'HARD_REJECTED' AND primary_lane IS NOT NULL"
    );
    expect(Number(laneDecisions.rows[0].count)).toBe(5);
    expect(rejectedWithLane).toBe(0);
  });

  it("Stage 4 — deterministic decisions persist and budget overflow is deferred durably", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const { runExplanationQueueEnqueuer } = await import("../../pipeline/explanationQueueEnqueuer.js");

    const { runDeterministicMatcher } = await import("../../pipeline/deterministicMatcher.js");

    const matching = await runDeterministicMatcher(getClient(), { context: getContext() });
    const decisions = await runRecommendationDecider(getClient(), { context: getContext() });
    const budgetRunId = crypto.randomUUID();
    const queueSummary = await runExplanationQueueEnqueuer(getClient(), {
      context: getContext(),
      limit: 4,
      budgetRunId,
    });

    const budgetUsage = await q(
      `SELECT lane, budget_limit, selected_count
         FROM ai_evaluation_budget_usage
        WHERE workspace_id = $1 AND budget_run_id = $2
        ORDER BY lane`,
      [getContext().workspaceId, budgetRunId]
    );
    const usageByLane = new Map(
      budgetUsage.rows.map((row) => [row.lane as string, row] as const)
    );
    for (const [lane, budget] of Object.entries(expectedEligibleLaneBudgets)) {
      const usage = usageByLane.get(lane);
      expect(usage, `Missing persisted budget for ${lane}`).toBeDefined();
      expect(usage?.budget_limit, lane).toBe(budget);
    }

    const persistedQueue = await q(
      `SELECT eq.canonical_job_id::text AS canonical_job_id,
              eq.job_version_id::text AS job_version_id,
              eq.lane,
              eq.status,
              c.processing_state,
              c.processing_status
         FROM evaluation_queue eq
         JOIN canonical_jobs c ON c.id = eq.canonical_job_id
        WHERE eq.workspace_id = $1 AND eq.budget_run_id = $2
        ORDER BY eq.lane, eq.canonical_job_id`,
      [getContext().workspaceId, budgetRunId]
    );
    const missingDecisions = await countWhere(
      "canonical_jobs",
      "processing_status != 'MANUALLY_REMOVED' AND recommendation_outcome IS NULL"
    );
    const deferral = await q(
      `SELECT rjo.source_external_id AS fixture_id,
              c.normalized_title,
              c.processing_state,
              c.processing_status,
              d.lane,
              d.budget_limit,
              d.reason_code,
              d.evidence
         FROM evaluation_budget_deferrals d
         JOIN canonical_jobs c ON c.id = d.canonical_job_id
         JOIN raw_job_observations rjo ON rjo.job_version_id = d.job_version_id
        WHERE d.workspace_id = $1 AND d.budget_run_id = $2`,
      [getContext().workspaceId, budgetRunId]
    );
    expect(matching.errors).toBe(0);
    expect(matching.matchedJobs).toBe(5);
    expect(decisions.errors).toBe(0);
    expect(queueSummary.enqueued).toBe(4);
    expect(queueSummary.updated).toBe(4);
    expect(queueSummary.deferred).toBe(1);
    expect(persistedQueue.rows).toHaveLength(4);
    expect(new Set(persistedQueue.rows.map((row) => row.canonical_job_id)).size).toBe(4);
    expect(new Set(persistedQueue.rows.map((row) => row.lane))).toEqual(
      new Set(Object.keys(expectedEligibleLaneBudgets))
    );
    for (const row of persistedQueue.rows) {
      expect(row.status).toBe("PENDING");
      expect(row.processing_state).toBe("QUEUED_FOR_AI");
      expect(row.processing_status).toBe("QUEUED_FOR_AI");
    }
    for (const lane of Object.keys(expectedEligibleLaneBudgets)) {
      expect(usageByLane.get(lane)?.selected_count, lane).toBe(1);
    }
    expect(deferral.rows).toHaveLength(1);
    expect(deferral.rows[0].fixture_id).toBe("fixture-email-008");
    expect(deferral.rows[0].normalized_title).toBe("fourth junior data engineer");
    expect(deferral.rows[0].processing_state).toBe("DEFERRED_BUDGET");
    expect(deferral.rows[0].processing_status).toBe("DEFERRED_BUDGET");
    expect(deferral.rows[0].lane).toBe("CORE_AI_DATA");
    expect(deferral.rows[0].budget_limit).toBe(expectedEligibleLaneBudgets.CORE_AI_DATA);
    expect(deferral.rows[0].reason_code).toBe("AI_BUDGET_EXHAUSTED");
    expect(deferral.rows[0].evidence.budget_configured).toBe(true);
    expect(missingDecisions).toBe(0);

    const fixtureRowsResult = await q(
      `SELECT rjo.source_external_id AS fixture_id,
              c.id::text AS canonical_job_id,
              jv.id::text AS job_version_id,
              c.gate_decision,
              c.processing_state,
              c.processing_status,
              c.primary_lane,
              c.recommendation_outcome,
              c.recommendation_eligibility,
              c.deterministic_match_score,
              c.deterministic_match_coverage,
              c.recommendation_evidence_completeness,
              COUNT(*) OVER (PARTITION BY c.id)::int AS version_count
         FROM raw_job_observations rjo
         JOIN job_versions jv ON jv.id = rjo.job_version_id
         JOIN canonical_jobs c ON c.id = jv.canonical_job_id
        WHERE rjo.source_name = 'gmail'
          AND rjo.source_external_id LIKE 'fixture-email-%'
        ORDER BY rjo.source_external_id`
    );
    // PostgreSQL rows are checked against the typed fixture contract below.
    const fixtureRows = fixtureRowsResult.rows as PipelineFixtureRow[];
    const rowsByFixture = new Map(fixtureRows.map((row) => [row.fixture_id, row]));
    const expectedFixtureIds = fixtureEmails.map((fixture) => fixture.id).sort();
    const observedFixtureIds = fixtureRows.map((row) => row.fixture_id).sort();

    expect(fixtureRows).toHaveLength(9);
    expect(observedFixtureIds).toEqual(expectedFixtureIds);
    expect(new Set(fixtureRows.map((row) => row.job_version_id)).size).toBe(9);
    expect(new Set(fixtureRows.map((row) => row.canonical_job_id)).size).toBe(8);

    for (const fixture of fixtureEmails) {
      const row = rowsByFixture.get(fixture.id);
      expect(row, `Missing pipeline row for ${fixture.id}`).toBeDefined();
      if (!row) {
        throw new Error(`Missing pipeline row for ${fixture.id}`);
      }

      expect(actionToOutcome[fixture.expected_action]).toBe(fixture.expected_recommendation_outcome);
      expect(row.gate_decision).toBe(fixture.expected_gate);
      expect(row.recommendation_outcome, fixture.id).toBe(fixture.expected_recommendation_outcome);
      expect(row.primary_lane ?? "UNCLASSIFIED").toBe(fixture.expected_lane);
      expect(row.processing_state).toBe(fixture.expected_status);
      expect(row.processing_status).toBe(fixture.expected_status);
      expect(row.recommendation_eligibility).toBe(
        fixture.expected_gate === "HARD_REJECT" ? "INELIGIBLE" : "ELIGIBLE"
      );
      expect(row.version_count).toBe(fixture.expected_version);

      if (fixture.expected_duplicate_canonical_id) {
        const original = rowsByFixture.get(fixture.expected_duplicate_canonical_id);
        expect(original, `Missing original fixture for ${fixture.id}`).toBeDefined();
        if (!original) {
          throw new Error(`Missing original fixture for ${fixture.id}`);
        }
        expect(row.canonical_job_id).toBe(original.canonical_job_id);
      }
    }
  });

  it("Conservation — no observation, canonical job, or version disappears", async () => {
    const conservation = await q(
      `SELECT COUNT(*)::int AS observation_count,
              COUNT(DISTINCT rjo.job_version_id)::int AS observed_version_count,
              COUNT(DISTINCT jv.canonical_job_id)::int AS canonical_count
         FROM raw_job_observations rjo
         JOIN job_versions jv ON jv.id = rjo.job_version_id
        WHERE rjo.source_name = 'gmail'
          AND rjo.source_external_id LIKE 'fixture-email-%'`
    );
    const versionCount = await countWhere("job_versions", "TRUE");

    expect(Number(conservation.rows[0].observation_count)).toBe(9);
    expect(Number(conservation.rows[0].observed_version_count)).toBe(9);
    expect(Number(conservation.rows[0].canonical_count)).toBe(8);
    expect(versionCount).toBe(9);
  });

  it("Integrity — every fixture observation maps to a live canonical job version", async () => {
    const unmapped = await countWhere(
      "raw_job_observations",
      "source_name = 'gmail' AND source_external_id LIKE 'fixture-email-%' AND job_version_id IS NULL"
    );
    const orphaned = await q(
      `SELECT COUNT(*)::int AS count
         FROM raw_job_observations rjo
         LEFT JOIN job_versions jv ON jv.id = rjo.job_version_id
        WHERE rjo.source_name = 'gmail'
          AND rjo.source_external_id LIKE 'fixture-email-%'
          AND jv.id IS NULL`
    );

    expect(unmapped).toBe(0);
    expect(Number(orphaned.rows[0].count)).toBe(0);
  });
});
