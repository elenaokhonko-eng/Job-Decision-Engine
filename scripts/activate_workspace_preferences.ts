import pg from 'pg';

import { pgPoolConfig } from '../src/db/pgSsl.js';
import {
  PreferenceActivationRefusal,
  runPreferenceActivation,
} from '../src/policy/preferenceActivation.js';

// Operator-approved activation of stage3 / lane_intent preference revisions.
// Dry run by default (READ ONLY transaction). See docs/data-contracts.md,
// "Activating workspace preferences in production", for the runbook.
// scripts/seed_workspace_preferences.ts remains the staging-only seeder.
//
// Deliberately no dotenv.config(): .env and .env.local are never loaded, so a
// local file cannot redirect this command to another database. The target URL
// comes only from --env=<file> or from the environment the caller set up
// (for example `npx tsx --env-file=<file>`).

async function main(): Promise<void> {
  const report = await runPreferenceActivation({
    argv: process.argv.slice(2),
    env: process.env,
    connect: async ({ databaseUrl }) => {
      const pool = new pg.Pool(pgPoolConfig(databaseUrl));
      const client = await pool.connect();
      return {
        client,
        close: async () => {
          client.release();
          await pool.end();
        },
      };
    },
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof PreferenceActivationRefusal) {
    console.error(`Refused. ${error.message}`);
  } else {
    console.error('Preference activation failed:', error instanceof Error ? error.message : 'unknown error');
  }
  process.exitCode = 1;
});
