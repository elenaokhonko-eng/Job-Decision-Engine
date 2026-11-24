/**
 * Blind review set (read-only, replay branch): 30 jobs the user has NOT saved, ranked by the new
 * top-K score. Only jobs the Review list could show are eligible (live, gate PASS, complete content, confirmed open, no result awaiting recompute, confirmed posting link; src/reporting/blindReviewPool.ts), and the count left out for each reason is printed; jobs
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
import { loadBlindReviewPool } from '../../src/reporting/blindReviewPool.js';
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
  const pool = await loadBlindReviewPool(client, { workspaceId: ws.workspaceId, savedSourceName: LINKEDIN_SAVED_SOURCE_NAME, excludedIds: EXCLUDED_IDS });
  const rows = pool.rows;
  // Jobs that passed the gate and have a match but no stored adjusted score yet (not re-decided since migration 121) are not
  // in the pool: say how many, so the omission is never silent.
  const { rows: notYetDecided } = await client.query(
    `SELECT COUNT(*)::int AS n FROM canonical_jobs cj
      WHERE cj.workspace_id = $1 AND cj.archived_at IS NULL AND cj.gate_decision = 'PASS' AND cj.is_test_fixture IS NOT TRUE
        AND cj.latest_match_run_id IS NOT NULL AND cj.recommendation_requirement_score IS NULL`,
    [ws.workspaceId],
  );
  console.log(`dropped (matched, gate-passed, no adjusted score yet - re-decide first): ${notYetDecided[0]?.n ?? 0}`);
  console.log(`eligible jobs ${rows.length}; left out by reason: ${Object.entries(pool.excluded).map(([reason, count]) => `${reason}=${count}`).join(', ')}`);
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
