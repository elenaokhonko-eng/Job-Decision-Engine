import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../src/db/pgSsl.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

interface StatusCount {
  processing_status: string;
  count: number;
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

async function getStatusCounts(client: pg.PoolClient): Promise<StatusCount[]> {
  const res = await client.query<StatusCount>(`
    SELECT processing_status, COUNT(*)::int AS count
    FROM canonical_jobs
    GROUP BY processing_status
    ORDER BY processing_status ASC
  `);
  return res.rows;
}

async function runBackfillCutoverAudit(): Promise<void> {
  const client = await pool.connect();

  try {
    const before = await getStatusCounts(client);

    const cutoverViolations = await client.query<{
      legacy_evaluated: number;
      legacy_rejected_after_eval: number;
      legacy_semantic_shortlisted: number;
      matched_without_score: number;
      docs_without_state: number;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE c.processing_status = 'EVALUATED')::int AS legacy_evaluated,
        COUNT(*) FILTER (WHERE c.processing_status = 'REJECTED_AFTER_EVALUATION')::int AS legacy_rejected_after_eval,
        COUNT(*) FILTER (WHERE c.processing_status = 'SEMANTIC_SHORTLISTED')::int AS legacy_semantic_shortlisted,
        COUNT(*) FILTER (
          WHERE c.processing_status = 'MATCHED' AND (c.deterministic_match_score IS NULL OR c.latest_match_run_id IS NULL)
        )::int AS matched_without_score,
        (
          SELECT COUNT(*)::int
          FROM document_runs dr
          LEFT JOIN job_version_pipeline_state ps ON ps.job_version_id = dr.job_version_id
          WHERE dr.status = 'COMPLETED'
            AND (ps.id IS NULL OR ps.current_stage <> 'DOCUMENT_READY' OR ps.stage_status <> 'COMPLETED')
        ) AS docs_without_state
      FROM canonical_jobs c
    `);

    const row = cutoverViolations.rows[0];

    console.log('=== Phase 8 Backfill Cutover Audit ===');
    console.log('Status counts:');
    for (const status of before) {
      console.log(`- ${status.processing_status}: ${status.count}`);
    }

    console.log('Cutover checks:');
    console.log(`- legacy EVALUATED rows: ${row.legacy_evaluated}`);
    console.log(`- legacy REJECTED_AFTER_EVALUATION rows: ${row.legacy_rejected_after_eval}`);
    console.log(`- legacy SEMANTIC_SHORTLISTED rows: ${row.legacy_semantic_shortlisted}`);
    console.log(`- MATCHED rows missing deterministic score/run: ${row.matched_without_score}`);
    console.log(`- Completed document runs missing DOCUMENT_READY state: ${row.docs_without_state}`);

    const failures =
      row.legacy_evaluated +
      row.legacy_rejected_after_eval +
      row.legacy_semantic_shortlisted +
      row.matched_without_score +
      row.docs_without_state;

    if (failures > 0) {
      throw new Error(`Cutover audit failed with ${failures} unresolved legacy/backfill issues.`);
    }

    console.log('Cutover audit passed. No unresolved legacy/backfill issues detected.');
  } finally {
    client.release();
    await pool.end();
  }
}

runBackfillCutoverAudit().catch((error) => {
  console.error('Backfill cutover audit failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
