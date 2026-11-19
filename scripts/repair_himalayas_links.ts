/**
 * Repair of Himalayas jobs stored with an invented posting link (himalayas.app/jobs/<hash>) or the API
 * address, and with location "Unknown", before the adapter read the feed's real field names
 * (guid, applicationLink, locationRestrictions; PR #198).
 *
 *   npx tsx scripts/repair_himalayas_links.ts --target replay        # dry run (the default), read only
 *   npx tsx scripts/repair_himalayas_links.ts --target production    # dry run on production, read only
 *   ... --rescue-file=private/review/himalayas_rescue.json           # also write the rescue list (local file)
 *
 * APPLY (guarded; only with the owner's approval of the dry-run numbers):
 *   REPAIR_APPLY_ALLOWED=true npx tsx scripts/repair_himalayas_links.ts --target production --apply \
 *     --confirm-workspace=<workspace uuid> --restore-point=<Neon restore point / branch id>
 *
 * What apply does, in ONE transaction scoped to active Himalayas jobs with an invented/API link or an
 * Unknown location:
 *   1. Repairs the link and/or location only where the stored payload proves it (a real http(s) URL in
 *      jobUrl/url/guid/applicationLink; locationRestrictions, empty meaning remote worldwide). A new link
 *      already held by another job is skipped and counted (never merged).
 *   2. Archives the jobs whose real link was never stored as POSTING_NOT_CONFIRMABLE, reversible through
 *      restoreArchivedJob. They are not marked closed: whether they are open is unknown.
 *   3. KEEPS (no change, logged KEPT_FOR_RESCUE) jobs that passed the gates and reached Review/Priority,
 *      so their real posting can be searched by employer and title first.
 *   4. Writes every old and new value to himalayas_link_repair_log (migration 113) with the restore point.
 * After the commit it re-gates the repaired jobs and prints how many changed gate outcome.
 * Closing expired postings from expiryDate is a separate step with its own count.
 *
 * Output prints counts and ids only. Employer names appear only in the local rescue file.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import { pgConnectionConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';
import { archiveJobsAsPostingNotConfirmable } from '../src/services/jobArchive.js';
import { regateJobIds } from './regate_job_ids.js';

dotenv.config({ path: '.env.local' });

const argv = process.argv.slice(2);
const argValue = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() || null : null;
};
const target = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : '';
if (target !== 'replay' && target !== 'production') throw new Error('usage: --target replay|production [--apply ...]');
const apply = argv.includes('--apply');

const url = (target === 'replay' ? process.env.REPLAY_DATABASE_URL : process.env.DATABASE_URL)?.trim();
if (!url) throw new Error(`${target} database url is not set`);

const INVENTED = /^https?:\/\/himalayas\.app\/jobs\/(?:[0-9a-f]{16,}|api(?:\?.*)?)$/i;

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Same rule as the adapter: restrictions joined; an empty list on this remote feed is remote, anywhere. */
function locationFrom(payload: Record<string, unknown>): string | null {
  const direct = payload.location ?? payload.locationRaw;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const restrictions = payload.locationRestrictions;
  if (!Array.isArray(restrictions)) return null;
  const places = restrictions.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  return places.length > 0 ? places.join(', ') : 'Remote, worldwide';
}

