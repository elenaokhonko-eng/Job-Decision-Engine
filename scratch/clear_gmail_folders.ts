import { ImapFlow } from "imapflow";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const gmailUser = process.env.GMAIL_USER;
const gmailPassword = process.env.GMAIL_APP_PASSWORD;
const gmailFolder = process.env.GMAIL_FOLDER || "Jobs-Alerts";
const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

async function clearGmail() {
  console.log("====================================================");
  console.log("             GMAIL FULL PURGE & CLEANUP             ");
  console.log("====================================================");

  if (!gmailUser || !gmailPassword) {
    console.error("❌ ERROR: Missing GMAIL_USER or GMAIL_APP_PASSWORD.");
    process.exit(1);
  }

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

    // 1. Purge Jobs-Alerts folder
    console.log(`Opening mailbox "${gmailFolder}"...`);
    const mainMailbox = await client.mailboxOpen(gmailFolder);
    console.log(`Mailbox "${gmailFolder}" has ${mainMailbox.exists} messages.`);
    
    if (mainMailbox.exists > 0) {
      console.log(`Deleting ${mainMailbox.exists} emails from "${gmailFolder}"...`);
      // Add \Deleted flag to all messages in the mailbox
      await client.messageFlagsAdd("1:*", ["\\Deleted"]);
      console.log(`Expunging messages from "${gmailFolder}"...`);
    }
    await client.mailboxClose();

    // 2. Purge Jobs-Alerts-Processed folder
    console.log(`\nOpening mailbox "${gmailProcessedFolder}"...`);
    const processedMailbox = await client.mailboxOpen(gmailProcessedFolder);
    console.log(`Mailbox "${gmailProcessedFolder}" has ${processedMailbox.exists} messages.`);
    
    if (processedMailbox.exists > 0) {
      console.log(`Deleting ${processedMailbox.exists} emails from "${gmailProcessedFolder}"...`);
      await client.messageFlagsAdd("1:*", ["\\Deleted"]);
      console.log(`Expunging messages from "${gmailProcessedFolder}"...`);
    }
    await client.mailboxClose();

    await client.logout();
    console.log("\n✅ Gmail folder purge completed successfully! Both folders are now empty.");
  } catch (err: any) {
    console.error("❌ Purge error:", err.message || err);
  }
}

clearGmail();
