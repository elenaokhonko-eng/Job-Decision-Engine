/**
 * Blind review set (read-only, replay branch): 30 jobs scored under the top-K policy, 15 from the top of the ranking and 15
 * from the middle, shuffled, with no scores or ranks shown. Eligibility is in src/reporting/blindReviewRules.ts: confirmed
 * open on the draw date (Asia/Singapore), LinkedIn and job-board or aggregator leads left out, and no saved, applied-to or
 * previously labelled job (--exclude=<earlier key.json>, repeatable). The count left out for each reason is printed. The sheet goes to the user; the
 * key stays in a separate file so the labels can be scored afterwards.
 *
 *   SCORING_POLICY is not needed: this reads the scores the replay already wrote.
 *   npx tsx scripts/experiments/blind_review_set.ts <sheet.md> <key.json> [--seed=<text>] [--exclude=<earlier key.json> ...]
 */
import fs from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';
import { pgConnectionConfig } from '../../src/db/pgSsl.js';
import { requireApprovedReplayTarget, requireReplayDatabaseUrl } from '../../src/reporting/replayGuard.js';
import { loadBlindReviewPool } from '../../src/reporting/blindReviewPool.js';
import {
  blindReviewPoolSummary,
  drawBlindReview,
  labelledIdsFromKeys,
  parseBlindReviewArgs,
  renderBlindReviewKey,
  renderBlindReviewSheet,
} from '../../src/reporting/blindReviewDraw.js';
import { resolveWorkspaceContext } from '../../src/workspace/context.js';

dotenv.config({ path: '.env.local' });

const { sheetPath, keyPath, seed, excludeKeyPaths } = parseBlindReviewArgs(process.argv.slice(2));
const excludedIds = labelledIdsFromKeys(excludeKeyPaths, (file) => fs.readFileSync(file, 'utf8'));

const url = requireReplayDatabaseUrl(process.env.REPLAY_DATABASE_URL);
const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
await client.query('BEGIN READ ONLY');
try {
  const id = await client.query(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
  requireApprovedReplayTarget(url, { databaseName: id.rows[0].d, branchId: id.rows[0].b }, process.env.REPLAY_BRANCH_ID);
  const ws = await resolveWorkspaceContext(client as never);
  const pool = await loadBlindReviewPool(client, { workspaceId: ws.workspaceId, excludedIds, now: new Date() });
  console.log(blindReviewPoolSummary(pool));

  const picked = drawBlindReview(pool, seed);
  fs.writeFileSync(sheetPath, renderBlindReviewSheet(picked, pool), 'utf8');
  fs.writeFileSync(keyPath, renderBlindReviewKey(picked, pool, seed), 'utf8');
  console.log(`wrote ${picked.length} items (${picked.filter((j) => j.group === 'TOP').length} top, ${picked.filter((j) => j.group === 'MIDDLE').length} middle); ${excludedIds.length} labelled ids excluded`);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
