import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { getMigrationStatus } from "../src/db/migrate.js";
import { getProductionDatabaseUrl } from "./productionRehearsalTarget.js";

async function main() {
  const productionUrl = getProductionDatabaseUrl();
  const client = new pg.Client(pgConnectionConfig(productionUrl));
  await client.connect();

  console.log("=== PRODUCTION DATABASE CONNECTION INFO ===");
  const info = await client.query(`
    SELECT current_database() AS db, current_user AS usr, current_schema() AS schema, inet_server_addr() AS addr;
  `);
  console.log(info.rows[0]);

  console.log("\n=== MIGRATION STATUS ===");
  const status = await getMigrationStatus(client);
  console.log({
    isInitialized: status.isInitialized,
    total: status.total,
    appliedCount: status.appliedCount,
    pendingCount: status.pendingCount,
    applied: status.applied,
    pending: status.pending,
  });

  console.log("\n=== DATA BASELINE: TABLE COUNTS ===");
  const tables = [
    "schema_migrations",
    "canonical_jobs",
    "job_versions",
    "raw_job_observations",
    "gate_decisions",
    "lane_decisions",
    "candidate_profiles",
    "profile_versions",
    "profile_facts",
    "profile_engagements",
    "job_requirements",
    "requirement_sets",
    "match_runs",
    "requirement_evidence_matches",
    "evaluation_queue",
    "ai_evaluations",
    "embedding_spaces",
    "embedding_inputs",
    "embedding_batches",
    "semantic_embeddings",
  ];

  for (const tbl of tables) {
    try {
      const res = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
      console.log(`${tbl}: ${res.rows[0].cnt}`);
    } catch (e: any) {
      console.log(`${tbl}: [TABLE MISSING OR ERROR: ${e.message}]`);
    }
  }

  console.log("\n=== PROCESSING STATE DISTRIBUTION ===");
  try {
    const states = await client.query(`
      SELECT COALESCE(processing_state, processing_status, 'NULL') AS state,
             COUNT(*)::int AS count
      FROM canonical_jobs
      GROUP BY 1
      ORDER BY 2 DESC;
    `);
    console.table(states.rows);
  } catch (e: any) {
    console.error("Error querying processing_state:", e.message);
  }

  console.log("\n=== GATE REJECTION REASONS ===");
  try {
    const reasons = await client.query(`
      SELECT unnest(rejection_codes) AS code, COUNT(*)::int AS count
      FROM gate_decisions
      WHERE decision = 'REJECTED'
      GROUP BY 1
      ORDER BY 2 DESC;
    `);
    console.table(reasons.rows);
  } catch (e: any) {
    console.error("Error querying rejection codes:", e.message);
  }

  console.log("\n=== LANE DISTRIBUTION ===");
  try {
    const lanes = await client.query(`
      SELECT COALESCE(primary_lane, 'UNCLASSIFIED') AS lane, COUNT(*)::int AS count
      FROM canonical_jobs
      GROUP BY 1
      ORDER BY 2 DESC;
    `);
    console.table(lanes.rows);
  } catch (e: any) {
    console.error("Error querying lanes:", e.message);
  }

  await client.end();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
