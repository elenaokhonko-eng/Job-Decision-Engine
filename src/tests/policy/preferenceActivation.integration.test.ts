import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isLocalPostgresConnectionString, pgConnectionConfig } from '../../db/pgSsl.js';
import { runMigrations } from '../../db/migrate.js';
import {
  PREFERENCE_ACTIVATION_ENV_FLAG,
  PreferenceActivationRefusal,
  runPreferenceActivation,
  type PreferenceActivationReport,
} from '../../policy/preferenceActivation.js';
import { MobilityPreferencesSchema, STAGE3_SCHEMA_VERSION } from '../../policy/stage3Contracts.js';
import { saveWorkspacePreferenceRevision } from '../../policy/workspacePreferenceRegistry.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../../workspace/context.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === 'true' && skipReal) {
  throw new Error('CI must run the preference activation tests against its PostgreSQL service.');
}
const ONSITE_FIELD_KNOWN = 'onsite_exception_employers' in MobilityPreferencesSchema.shape;

// Synthetic preferences only.
const LANE_INTENT = {
  schema_version: '1.0.0',
  lane_weights: {
    CORE_AI_DATA: 30,
    LEGAL_REGTECH: 20,
    UNIVERSITY_AI_RESEARCH: 10,
    HEALTH_BIO_PHARMA: 20,
    INVESTMENT_MARKETS_FINTECH: 15,
    SOCIAL_IMPACT_MULTILATERAL: 5,
  },
  lane_preferences: {},
  cross_lane_work_style_signals: { positive: [], negative: [] },
};
const STAGE3 = {
  schema_version: STAGE3_SCHEMA_VERSION,
  mobility: { travel_max_pct: 10, living_travel_excluded_regions: ['Region A'] },
  employment_structure: {},
  compensation: {},
  freshness: { max_posting_age_days: 30 },
  watchlist: { watchlist_companies: ['Alpha Fixture Labs', 'Beta Fixture Works'] },
};
const FILE = {
  lane_intent: LANE_INTENT,
  mobility: { travel_max_pct: 25, living_travel_excluded_regions: ['Region A'] },
  watchlist: {
    watchlist_companies: ['Alpha Fixture Labs', 'Gamma Fixture Systems', 'Delta Fixture Data'],
    excluded_employers: ['Omega Fixture Agency'],
  },
  work_mode: { preferred: ['REMOTE'] },
};

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = '';
let context: WorkspaceContext | undefined;
let fileText = JSON.stringify(FILE);

function db(): pg.PoolClient {
  if (!client) throw new Error('Test client is not initialized.');
  return client;
}
function ctx(): WorkspaceContext {
  if (!context) throw new Error('Test workspace is not initialized.');
  return context;
}

const ENV = { [PREFERENCE_ACTIVATION_ENV_FLAG]: 'true' };
// Every run names its target. The tests always hand back the test client, so a different
// URL below models "the same command pointed at another database" without a second server.
const TARGET_URL = 'postgres://fixture_user:fixture-secret-pw@localhost:47999/fixturedb';
const OTHER_TARGET_URL = 'postgres://fixture_user:fixture-secret-pw@other-host.example.test:47999/fixturedb';
let envFileText = '';
const connectedUrls: string[] = [];

function connectTestClient(target: { databaseUrl: string }) {
  connectedUrls.push(target.databaseUrl);
  return Promise.resolve({ client: db(), close: async () => undefined });
}
function run(argv: string[], env: Record<string, string> = {}): Promise<PreferenceActivationReport> {
  return runPreferenceActivation({
    argv: ['--file=fixture.json', ...argv],
    env: { DATABASE_URL: TARGET_URL, ...env },
    readFile: async (filePath) => (filePath.endsWith('.env') ? envFileText : fileText),
    connect: connectTestClient,
  });
}
function runRollback(argv: string[], env: Record<string, string> = {}): Promise<PreferenceActivationReport> {
  return runPreferenceActivation({
    argv,
    env: { DATABASE_URL: TARGET_URL, ...env },
    readFile: async () => { throw new Error('A rollback must not read the preferences file.'); },
    connect: connectTestClient,
  });
}
function applyArgs(diffHash: string, extra: string[] = []): string[] {
  return [
    '--apply',
    `--confirm-workspace=${ctx().workspaceId}`,
    `--expect-diff-hash=${diffHash}`,
    '--operator=fixture-operator',
    '--reason=fixture activation',
    ...extra,
  ];
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PreferenceActivationRefusal) return error.code;
    throw error;
  }
  throw new Error('Expected a refusal.');
}

