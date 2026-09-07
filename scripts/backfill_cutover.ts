import pg from 'pg';
import dotenv from 'dotenv';
import { pgPoolConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

interface StatusCount {
  processing_state: string;
  count: number;
}

const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

async function getStatusCounts(client: pg.PoolClient, workspaceId: string): Promise<StatusCount[]> {
  const res = await client.query<StatusCount>(
    `
      SELECT
        COALESCE(processing_state, processing_status) AS processing_state,
        COUNT(*)::int AS count
      FROM canonical_jobs
      WHERE workspace_id = $1
      GROUP BY COALESCE(processing_state, processing_status)
      ORDER BY processing_state ASC
    `,
    [workspaceId]
  );
  return res.rows;
}

function parseArgs(argv: string[]): { auditKey: string; expectedDiffSignature?: string; workspaceKey?: string; userKey?: string } {
  const out: { auditKey: string; expectedDiffSignature?: string; workspaceKey?: string; userKey?: string } = {
    auditKey: 'v22_cutover',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audit-key' && argv[i + 1]) {
      out.auditKey = String(argv[i + 1]).trim();
      i++;
    } else if (a === '--expected-diff-signature' && argv[i + 1]) {
      out.expectedDiffSignature = String(argv[i + 1]).trim();
      i++;
    } else if (a === '--workspace-key' && argv[i + 1]) {
      out.workspaceKey = String(argv[i + 1]).trim();
      i++;
    } else if (a === '--user-key' && argv[i + 1]) {
      out.userKey = String(argv[i + 1]).trim();
      i++;
    }
  }

  return out;
}

async function runBackfillCutoverAudit(): Promise<void> {
  const client = await pool.connect();

  try {
    const args = parseArgs(process.argv.slice(2));
    const ctx = await resolveWorkspaceContext(client as any, {
      workspaceKey: args.workspaceKey,
      userKey: args.userKey,
    });

    const before = await getStatusCounts(client, ctx.workspaceId);

    const cutoverViolations = await client.query<{
      legacy_evaluated: number;
      legacy_rejected_after_eval: number;
      legacy_semantic_shortlisted: number;
      matched_without_score: number;
      docs_without_state: number;
      deferred_budget: number;
      undecided_jobs: number;
      cross_workspace_versions: number;
      dead_letter_tasks: number;
    }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE COALESCE(c.processing_state, c.processing_status) = 'EVALUATED')::int AS legacy_evaluated,
          COUNT(*) FILTER (WHERE COALESCE(c.processing_state, c.processing_status) = 'REJECTED_AFTER_EVALUATION')::int AS legacy_rejected_after_eval,
          COUNT(*) FILTER (WHERE COALESCE(c.processing_state, c.processing_status) = 'SEMANTIC_SHORTLISTED')::int AS legacy_semantic_shortlisted,
          COUNT(*) FILTER (
            WHERE COALESCE(c.processing_state, c.processing_status) = 'MATCHED'
              AND (c.deterministic_match_score IS NULL OR c.latest_match_run_id IS NULL)
          )::int AS matched_without_score,
          COUNT(*) FILTER (WHERE COALESCE(c.processing_state, c.processing_status) = 'DEFERRED_BUDGET')::int AS deferred_budget,
          COUNT(*) FILTER (
            WHERE COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
              AND c.recommendation_outcome IS NULL
          )::int AS undecided_jobs,
          (
            SELECT COUNT(*)::int
            FROM job_versions v
            JOIN canonical_jobs c2 ON c2.id = v.canonical_job_id
            WHERE (c2.workspace_id = $1 OR v.workspace_id = $1)
              AND v.workspace_id <> c2.workspace_id
          ) AS cross_workspace_versions,
          (
            SELECT COUNT(*)::int
            FROM pipeline_tasks t
            WHERE t.workspace_id = $1
              AND t.status = 'DEAD_LETTER'
          ) AS dead_letter_tasks,
          (
            SELECT COUNT(*)::int
            FROM document_runs dr
            LEFT JOIN job_version_pipeline_state ps
              ON ps.workspace_id = dr.workspace_id
             AND ps.job_version_id = dr.job_version_id
            WHERE dr.workspace_id = $1
              AND dr.status = 'COMPLETED'
              AND (ps.id IS NULL OR ps.current_stage <> 'DOCUMENT_READY' OR ps.stage_status <> 'COMPLETED')
          ) AS docs_without_state
        FROM canonical_jobs c
        WHERE c.workspace_id = $1
      `,
      [ctx.workspaceId]
    );

    const row = cutoverViolations.rows[0];

    console.log('=== v2.2 Backfill / Parity / Cutover Audit ===');
    console.log(`workspace_key=${ctx.workspaceKey} user_key=${ctx.userKey}`);
    console.log('Status counts:');
    for (const status of before) {
      console.log(`- ${status.processing_state}: ${status.count}`);
    }

    console.log('Cutover checks:');
    console.log(`- legacy EVALUATED rows: ${row.legacy_evaluated}`);
    console.log(`- legacy REJECTED_AFTER_EVALUATION rows: ${row.legacy_rejected_after_eval}`);
    console.log(`- legacy SEMANTIC_SHORTLISTED rows: ${row.legacy_semantic_shortlisted}`);
    console.log(`- MATCHED rows missing deterministic score/run: ${row.matched_without_score}`);
    console.log(`- DEFERRED_BUDGET rows: ${row.deferred_budget}`);
    console.log(`- Jobs missing deterministic recommendation_outcome: ${row.undecided_jobs}`);
    console.log(`- Cross-workspace job_versions: ${row.cross_workspace_versions}`);
    console.log(`- Dead-letter pipeline tasks: ${row.dead_letter_tasks}`);
    console.log(`- Completed document runs missing DOCUMENT_READY state: ${row.docs_without_state}`);

    const failures =
      row.legacy_evaluated +
      row.legacy_rejected_after_eval +
      row.legacy_semantic_shortlisted +
      row.matched_without_score +
      row.deferred_budget +
      row.undecided_jobs +
      row.cross_workspace_versions +
      row.dead_letter_tasks +
      row.docs_without_state;

    const findings = {
      legacy_evaluated: row.legacy_evaluated,
      legacy_rejected_after_eval: row.legacy_rejected_after_eval,
      legacy_semantic_shortlisted: row.legacy_semantic_shortlisted,
      matched_without_score: row.matched_without_score,
      deferred_budget: row.deferred_budget,
      undecided_jobs: row.undecided_jobs,
      cross_workspace_versions: row.cross_workspace_versions,
      dead_letter_tasks: row.dead_letter_tasks,
      docs_without_state: row.docs_without_state,
      failures,
    };

    try {
      await client.query(
        `
        INSERT INTO parity_audit_runs (
          workspace_id,
          audit_key,
          status,
          findings,
          expected_diff_signature,
          created_by_user_id
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        `,
        [
          ctx.workspaceId,
          args.auditKey,
          failures > 0 ? 'FAILED' : 'PASSED',
          JSON.stringify(findings),
          args.expectedDiffSignature || null,
          ctx.userId,
        ]
      );
    } catch (err: any) {
      if (err?.code !== '42P01') {
        throw err;
      }
      console.warn('parity_audit_runs table missing; skipping audit persistence (apply migration 035).');
    }

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
