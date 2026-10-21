import dotenv from 'dotenv';
import pg from 'pg';

import { isPooledPostgresConnectionString, pgPoolConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

interface ProfileVersionRow {
  readonly id: string;
  readonly candidate_profile_id: string;
  readonly version_number: number;
  readonly status: string;
}

function profileVersionIdArgument(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf('--profile-version-id');
  const inline = args.find((argument) => argument.startsWith('--profile-version-id='));
  const value = inline?.slice('--profile-version-id='.length) ?? (index >= 0 ? args[index + 1] : undefined);
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Provide a valid --profile-version-id UUID.');
  }
  return value;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const profileVersionId = profileVersionIdArgument();
  const databaseUrl = process.env.STAGE3_STAGING_DATABASE_URL;
  if (!databaseUrl) throw new Error('STAGE3_STAGING_DATABASE_URL is required.');
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error('Staging profile activation requires a direct, unpooled connection.');
  }

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    const context = await resolveWorkspaceContext(client);
    if (apply) {
      await client.query('BEGIN');
      transactionStarted = true;
    }

    const targetResult = await client.query<ProfileVersionRow>(
      `SELECT id, candidate_profile_id, version_number, status
       FROM profile_versions
       WHERE workspace_id = $1 AND id = $2
       ${apply ? 'FOR UPDATE' : ''}`,
      [context.workspaceId, profileVersionId]
    );
    const target = targetResult.rows[0];
    if (!target) throw new Error('The requested profile version does not exist in this staging workspace.');
    if (target.status !== 'DRAFT') {
      throw new Error(`Expected the target profile version to be DRAFT; found ${target.status}.`);
    }

    const activeResult = await client.query<ProfileVersionRow>(
      `SELECT id, candidate_profile_id, version_number, status
       FROM profile_versions
       WHERE workspace_id = $1
         AND candidate_profile_id = $2
         AND status = 'ACTIVE'
       ORDER BY effective_at DESC NULLS LAST, version_number DESC
       LIMIT 1
       ${apply ? 'FOR UPDATE' : ''}`,
      [context.workspaceId, target.candidate_profile_id]
    );
    const active = activeResult.rows[0] ?? null;

    if (apply) {
      await client.query(
        `UPDATE profile_versions
         SET status = 'RETIRED'
         WHERE workspace_id = $1
           AND candidate_profile_id = $2
           AND status = 'ACTIVE'
           AND id <> $3`,
        [context.workspaceId, target.candidate_profile_id, target.id]
      );
      const activated = await client.query(
        `UPDATE profile_versions
         SET status = 'ACTIVE', effective_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND id = $2 AND status = 'DRAFT'`,
        [context.workspaceId, target.id]
      );
      if (activated.rowCount !== 1) throw new Error('The staging draft changed before activation; no profile was activated.');
      await client.query('COMMIT');
      transactionStarted = false;
    }

    console.log(JSON.stringify({
      mode: apply ? 'STAGING_PROFILE_ACTIVATED' : 'DRY_RUN',
      profileVersionId: target.id,
      profileVersionNumber: target.version_number,
      priorActiveProfileVersionId: active?.id ?? null,
      priorActiveProfileVersionNumber: active?.version_number ?? null,
      profileStatusAfterRun: apply ? 'ACTIVE' : 'DRAFT',
      hardGatesReplayed: false,
      laneRoutingReplayed: false,
    }, null, 2));
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Staging profile activation rollback failed:', rollbackError instanceof Error ? rollbackError.message : rollbackError);
      }
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Staging profile activation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