async function counts(): Promise<{ revisions: number; events: number; audits: number }> {
  const { rows } = await db().query<{ revisions: number; events: number; audits: number }>(
    `SELECT (SELECT count(*)::int FROM workspace_user_preference_revisions) AS revisions,
            (SELECT count(*)::int FROM workspace_user_preference_activation_events) AS events,
            (SELECT count(*)::int FROM workspace_user_preference_change_audit) AS audits`,
  );
  return rows[0] as { revisions: number; events: number; audits: number };
}
async function activeRevision(domain: string): Promise<{ id: string; hash: string; value: any }> {
  const { rows } = await db().query<{ id: string; hash: string; value: any }>(
    `SELECT r.id::text AS id, r.preference_hash AS hash, r.preference_value AS value
     FROM workspace_user_preference_active_versions a
     JOIN workspace_user_preference_revisions r ON r.id = a.revision_id
     WHERE a.workspace_id = $1 AND a.user_id = $2 AND a.preference_domain = $3`,
    [ctx().workspaceId, ctx().userId, domain],
  );
  const row = rows[0];
  if (!row) throw new Error(`No active ${domain} revision.`);
  return row;
}

describe.skipIf(skipReal)('preference activation (PostgreSQL)', () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `preference_activation_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    await client.query('BEGIN');
    for (const [domain, value] of [['lane_intent', LANE_INTENT], ['stage3', STAGE3]] as const) {
      await saveWorkspacePreferenceRevision(client, context, {
        preferenceDomain: domain,
        schemaVersion: value.schema_version,
        preferenceValue: value,
        activate: true,
      });
    }
    await client.query('COMMIT');
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query('RESET search_path').catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
  });

  beforeEach(() => {
    fileText = JSON.stringify(FILE);
  });

  it('a dry run reports the field diff and hashes in a READ ONLY transaction and writes nothing', async () => {
    const before = await counts();
    const stage3 = await activeRevision('stage3');
    const report = await run(['--only=watchlist.watchlist_companies,mobility.travel_max_pct']);
    expect(report.mode).toBe('DRY_RUN');
    expect(report.workspaceId).toBe(ctx().workspaceId);
    expect(report.auditTableReady).toBe(true);
    expect(report.domains).toEqual([expect.objectContaining({
      domain: 'stage3',
      activeRevisionId: stage3.id,
      activePreferenceHash: stage3.hash,
      changed: true,
    })]);
    expect(report.domains[0]?.proposedPreferenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.domains[0]?.proposedPreferenceHash).not.toBe(stage3.hash);
    expect(report.changes).toEqual([
      { path: 'stage3.mobility.travel_max_pct', change: 'CHANGED', valueKind: 'value' },
      { path: 'stage3.watchlist.watchlist_companies', change: 'CHANGED', valueKind: 'list', itemsAdded: 2, itemsRemoved: 1 },
    ]);
    expect(JSON.stringify(report)).not.toContain('Gamma Fixture Systems');
    expect(report.followUps.map((followUp) => followUp.stage)).toEqual(['HARD_GATE', 'APPLICATION_RANKING']);
    expect(report.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.nextStep).toContain(`--expect-diff-hash=${report.diffHash}`);
    expect(await counts()).toEqual(before);

    const withValues = await run(['--only=watchlist.watchlist_companies', '--show-values']);
    expect(withValues.valuesShown).toBe(true);
    expect(withValues.changes[0]).toMatchObject({ addedItems: ['Gamma Fixture Systems', 'Delta Fixture Data'], removedItems: ['Beta Fixture Works'] });
  });

  it('refuses a mismatched diff hash, a wrong workspace and a missing audit table without writing', async () => {
    const before = await counts();
    const activeBefore = await activeRevision('stage3');
    const dry = await run(['--only=watchlist.watchlist_companies']);

    expect(await refusal(run(['--only=watchlist.watchlist_companies', ...applyArgs('b'.repeat(64))], ENV))).toBe('DIFF_HASH_MISMATCH');
    // Same reviewed hash, but a different file: the hash no longer matches.
    fileText = JSON.stringify({ ...FILE, watchlist: { watchlist_companies: ['Epsilon Fixture Co'] } });
    expect(await refusal(run(['--only=watchlist.watchlist_companies', ...applyArgs(dry.diffHash)], ENV))).toBe('DIFF_HASH_MISMATCH');
    fileText = JSON.stringify(FILE);
    // Same file, but a different selection.
    expect(await refusal(run(['--only=watchlist', ...applyArgs(dry.diffHash)], ENV))).toBe('DIFF_HASH_MISMATCH');

    const wrongWorkspace = applyArgs(dry.diffHash).map((arg) => arg.startsWith('--confirm-workspace=') ? `--confirm-workspace=${randomUUID()}` : arg);
    expect(await refusal(run(['--only=watchlist.watchlist_companies', ...wrongWorkspace], ENV))).toBe('CONFIRM_WORKSPACE_MISMATCH');

    // Hide migration 108's table. The search path is narrowed to the test schema so that a
    // copy migrated into public by another suite on the same database cannot stand in for it.
    await db().query('ALTER TABLE workspace_user_preference_change_audit RENAME TO workspace_user_preference_change_audit_hidden');
    await db().query(`SET search_path TO ${schemaName}`);
    try {
      expect(await refusal(run(['--only=watchlist.watchlist_companies', ...applyArgs(dry.diffHash)], ENV))).toBe('AUDIT_TABLE_MISSING');
    } finally {
      await db().query(`SET search_path TO ${schemaName}, public`);
      await db().query('ALTER TABLE workspace_user_preference_change_audit_hidden RENAME TO workspace_user_preference_change_audit');
    }

    expect(await counts()).toEqual(before);
    expect((await activeRevision('stage3')).id).toBe(activeBefore.id);
  });

  it('refuses unknown fields and schema failures without writing', async () => {
    const before = await counts();
    fileText = JSON.stringify({ ...FILE, mobility: { ...FILE.mobility, undeclared_field: ['x'] } });
    expect(await refusal(run(['--only=mobility']))).toBe('UNKNOWN_FIELD');
    fileText = JSON.stringify({ ...FILE, mobility: { travel_max_pct: 400 } });
    expect(await refusal(run(['--only=mobility.travel_max_pct']))).toBe('SCHEMA_VALIDATION_FAILED');
    fileText = JSON.stringify({ ...FILE, lane_intent: { ...LANE_INTENT, lane_weights: { ...LANE_INTENT.lane_weights, CORE_AI_DATA: 31 } } });
    expect(await refusal(run(['--only=lane_intent']))).toBe('SCHEMA_VALIDATION_FAILED');
    if (!ONSITE_FIELD_KNOWN) {
      expect(await refusal(run(['--only=mobility.onsite_exception_employers']))).toBe('UNKNOWN_FIELD');
    }
    expect(await counts()).toEqual(before);
  });

  it('a failure after the revision insert rolls the whole activation back', async () => {
    const before = await counts();
    const activeBefore = await activeRevision('stage3');
    const dry = await run(['--only=watchlist.watchlist_companies']);
    await db().query(`
      CREATE FUNCTION ${schemaName}.fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture audit failure'; END; $$`);
    await db().query(`CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON workspace_user_preference_change_audit
      FOR EACH ROW EXECUTE FUNCTION ${schemaName}.fixture_fail_audit()`);
    try {
      await expect(run(['--only=watchlist.watchlist_companies', ...applyArgs(dry.diffHash)], ENV)).rejects.toThrow('fixture audit failure');
    } finally {
      await db().query('DROP TRIGGER fixture_fail_audit ON workspace_user_preference_change_audit');
      await db().query(`DROP FUNCTION ${schemaName}.fixture_fail_audit()`);
    }
    expect(await counts()).toEqual(before);
    expect((await activeRevision('stage3')).id).toBe(activeBefore.id);
  });

  it('applies exactly the reviewed change, keeps the previous revision, audits it, and rolls back', async () => {
    const before = await counts();
    const previous = await activeRevision('stage3');
    const dry = await run(['--only=watchlist.watchlist_companies']);

    const applied = await run(['--only=watchlist.watchlist_companies', ...applyArgs(dry.diffHash)], ENV);
    expect(applied.mode).toBe('APPLIED');
    expect(applied.diffHash).toBe(dry.diffHash);
    const domain = applied.domains[0];
    expect(domain).toMatchObject({ domain: 'stage3', activeRevisionId: previous.id, revisionReused: false });

    const current = await activeRevision('stage3');
    expect(current.id).toBe(domain?.newRevisionId);
    expect(current.hash).toBe(dry.domains[0]?.proposedPreferenceHash);
    expect(current.value.watchlist.watchlist_companies).toEqual(['Alpha Fixture Labs', 'Gamma Fixture Systems', 'Delta Fixture Data']);
    // Only the selected field changed: the rest of the active revision is kept.
    expect(current.value.watchlist.excluded_employers).toBeUndefined();
    expect(current.value.mobility).toEqual(STAGE3.mobility);
    expect(await counts()).toEqual({ revisions: before.revisions + 1, events: before.events + 1, audits: before.audits + 1 });

    const kept = await db().query('SELECT 1 FROM workspace_user_preference_revisions WHERE id = $1', [previous.id]);
    expect(kept.rowCount).toBe(1);
    const audit = await db().query(
      `SELECT a.action, a.previous_revision_id::text AS previous, a.active_revision_id::text AS active,
              a.diff_hash, a.operator, a.reason, a.changed_paths, a.tool, e.action AS event_action
       FROM workspace_user_preference_change_audit a
       JOIN workspace_user_preference_activation_events e ON e.id = a.activation_event_id
       WHERE a.id = $1`,
      [domain?.auditId],
    );
    expect(audit.rows[0]).toEqual({
      action: 'APPLY',
      previous: previous.id,
      active: current.id,
      diff_hash: dry.diffHash,
      operator: 'fixture-operator',
      reason: 'fixture activation',
      changed_paths: ['stage3.watchlist.watchlist_companies'],
      tool: 'scripts/activate_workspace_preferences.ts',
      event_action: 'SWITCH',
    });

    // The same apply again is refused: nothing left to activate.
    expect(await refusal(run(['--only=watchlist.watchlist_companies', ...applyArgs(dry.diffHash)], ENV))).toBe('NO_CHANGE');
    expect((await run(['--only=watchlist.watchlist_companies'])).domains[0]?.changed).toBe(false);

    // Audit rows are append-only.
    await expect(db().query('UPDATE workspace_user_preference_change_audit SET reason = $1', ['edited'])).rejects.toThrow(/append-only/);
    await expect(db().query('DELETE FROM workspace_user_preference_change_audit')).rejects.toThrow(/append-only/);
    await expect(db().query('TRUNCATE workspace_user_preference_change_audit')).rejects.toThrow(/append-only \(TRUNCATE rejected\)/);
    expect((await counts()).audits).toBe(before.audits + 1);

    // Rollback: guarded the same way, re-activates the stored revision without creating one.
    expect(await refusal(runRollback([`--rollback-to=${current.id}`]))).toBe('ROLLBACK_REVISION_ALREADY_ACTIVE');
    expect(await refusal(runRollback([`--rollback-to=${randomUUID()}`]))).toBe('ROLLBACK_REVISION_NOT_FOUND');
    const rollbackDry = await runRollback([`--rollback-to=${previous.id}`]);
    expect(rollbackDry.mode).toBe('DRY_RUN');
    expect(rollbackDry.action).toBe('ROLLBACK');
    expect(rollbackDry.changes).toEqual([
      { path: 'stage3.watchlist.watchlist_companies', change: 'CHANGED', valueKind: 'list', itemsAdded: 1, itemsRemoved: 2 },
    ]);
    expect(rollbackDry.diffHash).not.toBe(dry.diffHash);
    expect(await refusal(runRollback([`--rollback-to=${previous.id}`, '--apply', `--confirm-workspace=${ctx().workspaceId}`, `--expect-diff-hash=${rollbackDry.diffHash}`, '--operator=fixture-operator', '--reason=fixture rollback']))).toBe('APPLY_ENV_FLAG_MISSING');
    expect(await refusal(runRollback([`--rollback-to=${previous.id}`, ...applyArgs(dry.diffHash)], ENV))).toBe('DIFF_HASH_MISMATCH');

    const afterApply = await counts();
    const rolledBack = await runRollback([`--rollback-to=${previous.id}`, ...applyArgs(rollbackDry.diffHash)], ENV);
    expect(rolledBack.mode).toBe('APPLIED');
    expect((await activeRevision('stage3')).id).toBe(previous.id);
    expect(await counts()).toEqual({ revisions: afterApply.revisions, events: afterApply.events + 1, audits: afterApply.audits + 1 });
    const rollbackAudit = await db().query(
      `SELECT action, previous_revision_id::text AS previous, active_revision_id::text AS active
       FROM workspace_user_preference_change_audit WHERE id = $1`,
      [rolledBack.domains[0]?.auditId],
    );
    expect(rollbackAudit.rows[0]).toEqual({ action: 'ROLLBACK', previous: current.id, active: previous.id });
  });

  it('refuses an apply whose starting revision changed after the dry run', async () => {
    const dry = await run(['--only=mobility.travel_max_pct']);
    // Someone else activates a different stage3 revision in between.
    await db().query('BEGIN');
    await saveWorkspacePreferenceRevision(db(), ctx(), {
      preferenceDomain: 'stage3',
      schemaVersion: STAGE3_SCHEMA_VERSION,
      preferenceValue: { ...STAGE3, freshness: { max_posting_age_days: 45 } },
      activate: true,
    });
    await db().query('COMMIT');
    const before = await counts();
    expect(await refusal(run(['--only=mobility.travel_max_pct', ...applyArgs(dry.diffHash)], ENV))).toBe('DIFF_HASH_MISMATCH');
    expect(await counts()).toEqual(before);
  });

  it('activates lane_intent and stage3 together in one transaction', async () => {
    fileText = JSON.stringify({
      ...FILE,
      lane_intent: { ...LANE_INTENT, lane_weights: { ...LANE_INTENT.lane_weights, CORE_AI_DATA: 25, LEGAL_REGTECH: 25 } },
    });
    const before = await counts();
    const dry = await run(['--only=lane_intent.lane_weights,mobility.travel_max_pct']);
    expect(dry.domains.map((domain) => domain.domain)).toEqual(['lane_intent', 'stage3']);
    expect(dry.followUps.map((followUp) => followUp.stage)).toEqual(['HARD_GATE', 'LANE_ROUTING', 'RECOMMENDATION', 'APPLICATION_RANKING']);
    const applied = await run(['--only=lane_intent.lane_weights,mobility.travel_max_pct', ...applyArgs(dry.diffHash)], ENV);
    expect(applied.domains.every((domain) => domain.auditId)).toBe(true);
    expect(await counts()).toEqual({ revisions: before.revisions + 2, events: before.events + 2, audits: before.audits + 2 });
    expect((await activeRevision('lane_intent')).value.lane_weights.LEGAL_REGTECH).toBe(25);
  });

  it('prints the target database without credentials and refuses an apply against another database', async () => {
    const before = await counts();
    const dry = await run(['--only=watchlist.excluded_employers']);
    const { rows } = await db().query<{ database: string }>('SELECT current_database() AS database');
    expect(dry.targetDatabase).toMatchObject({
      host: 'localhost',
      port: '47999',
      database: rows[0]?.database,
      urlVariable: 'DATABASE_URL',
      source: 'PROCESS_ENVIRONMENT',
    });
    expect(dry.targetDatabase.systemIdentifier).toMatch(/^\d+$/);
    expect(JSON.stringify(dry)).not.toMatch(/fixture_user|fixture-secret-pw/);
    expect(dry.nextStep).toContain('localhost/');

    // Same file, selection and active revision, but another database: refused, nothing written.
    expect(await refusal(run(['--only=watchlist.excluded_employers', ...applyArgs(dry.diffHash)], { ...ENV, DATABASE_URL: OTHER_TARGET_URL }))).toBe('DIFF_HASH_MISMATCH');
    expect(await counts()).toEqual(before);

    // --env names the only file the URL may come from; the process environment is ignored.
    envFileText = `DATABASE_URL_UNPOOLED=${OTHER_TARGET_URL}\n`;
    connectedUrls.length = 0;
    const viaEnvFile = await run(['--env=target.env', '--only=watchlist.excluded_employers'], { DATABASE_URL_UNPOOLED: TARGET_URL });
    expect(connectedUrls).toEqual([OTHER_TARGET_URL]);
    expect(viaEnvFile.targetDatabase).toMatchObject({ host: 'other-host.example.test', urlVariable: 'DATABASE_URL_UNPOOLED', source: 'ENV_FILE' });
    expect(viaEnvFile.diffHash).not.toBe(dry.diffHash);
    // The apply with the matching --env file and its own reviewed hash goes through.
    const applied = await run(['--env=target.env', '--only=watchlist.excluded_employers', ...applyArgs(viaEnvFile.diffHash)], ENV);
    expect(applied.mode).toBe('APPLIED');
    expect(applied.targetDatabase.host).toBe('other-host.example.test');
  });

  it.runIf(ONSITE_FIELD_KNOWN)('activates mobility.onsite_exception_employers when the schema defines it', async () => {
    const employers = Array.from({ length: 11 }, (_, index) => `Fixture Employer ${index + 1}`);
    fileText = JSON.stringify({ ...FILE, mobility: { ...FILE.mobility, onsite_exception_employers: employers } });
    const dry = await run(['--only=mobility.onsite_exception_employers']);
    expect(dry.changes).toEqual([
      { path: 'stage3.mobility.onsite_exception_employers', change: 'ADDED', valueKind: 'list', itemsAdded: 11, itemsRemoved: 0 },
    ]);
    expect(dry.workabilityPolicyHashNote).toBeDefined();
    await run(['--only=mobility.onsite_exception_employers', ...applyArgs(dry.diffHash)], ENV);
    expect((await activeRevision('stage3')).value.mobility.onsite_exception_employers).toEqual(employers);
  });
});
