import dotenv from "dotenv";
import { GmailApiClient, loadGmailApiCredentials } from "../src/services/gmailApi.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

async function cleanProcessedFolder(): Promise<void> {
  const gmailClient = new GmailApiClient(loadGmailApiCredentials());
  const { messages } = await gmailClient.readMessagesByLabel(gmailProcessedFolder);

  console.log(`Gmail label "${gmailProcessedFolder}" contains ${messages.length} messages.`);
  for (const message of messages) {
    await gmailClient.deleteMessage(message.id);
  }
  console.log(`Deleted ${messages.length} processed Gmail messages through the Gmail API.`);
}

if (process.argv[1] && process.argv[1].includes("delete_processed_emails")) {
  cleanProcessedFolder().catch((error) => {
    console.error("Gmail processed-message cleanup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
