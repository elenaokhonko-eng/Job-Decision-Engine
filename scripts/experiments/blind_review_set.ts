/**
 * Blind review set (read-only, replay branch): 30 jobs the user has NOT saved, ranked by the new
 * top-K score. Only live jobs that passed the hard gate and have a confirmed posting link are eligible; jobs
 * already labelled in an earlier sheet (--exclude=<key.json>, repeatable) are left out. 15 are drawn from the top of the ranking and 15 from the middle, shuffled, with no
 * scores or ranks shown. The sheet goes to the user; the key stays in a separate file so the
 * labels can be scored afterwards.
 *
 *   SCORING_POLICY is not needed: this reads the scores the replay already wrote.
 *   npx tsx scripts/experiments/blind_review_set.ts <sheet.md> <key.json> [--seed=<text>] [--exclude=<earlier key.json> ...]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';
import { pgConnectionConfig } from '../../src/db/pgSsl.js';
import { requireApprovedReplayTarget } from '../../src/reporting/replayGuard.js';
import { LINKEDIN_SAVED_SOURCE_NAME } from '../../src/ingestion/linkedInSavedExport.js';
import { resolveWorkspaceContext } from '../../src/workspace/context.js';

dotenv.config({ path: '.env.local' });

const args = process.argv.slice(2);
const [sheetPath, keyPath] = args.filter((a) => !a.startsWith('--'));
if (!sheetPath || !keyPath) throw new Error('usage: blind_review_set.ts <sheet.md> <key.json> [--seed=<text>] [--exclude=<key.json> ...]');
const flag = (name: string) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const TOP_POOL = 30; // draw 15 from the best 30
const SEED = flag('seed')[0] ?? 'blind-review-2026-11-20';
// Jobs the user has already labelled in an earlier sheet must not come back.
const EXCLUDED_IDS: string[] = flag('exclude').flatMap((file) => {
  const key = JSON.parse(fs.readFileSync(file, 'utf8')) as { items?: Array<{ id: string }> };
  if (!key.items?.length) throw new Error(`${file} has no items to exclude`);
  return key.items.map((item) => item.id);
});
const rank = (id: string) => createHash('sha256').update(`${SEED}:${id}`).digest().readUInt32BE(0);

const url = process.env.REPLAY_DATABASE_URL!.trim();
const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
await client.query('BEGIN READ ONLY');
try {
  const id = await client.query(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
  requireApprovedReplayTarget(url, { databaseName: id.rows[0].d, branchId: id.rows[0].b }, process.env.REPLAY_BRANCH_ID);
  const ws = await resolveWorkspaceContext(client as never);
  const { rows: allRows } = await client.query(
    `SELECT cj.id, cj.company_name, cj.normalized_title AS title, COALESCE(NULLIF(BTRIM(cj.location), ''), 'not stated') AS location, cj.canonical_url, (cj.recommendation_requirement_score * 100)::float AS score,
            COALESCE(av.availability_current, FALSE) AS availability_current,
            (SELECT COUNT(*) FROM requirement_evidence_matches m JOIN job_requirements r ON r.id = m.requirement_id
              WHERE m.match_run_id = cj.latest_match_run_id AND r.importance = 'MUST' AND m.match_type IN ('NO_MATCH','UNKNOWN')
                AND r.requirement_type NOT IN ('EXPERIENCE_YEARS','DEGREE','CREDENTIAL','WORK_AUTH','OFFICE_DAYS','WORK_MODE','EMPLOYMENT_TYPE','TRAVEL','ON_CALL','SHIFT_WORK'))::int AS unmatched_must
     FROM canonical_jobs cj
     JOIN match_runs mr ON mr.id = cj.latest_match_run_id AND mr.status = 'COMPLETED' AND mr.policy_version LIKE '%topk_capability_semantic_v1'
     LEFT JOIN v_job_availability_current av ON av.workspace_id = cj.workspace_id AND av.canonical_job_id = cj.id AND av.job_version_id::text = cj.latest_job_version_id::text
     WHERE cj.workspace_id = $1 AND cj.archived_at IS NULL AND cj.recommendation_requirement_score IS NOT NULL
       AND cj.gate_decision = 'PASS' AND cj.is_test_fixture IS NOT TRUE
       AND COALESCE(cj.processing_state, cj.processing_status) <> 'MANUALLY_REMOVED'
       AND cj.canonical_url ~* '^https?://'
       AND cj.canonical_url !~* '^https?://himalayas\\.app/jobs/([0-9a-f]{16,}|api)'
       AND NOT (cj.id = ANY($3::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM raw_job_observations o JOIN job_versions v ON v.id = o.job_version_id
                       WHERE o.workspace_id = cj.workspace_id AND o.source_name = $2 AND v.canonical_job_id = cj.id)
     ORDER BY cj.recommendation_requirement_score DESC, cj.id`,
    [ws.workspaceId, LINKEDIN_SAVED_SOURCE_NAME, EXCLUDED_IDS],
  );
  // Jobs that passed the gate and have a match but no stored adjusted score yet (not re-decided since migration 121) are not
  // in the pool above: say how many, so the omission is never silent.
  const { rows: notYetDecided } = await client.query(
    `SELECT COUNT(*)::int AS n FROM canonical_jobs cj
      WHERE cj.workspace_id = $1 AND cj.archived_at IS NULL AND cj.gate_decision = 'PASS' AND cj.is_test_fixture IS NOT TRUE
        AND cj.latest_match_run_id IS NOT NULL AND cj.recommendation_requirement_score IS NULL`,
    [ws.workspaceId],
  );
  console.log(`dropped (matched, gate-passed, no adjusted score yet - re-decide first): ${notYetDecided[0]?.n ?? 0}`);
  // A posting is drawn only if the read model says it is currently open (v_job_availability_current,
  // migration 114). This script does not decide that itself; it only counts what was left out.
  const rows = allRows.filter((r) => r.availability_current === true);
  console.log(`eligible jobs ${allRows.length}; currently open ${rows.length}; held back as not confirmed open ${allRows.length - rows.length}`);
  // Defence in depth: nothing the filters above should have removed may be in the pool.
  const bad = rows.filter((r) => !/^https?:\/\//i.test(String(r.canonical_url ?? '')) || EXCLUDED_IDS.includes(r.id));
  if (bad.length > 0) throw new Error(`${bad.length} ineligible job(s) in the pool`);
  if (rows.length < 100) throw new Error(`only ${rows.length} unsaved jobs scored under the new policy; expected the replay to have written them and the availability refresh to have run`);

  const lo = Math.floor(rows.length * 0.4);
  const hi = Math.floor(rows.length * 0.6);
  const top = rows.slice(0, TOP_POOL).sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 15).map((r) => ({ ...r, group: 'TOP' }));
  const middle = rows.slice(lo, hi).sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 15).map((r) => ({ ...r, group: 'MIDDLE' }));
  const picked = [...top, ...middle].sort((a, b) => rank(`x${a.id}`) - rank(`x${b.id}`));

  const sheet = [
    '# Blind review: would you apply?',
    '',
    'Thirty jobs you have not saved. Scores and ranks are hidden. For each, mark **Y** (would apply) or **N** (would not).',
    'Judge the role, not the evidence match. About 10 minutes.',
    '',
    '| # | Title | Company | Location | Link | Apply? (Y/N) |',
    '|---|---|---|---|---|---|',
    ...picked.map((j, i) => `| ${i + 1} | ${String(j.title).replace(/\|/g, '/')} | ${String(j.company_name ?? '').replace(/\|/g, '/')} | ${String(j.location ?? '').replace(/\|/g, '/')} | ${j.canonical_url ?? ''} |  |`),
    '',
  ].join('\n');
  fs.writeFileSync(sheetPath, sheet, 'utf8');
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ pool: rows.length, seed: SEED, items: picked.map((j, i) => ({ n: i + 1, id: j.id, group: j.group, score: j.score, unmatchedMust: j.unmatched_must, title: j.title })) }, null, 2),
    'utf8',
  );
  console.log(`eligible pool (live, gate-passed, linked, unsaved, not previously labelled; ${EXCLUDED_IDS.length} excluded ids): ${rows.length}; wrote ${picked.length} items (${top.length} top, ${middle.length} middle)`);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
