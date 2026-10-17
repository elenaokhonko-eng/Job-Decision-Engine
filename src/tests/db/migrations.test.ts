/**
 * P0-03 — Additive Migration Chain & Canonical Schema Integrity
 *
 * Two tiers:
 *  TIER 1 — Mock-based (always run): verify idempotency logic and
 *    transaction wrapping without a live DB.
 *  TIER 2 — Real PostgreSQL (CI only): apply all migrations against
 *    the actual postgres:15 CI container and assert table/column
 *    existence, including the 004 backoff+gmail_uid additions.
 */
import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";

// ── CI detection ──────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL || "";
const isCI = isLocalPostgresConnectionString(DB_URL);
const skipReal = !DB_URL || !isCI;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");

async function applyMigrationFile(client: pg.PoolClient, file: string): Promise<void> {
  const sqlContent = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8").replace(/^\uFEFF/, "");
  await client.query("BEGIN");
  try {
    await client.query(sqlContent);
    await client.query(
      `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT (version) DO NOTHING`,
      [file]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// ── Tier 1: Mock tests (always run) ──────────────────────────────────────────

describe("P0-03: Additive Migration Chain & Canonical Schema Integrity", () => {
  it("loads local CLI configuration and prefers the direct migration connection", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../db/migrate.ts"), "utf8");

    expect(source).toContain('dotenv.config({ path: ".env.local" });');
    expect(source).toContain("process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL");
    expect(source).toContain("isPooledPostgresConnectionString(migrationDatabaseUrl)");
  });

  it("should track and apply migrations idempotently", async () => {
    const executedQueries: string[] = [];
    const appliedVersions: string[] = [];

    const mockClient: any = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        executedQueries.push(sql);
        if (sql.includes("SELECT version FROM schema_migrations")) {
          return { rows: appliedVersions.map((v) => ({ version: v })) };
        }
        if (sql.includes("INSERT INTO schema_migrations")) {
          appliedVersions.push(params?.[0]);
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    // First run: should apply all unapplied migrations
    const firstRun = await runMigrations(mockClient);
    expect(firstRun.length).toBeGreaterThanOrEqual(3);
    expect(firstRun).toContain("001_legacy_tables.sql");
    expect(firstRun).toContain("002_stage0_discovery.sql");
    expect(firstRun).toContain("003_canonical_schema_hardening.sql");

    // Second run: should apply 0 migrations (idempotent)
    const secondRun = await runMigrations(mockClient);
    expect(secondRun).toHaveLength(0);
  });

  it("should execute migrations inside BEGIN / COMMIT transactions", async () => {
    const txLog: string[] = [];
    const mockClient: any = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          txLog.push(sql);
        }
        if (sql.includes("SELECT version FROM schema_migrations")) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await runMigrations(mockClient);

    expect(txLog).toContain("BEGIN");
    expect(txLog).toContain("COMMIT");
    expect(txLog).not.toContain("ROLLBACK");
  });
});

// ── Tier 2: Real PostgreSQL migration tests (CI only) ─────────────────────────

let realPool: pg.Pool;

describe.skipIf(skipReal)("P0-03: Real PostgreSQL Migration Verification", () => {
  beforeAll(async () => {
    realPool = new pg.Pool(pgConnectionConfig(DB_URL));
    // Apply all migrations to ensure schema is current
    await runMigrations(realPool);
  });

  afterAll(async () => {
    await realPool.end();
  });

  it("all migration files are recorded in schema_migrations", async () => {
    const { rows } = await realPool.query(
      `SELECT version FROM schema_migrations ORDER BY version ASC`
    );
    const versions = rows.map((r: any) => r.version);
    expect(versions).toContain("001_legacy_tables.sql");
    expect(versions).toContain("002_stage0_discovery.sql");
    expect(versions).toContain("003_canonical_schema_hardening.sql");
    expect(versions).toContain("004_queue_backoff_and_gmail_uid.sql");
    expect(versions).toContain("005_streamlit_read_model.sql");
    expect(versions).toContain("006_schema_hardening_v2.sql");
    expect(versions).toContain("007_job_version_integrity.sql");
    expect(versions).toContain("008_job_version_integrity_v2.sql");
    expect(versions).toContain("009_canonical_read_model_and_quarantine.sql");
    expect(versions).toContain("010_read_model_version_strictness_and_quarantine_cleanup.sql");
    expect(versions).toContain("011_source_runs_hardening.sql");
    expect(versions).toContain("012_profile_evidence_foundation.sql");
    expect(versions).toContain("013_job_requirements_and_pipeline_state.sql");
    expect(versions).toContain("014_embedding_spaces_and_batches.sql");
    expect(versions).toContain("014b_embedding_manifest_and_fallback.sql");
    expect(versions).toContain("015_deterministic_matching.sql");
    expect(versions).toContain("016_document_provenance.sql");
    expect(versions).toContain("017_streamlit_read_model_integrity.sql");
    expect(versions).toContain("018_backfill_cutover.sql");
    expect(versions).toContain("044_evaluation_queue_context_identity.sql");
    expect(versions).toContain("049_embedding_input_history.sql");
    expect(versions).toContain("050_ai_evaluation_budget_deferral.sql");
    expect(versions).toContain("054_repair_rejected_read_model_views.sql");
    expect(versions).toContain("055_repair_shortlist_nullable_priority.sql");
    expect(versions).toContain("056_authoritative_user_action_projection.sql");
    expect(versions).toContain("057_pipeline_reliability_fixture_isolation.sql");
    expect(versions).toContain("066_application_command_centre_v5.sql");
    expect(versions).toContain("067_application_profile_coverage_completeness.sql");
    expect(versions).toContain("068_allow_unknown_optional_rank_signals.sql");
    expect(versions).toContain("069_validate_application_document_context.sql");
    expect(versions).toContain("070_verified_culture_observations.sql");
    expect(versions).toContain("071_expose_ranking_lineage.sql");
    expect(versions).toContain("072_expose_top_ten_component_scores.sql");
    expect(versions).toContain("073_preserve_culture_observation_immutability.sql");
    expect(versions).toContain("074_rebalance_optional_ranking_confidence.sql");
  });

  it("V5 creates the ranking, culture, and workspace-scoped application read models", async () => {
    const { rows: tables } = await realPool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name IN (
          'ranking_policies',
          'job_ranking_snapshots',
          'company_culture_observations',
          'workspace_companies',
          'policy_recheck_requests'
        )
      ORDER BY table_name
    `);
    expect(tables.map((row) => row.table_name)).toEqual([
      'company_culture_observations',
      'job_ranking_snapshots',
      'policy_recheck_requests',
      'ranking_policies',
      'workspace_companies',
    ]);

    const { rows: views } = await realPool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN (
          'v_apply_now_jobs_scoped',
          'v_track_jobs_scoped',
          'v_top_ten_ready_jobs_scoped',
          'v_application_workspace_scoped',
          'v_company_culture_analytics_scoped',
          'v_company_culture_evidence_scoped',
          'v_job_profile_evidence_scoped',
          'v_profile_coverage_scoped',
          'v_application_workspace_summary_scoped'
        )
      ORDER BY table_name
    `);
    expect(views.map((row) => row.table_name)).toEqual([
      'v_application_workspace_scoped',
      'v_application_workspace_summary_scoped',
      'v_apply_now_jobs_scoped',
      'v_company_culture_analytics_scoped',
      'v_company_culture_evidence_scoped',
      'v_job_profile_evidence_scoped',
      'v_profile_coverage_scoped',
      'v_top_ten_ready_jobs_scoped',
      'v_track_jobs_scoped',
    ]);
  });

  it("V5 materializes culture evidence and deterministic recheck tasks from validated current evaluations", async () => {
    const { rows } = await realPool.query<{ trigger_name: string }>(`
      SELECT trigger_row.tgname AS trigger_name
      FROM pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = to_regclass('public.ai_evaluations')
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname = 'trg_ai_evaluations_materialize_v5_signals'
    `);
    expect(rows.map((row) => row.trigger_name)).toContain('trg_ai_evaluations_materialize_v5_signals');
  });

  it("culture analytics exclude unverified model-proposed scores", async () => {
    const { rows: triggerRows } = await realPool.query<{ trigger_name: string }>(`
      SELECT trigger_row.tgname AS trigger_name
      FROM pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = to_regclass('public.ai_evaluations')
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname = 'trg_z_ai_evaluations_validated_culture_observation'
    `);
    expect(triggerRows.map((row) => row.trigger_name)).toContain(
      "trg_z_ai_evaluations_validated_culture_observation"
    );
    const { rows: insertGuards } = await realPool.query<{ trigger_name: string }>(`
      SELECT trigger_row.tgname AS trigger_name
      FROM pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = to_regclass('public.company_culture_observations')
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname = 'trg_skip_unverified_culture_observation_insert'
    `);
    expect(insertGuards.map((row) => row.trigger_name)).toContain(
      "trg_skip_unverified_culture_observation_insert"
    );

    const { rows: viewDefinitions } = await realPool.query<{ definition: string | null }>(`
      SELECT pg_get_viewdef(to_regclass('public.v_company_culture_analytics_scoped'), TRUE) AS definition
    `);
    const definition = (viewDefinitions[0]?.definition ?? "").replace(/\s+/g, " ");
    expect(definition).toContain("observation.source_type = 'DETERMINISTIC_QUOTE_RULES_V1'");
  });

  it("policy recheck requests retain current context, evidence, and status", async () => {
    const expectedColumns = [
      'workspace_id',
      'canonical_job_id',
      'job_version_id',
      'profile_version_id',
      'match_run_id',
      'deterministic_decision_id',
      'ai_evaluation_id',
      'ranking_policy_version',
      'context_fingerprint',
      'reason_code',
      'evidence_payload',
      'status',
      'created_at',
    ];
    const { rows } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'policy_recheck_requests'
        AND column_name = ANY($1::text[])
    `, [expectedColumns]);

    expect(rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(expectedColumns));
  });

  it("apply-now exposes policy recheck state and Top-10 excludes pending rechecks", async () => {
    const { rows: recheckColumns } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v_apply_now_jobs_scoped'
        AND column_name = 'policy_recheck_required'
    `);
    expect(recheckColumns).toHaveLength(1);

    const { rows: definitions } = await realPool.query<{ definition: string | null }>(`
      SELECT pg_get_viewdef(to_regclass('public.v_top_ten_ready_jobs_scoped'), TRUE) AS definition
    `);
    expect(definitions).toHaveLength(1);
    const definition = (definitions[0].definition ?? '').replace(/\s+/g, ' ');
    expect(definition).toMatch(/NOT\s*(?:\(\s*)?EXISTS\s*\([\s\S]*policy_recheck_requests[\s\S]*status\s*=\s*'PENDING'/i);
    expect(definition).toContain("recommendation_outcome");
    expect(definition).not.toMatch(/autonomy_score\s+IS\s+NOT\s+NULL/i);
    expect(definition).not.toMatch(/strategic_value_score\s+IS\s+NOT\s+NULL/i);
  });

  it("workspace company identity is unique within a workspace, not globally", async () => {
    const { rows: uniqueIndexes } = await realPool.query<{ columns: string[] }>(`
      SELECT ARRAY_AGG(attribute.attname::TEXT ORDER BY attribute.attname::TEXT) AS columns
      FROM pg_index AS index_row
      CROSS JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY
        AS key_column(attnum, ordinal_position)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = index_row.indrelid
       AND attribute.attnum = key_column.attnum
      WHERE index_row.indrelid = to_regclass('public.workspace_companies')
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indpred IS NULL
        AND key_column.ordinal_position <= index_row.indnkeyatts
      GROUP BY index_row.indexrelid
    `);
    const uniqueColumnSets = uniqueIndexes.map((index) => index.columns);

    expect(uniqueColumnSets).toContainEqual(['normalized_company_name', 'workspace_id']);
    expect(uniqueColumnSets).not.toContainEqual(['normalized_company_name']);
  });

  it("V5 document provenance pins profile, deterministic decision, and context fingerprints", async () => {
    const { rows } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'document_runs'
        AND column_name = ANY($1::text[])
    `, [["profile_version_id", "deterministic_decision_id", "context_fingerprint"]]);
    expect(rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      "profile_version_id",
      "deterministic_decision_id",
      "context_fingerprint",
    ]));

    const { rows: applicationColumns } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v_application_workspace_scoped'
        AND column_name IN ('cv_document_status', 'cover_letter_document_status')
    `);
    expect(applicationColumns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      "cv_document_status",
      "cover_letter_document_status",
    ]));

    const { rows: viewDefinitions } = await realPool.query<{ definition: string | null }>(`
      SELECT pg_get_viewdef(to_regclass('public.v_application_workspace_scoped'), TRUE) AS definition
    `);
    const definition = (viewDefinitions[0]?.definition ?? "").replace(/\s+/g, " ");
    expect(definition).toContain("job_version.active_requirement_set_id IS NOT NULL");
    expect(definition).toContain("current_match.requirement_set_id = job_version.active_requirement_set_id");
    expect(definition).toContain("current_match.job_content_hash = job_version.content_hash");
    expect(definition).toContain("current_shortlist.gate_status = 'PASS'");
    expect(definition).toContain("current_shortlist.recommendation_outcome");
    expect(definition).toContain("current_shortlist.recommendation_eligibility");
    expect(definition).toContain("'PRIORITY'");
    expect(definition).toContain("'REVIEW'");
    expect(definition).toContain("current_match.context_fingerprint = cv_document.context_fingerprint");
    expect(definition).toContain("current_match.context_fingerprint = cover_letter_document.context_fingerprint");
  });

  it("Top 10 read model exposes all persisted ranking lineage identities", async () => {
    const requiredColumns = [
      "profile_version_id",
      "match_run_id",
      "deterministic_decision_id",
      "ai_evaluation_id",
      "requirement_fit_score",
      "requirement_coverage_score",
      "evidence_completeness_score",
      "lane_confidence_score",
      "autonomy_score",
      "politics_risk_score",
      "sensory_workload_risk_score",
      "strategic_value_score",
      "focus_protection_score",
      "building_ratio_score",
      "interaction_burden_score",
    ];
    const { rows } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v_top_ten_ready_jobs_scoped'
        AND column_name = ANY($1::text[])
    `, [requiredColumns]);

    expect(rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(requiredColumns));
  });

  it("active V5 ranking policy permits Top 10 with optional strategic value unknown", async () => {
    const { rows } = await realPool.query<{
      weights: Record<string, number>;
      minimum_ranking_confidence: number;
    }>(`
      SELECT weights, minimum_ranking_confidence::FLOAT8 AS minimum_ranking_confidence
      FROM ranking_policies
      WHERE schema_version = '5.2.0'
      ORDER BY policy_version DESC
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const policy of rows) {
      expect(policy.weights.strategicValue).toBeLessThanOrEqual(5);
      expect(policy.minimum_ranking_confidence).toBe(95);
    }
  });

  it("V5 ranking snapshots retain the full current decision context", async () => {
    const { rows } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'job_ranking_snapshots'
        AND column_name = ANY($1::text[])
    `, [[
      'workspace_id',
      'canonical_job_id',
      'job_version_id',
      'profile_version_id',
      'match_run_id',
      'deterministic_decision_id',
      'ai_evaluation_id',
      'ranking_policy_version',
      'context_fingerprint',
      'overall_rank_score',
      'ranking_confidence',
      'created_at',
    ]]);
    expect(rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'workspace_id',
      'canonical_job_id',
      'job_version_id',
      'profile_version_id',
      'match_run_id',
      'deterministic_decision_id',
      'ai_evaluation_id',
      'ranking_policy_version',
      'context_fingerprint',
      'overall_rank_score',
      'ranking_confidence',
      'created_at',
    ]));
  });

  it("V5 culture observations store nullable structured signals and evidence provenance", async () => {
    const signalColumns = [
      'autonomy_signal',
      'politics_risk_signal',
      'sensory_workload_risk_signal',
      'strategic_value_signal',
      'focus_protection_signal',
    ];
    const evidenceColumns = [
      'source_type',
      'source_url',
      'evidence_quote',
      'evidence_hash',
      'observed_at',
    ];
    const { rows } = await realPool.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'company_culture_observations'
        AND column_name = ANY($1::text[])
    `, [[...signalColumns, ...evidenceColumns]]);
    const actualColumns = rows.map((row) => row.column_name);

    expect(actualColumns).toEqual(expect.arrayContaining([...signalColumns, ...evidenceColumns]));
    expect(rows.filter((row) => signalColumns.includes(row.column_name))).toHaveLength(signalColumns.length);
    expect(rows
      .filter((row) => signalColumns.includes(row.column_name))
      .every((row) => row.is_nullable === 'YES')).toBe(true);
  });

  it("culture analytics and profile coverage expose signal and match-count summaries", async () => {
    const companyAnalyticsColumns = [
      'focus_protection_score_status',
      'focus_protection_observation_count',
      'last_updated',
      'company_job_count',
    ];
    const { rows: companyAnalytics } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v_company_culture_analytics_scoped'
        AND column_name = ANY($1::text[])
    `, [companyAnalyticsColumns]);
    expect(companyAnalytics.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(companyAnalyticsColumns)
    );

    const profileCoverageColumns = [
      'must_exact_matched_count',
      'must_semantic_matched_count',
      'preferred_exact_matched_count',
      'preferred_semantic_matched_count',
      'profile_fact_count',
      'active_credential_count',
      'engagement_count',
      'skill_count',
      'technology_count',
      'domain_count',
      'project_count',
      'achievement_count',
      'publication_count',
    ];
    const { rows: profileCoverage } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v_profile_coverage_scoped'
        AND column_name = ANY($1::text[])
    `, [profileCoverageColumns]);
    expect(profileCoverage.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(profileCoverageColumns)
    );
  });

  it("V5 seeds a versioned ranking policy with weights totaling 100", async () => {
    const { rows } = await realPool.query<{
      policy_version: string | number;
      weights: Record<string, number>;
      minimum_ranking_confidence: number;
    }>(`
      SELECT policy_version, weights, minimum_ranking_confidence::float8 AS minimum_ranking_confidence
      FROM ranking_policies
      ORDER BY policy_version
    `);
    expect(rows.length).toBeGreaterThan(0);

    const requiredWeights = [
      'requirementFit',
      'requirementCoverage',
      'evidenceCompleteness',
      'laneConfidence',
      'autonomy',
      'politicsRisk',
      'sensoryWorkloadRisk',
      'strategicValue',
    ];
    for (const policy of rows) {
      expect(policy.policy_version).toBeTruthy();
      expect(policy.minimum_ranking_confidence).toBe(95);
      expect(Object.keys(policy.weights)).toEqual(expect.arrayContaining(requiredWeights));
      const weights = Object.values(policy.weights);
      expect(weights.every((weight) => Number.isFinite(weight) && weight >= 0)).toBe(true);
      expect(weights.reduce((total, weight) => total + weight, 0)).toBeCloseTo(100, 8);
    }
  });

  it("V5 application status accepts the new workflow states and retains legacy states", async () => {
    const { rows } = await realPool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace_row ON namespace_row.oid = relation.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND relation.relname = 'application_records'
        AND constraint_row.contype = 'c'
        AND pg_get_constraintdef(constraint_row.oid) ILIKE '%status%'
    `);
    const statusConstraint = rows.find((row) => row.definition.includes("'TO_APPLY'"));
    expect(statusConstraint).toBeDefined();

    for (const status of [
      'TO_APPLY',
      'APPLIED',
      'ASSESSMENT',
      'INTENT',
      'READY_TO_APPLY',
      'SUBMITTED',
      'FOLLOW_UP',
      'INTERVIEW',
      'OFFER',
      'REJECTED',
      'WITHDRAWN',
      'CLOSED',
    ]) {
      expect(statusConstraint?.definition).toContain(`'${status}'`);
    }
  });

  it("embedding inputs preserve history with current-row uniqueness and current-only views", async () => {
    const { rows: columns } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'embedding_inputs'
        AND column_name IN ('is_current', 'superseded_at')
    `);
    expect(columns.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['is_current', 'superseded_at'])
    );

    const { rows: indexes } = await realPool.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'embedding_inputs'
        AND indexname IN ('idx_embedding_inputs_workspace_source', 'idx_embedding_inputs_workspace_source_current')
    `);
    expect(indexes.some((row) => row.indexname === 'idx_embedding_inputs_workspace_source')).toBe(false);
    const currentIndex = indexes.find(
      (row) => row.indexname === 'idx_embedding_inputs_workspace_source_current'
    );
    expect(currentIndex?.indexdef).toContain('is_current');

    const { rows: views } = await realPool.query<{ view_name: string; definition: string }>(`
      SELECT c.relname AS view_name, pg_get_viewdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('v_published_semantic_embeddings', 'v_matchable_nodes')
    `);
    expect(views).toHaveLength(2);
    expect(views.every((view) => view.definition.includes('is_current'))).toBe(true);
  });

  it("canonical_jobs table has all required columns from migrations 001–004", async () => {
    const { rows } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'canonical_jobs'
    `);
    const cols = rows.map((r: any) => r.column_name);

    // Core identity columns (001/002)
    expect(cols).toContain("id");
    expect(cols).toContain("company_name");
    expect(cols).toContain("processing_status");
    expect(cols).toContain("primary_lane");

    // Hardening columns (003)
    expect(cols).toContain("secondary_lanes");
    expect(cols).toContain("rejection_reason");

    // Backoff columns (004)
    expect(cols).toContain("gate_evidence_quotes");
    expect(cols).toContain("workability_facts");
  });

  it("evaluation_queue has available_at column from migration 004", async () => {
    const { rows } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'evaluation_queue' AND column_name = 'available_at' AND table_schema = 'public'
    `);
    expect(rows).toHaveLength(1);
  });

  it("evaluation queue exposes durable budget-run identity and budget audit tables", async () => {
    const { rows: queueColumns } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'evaluation_queue'
        AND column_name = 'budget_run_id'
    `);
    expect(queueColumns).toHaveLength(1);

    const { rows: tables } = await realPool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'ai_evaluation_budget_runs',
          'ai_evaluation_budget_usage',
          'evaluation_budget_deferrals'
        )
    `);
    expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual(
      expect.arrayContaining([
        'ai_evaluation_budget_runs',
        'ai_evaluation_budget_usage',
        'evaluation_budget_deferrals',
      ])
    );
    expect(tables).toHaveLength(3);
  });

  it("budget deferrals retain both durable reason codes and nullable queue priority", async () => {
    const { rows: constraints } = await realPool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'evaluation_budget_deferrals'::regclass
        AND conname = 'evaluation_budget_deferrals_reason_code_chk'
    `);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].definition).toContain("AI_BUDGET_EXHAUSTED");
    expect(constraints[0].definition).toContain("AI_BUDGET_UNCONFIGURED_LANE");

    const { rows: views } = await realPool.query<{ definition: string }>(`
      SELECT pg_get_viewdef('v_canonical_shortlist'::regclass, TRUE) AS definition
    `);
    expect(views).toHaveLength(1);
    expect(views[0].definition).toContain("vq.priority_score");
    expect(views[0].definition).not.toMatch(/COALESCE\s*\(\s*vq\.priority_score/i);
  });

  it("migration 052 repairs a legacy coalesced shortlist priority expression", async () => {
    const client = await realPool.connect();
    const schemaName = `nullable_priority_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await client.query(`
        CREATE TABLE schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE vq (priority_score NUMERIC);
        CREATE VIEW v_canonical_shortlist AS
        SELECT COALESCE(vq.priority_score, 0.0) AS priority_score
        FROM vq;
      `);

      await applyMigrationFile(client, "052_preserve_nullable_queue_priority.sql");

      const { rows } = await client.query<{ definition: string }>(
        `SELECT pg_get_viewdef('v_canonical_shortlist'::regclass, TRUE) AS definition`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].definition).toContain("priority_score");
      expect(rows[0].definition).not.toMatch(/COALESCE\s*\(\s*(?:vq\.)?priority_score/i);
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
  });

  it("migration 055 deterministically repairs legacy 019 view definition preserving null and zero", async () => {
    const client = await realPool.connect();
    const schemaName = `nullable_055_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await client.query(`
        CREATE TABLE schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE canonical_jobs (
          id UUID PRIMARY KEY,
          workspace_id UUID,
          normalized_title TEXT,
          company_name TEXT,
          canonical_url TEXT,
          location TEXT,
          location_summary TEXT,
          workplace_type TEXT,
          employment_type TEXT,
          gate_decision TEXT,
          rejection_codes JSONB,
          primary_lane TEXT,
          secondary_lanes JSONB,
          lane_confidence TEXT,
          deterministic_match_score NUMERIC,
          deterministic_match_coverage NUMERIC,
          processing_state TEXT,
          processing_status TEXT,
          recommendation_eligibility TEXT,
          recommendation_outcome TEXT,
          recommendation_requirement_score NUMERIC,
          recommendation_coverage_score NUMERIC,
          recommendation_evidence_completeness NUMERIC,
          recommendation_decided_at TIMESTAMPTZ,
          latest_job_version_id UUID,
          latest_match_run_id UUID,
          latest_deterministic_decision_id UUID,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE job_versions (
          id UUID PRIMARY KEY,
          workspace_id UUID,
          canonical_job_id UUID,
          active_requirement_set_id UUID,
          content_hash TEXT,
          description_text TEXT,
          observed_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE raw_job_observations (
          job_version_id UUID,
          source_name TEXT,
          retrieved_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE gate_decisions (
          canonical_job_id UUID,
          job_version_id UUID,
          decision TEXT,
          rejection_codes JSONB,
          evidence_quotes JSONB,
          gate_version TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE ai_evaluations (
          id UUID PRIMARY KEY,
          workspace_id UUID,
          canonical_job_id UUID,
          job_version_id UUID,
          profile_version_id UUID,
          match_run_id UUID,
          deterministic_decision_id UUID,
          job_content_hash TEXT,
          context_fingerprint TEXT,
          full_evaluation_payload JSONB,
          lane_matches JSONB,
          workability_facts JSONB,
          provider TEXT,
          model TEXT,
          attempt INT,
          is_fallback BOOLEAN,
          degraded_state BOOLEAN,
          evaluated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE evaluation_queue (
          canonical_job_id UUID,
          job_version_id UUID,
          status TEXT,
          priority_score DOUBLE PRECISION,
          attempt_count INT,
          last_error TEXT,
          available_at TIMESTAMPTZ,
          enqueued_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ
        );
        CREATE TABLE document_runs (
          id UUID PRIMARY KEY,
          canonical_job_id UUID,
          job_version_id UUID,
          document_type TEXT,
          status TEXT,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE profile_versions (
          id UUID PRIMARY KEY,
          workspace_id UUID,
          status TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE match_runs (
          id UUID PRIMARY KEY,
          workspace_id UUID,
          canonical_job_id UUID,
          job_version_id UUID,
          profile_version_id UUID,
          requirement_set_id UUID,
          job_content_hash TEXT,
          context_fingerprint TEXT,
          status TEXT
        );
        CREATE TABLE deterministic_decisions (
          id UUID PRIMARY KEY,
          workspace_id UUID,
          canonical_job_id UUID,
          job_version_id UUID,
          match_run_id UUID,
          context_fingerprint TEXT
        );
        CREATE TABLE pipeline_tasks (
          workspace_id UUID,
          status TEXT,
          payload JSONB,
          blocked_reason TEXT
        );

        -- Legacy view definition with COALESCE to 0.0::double precision
        CREATE VIEW v_canonical_shortlist AS
        SELECT
          c.id AS canonical_job_id,
          COALESCE(vq.priority_score, 0.0::double precision) AS priority_score
        FROM canonical_jobs c
        LEFT JOIN evaluation_queue vq ON vq.canonical_job_id = c.id;
      `);

      await applyMigrationFile(client, "055_repair_shortlist_nullable_priority.sql");

      const { rows: viewDef } = await client.query<{ definition: string }>(
        `SELECT pg_get_viewdef('v_canonical_shortlist'::regclass, TRUE) AS definition`
      );
      expect(viewDef[0].definition).toContain("vq.priority_score");
      expect(viewDef[0].definition).not.toMatch(/COALESCE\s*\(\s*vq\.priority_score/i);

      // Verify data behavior:
      // 1. Unknown priority => NULL
      // 2. Genuine numeric zero => 0
      // 3. Known numeric priority => preserved value
      const jobNull = "11111111-1111-1111-1111-111111111111";
      const jobZero = "22222222-2222-2222-2222-222222222222";
      const jobKnown = "33333333-3333-3333-3333-333333333333";

      await client.query(`
        INSERT INTO canonical_jobs (id, processing_state) VALUES
          ('${jobNull}', 'RAW_STAGED'),
          ('${jobZero}', 'RAW_STAGED'),
          ('${jobKnown}', 'RAW_STAGED');
        INSERT INTO job_versions (id, canonical_job_id) VALUES
          ('44444444-4444-4444-4444-444444444444', '${jobNull}'),
          ('55555555-5555-5555-5555-555555555555', '${jobZero}'),
          ('66666666-6666-6666-6666-666666666666', '${jobKnown}');
        INSERT INTO evaluation_queue (canonical_job_id, job_version_id, priority_score) VALUES
          ('${jobZero}', '55555555-5555-5555-5555-555555555555', 0.0),
          ('${jobKnown}', '66666666-6666-6666-6666-666666666666', 0.875);
      `);

      const { rows: res } = await client.query<{ canonical_job_id: string; priority_score: number | null }>(
        `SELECT canonical_job_id, priority_score FROM v_canonical_shortlist ORDER BY canonical_job_id`
      );

      const rowNull = res.find((r) => r.canonical_job_id === jobNull);
      const rowZero = res.find((r) => r.canonical_job_id === jobZero);
      const rowKnown = res.find((r) => r.canonical_job_id === jobKnown);

      expect(rowNull?.priority_score).toBeNull();
      expect(Number(rowZero?.priority_score)).toBe(0);
      expect(Number(rowKnown?.priority_score)).toBeCloseTo(0.875, 3);
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
  });

  it("hides marked release fixtures from operational read models and queue metrics", async () => {
    const client = await realPool.connect();
    try {
      await client.query("BEGIN");
      const workspace = await client.query<{ id: string }>(
        `SELECT id FROM workspaces WHERE workspace_key = 'default' LIMIT 1`,
      );
      const workspaceId = workspace.rows[0]?.id;
      expect(workspaceId).toBeTruthy();
      const reportTable = await client.query<{ exists: boolean }>(
        `SELECT to_regclass('public.pipeline_run_reports') IS NOT NULL AS exists`,
      );
      expect(reportTable.rows[0]?.exists).toBe(true);
      const fixtureJob = await client.query<{ id: string }>(
        `INSERT INTO canonical_jobs (
           workspace_id, company_name, normalized_title, canonical_url,
           processing_state, processing_status, is_test_fixture
         ) VALUES ($1, 'Fixture Co', 'Fixture Engineer', 'https://fixture.example.test',
                   'RAW_STAGED', 'RAW_STAGED', TRUE)
         RETURNING id`,
        [workspaceId],
      );
      const fixtureJobId = fixtureJob.rows[0].id;
      const fixtureVersion = await client.query<{ id: string }>(
        `INSERT INTO job_versions (workspace_id, canonical_job_id, content_hash, description_text)
         VALUES ($1, $2, 'fixture-content', 'Fixture-only canary job.')
         RETURNING id`,
        [workspaceId, fixtureJobId],
      );
      await client.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`,
        [fixtureVersion.rows[0].id, fixtureJobId],
      );
      await client.query(
        `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload)
         VALUES ($1, 'MATCH_PROFILE_EVIDENCE', 'fixture-task-' || gen_random_uuid()::text,
                 jsonb_build_object('canonical_job_id', $2::text, 'job_version_id', $3::text))`,
        [workspaceId, fixtureJobId, fixtureVersion.rows[0].id],
      );

      const shortlist = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM v_canonical_shortlist_actions_scoped
         WHERE workspace_id = $1 AND canonical_job_id = $2`,
        [workspaceId, fixtureJobId],
      );
      const queueHealth = await client.query<{ count: number }>(
        `SELECT COALESCE(SUM(task_count), 0)::int AS count
         FROM v_pipeline_task_queue_health
         WHERE workspace_id = $1
           AND task_type = 'MATCH_PROFILE_EVIDENCE'`,
        [workspaceId],
      );

      expect(shortlist.rows[0]?.count).toBe(0);
      expect(queueHealth.rows[0]?.count).toBe(0);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("authoritative user-action projection exposes explicit action and technical-state fields", async () => {
    const { rows } = await realPool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v_canonical_shortlist_actions_scoped'
        AND column_name IN (
          'requires_user_action',
          'user_action_type',
          'user_action_category',
          'user_action_status',
          'technical_error_count',
          'pipeline_display_category'
        )
    `);
    expect(rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'requires_user_action',
      'user_action_type',
      'user_action_category',
      'user_action_status',
      'technical_error_count',
      'pipeline_display_category',
    ]));

    const { rows: invariantRows } = await realPool.query<{ invalid_actions: number }>(`
      SELECT COUNT(*)::int AS invalid_actions
      FROM v_current_user_actions action
      LEFT JOIN verification_question_job_links link
        ON link.workspace_id = action.workspace_id
       AND link.verification_question_id = action.verification_question_id
       AND link.canonical_job_id = action.canonical_job_id
       AND link.job_version_id = action.job_version_id
      WHERE link.status <> 'OPEN'
    `);
    expect(invariantRows[0]?.invalid_actions).toBe(0);
  });

  it("requires a current open verification action before a shortlist row needs user action", async () => {
    const client = await realPool.connect();

    try {
      await client.query("BEGIN");
      const workspace = await client.query<{ id: string }>(
        `SELECT id FROM workspaces WHERE workspace_key = 'default' LIMIT 1`
      );
      const workspaceId = workspace.rows[0]?.id;
      expect(workspaceId).toBeTruthy();

      const canonical = await client.query<{ id: string }>(
        `INSERT INTO canonical_jobs (
           workspace_id, company_name, normalized_title, canonical_url,
           processing_state, processing_status, gate_decision
         ) VALUES ($1, 'Action Test Co', 'Action Test Engineer', 'https://example.test/action',
                   'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION')
         RETURNING id`,
        [workspaceId]
      );
      const canonicalJobId = canonical.rows[0].id;
      const version = await client.query<{ id: string }>(
        `INSERT INTO job_versions (workspace_id, canonical_job_id, content_hash, description_text)
         VALUES ($1, $2, 'action-test-content', 'Remote machine learning engineering role.')
         RETURNING id`,
        [workspaceId, canonicalJobId]
      );
      const jobVersionId = version.rows[0].id;
      await client.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`,
        [jobVersionId, canonicalJobId]
      );
      const gate = await client.query<{ id: string }>(
        `INSERT INTO gate_decisions (
           workspace_id, canonical_job_id, job_version_id, gate_version,
           decision, rejection_codes, evidence_quotes, workability_facts
         ) VALUES ($1, $2, $3, 'test', 'NEEDS_VERIFICATION',
                   '["NEEDS_VERIFICATION_OFFICE_DAYS"]'::jsonb, '[]'::jsonb, '{}'::jsonb)
         RETURNING id`,
        [workspaceId, canonicalJobId, jobVersionId]
      );
      const question = await client.query<{ id: string }>(
        `INSERT INTO verification_questions (
           workspace_id, question_key, category, question_text, linked_job_ids, status
         ) VALUES ($1, 'test-current-action-' || gen_random_uuid()::text,
                   'WORKPLACE_MODEL', 'Confirm office-day requirement.',
                   jsonb_build_array($2::text), 'PENDING')
         RETURNING id`,
        [workspaceId, canonicalJobId]
      );
      await client.query(
        `INSERT INTO verification_question_job_links (
           workspace_id, verification_question_id, canonical_job_id, job_version_id,
           gate_decision_id, status
         ) VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
        [workspaceId, question.rows[0].id, canonicalJobId, jobVersionId, gate.rows[0].id]
      );

      const current = await client.query<{ requires_user_action: boolean; pipeline_display_category: string }>(
        `SELECT requires_user_action, pipeline_display_category
         FROM v_canonical_shortlist_actions_scoped
         WHERE workspace_id = $1 AND canonical_job_id = $2`,
        [workspaceId, canonicalJobId]
      );
      expect(current.rows[0]).toMatchObject({
        requires_user_action: true,
        pipeline_display_category: 'USER_ACTION_REQUIRED',
      });

      // A newer job version invalidates the old gate/question link, so stale
      // history cannot inflate manual-action counters.
      const nextVersion = await client.query<{ id: string }>(
        `INSERT INTO job_versions (workspace_id, canonical_job_id, content_hash, description_text)
         VALUES ($1, $2, 'action-test-content-next', 'Updated remote role.')
         RETURNING id`,
        [workspaceId, canonicalJobId]
      );
      await client.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`,
        [nextVersion.rows[0].id, canonicalJobId]
      );

      const stale = await client.query<{ requires_user_action: boolean }>(
        `SELECT requires_user_action
         FROM v_canonical_shortlist_actions_scoped
         WHERE workspace_id = $1 AND canonical_job_id = $2`,
        [workspaceId, canonicalJobId]
      );
      expect(stale.rows[0]?.requires_user_action).toBe(false);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("evaluation queue uniqueness is scoped to current context", async () => {
    const { rows } = await realPool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'evaluation_queue'
         AND indexname IN ('idx_evaluation_queue_active_job', 'idx_evaluation_queue_active_context')`
    );
    expect(rows.some((row) => row.indexname === "idx_evaluation_queue_active_job")).toBe(false);
    const currentIndex = rows.find((row) => row.indexname === "idx_evaluation_queue_active_context");
    expect(currentIndex?.indexdef).toContain("context_fingerprint");
  });

  it("gate_decisions audit table and pipeline run identity exist", async () => {
    const { rows } = await realPool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'gate_decisions' AND table_schema = 'public'
    `);
    expect(rows).toHaveLength(1);

    const { rows: columns } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'gate_decisions'
        AND column_name = 'pipeline_run_id'
        AND table_schema = 'public'
    `);
    expect(columns).toHaveLength(1);
  });

  it("rejected-job audit read models exist for base and workspace-scoped consumers", async () => {
    const { rows } = await realPool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN ('v_rejected_jobs_audit', 'v_rejected_jobs_audit_scoped')
    `);
    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['v_rejected_jobs_audit', 'v_rejected_jobs_audit_scoped'])
    );
    expect(rows).toHaveLength(2);
  });

  it("raw_email_alerts has gmail_message_id column from migration 004", async () => {
    const { rows } = await realPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'raw_email_alerts' AND column_name = 'gmail_message_id' AND table_schema = 'public'
    `);
    expect(rows).toHaveLength(1);
  });

  it("running migrations twice is idempotent (no rows re-applied)", async () => {
    const before = (await realPool.query(`SELECT COUNT(*)::int AS n FROM schema_migrations`)).rows[0].n;
    await runMigrations(realPool); // second run — should apply nothing
    const after = (await realPool.query(`SELECT COUNT(*)::int AS n FROM schema_migrations`)).rows[0].n;
    expect(after).toBe(before);
  });

  it("migration 008 succeeds on legacy upgrade path without uq_canonical_job_content_hash", async () => {
    const client = await realPool.connect();
    const schemaName = `legacy_upgrade_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      const allFiles = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql") && !f.startsWith("."))
        .sort();
      const baselineFiles = allFiles.filter((f) => f <= "007_job_version_integrity.sql");
      for (const file of baselineFiles) {
        await applyMigrationFile(client, file);
      }

      // Simulate legacy DB drift where this unique constraint is missing.
      await client.query(`ALTER TABLE job_versions DROP CONSTRAINT IF EXISTS uq_canonical_job_content_hash`);

      const canonicalJobId = (
        await client.query(
          `INSERT INTO canonical_jobs (company_name, normalized_title, canonical_url, processing_status)
           VALUES ('Legacy Upgrade Co', 'Data Engineer', 'https://example.com/legacy-upgrade', 'LANE_ROUTED')
           RETURNING id`
        )
      ).rows[0].id as string;

      await client.query(
        `INSERT INTO evaluation_queue (canonical_job_id, lane, status, job_version_id)
         VALUES ($1, 'CORE_AI_DATA', 'PENDING', NULL)`,
        [canonicalJobId]
      );

      const before = await client.query(
        `SELECT 1 FROM schema_migrations WHERE version = '008_job_version_integrity_v2.sql'`
      );
      expect(before.rows).toHaveLength(0);

      await runMigrations(client);

      const after = await client.query(
        `SELECT 1 FROM schema_migrations WHERE version = '008_job_version_integrity_v2.sql'`
      );
      expect(after.rows).toHaveLength(1);

      // Migration 008 temporarily repairs unlinked queue rows. Migration 010 then
      // quarantines synthetic placeholder-linked queue rows and removes them from
      // active evaluation_queue.
      const queueRows = await client.query(
        `SELECT status, job_version_id FROM evaluation_queue WHERE canonical_job_id = $1`,
        [canonicalJobId]
      );
      expect(queueRows.rows).toHaveLength(0);

      const quarantinedRows = await client.query(
        `SELECT canonical_job_id, quarantine_reason, raw_record_payload
         FROM quarantined_queue_records
         WHERE canonical_job_id = $1`,
        [canonicalJobId]
      );
      expect(quarantinedRows.rows).toHaveLength(1);
      expect(quarantinedRows.rows[0].quarantine_reason).toContain("synthetic migration-008 placeholder version");
      expect(quarantinedRows.rows[0].canonical_job_id).toBe(canonicalJobId);
      expect(quarantinedRows.rows[0].raw_record_payload).toBeTruthy();
      expect(quarantinedRows.rows[0].raw_record_payload.canonical_job_id).toBe(canonicalJobId);
    } finally {
      await client.query(`RESET search_path`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
  }, 30_000);
});
