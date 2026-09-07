import { GmailApiClient, loadGmailApiCredentials } from "./gmailApi.js";

/**
 * Read raw Gmail messages by label through the Gmail API over HTTPS.
 * This helper is read-only on Gmail; label changes are performed only by the
 * durable ingestion script after the raw message is staged in PostgreSQL.
 */
export async function fetchGmailAlerts(): Promise<string[]> {
  const inboxLabel = process.env.GMAIL_LABEL ?? process.env.GMAIL_FOLDER ?? "Jobs-Alerts";
  const client = new GmailApiClient(loadGmailApiCredentials());
  const result = await client.readMessagesByLabel(inboxLabel);
  return result.messages.map((message) => message.raw);
}
