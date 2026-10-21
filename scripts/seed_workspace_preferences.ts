import pg from 'pg';
import dotenv from 'dotenv';

import { loadProfile } from '../src/profile/loader.js';
import { pgPoolConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';
import { saveWorkspacePreferenceRevision } from '../src/policy/workspacePreferenceRegistry.js';
import { Stage3WorkPreferencesSchema, STAGE3_SCHEMA_VERSION } from '../src/policy/stage3Contracts.js';
import { LaneIntentPreferencesSchema } from '../src/policy/laneIntentContracts.js';

// Loads local canonical preference inputs into immutable revisions. No import path
// activates these automatically; activation is an explicit staging-only operator action.
dotenv.config();
dotenv.config({ path: '.env.local' });

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const activate = hasFlag('--activate');
  if (activate && !apply) throw new Error('--activate requires --apply.');

  const profile = await loadProfile();
  const workPreferences = profile.workPreferences;
  if (!workPreferences?.lane_intent) throw new Error('Canonical work_preferences.json has no validated lane_intent package.');

  const laneIntent = LaneIntentPreferencesSchema.parse(workPreferences.lane_intent);
  const stage3 = Stage3WorkPreferencesSchema.parse({
    schema_version: STAGE3_SCHEMA_VERSION,
    mobility: workPreferences.mobility,
    employment_structure: workPreferences.employment_structure,
    compensation: workPreferences.compensation,
    freshness: workPreferences.freshness,
    application_priority_weights: workPreferences.application_priority_weights,
    company_stage_preferences: workPreferences.company_stage_preferences,
    market_opportunities: workPreferences.market_opportunities,
    research_geographies: workPreferences.research_geographies,
    watchlist: workPreferences.watchlist,
    culture_priorities: workPreferences.culture_priorities,
  });

  console.log(JSON.stringify({
    mode: activate ? 'CREATE_AND_ACTIVATE' : apply ? 'CREATE_INACTIVE_REVISIONS' : 'DRY_RUN',
    profileVersion: profile.profile.profile_version,
    preferenceDomains: [
      { domain: 'lane_intent', schemaVersion: laneIntent.schema_version, laneWeights: laneIntent.lane_weights },
      { domain: 'stage3', schemaVersion: stage3.schema_version },
    ],
    profileActivation: 'NOT_CHANGED',
    companyPolling: 'DISABLED',
  }, null, 2));

  if (!apply) return;
  const databaseUrl = process.env.STAGE3_STAGING_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Set STAGE3_STAGING_DATABASE_URL to a direct connection for a non-production staging branch. Generic DATABASE_URL is intentionally not accepted.');
  }

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    const context = await resolveWorkspaceContext(client);
    await client.query('BEGIN');
    const laneRevision = await saveWorkspacePreferenceRevision(client, context, {
      preferenceDomain: 'lane_intent',
      schemaVersion: laneIntent.schema_version,
      preferenceValue: laneIntent,
      activate,
    });
    const stage3Revision = await saveWorkspacePreferenceRevision(client, context, {
      preferenceDomain: 'stage3',
      schemaVersion: stage3.schema_version,
      preferenceValue: stage3,
      activate,
    });
    await client.query('COMMIT');
    console.log(JSON.stringify({
      committed: true,
      activated: activate,
      laneIntentRevision: laneRevision,
      stage3Revision,
      profileVersionActivated: false,
      pipelineBackfillScheduled: false,
      companyPollingEnabled: false,
    }, null, 2));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Preference seeding rollback failed:', rollbackError instanceof Error ? rollbackError.message : rollbackError);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Preference seeding failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
