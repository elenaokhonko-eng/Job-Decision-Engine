import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { runMigrations, getMigrationStatus } from "../src/db/migrate.js";
import {
  getRehearsalDatabaseTarget,
  requireRehearsalWriteConfirmation,
} from "./productionRehearsalTarget.js";

interface SchemaSnapshot {
  tables: string[];
  views: string[];
  columns: { table_name: string; column_name: string; data_type: string; is_nullable: string }[];
  constraints: { table_name: string; constraint_name: string; constraint_type: string }[];
  indexes: { table_name: string; index_name: string }[];
  rowCounts: Record<string, number>;
}

async function captureSnapshot(client: pg.Client): Promise<SchemaSnapshot> {
  const tablesRes = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);

  const viewsRes = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.views
    WHERE table_schema = current_schema()
    ORDER BY table_name;
  `);

  const colsRes = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()
    ORDER BY table_name, ordinal_position;
  `);

  const constrRes = await client.query<{ table_name: string; constraint_name: string; constraint_type: string }>(`
    SELECT table_name, constraint_name, constraint_type
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
    ORDER BY table_name, constraint_name;
  `);

  const idxRes = await client.query<{ table_name: string; index_name: string }>(`
    SELECT tablename AS table_name, indexname AS index_name
    FROM pg_indexes
    WHERE schemaname = current_schema()
    ORDER BY tablename, indexname;
  `);

  const rowCounts: Record<string, number> = {};
  for (const row of tablesRes.rows) {
    try {
      const c = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${row.table_name}`);
      rowCounts[row.table_name] = c.rows[0].cnt;
    } catch {
      rowCounts[row.table_name] = -1;
    }
  }

  return {
    tables: tablesRes.rows.map((r) => r.table_name),
    views: viewsRes.rows.map((r) => r.table_name),
    columns: colsRes.rows,
    constraints: constrRes.rows,
    indexes: idxRes.rows,
    rowCounts,
  };
}

async function main() {
  const target = getRehearsalDatabaseTarget();
  requireRehearsalWriteConfirmation(target);

  console.log("==================================================");
  console.log(`PHASE 2: ${target.environment} SCHEMA UPGRADE REHEARSAL`);
  console.log("==================================================");

  const client = new pg.Client(pgConnectionConfig(target.databaseUrl));
  await client.connect();

  console.log("\n[1] Capturing PRE-MIGRATION schema snapshot...");
  const preSnapshot = await captureSnapshot(client);
  console.log(`Pre-migration: ${preSnapshot.tables.length} tables, ${preSnapshot.views.length} views, ${preSnapshot.columns.length} columns`);

  const preStatus = await getMigrationStatus(client);
  console.log(`Pre-migration status: ${preStatus.appliedCount} applied, ${preStatus.pendingCount} pending.`);
  console.log("Pending migrations to apply:", preStatus.pending);

  console.log("\n[2] Executing runMigrations()...");
  const newlyApplied = await runMigrations(client);
  console.log(`✅ Applied ${newlyApplied.length} migrations:`, newlyApplied);

  console.log("\n[3] Capturing POST-MIGRATION schema snapshot...");
  const postSnapshot = await captureSnapshot(client);
  console.log(`Post-migration: ${postSnapshot.tables.length} tables, ${postSnapshot.views.length} views, ${postSnapshot.columns.length} columns`);

  const postStatus = await getMigrationStatus(client);
  console.log(`Post-migration status: ${postStatus.appliedCount} applied, ${postStatus.pendingCount} pending.`);

  console.log("\n[4] SCHEMA DIFF ANALYSIS:");
  const addedTables = postSnapshot.tables.filter((t) => !preSnapshot.tables.includes(t));
  const addedViews = postSnapshot.views.filter((v) => !preSnapshot.views.includes(v));
  const addedCols = postSnapshot.columns.filter(
    (c) => !preSnapshot.columns.some((pc) => pc.table_name === c.table_name && pc.column_name === c.column_name)
  );
  const addedConstraints = postSnapshot.constraints.filter(
    (c) => !preSnapshot.constraints.some((pc) => pc.table_name === c.table_name && pc.constraint_name === c.constraint_name)
  );
  const addedIndexes = postSnapshot.indexes.filter(
    (i) => !preSnapshot.indexes.some((pi) => pi.table_name === i.table_name && pi.index_name === i.index_name)
  );

  console.log("Added Tables:", addedTables);
  console.log("Added Views:", addedViews);
  console.log("Added Columns:", addedCols);
  console.log("Added Constraints:", addedConstraints);
  console.log("Added Indexes:", addedIndexes);

  console.log("\n[5] VALIDATION CHECKS:");

  // 1. All pending migrations recorded in schema_migrations
  const expectedPending = [
    '050_ai_evaluation_budget_deferral.sql',
    '051_budget_deferral_reason_codes.sql',
    '052_preserve_nullable_queue_priority.sql',
    '053_gate_decision_pipeline_run_id.sql',
    '054_repair_rejected_read_model_views.sql',
    '055_repair_shortlist_nullable_priority.sql',
    '056_authoritative_user_action_projection.sql',
  ];
  const missingFromApplied = expectedPending.filter((m) => !postStatus.applied.includes(m));
  if (missingFromApplied.length > 0) {
    throw new Error(`FAIL: Missing migrations from schema_migrations: ${missingFromApplied.join(', ')}`);
  }
  console.log("✓ All 7 pending migrations recorded in schema_migrations.");

  // 2. Budget tables exist
  const budgetTables = ['ai_evaluation_budget_runs', 'ai_evaluation_budget_usage', 'evaluation_budget_deferrals'];
  for (const bt of budgetTables) {
    if (!postSnapshot.tables.includes(bt)) {
      throw new Error(`FAIL: Budget table ${bt} does not exist`);
    }
  }
  console.log("✓ New budget tables created.");

  // 3. gate_decisions.pipeline_run_id exists
  const hasPipelineRunId = postSnapshot.columns.some(
    (c) => c.table_name === 'gate_decisions' && c.column_name === 'pipeline_run_id'
  );
  if (!hasPipelineRunId) {
    throw new Error("FAIL: gate_decisions.pipeline_run_id column missing");
  }
  console.log("✓ gate_decisions.pipeline_run_id exists.");

  // 3b. Verify check constraint on evaluation_budget_deferrals
  try {
    const chkRes = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'evaluation_budget_deferrals'::regclass
        AND conname = 'evaluation_budget_deferrals_reason_code_chk';
    `);
    if (chkRes.rows.length === 0) {
      throw new Error("FAIL: evaluation_budget_deferrals_reason_code_chk constraint not found");
    }
    console.log(`✓ Constraint evaluation_budget_deferrals_reason_code_chk verified: ${chkRes.rows[0].def}`);
  } catch (e: any) {
    throw new Error(`FAIL: Check constraint verification failed: ${e.message}`);
  }

  // 3c. Verify nullable shortlist priority behavior in view definition
  try {
    const viewDefRes = await client.query(`
      SELECT pg_get_viewdef('v_canonical_shortlist'::regclass, true) AS def;
    `);
    const def = viewDefRes.rows[0].def;
    const isCoalesced = def.includes('COALESCE(vq.priority_score, 0') || def.includes('COALESCE(priority_score, 0');
    if (isCoalesced) {
      throw new Error("FAIL: v_canonical_shortlist still retains COALESCE(priority_score, 0) after migration 055");
    }
    console.log("✓ v_canonical_shortlist preserves nullable priority_score without COALESCE fallback to 0.");
  } catch (e: any) {
    throw new Error(`FAIL: View definition verification failed: ${e.message}`);
  }

  // 4. Views exist and queryable
  const requiredViews = [
    'v_rejected_jobs_audit',
    'v_rejected_jobs_audit_scoped',
    'v_canonical_shortlist',
    'v_canonical_shortlist_scoped',
    'v_current_user_actions',
    'v_canonical_shortlist_actions_scoped',
    'v_matchable_nodes',
    'v_published_semantic_embeddings',
    'v_application_tracker',
  ];
  for (const v of requiredViews) {
    try {
      const vRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${v}`);
      console.log(`✓ View ${v} is queryable (row count: ${vRes.rows[0].cnt})`);
    } catch (e: any) {
      throw new Error(`FAIL: View ${v} cannot be queried: ${e.message}`);
    }
  }

  // 5. Data integrity - row counts before and after
  console.log("\n[6] DATA INTEGRITY CHECK (Row counts before vs after):");
  const coreTables = [
    'canonical_jobs',
    'job_versions',
    'raw_job_observations',
    'gate_decisions',
    'lane_decisions',
    'candidate_profiles',
    'profile_versions',
    'profile_facts',
    'profile_engagements',
    'job_requirements',
    'requirement_sets',
    'match_runs',
    'requirement_evidence_matches',
    'evaluation_queue',
    'ai_evaluations',
    'embedding_spaces',
    'embedding_inputs',
    'embedding_batches',
    'semantic_embeddings',
  ];
  for (const tbl of coreTables) {
    const preCount = preSnapshot.rowCounts[tbl] ?? 0;
    const postCount = postSnapshot.rowCounts[tbl] ?? 0;
    if (preCount !== postCount) {
      throw new Error(`FAIL: Row count mismatch on ${tbl}: pre=${preCount}, post=${postCount}`);
    }
    console.log(`✓ ${tbl}: ${preCount} -> ${postCount} (intact)`);
  }

  console.log("\n[7] TESTING IDEMPOTENCY (Running runMigrations second time)...");
  const secondRunApplied = await runMigrations(client);
  console.log(`Second migration run applied: ${secondRunApplied.length} migrations (expected 0)`);
  if (secondRunApplied.length !== 0) {
    throw new Error(`FAIL: Migration runner is not idempotent! Applied ${secondRunApplied.join(', ')} on second pass`);
  }
  console.log("✓ Migration runner verified 100% idempotent.");

  await client.end();
  console.log("\n✅ PHASE 2 COMPLETED SUCCESSFULLY WITH ZERO ERRORS.");
}

main().catch((err) => {
  console.error("Migration rehearsal failed:", err);
  process.exit(1);
});
