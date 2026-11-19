/**
 * Repair of Himalayas jobs stored with an invented posting link (himalayas.app/jobs/<hash>) or the API
 * address, and with location "Unknown", before the adapter read the feed's real field names
 * (guid, applicationLink, locationRestrictions).
 *
 *   npx tsx scripts/repair_himalayas_links.ts --target replay        # dry run (the default), read only
 *   npx tsx scripts/repair_himalayas_links.ts --target production    # dry run on production, read only
 *
 * This file is the DRY RUN only. It reports counts and five before/after examples with the employer
 * hidden, and writes nothing. The apply step (one transaction, old values kept in a repair log, a Neon
 * restore point first, then a re-gate of the changed jobs) is added after the owner approves the numbers.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { pgConnectionConfig } from '../src/db/pgSsl.js';

dotenv.config({ path: '.env.local' });

const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : '';
if (target !== 'replay' && target !== 'production') throw new Error('usage: --target replay|production');
if (process.argv.includes('--apply')) throw new Error('--apply is not implemented yet: this is the dry run');

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

const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
await client.query('BEGIN READ ONLY');
try {
  const id = await client.query(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
  console.log(`target=${target} database=${id.rows[0].d} branch=${id.rows[0].b}`);
  if (target === 'replay' && (!process.env.REPLAY_BRANCH_ID || id.rows[0].b !== process.env.REPLAY_BRANCH_ID)) throw new Error('refusing: the replay database is not the branch named in REPLAY_BRANCH_ID');

  const { rows } = await client.query(
    `SELECT cj.id::text AS job_id, cj.canonical_url, cj.location, cj.archived_at IS NOT NULL AS archived,
            o.raw_payload
       FROM canonical_jobs cj
       JOIN LATERAL (
         SELECT o.raw_payload FROM raw_job_observations o
           JOIN job_versions v ON v.id = o.job_version_id
          WHERE v.canonical_job_id = cj.id AND o.source_name = 'HIMALAYAS'
          ORDER BY o.id DESC LIMIT 1) o ON TRUE
      WHERE cj.canonical_url ILIKE '%himalayas.app%'`,
  );

  let scoped = 0, archived = 0, noPayloadLink = 0, repairableLink = 0, locationUnknown = 0, locationRepairable = 0, alreadyOk = 0;
  const examples: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const payload = (typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload) ?? {};
    const brokenLink = INVENTED.test(String(row.canonical_url ?? ''));
    const unknownLocation = !row.location || row.location === 'Unknown';
    if (!brokenLink && !unknownLocation) { alreadyOk++; continue; }
    if (row.archived) { archived++; continue; }
    scoped++;
    const newLink = httpUrl(payload.jobUrl) ?? httpUrl(payload.url) ?? httpUrl(payload.guid) ?? httpUrl(payload.applicationLink);
    const newLocation = locationFrom(payload);
    if (brokenLink) { if (newLink) repairableLink++; else noPayloadLink++; }
    if (unknownLocation) { locationUnknown++; if (newLocation) locationRepairable++; }
    if (examples.length < 5 && brokenLink && newLink) {
      examples.push({ before_link: redact(row.canonical_url), after_link: redact(newLink), before_location: row.location, after_location: newLocation });
    }
  }
  console.log(JSON.stringify({ himalayas_rows: rows.length, in_scope_active: scoped, archived_skipped: archived, already_ok: alreadyOk, link_repairable: repairableLink, link_no_valid_url_in_payload: noPayloadLink, location_unknown: locationUnknown, location_repairable: locationRepairable }, null, 2));
  console.log('five before/after examples (employer hidden):');
  console.table(examples);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
