import pg from 'pg';
import dotenv from 'dotenv';

import { pgPoolConfig } from '../src/db/pgSsl.js';
import {
  PreferenceActivationRefusal,
  runPreferenceActivation,
} from '../src/policy/preferenceActivation.js';

// Operator-approved activation of stage3 / lane_intent preference revisions.
// Dry run by default (READ ONLY transaction). See docs/data-contracts.md,
// "Activating workspace preferences in production", for the runbook.
// scripts/seed_workspace_preferences.ts remains the staging-only seeder.
dotenv.config();
dotenv.config({ path: '.env.local' });

async function main(): Promise<void> {
  const report = await runPreferenceActivation({
    argv: process.argv.slice(2),
    env: process.env,
    connect: async () => {
      const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('Set DATABASE_URL_UNPOOLED or DATABASE_URL to the target database.');
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
