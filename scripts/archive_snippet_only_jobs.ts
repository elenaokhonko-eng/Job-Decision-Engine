/**
 * Archive live jobs that are known only from an alert-email snippet and were never fetched.
 *
 * Rule (src/services/jobArchive.ts findSnippetOnlyArchiveCandidates): every observation is GMAIL_ALERT, the
 * description never reached the completeness rule, no FETCH_JOB_CONTENT task was ever queued for the job, and
 * nothing was seen for --min-age-days (default 7). Saved-export jobs and manually removed jobs are never touched.
 * Jobs with an active application, document run, lease, manual review or archive hold are skipped and counted.
 *
 * Archives under POSTING_NOT_CONFIRMABLE / POSTING_LINK_UNVERIFIABLE: not "closed" (the posting's state is
 * unknown) and reversible through restoreArchivedJob. Nothing is deleted.
 *
 *   npx tsx scripts/archive_snippet_only_jobs.ts --target replay                 # dry run (default), read only
 *   npx tsx scripts/archive_snippet_only_jobs.ts --target production             # dry run on production, read only
 *
 * APPLY (guarded; only with the owner's approval of the dry-run numbers):
 *   ARCHIVE_SNIPPET_APPLY_ALLOWED=true npx tsx scripts/archive_snippet_only_jobs.ts --target production --apply \
 *     --confirm-workspace=<workspace uuid> --restore-point=<Neon restore point / branch id>
 *
 * EXPIRY RULE (--rule=expiry, src/ingestion/snippetExpiry.ts): a snippet-only job whose fetch has not succeeded
 * is archived 7 days after it was last seen, or 21 days after it was first seen, unless a fetch is still within its
 * retry budget (a pending fetch
 * task still within its retry budget defers the archive; once the task is exhausted, parked or dead-lettered the
 * job expires). Same guards, same reversibility, idempotent. Manual and env-gated: nothing schedules this script.
 * --restore-point is an audit label recorded on the archive run (the owner takes the Neon restore point first; the
 * script cannot verify it exists, so it only requires a non-empty value).
 *
 *   npx tsx scripts/archive_snippet_only_jobs.ts --target replay --rule=expiry                        # dry run
 *   SNIPPET_EXPIRY_APPLY_ALLOWED=true npx tsx scripts/archive_snippet_only_jobs.ts --target production --rule=expiry --apply \
 *     --confirm-workspace=<workspace uuid> --restore-point=<Neon restore point / branch id>
 *
 * Output prints counts and job ids only; no employer names or titles.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { pgConnectionConfig } from '../src/db/pgSsl.js';
import { requireApprovedReplayTarget } from '../src/reporting/replayGuard.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';
import { archiveJobsAsPostingNotConfirmable, findSnippetOnlyArchiveCandidates } from '../src/services/jobArchive.js';
import { expireSnippetOnlyJobs } from '../src/ingestion/snippetExpiry.js';

dotenv.config({ path: '.env.local' });

const argv = process.argv.slice(2);
const argValue = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() || null : null;
};
const target = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : '';
if (target !== 'replay' && target !== 'production') throw new Error('usage: --target replay|production [--min-age-days=7] [--apply ...]');
const apply = argv.includes('--apply');
const rule = argValue('rule') ?? 'never-fetched';
if (rule !== 'never-fetched' && rule !== 'expiry') throw new Error('--rule must be never-fetched or expiry');
const minAgeDays = Number(argValue('min-age-days') ?? '7');

const url = (target === 'replay' ? process.env.REPLAY_DATABASE_URL : process.env.DATABASE_URL)?.trim();
if (!url) throw new Error(`${target} database url is not set`);

const tally = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
};

const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const id = await client.query<{ d: string; b: string | null }>(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
  if (target === 'replay') requireApprovedReplayTarget(url, { databaseName: id.rows[0].d, branchId: id.rows[0].b }, process.env.REPLAY_BRANCH_ID);
  console.log(`target=${target} database=${id.rows[0].d} branch=${id.rows[0].b} mode=${apply ? 'APPLY' : 'DRY RUN'} min_age_days=${minAgeDays}`);
  const context = await resolveWorkspaceContext(client as unknown as pg.PoolClient);
  console.log(`workspace=${context.workspaceId}`);
  if (rule === 'expiry') {
    await client.query('ROLLBACK');
    if (apply) {
      if (process.env.SNIPPET_EXPIRY_APPLY_ALLOWED !== 'true') throw new Error('Refusing to apply: set SNIPPET_EXPIRY_APPLY_ALLOWED=true after the owner approves the dry-run numbers.');
      const restorePoint = argValue('restore-point');
      if (!restorePoint) throw new Error('Refusing to apply: --restore-point=<Neon restore point or branch id> is required (take it first).');
      if (argValue('confirm-workspace') !== context.workspaceId) throw new Error('Refusing to apply: --confirm-workspace must equal the resolved workspace id.');
    }
    // Apply manages its own transaction (the row locks must last until the archive commits); a dry run is read only.
    if (!apply) await client.query('BEGIN READ ONLY');
    try {
      const report = await expireSnippetOnlyJobs(client as unknown as pg.PoolClient, {
        workspaceId: context.workspaceId, apply, actor: 'script:archive_snippet_only_jobs:expiry', restorePoint: argValue('restore-point') ?? undefined,
      });
      if (!apply) await client.query('ROLLBACK');
      console.log(JSON.stringify(report, null, 2));
      console.log(apply ? `APPLIED: archived ${report.archived} of ${report.toArchive}.` : 'DRY RUN: nothing was written.');
      if (apply && report.archived !== report.toArchive) process.exitCode = 1;
    } catch (error) {
      if (!apply) await client.query('ROLLBACK');
      throw error;
    }
    await client.end();
    process.exit(process.exitCode ?? 0);
  }
  const candidates = await findSnippetOnlyArchiveCandidates(client as unknown as pg.PoolClient, { workspaceId: context.workspaceId, minAgeDays });
  await client.query('ROLLBACK');

  const eligible = candidates.filter((c) => !c.protected);
  const protectedJobs = candidates.filter((c) => c.protected);
  const seen = eligible.map((c) => c.lastSeenAt).filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime());
  console.log(JSON.stringify({
    candidates: candidates.length,
    to_archive: eligible.length,
    protected_skipped: protectedJobs.length,
    by_gate_decision: tally(eligible, (c) => c.gateDecision ?? 'none'),
    by_stored_recommendation: tally(eligible, (c) => c.recommendationOutcome ?? 'none'),
    max_snippet_chars: eligible.reduce((m, c) => Math.max(m, c.snippetChars), 0),
    last_seen_oldest: seen[0]?.toISOString() ?? null,
    last_seen_newest: seen[seen.length - 1]?.toISOString() ?? null,
  }, null, 2));

  if (!apply) {
    console.log('DRY RUN: nothing was written.');
  } else {
    if (process.env.ARCHIVE_SNIPPET_APPLY_ALLOWED !== 'true') throw new Error('Refusing to apply: set ARCHIVE_SNIPPET_APPLY_ALLOWED=true after the owner approves the dry-run numbers.');
    const restorePoint = argValue('restore-point');
    if (!restorePoint) throw new Error('Refusing to apply: --restore-point=<Neon restore point or branch id> is required (take it first).');
    if (argValue('confirm-workspace') !== context.workspaceId) throw new Error('Refusing to apply: --confirm-workspace must equal the resolved workspace id.');
    await client.query('BEGIN');
    try {
      // Re-read inside the write transaction: only jobs that are still candidates and still unprotected are archived.
      const fresh = (await findSnippetOnlyArchiveCandidates(client as unknown as pg.PoolClient, { workspaceId: context.workspaceId, minAgeDays })).filter((c) => !c.protected);
      const archived = await archiveJobsAsPostingNotConfirmable(client as unknown as pg.PoolClient, {
        workspaceId: context.workspaceId,
        canonicalJobIds: fresh.map((c) => c.canonicalJobId),
        actor: 'script:archive_snippet_only_jobs',
        details: {
          rule: 'snippet-only-never-fetched',
          min_age_days: minAgeDays,
          restore_point: restorePoint,
          reason: 'Alert snippet only; the posting was never fetched and its state is unknown (not closed).',
        },
      });
      await client.query('COMMIT');
      console.log(`APPLIED: archived ${archived.length} of ${fresh.length} fresh candidates (${eligible.length} at dry run).`);
      if (archived.length !== fresh.length) {
        console.error(`${fresh.length - archived.length} candidate(s) were not archived by the archive transition.`);
        process.exitCode = 1;
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}
