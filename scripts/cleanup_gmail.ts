import pg from "pg";
import dotenv from "dotenv";
import { GmailApiClient, loadGmailApiCredentials } from "../src/services/gmailApi.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { reconcileTerminalGmailAlerts } from "../src/services/gmailLifecycle.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const databaseUrl = process.env.DATABASE_URL;
const isDryRun = process.argv.includes("--dry-run");

export async function cleanupGmail(options: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = options.dryRun ?? isDryRun;
  console.log("====================================================");
  console.log(`     GMAIL TERMINAL RECONCILIATION & CLEANUP        ${dryRun ? "[DRY RUN]" : ""}`);
  console.log("====================================================");

  if (!databaseUrl) {
    throw new Error("Missing required DATABASE_URL.");
  }

  let gmailClient: GmailApiClient | undefined;
  try {
    gmailClient = new GmailApiClient(loadGmailApiCredentials());
  } catch (err: any) {
    console.warn("Gmail OAuth credentials not configured or incomplete:", err?.message || err);
    console.log("Proceeding with Postgres-only reconciliation (messages will not be trashed via Gmail API).");
  }

  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));

  try {
    const ctx = await resolveWorkspaceContext(pool as any);
    console.log(`Reconciling terminal email alerts for workspace ${ctx.workspaceId}...`);

    const result = await reconcileTerminalGmailAlerts({
      pool,
      gmailClient,
      dryRun,
      limit: 500,
    });

    console.log(`\nReconciliation Summary:`);
    console.log(`- Total email alerts inspected: ${result.inspectedAlerts}`);
    console.log(`- In-flight alerts (retained):    ${result.inFlightAlerts}`);
    console.log(`- Eligible terminal alerts:      ${result.eligibleTerminalAlerts}`);
    console.log(`- Alerts moved to Trash:         ${result.trashedAlerts} ${dryRun ? "(dry-run)" : ""}`);
    if (result.errors.length > 0) {
      console.warn(`- Errors encountered:             ${result.errors.length}`);
      for (const err of result.errors.slice(0, 10)) {
        console.warn(`  * ${err}`);
      }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes("cleanup_gmail")) {
  cleanupGmail().catch((error) => {
    console.error("Gmail cleanup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
