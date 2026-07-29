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

async function cleanupGmail() {
  console.log("====================================================");
  console.log("             GMAIL CLEANUP & ALIGNMENT UNIT         ");
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
    // 1. Fetch all subjects of emails already stored in Postgres database
    console.log("Connecting to Postgres to fetch ingested alert subjects...");
    const dbRes = await pool.query("SELECT subject FROM raw_email_alerts");
    const ingestedSubjects = new Set(dbRes.rows.map(r => r.subject));
    console.log(`Found ${ingestedSubjects.size} unique email subjects already in database.`);

    // 2. Connect to Gmail
    await client.connect();
    
    // 3. Clean up the Jobs-Alerts folder (remove label from already ingested emails)
    console.log(`Opening mailbox "${gmailFolder}"...`);
    const mainMailbox = await client.mailboxOpen(gmailFolder);
    console.log(`Mailbox "${gmailFolder}" has ${mainMailbox.exists} messages.`);

    if (mainMailbox.exists > 0) {
      const messages: any[] = [];
      for await (const message of client.fetch("1:*", { envelope: true, uid: true })) {
        messages.push(message);
      }

      let movedCount = 0;
      for (const msg of messages) {
        const subject = msg.envelope?.subject || "No Subject";
        if (ingestedSubjects.has(subject)) {
          console.log(`Removing "${gmailFolder}" label from already ingested email: "${subject}"`);
          // Add processed label, remove main label
          await client.messageFlagsAdd(msg.uid, [gmailProcessedFolder], { uid: true, useLabels: true });
          await client.messageFlagsRemove(msg.uid, [gmailFolder], { uid: true, useLabels: true });
          movedCount++;
        }
      }
      console.log(`✅ Cleared ${movedCount} already-ingested emails from "${gmailFolder}".`);
    }

    // 4. Clean up the Jobs-Alerts-Processed folder (delete them to keep folder clean)
    console.log(`Opening mailbox "${gmailProcessedFolder}"...`);
    const processedMailbox = await client.mailboxOpen(gmailProcessedFolder);
    console.log(`Mailbox "${gmailProcessedFolder}" has ${processedMailbox.exists} messages.`);

    if (processedMailbox.exists > 0) {
      console.log(`Deleting ${processedMailbox.exists} emails from "${gmailProcessedFolder}"...`);
      await client.messageFlagsAdd("1:*", ["\\Deleted"]);
      await client.mailboxClose();
      console.log(`✅ Successfully emptied "${gmailProcessedFolder}".`);
    }

    await client.logout();
    console.log("\n✅ Gmail cleanup completed successfully!");
  } catch (err: any) {
    console.error("❌ Cleanup error:", err.message || err);
  } finally {
    await pool.end();
  }
}

cleanupGmail();
