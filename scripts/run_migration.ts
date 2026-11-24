/**
 * Applies the pending migrations to an explicitly chosen database through runMigrations (src/db/migrate.ts).
 * It never chooses a database for you.
 *
 *   npx tsx scripts/run_migration.ts --target replay        # REPLAY_DATABASE_URL, gated by REPLAY_BRANCH_ID
 *   npx tsx scripts/run_migration.ts --target production --confirm-production --confirm-workspace=<workspace uuid>
 *       # DATABASE_URL_UNPOOLED only (no fallback to DATABASE_URL); the connection must report the known production
 *       # Neon branch AND the typed workspace id must equal the resolved one, both checked before any change.
 *
 * The rules and the whole command flow are in src/db/migrationTarget.ts (unit-tested); this file only wires real
 * dependencies. Prints counts and the pending file names, never a URL or a host. Exit code 1 on any refusal or failure.
 */
import dotenv from "dotenv";
import pg from "pg";
import { getMigrationStatus, runMigrations } from "../src/db/migrate.js";
import { executeMigrationCommand, type MigrationCommandClient } from "../src/db/migrationTarget.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { requireApprovedReplayTarget } from "../src/reporting/replayGuard.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const asPg = (client: MigrationCommandClient): pg.Client => client as unknown as pg.Client;

const result = await executeMigrationCommand(process.argv.slice(2), process.env, {
  async connect(url) {
    const client = new pg.Client(pgConnectionConfig(url));
    await client.connect();
    return client as unknown as MigrationCommandClient;
  },
  async pendingMigrations(client) {
    const status = await getMigrationStatus(asPg(client));
    return { applied: status.appliedCount, pending: status.pending };
  },
  runPending: (client) => runMigrations(asPg(client)),
  resolveWorkspaceId: async (client) => (await resolveWorkspaceContext(asPg(client) as unknown as pg.PoolClient)).workspaceId,
  approveReplayTarget: (url, identity, expectedBranchId) => {
    requireApprovedReplayTarget(url, identity, expectedBranchId);
  },
});
for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
process.exitCode = result.exitCode;
