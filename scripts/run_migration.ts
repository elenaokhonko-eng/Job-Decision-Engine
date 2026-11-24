/**
 * Applies the pending migrations to an explicitly chosen database through runMigrations (src/db/migrate.ts).
 * It never chooses a database for you and never reads DATABASE_URL for a replay target.
 *
 *   npx tsx scripts/run_migration.ts --target replay                 # REPLAY_DATABASE_URL, guarded by REPLAY_BRANCH_ID
 *   npx tsx scripts/run_migration.ts --target production --confirm-production --confirm-workspace=<workspace uuid>
 *
 * The rules are in src/db/migrationTarget.ts (unit-tested). Prints the pending list and counts only, never a URL.
 * Exit code 1 on any refusal or failed migration.
 */
import dotenv from "dotenv";
import pg from "pg";
import { getMigrationStatus, runMigrations } from "../src/db/migrate.js";
import {
  assertReplayIdentity,
  directReplayUrl,
  readConnectedIdentity,
  resolveMigrationTarget,
} from "../src/db/migrationTarget.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { requireApprovedReplayTarget } from "../src/reporting/replayGuard.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
  const resolved = resolveMigrationTarget(process.argv.slice(2), process.env);
  const url = resolved.target === "replay" ? directReplayUrl(resolved.databaseUrl) : resolved.databaseUrl;
  const client = new pg.Client(pgConnectionConfig(url));
  await client.connect();
  try {
    const identity = await readConnectedIdentity(client);
    if (resolved.target === "replay") {
      assertReplayIdentity(identity, resolved.expectedBranchId!);
      requireApprovedReplayTarget(url, identity, resolved.expectedBranchId);
    } else {
      const context = await resolveWorkspaceContext(client as unknown as pg.PoolClient);
      if (context.workspaceId !== resolved.confirmWorkspaceId) {
        throw new Error("Refusing to migrate production: --confirm-workspace must equal the resolved workspace id.");
      }
    }
    console.log(`target=${resolved.target} database=${identity.databaseName} branch=${identity.branchId}`);
    const before = await getMigrationStatus(client);
    console.log(JSON.stringify({ applied: before.appliedCount, pending: before.pending }));
    const applied = await runMigrations(client);
    if (resolved.target === "replay") assertReplayIdentity(await readConnectedIdentity(client), resolved.expectedBranchId!);
    console.log(`Migration runner finished. Applied ${applied.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration refused or failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
