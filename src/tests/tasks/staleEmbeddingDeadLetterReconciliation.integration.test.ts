import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';

import { runMigrations } from '../../db/migrate.js';
import { isLocalPostgresConnectionString, pgConnectionConfig } from '../../db/pgSsl.js';
import {
  readDeadLetterTaskHealth,
  reconcileStaleSupersededEmbeddingDeadLetters,
  STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION,
} from '../../tasks/deadLetterPolicy.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../../workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const databaseUrl = process.env.DATABASE_URL || '';
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = '';
let context: WorkspaceContext | undefined;
let staleTaskIds: string[] = [];
let originalAttemptTaskId = '';
let currentTaskId = '';
let nonEmbeddingTaskId = '';
let unresolvedTaskId = '';
let priorCompletedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

function getClient(): pg.PoolClient {
  if (!client) throw new Error('The stale dead-letter test client is not initialized.');
  return client;
}

function getWorkspaceId(): string {
  if (!context) throw new Error('The stale dead-letter test workspace is not initialized.');
  return context.workspaceId;
}

async function insertCanonicalVersions(index: number): Promise<{
  canonicalJobId: string;
  oldVersionId: string;
  latestVersionId: string;
}> {
  const database = getClient();
  const canonicalJobId = crypto.randomUUID();
  const oldVersionId = crypto.randomUUID();
  const latestVersionId = crypto.randomUUID();
  await database.query(
    `INSERT INTO canonical_jobs (
       id, workspace_id, company_name, normalized_title, canonical_url,
       processing_state, processing_status
     ) VALUES ($1, $2, $3, $4, $5, 'PREQUALIFIED', 'PREQUALIFIED')`,
    [canonicalJobId, getWorkspaceId(), `Dead Letter Test ${index}`, `Fixture ${index}`, `https://example.test/dead-letter/${canonicalJobId}`],
  );
  for (const [id, contentHash] of [
    [oldVersionId, `old-${crypto.randomUUID()}`],
    [latestVersionId, `latest-${crypto.randomUUID()}`],
  ]) {
    await database.query(
      `INSERT INTO job_versions (
         id, workspace_id, canonical_job_id, content_hash, description_text, observed_at
       ) VALUES ($1, $2, $3, $4, 'Dead-letter reconciliation fixture', NOW())`,
      [id, getWorkspaceId(), canonicalJobId, contentHash],
    );
  }
  await database.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [latestVersionId, getWorkspaceId(), canonicalJobId],
  );
  return { canonicalJobId, oldVersionId, latestVersionId };
}

async function insertDeadLetterTask(input: {
  taskType: string;
  canonicalJobId?: string;
  jobVersionId?: string;
  suffix: string;
}): Promise<string> {
  const database = getClient();
  const id = crypto.randomUUID();
  const payload: Record<string, string> = {};
  if (input.canonicalJobId) payload.canonical_job_id = input.canonicalJobId;
  if (input.jobVersionId) payload.job_version_id = input.jobVersionId;
  await database.query(
    `INSERT INTO pipeline_tasks (
       id, workspace_id, task_type, task_key, payload, context_fingerprint,
       status, available_at, lease_id, lease_expires_at, heartbeat_at, claimed_by,
       attempt_count, max_attempts, last_error, dead_letter_reason, repair_action,
       created_at, updated_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6,
       'DEAD_LETTER', NOW(), $7, NOW() + INTERVAL '5 minutes', NOW(), 'test-worker',
       3, 3, 'original provider error', 'original dead-letter reason', 'original repair action',
       $8, $8, $8
     )`,
    [
      id,
      getWorkspaceId(),
      input.taskType,
      `dead-letter-reconciliation:${input.suffix}:${crypto.randomUUID()}`,
      JSON.stringify(payload),
      `dead-letter-context:${crypto.randomUUID()}`,
      crypto.randomUUID(),
      priorCompletedAt,
    ],
  );
  return id;
}

