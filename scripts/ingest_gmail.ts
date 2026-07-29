import { ImapFlow } from "imapflow";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;
const gmailUser = process.env.GMAIL_USER;
const gmailPassword = process.env.GMAIL_APP_PASSWORD;
const gmailFolder = process.env.GMAIL_FOLDER || "Jobs-Alerts";
const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

async function ingestGmail() {
  console.log("====================================================");
  console.log("       NATIVE GMAIL JOB ALERT INGESTION (TS)       ");
  console.log("====================================================");

  if (!databaseUrl || !gmailUser || !gmailPassword) {
    console.error("❌ ERROR: Missing DATABASE_URL, GMAIL_USER, or GMAIL_APP_PASSWORD.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
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

  try {
    await client.connect();
    console.log(`Connected to Gmail IMAP. Opening mailbox "${gmailFolder}"...`);
    const mailbox = await client.mailboxOpen(gmailFolder);
    console.log(`Mailbox "${gmailFolder}" opened. Total messages found: ${mailbox.exists}`);

    if (mailbox.exists === 0) {
      console.log("No messages to process.");
      await client.logout();
      await pool.end();
      return;
    }

    const messages: any[] = [];
    for await (const message of client.fetch("1:*", { envelope: true, source: true, uid: true })) {
      messages.push(message);
    }

    console.log(`Found ${messages.length} email alerts in "${gmailFolder}".`);
    let count = 0;
    for (const msg of messages) {
      const subject = msg.envelope?.subject || "No Subject";
      const body = msg.source?.toString("utf-8") || "";
      console.log(`Processing email #${count + 1}: "${subject}"`);

      // Insert into raw_email_alerts table
      await pool.query(
        "INSERT INTO raw_email_alerts (subject, body, processed) VALUES ($1, $2, FALSE)",
        [subject, body]
      );

      // Move email message out of Jobs-Alerts to Jobs-Alerts-Processed
      try {
        await client.messageFlagsAdd(msg.uid, [gmailProcessedFolder], { uid: true, useLabels: true });
        await client.messageFlagsRemove(msg.uid, [gmailFolder], { uid: true, useLabels: true });
      } catch (labelErr) {
        try {
          await client.messageMove(msg.uid, gmailProcessedFolder, { uid: true });
        } catch (moveErr) {
          try {
            await client.messageCopy(msg.uid, gmailProcessedFolder, { uid: true });
            await client.messageFlagsAdd(msg.uid, ["\\Seen", "\\Deleted"], { uid: true });
          } catch {}
        }
      }
      count++;
    }

    console.log(`✅ Successfully ingested ${count} raw email alerts to Postgres and moved to "${gmailProcessedFolder}".`);
    try {
      await client.mailboxClose();
    } catch {}
    await client.logout();
  } catch (err: any) {
    console.error("❌ Gmail ingestion error:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

ingestGmail();
