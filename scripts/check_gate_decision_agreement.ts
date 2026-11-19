/**
 * Fails (exit 1) when a job whose latest gate result is HARD_REJECT still carries a recommendation, or
 * appears in the Review / Priority / Apply Now sets. Read only; prints counts and job ids, no employer
 * names or titles.
 *
 *   npx tsx scripts/check_gate_decision_agreement.ts [--target production|replay]   (default: DATABASE_URL)
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { pgConnectionConfig } from '../src/db/pgSsl.js';

dotenv.config({ path: '.env.local' });
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'production';
if (target !== 'replay' && target !== 'production') throw new Error('usage: --target replay|production');
const url = (target === 'replay' ? process.env.REPLAY_DATABASE_URL : process.env.DATABASE_URL)?.trim();
if (!url) throw new Error(`${target} database url is not set`);

const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
await client.query('BEGIN READ ONLY');
let violations = 0;
try {
  // Any recommendation (PRIORITY, REVIEW, TRACK, or an eligibility) on a job the latest gate rejected.
  const { rows } = await client.query<{ id: string; outcome: string | null; eligibility: string | null; state: string | null }>(
    `WITH latest AS (
       SELECT DISTINCT ON (canonical_job_id) canonical_job_id, decision
         FROM gate_decisions ORDER BY canonical_job_id, created_at DESC, id DESC)
     SELECT c.id::text AS id, c.recommendation_outcome AS outcome, c.recommendation_eligibility AS eligibility,
            COALESCE(c.processing_state, c.processing_status) AS state
       FROM canonical_jobs c JOIN latest l ON l.canonical_job_id = c.id
      WHERE l.decision = 'HARD_REJECT' AND c.archived_at IS NULL
        AND (c.recommendation_outcome IN ('PRIORITY','REVIEW','TRACK') OR c.recommendation_eligibility IN ('ELIGIBLE','VERIFY'))`,
  );
  violations = rows.length;
  console.log(`target=${target} rejected-by-gate jobs that still carry a recommendation: ${violations}`);
  for (const row of rows) console.log(`  job ${row.id} outcome=${row.outcome} eligibility=${row.eligibility} state=${row.state}`);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
if (violations > 0) process.exitCode = 1;