const redact = (link: string | null) => (link ? link.replace(/\/companies\/[^/]+\//, '/companies/<employer>/') : null);

interface Plan {
  jobId: string;
  oldUrl: string | null;
  oldLocation: string | null;
  newUrl: string | null;
  newLocation: string | null;
  brokenLink: boolean;
  gate: string | null;
  outcome: string | null;
  company: string;
  title: string;
}

async function buildPlans(client: pg.PoolClient | pg.Client, workspaceId: string | null) {
  const { rows } = await client.query(
    `SELECT cj.id::text AS job_id, cj.canonical_url, cj.location, cj.archived_at IS NOT NULL AS archived,
            cj.gate_decision, cj.recommendation_outcome, cj.company_name, cj.normalized_title, o.raw_payload
       FROM canonical_jobs cj
       JOIN LATERAL (
         SELECT o.raw_payload FROM raw_job_observations o
           JOIN job_versions v ON v.id = o.job_version_id
          WHERE v.canonical_job_id = cj.id AND o.source_name = 'HIMALAYAS'
          ORDER BY o.id DESC LIMIT 1) o ON TRUE
      WHERE cj.canonical_url ILIKE '%himalayas.app%'
        AND ($1::uuid IS NULL OR cj.workspace_id = $1::uuid)`,
    [workspaceId],
  );
  const plans: Plan[] = [];
  let archived = 0;
  let alreadyOk = 0;
  for (const row of rows) {
    const payload = (typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload) ?? {};
    const brokenLink = INVENTED.test(String(row.canonical_url ?? ''));
    const unknownLocation = !row.location || row.location === 'Unknown';
    if (!brokenLink && !unknownLocation) { alreadyOk++; continue; }
    if (row.archived) { archived++; continue; }
    plans.push({
      jobId: row.job_id,
      oldUrl: row.canonical_url,
      oldLocation: row.location,
      newUrl: brokenLink ? (httpUrl(payload.jobUrl) ?? httpUrl(payload.url) ?? httpUrl(payload.guid) ?? httpUrl(payload.applicationLink)) : null,
      newLocation: unknownLocation ? locationFrom(payload) : null,
      brokenLink,
      gate: row.gate_decision,
      outcome: row.recommendation_outcome,
      company: row.company_name,
      title: row.normalized_title,
    });
  }
  return { plans, rowsTotal: rows.length, archived, alreadyOk };
}

/** Passed the gates and reached Review or Priority: keep for a search of the real posting first. */
const needsRescue = (p: Plan) => p.gate === 'PASS' && (p.outcome === 'REVIEW' || p.outcome === 'PRIORITY');

function summarize(plans: Plan[]) {
  const linkRepairable = plans.filter((p) => p.brokenLink && p.newUrl);
  const unlinked = plans.filter((p) => p.brokenLink && !p.newUrl);
  const rescue = unlinked.filter(needsRescue);
  const toArchive = unlinked.filter((p) => !needsRescue(p));
  const locationRepairable = plans.filter((p) => p.newLocation);
  return { linkRepairable, unlinked, rescue, toArchive, locationRepairable };
}

const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const id = await client.query(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
  console.log(`target=${target} database=${id.rows[0].d} branch=${id.rows[0].b} mode=${apply ? 'APPLY' : 'DRY RUN'}`);
  if (target === 'replay' && (!process.env.REPLAY_BRANCH_ID || id.rows[0].b !== process.env.REPLAY_BRANCH_ID)) throw new Error('refusing: the replay database is not the branch named in REPLAY_BRANCH_ID');

  const { plans, rowsTotal, archived, alreadyOk } = await buildPlans(client, null);
  const s = summarize(plans);
  await client.query('ROLLBACK');

  console.log(JSON.stringify({
    himalayas_rows: rowsTotal, in_scope_active: plans.length, archived_skipped: archived, already_ok: alreadyOk,
    link_repairable: s.linkRepairable.length,
    link_not_recoverable: s.unlinked.length,
    of_those_kept_for_rescue_search_review_or_priority: s.rescue.length,
    of_those_to_archive_posting_not_confirmable: s.toArchive.length,
    location_unknown_repairable: s.locationRepairable.length,
  }, null, 2));
  console.log('five before/after examples (employer hidden):');
  console.table(s.linkRepairable.slice(0, 5).map((p) => ({ before_link: redact(p.oldUrl), after_link: redact(p.newUrl), before_location: p.oldLocation, after_location: p.newLocation })));

  const rescueFile = argValue('rescue-file');
  if (rescueFile) {
    fs.writeFileSync(rescueFile, JSON.stringify(s.rescue.map((p) => ({ canonical_job_id: p.jobId, employer: p.company, title: p.title, stored_link: p.oldUrl })), null, 2));
    console.log(`rescue list (${s.rescue.length}) written to ${rescueFile} (local file, contains employer names)`);
  }

  if (!apply) {
    console.log('DRY RUN: nothing was written.');
  } else {
    if (process.env.REPAIR_APPLY_ALLOWED !== 'true') throw new Error('Refusing to apply: set REPAIR_APPLY_ALLOWED=true after the owner approves the dry-run numbers.');
    const restorePoint = argValue('restore-point');
    if (!restorePoint) throw new Error('Refusing to apply: --restore-point=<Neon restore point or branch id> is required (take it first).');
    await client.query('BEGIN READ ONLY');
    const context = await resolveWorkspaceContext(client as unknown as pg.PoolClient);
    await client.query('ROLLBACK');
    if (argValue('confirm-workspace') !== context.workspaceId) throw new Error('Refusing to apply: --confirm-workspace must equal the resolved workspace id.');

    const gateBefore = new Map(plans.map((p) => [p.jobId, `${p.gate}/${p.outcome}`]));
    const repairRunId = randomUUID();
    let linkRepaired = 0, locationRepaired = 0, conflicts = 0, archivedCount = 0;
    const touched: string[] = [];

    await client.query('BEGIN');
    try {
      const fresh = await buildPlans(client, context.workspaceId);
      const f = summarize(fresh.plans);
      const log = (p: Plan, action: string, newUrl: string | null, newLocation: string | null) => client.query(
        `INSERT INTO himalayas_link_repair_log (workspace_id, canonical_job_id, repair_run_id, action, old_canonical_url, new_canonical_url, old_location, new_location, restore_point)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [context.workspaceId, p.jobId, repairRunId, action, p.oldUrl, newUrl, p.oldLocation, newLocation, restorePoint],
      );
      for (const p of fresh.plans) {
        if (!p.newUrl && !p.newLocation) continue;
        let newUrl = p.newUrl;
        if (newUrl) {
          const clash = await client.query(`SELECT 1 FROM canonical_jobs WHERE workspace_id = $1 AND canonical_url = $2 AND id <> $3 LIMIT 1`, [context.workspaceId, newUrl, p.jobId]);
          if (clash.rowCount) { conflicts++; newUrl = null; }
        }
        if (!newUrl && !p.newLocation) continue;
        await client.query(
          `UPDATE canonical_jobs SET canonical_url = COALESCE($3, canonical_url), location = COALESCE($4, location), updated_at = NOW()
            WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL`,
          [context.workspaceId, p.jobId, newUrl, p.newLocation],
        );
        await log(p, newUrl && p.newLocation ? 'LINK_AND_LOCATION_REPAIRED' : newUrl ? 'LINK_REPAIRED' : 'LOCATION_REPAIRED', newUrl, p.newLocation);
        if (newUrl) linkRepaired++;
        if (p.newLocation) locationRepaired++;
        touched.push(p.jobId);
      }
      for (const p of f.rescue) await log(p, 'KEPT_FOR_RESCUE', null, null);
      const done = await archiveJobsAsPostingNotConfirmable(client as unknown as pg.PoolClient, {
        workspaceId: context.workspaceId,
        canonicalJobIds: f.toArchive.map((p) => p.jobId),
        actor: 'script:repair_himalayas_links',
        details: { repair_run_id: repairRunId, restore_point: restorePoint, reason: 'Himalayas real posting link was never stored; posting state unknown (not closed).' },
      });
      archivedCount = done.length;
      for (const p of f.toArchive) if (done.includes(p.jobId)) await log(p, 'ARCHIVED_NOT_CONFIRMABLE', null, null);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log(JSON.stringify({ repair_run_id: repairRunId, link_repaired: linkRepaired, location_repaired: locationRepaired, new_link_already_held_by_another_job_skipped: conflicts, archived_posting_not_confirmable: archivedCount }, null, 2));

    // Re-gate the changed jobs (a repaired location can change the location gate) and report outcome changes.
    const pool = new pg.Pool({ ...pgConnectionConfig(url), max: 2 });
    try {
      const outcome = await regateJobIds(pool, context, touched);
      console.log(`re-gate: eligible=${outcome.eligible} re-gated=${outcome.regated} errors=${outcome.errors} skipped=${outcome.skipped.length}`);
      const after = await pool.query(`SELECT id::text AS id, gate_decision, recommendation_outcome FROM canonical_jobs WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [context.workspaceId, touched]);
      const changed = after.rows.filter((r) => gateBefore.get(r.id) !== `${r.gate_decision}/${r.recommendation_outcome}`);
      const transitions: Record<string, number> = {};
      for (const r of changed) {
        const key = `${gateBefore.get(r.id)} -> ${r.gate_decision}/${r.recommendation_outcome}`;
        transitions[key] = (transitions[key] ?? 0) + 1;
      }
      console.log(`jobs whose gate/outcome changed after re-gate: ${changed.length} of ${touched.length}`, JSON.stringify(transitions));
      if (!outcome.ok) process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
} finally {
  await client.end();
}
