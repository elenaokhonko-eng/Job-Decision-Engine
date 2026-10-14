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
const inProcessingFolderName =
  process.env.GMAIL_IN_PROCESSING_FOLDER || "Jobs-Alerts-In-Processing";
const legacyProcessedFolderName =
  process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

export async function cleanupGmail(options: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = options.dryRun ?? isDryRun;
  console.log("====================================================");
  console.log(`     GMAIL TERMINAL RECONCILIATION & CLEANUP        ${dryRun ? "[DRY RUN]" : ""}`);
  console.log("====================================================");

  if (!databaseUrl) {
    throw new Error("Missing required DATABASE_URL.");
  }

  let gmailClient: GmailApiClient | undefined;
  const hasClientId = Boolean(process.env.GMAIL_OAUTH_CLIENT_ID?.trim());
  const hasClientSecret = Boolean(process.env.GMAIL_OAUTH_CLIENT_SECRET?.trim());
  const hasRefreshToken = Boolean(process.env.GMAIL_OAUTH_REFRESH_TOKEN?.trim());

  if (hasClientId || hasClientSecret || hasRefreshToken) {
    // Credentials provided: load strictly
    gmailClient = new GmailApiClient(loadGmailApiCredentials());
  } else {
    console.log("No Gmail OAuth credentials provided; running Postgres-only terminal reconciliation.");
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
      inProcessingFolderName,
      legacyProcessedFolderName,
    });

    console.log(`\nReconciliation Summary:`);
    console.log(`- Total email alerts inspected:          ${result.inspectedAlerts}`);
    console.log(`- Terminal eligible:                      ${result.eligibleTerminalAlerts}`);
    console.log(`- In-flight retained:                     ${result.inFlightAlerts}`);
    console.log(`- Zero-lineage retained:                  ${result.zeroLineageAlerts}`);
    console.log(`- Missing-lineage retained:               ${result.missingLineageAlerts}`);
    console.log(`- Legacy Processed -> In-Processing:      ${result.legacyProcessedToInProcessing}`);
    console.log(`- Terminal legacy Processed -> Trash eligible: ${result.legacyProcessedTerminalEligible}`);
    console.log(`- Alerts moved to Trash:                  ${result.trashedAlerts} ${dryRun ? "(dry-run)" : ""}`);
    if (result.errors.length > 0) {
      console.error(`- Errors encountered:                     ${result.errors.length}`);
      for (const err of result.errors.slice(0, 10)) {
        console.error(`  * ${err}`);
      }
      throw new Error(`Gmail terminal reconciliation encountered ${result.errors.length} systemic error(s).`);
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