describe.skipIf(skipReal)('stale embedding dead-letter reconciliation (PostgreSQL)', () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `stale_dead_letter_${crypto.randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    staleTaskIds = [];
    const versions: Array<{ canonicalJobId: string; oldVersionId: string; latestVersionId: string }> = [];
    for (let index = 0; index < 4; index += 1) {
      versions.push(await insertCanonicalVersions(index));
    }
    for (let versionIndex = 0; versionIndex < versions.length; versionIndex += 1) {
      for (let duplicateIndex = 0; duplicateIndex < 2; duplicateIndex += 1) {
        const version = versions[versionIndex];
        const taskId = await insertDeadLetterTask({
          taskType: 'PUBLISH_EMBEDDING',
          canonicalJobId: version.canonicalJobId,
          jobVersionId: version.oldVersionId,
          suffix: `stale-${versionIndex}-${duplicateIndex}`,
        });
        staleTaskIds.push(taskId);
      }
    }

    const firstVersion = versions[0];
    originalAttemptTaskId = staleTaskIds[0];
    await client.query(
      `INSERT INTO pipeline_task_attempts (
         workspace_id, task_id, attempt_number, status, started_at, finished_at,
         error_message, metadata
       ) VALUES ($1, $2, 3, 'FAILED', $3, $4, 'preserve attempt history', '{"audit":"keep"}'::jsonb)`,
      [getWorkspaceId(), originalAttemptTaskId, priorCompletedAt, priorCompletedAt],
    );

    currentTaskId = await insertDeadLetterTask({
      taskType: 'PUBLISH_EMBEDDING',
      canonicalJobId: firstVersion.canonicalJobId,
      jobVersionId: firstVersion.latestVersionId,
      suffix: 'current',
    });
    nonEmbeddingTaskId = await insertDeadLetterTask({
      taskType: 'MATCH_PROFILE_EVIDENCE',
      canonicalJobId: firstVersion.canonicalJobId,
      jobVersionId: firstVersion.oldVersionId,
      suffix: 'other-task-type',
    });
    unresolvedTaskId = await insertDeadLetterTask({
      taskType: 'PUBLISH_EMBEDDING',
      canonicalJobId: crypto.randomUUID(),
      jobVersionId: crypto.randomUUID(),
      suffix: 'unresolved',
    });
  });

  afterAll(async () => {
    if (client) {
      await client.query('RESET search_path').catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it('classifies and reconciles only provably superseded embedding dead letters while preserving audit fields', async () => {
    const database = getClient();
    const workspaceId = getWorkspaceId();
    const initialHealth = await readDeadLetterTaskHealth(database, workspaceId);
    expect(initialHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task_type: 'PUBLISH_EMBEDDING',
        actionable_dead_letter_count: 2,
        stale_historical_dead_letter_count: 8,
      }),
      expect.objectContaining({
        task_type: 'MATCH_PROFILE_EVIDENCE',
        actionable_dead_letter_count: 1,
        stale_historical_dead_letter_count: 0,
      }),
    ]));

    await expect(reconcileStaleSupersededEmbeddingDeadLetters(database, workspaceId)).resolves.toBe(8);
    await expect(reconcileStaleSupersededEmbeddingDeadLetters(database, workspaceId)).resolves.toBe(0);
    const reconciledHealth = await readDeadLetterTaskHealth(database, workspaceId);
    expect(reconciledHealth).toEqual(initialHealth);

    const reconciled = await database.query<{
      id: string;
      status: string;
      last_error: string | null;
      dead_letter_reason: string | null;
      repair_action: string | null;
      completed_at: Date | string | null;
      lease_id: string | null;
      lease_expires_at: Date | string | null;
      heartbeat_at: Date | string | null;
      claimed_by: string | null;
      attempt_count: number;
    }>(
      `SELECT id, status, last_error, dead_letter_reason, repair_action, completed_at,
              lease_id, lease_expires_at, heartbeat_at, claimed_by, attempt_count
       FROM pipeline_tasks WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
      [workspaceId, staleTaskIds],
    );
    expect(reconciled.rows).toHaveLength(8);
    for (const row of reconciled.rows) {
      expect(row.status).toBe('DEAD_LETTER');
      expect(row.last_error).toBe('original provider error');
      expect(row.dead_letter_reason).toBe('original dead-letter reason');
      expect(row.repair_action).toContain('original repair action');
      expect(row.repair_action).toContain(STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION);
      expect(row.repair_action?.split(STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION)).toHaveLength(2);
      expect(row.completed_at).toEqual(priorCompletedAt);
      expect(row.lease_id).not.toBeNull();
      expect(row.lease_expires_at).not.toBeNull();
      expect(row.heartbeat_at).not.toBeNull();
      expect(row.claimed_by).toBe('test-worker');
      expect(row.attempt_count).toBe(3);
    }

    const attempts = await database.query<{
      status: string;
      error_message: string | null;
      metadata: { audit: string };
    }>(
      `SELECT status, error_message, metadata FROM pipeline_task_attempts
       WHERE workspace_id = $1 AND task_id = $2`,
      [workspaceId, originalAttemptTaskId],
    );
    expect(attempts.rows).toEqual([{
      status: 'FAILED',
      error_message: 'preserve attempt history',
      metadata: { audit: 'keep' },
    }]);

    const untouched = await database.query<{ id: string; status: string }>(
      `SELECT id, status FROM pipeline_tasks WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, [currentTaskId, nonEmbeddingTaskId, unresolvedTaskId]],
    );
    expect(untouched.rows).toHaveLength(3);
    expect(untouched.rows.every((row) => row.status === 'DEAD_LETTER')).toBe(true);
  });
});
