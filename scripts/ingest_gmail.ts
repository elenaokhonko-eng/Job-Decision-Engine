import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { GmailApiClient, loadGmailApiCredentials } from "../src/services/gmailApi.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const databaseUrl = process.env.DATABASE_URL;
const gmailFolder = process.env.GMAIL_FOLDER || "Jobs-Alerts";
const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";
const gmailReadOnly = process.env.GMAIL_READ_ONLY === "true";

export async function ingestGmail(): Promise<number> {
  console.log("====================================================");
  console.log("        GMAIL API JOB ALERT INGESTION (HTTPS)       ");
  console.log("====================================================");

  if (!databaseUrl) {
    throw new Error("Missing required DATABASE_URL.");
  }

  const gmailClient = new GmailApiClient(loadGmailApiCredentials());
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  let ingestedCount = 0;

  try {
    const ctx = await resolveWorkspaceContext(pool as any);
    console.log(`Reading Gmail label "${gmailFolder}" through the Gmail API over HTTPS...`);
    const { label, messages } = await gmailClient.readMessagesByLabel(gmailFolder);
    console.log(`Gmail label "${gmailFolder}" resolved to ${label.id}. Messages found: ${messages.length}`);

    if (messages.length === 0) {
      console.log("No messages to process.");
      return 0;
    }

    for (const message of messages) {
      console.log(`Processing email #${ingestedCount + 1}: "${message.subject}"`);

      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");
        await dbClient.query(
          `INSERT INTO raw_email_alerts (workspace_id, subject, body, gmail_message_id, processed)
           VALUES ($1, $2, $3, $4, FALSE)
           ON CONFLICT (workspace_id, gmail_message_id) DO NOTHING`,
          [ctx.workspaceId, message.subject, message.raw, message.id]
        );
        await dbClient.query("COMMIT");
      } catch (transactionError) {
        await dbClient.query("ROLLBACK");
        throw transactionError;
      } finally {
        dbClient.release();
      }

      // Gmail is changed only after the raw message is durably staged in Postgres.
      if (!gmailReadOnly) {
        try {
          await gmailClient.markProcessed(message.id, label.id, gmailProcessedFolder);
        } catch (labelError) {
          console.warn(`Warning: Could not apply Gmail processed label to message ${message.id}:`, labelError);
        }
      }
      ingestedCount += 1;
    }

    console.log(`Successfully staged ${ingestedCount} raw email alerts to Postgres.`);
    if (gmailReadOnly) {
      console.log("GMAIL_READ_ONLY=true: source messages were not relabeled or marked.");
    }
  } catch (error) {
    console.error("Gmail API ingestion error:", error instanceof Error ? error.message : error);
    throw error;
  } finally {
    await pool.end();
  }

  return ingestedCount;
}

export async function ingestGmailWithRetry(): Promise<number> {
  const configuredAttempts = Number(process.env.GMAIL_INGEST_MAX_ATTEMPTS || "3");
  const maxAttempts = Number.isInteger(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await ingestGmail();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      const delayMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      console.warn(`Gmail ingestion attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

if (process.argv[1] && process.argv[1].includes("ingest_gmail")) {
  ingestGmailWithRetry()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
