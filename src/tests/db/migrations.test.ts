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
