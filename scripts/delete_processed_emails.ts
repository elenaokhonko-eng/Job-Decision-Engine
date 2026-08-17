import { ImapFlow } from "imapflow";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const gmailUser = process.env.GMAIL_USER;
const gmailPassword = process.env.GMAIL_APP_PASSWORD;
const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

async function cleanProcessedFolder() {
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
    
    // Check if the processed folder exists
    const tree = await client.list();
    const folderExists = tree.some(f => f.path === gmailProcessedFolder);
    
    if (folderExists) {
        console.log(`Mailbox "${gmailProcessedFolder}" exists. Opening...`);
        const mailbox = await client.mailboxOpen(gmailProcessedFolder);
        console.log(`Mailbox "${gmailProcessedFolder}" opened. Total messages found: ${mailbox.exists}`);

        if (mailbox.exists > 0) {
            console.log(`Deleting all ${mailbox.exists} messages from ${gmailProcessedFolder}...`);
            await client.messageFlagsAdd("1:*", ["\\Seen", "\\Deleted"]);
            console.log("✅ Marked all messages as Deleted in processed folder.");
        }
        await client.mailboxClose();
    } else {
        console.log(`Mailbox "${gmailProcessedFolder}" not found.`);
    }

    await client.logout();
  } catch (err: any) {
    console.error("❌ Gmail clean error:", err.message || err);
    process.exit(1);
  }
}

cleanProcessedFolder();
