import pg from "pg";
import dotenv from "dotenv";
import { GmailApiClient, loadGmailApiCredentials } from "../src/services/gmailApi.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const databaseUrl = process.env.DATABASE_URL;
const gmailFolder = process.env.GMAIL_FOLDER || "Jobs-Alerts";
const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

async function cleanupGmail(): Promise<void> {
  if (!databaseUrl) {
    throw new Error("Missing required DATABASE_URL.");
  }

  const gmailClient = new GmailApiClient(loadGmailApiCredentials());
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));

  try {
    const ctx = await resolveWorkspaceContext(pool as any);
    const databaseResult = await pool.query(
      "SELECT subject FROM raw_email_alerts WHERE workspace_id = $1",
      [ctx.workspaceId]
    );
    const ingestedSubjects = new Set(databaseResult.rows.map((row) => row.subject));
    const source = await gmailClient.readMessagesByLabel(gmailFolder);

    let relabeledCount = 0;
    for (const message of source.messages) {
      if (ingestedSubjects.has(message.subject)) {
        await gmailClient.markProcessed(message.id, source.label.id, gmailProcessedFolder);
        relabeledCount += 1;
      }
    }
    console.log(`Applied the processed label to ${relabeledCount} already-staged messages.`);

    const processed = await gmailClient.readMessagesByLabel(gmailProcessedFolder);
    for (const message of processed.messages) {
      await gmailClient.deleteMessage(message.id);
    }
    console.log(`Deleted ${processed.messages.length} messages from "${gmailProcessedFolder}".`);
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
