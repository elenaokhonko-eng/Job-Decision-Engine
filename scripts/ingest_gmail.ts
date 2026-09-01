import { ImapFlow } from "imapflow";
import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const databaseUrl = process.env.DATABASE_URL;
const gmailUser = process.env.GMAIL_USER;
const gmailPassword = process.env.GMAIL_APP_PASSWORD;
const gmailFolder = process.env.GMAIL_FOLDER || "Jobs-Alerts";
const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

export async function ingestGmail(): Promise<number> {
  console.log("====================================================");
  console.log("       NATIVE GMAIL JOB ALERT INGESTION (TS)       ");
  console.log("====================================================");

  if (!databaseUrl || !gmailUser || !gmailPassword) {
    console.error("❌ ERROR: Missing DATABASE_URL, GMAIL_USER, or GMAIL_APP_PASSWORD.");
    throw new Error("Missing required Gmail credentials or DATABASE_URL.");
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: pgSslConfig(databaseUrl)
  });

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: gmailUser,
      pass: gmailPassword
    },
    logger: false
  });

  let ingestedCount = 0;

  try {
    await client.connect();
    console.log(`Connected to Gmail IMAP. Opening mailbox "${gmailFolder}"...`);
    const mailbox = await client.mailboxOpen(gmailFolder);
    console.log(`Mailbox "${gmailFolder}" opened. Total messages found: ${mailbox.exists}`);

    if (mailbox.exists === 0) {
      console.log("No messages to process.");
      await client.logout();
      return 0;
    }

    const messages: any[] = [];
    for await (const message of client.fetch("1:*", { envelope: true, source: true, uid: true })) {
      messages.push(message);
    }

    console.log(`Found ${messages.length} email alerts in "${gmailFolder}".`);

    for (const msg of messages) {
      const subject = msg.envelope?.subject || "No Subject";
      const body = msg.source?.toString("utf-8") || "";
      console.log(`Processing email #${ingestedCount + 1}: "${subject}"`);

      // Transactionally stage email alert before modifying IMAP state
      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");
        await dbClient.query(
          `INSERT INTO raw_email_alerts (subject, body, gmail_message_id, processed)
           VALUES ($1, $2, $3, FALSE)
           ON CONFLICT DO NOTHING`,
          [subject, body, String(msg.uid)]
        );
        await dbClient.query("COMMIT");
      } catch (txErr) {
        await dbClient.query("ROLLBACK");
        throw txErr;
      } finally {
        dbClient.release();
      }

      // Non-destructive transition: Move email to processed folder (or mark seen), do not permanently delete
      try {
        await client.messageMove(msg.uid, gmailProcessedFolder, { uid: true }).catch(async () => {
          // Fallback if folder move is unsupported: mark as Seen
          await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
        });
      } catch (err) {
        console.warn(`Warning: Could not move email UID ${msg.uid} to ${gmailProcessedFolder}:`, err);
      }
      ingestedCount++;
    }

    console.log(`✅ Successfully staged ${ingestedCount} raw email alerts to Postgres.`);
    try {
      await client.mailboxClose();
    } catch {}
    await client.logout();
  } catch (err: any) {
    console.error("❌ Gmail ingestion error:", err.message || err);
    throw err;
  } finally {
    await pool.end();
  }

  return ingestedCount;
}

if (process.argv[1] && process.argv[1].includes("ingest_gmail")) {
  ingestGmail()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
