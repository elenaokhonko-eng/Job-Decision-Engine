import { ImapFlow } from "imapflow";

/**
 * Connect to Gmail via IMAP and fetch unread messages that match a given label.
 * Returns an array of raw email bodies (plain‑text). Emails are marked as Seen
 * after successful retrieval.
 */
export async function fetchGmailAlerts(): Promise<string[]> {
  const host = "imap.gmail.com";
  const port = 993;
  const secure = true;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_PASS;
  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER / GMAIL_PASS not set in .env.local – cannot access Gmail."
    );
  }

  // Use inbox and processed labels from env (defaults provided)
  const inboxLabel = process.env.GMAIL_LABEL ?? "jobs-alerts";
  const processedLabel = process.env.GMAIL_LABEL_PROCESSED ?? "jobs-alerts-processed";

  const client = new ImapFlow({ host, port, secure, auth: { user, pass } });
  await client.connect();

  // Select the mailbox (use "INBOX")
  const lock = await client.getMailboxLock("INBOX");
  try {
    // Search for unseen messages
    const uids = await client.search({ unseen: true });
    const bodies: string[] = [];

    for await (const msg of client.fetch(uids, { source: true, flags: true, envelope: true })) {
      // Check for inbox label
      const hasInboxLabel = msg.flags?.some((f) => f === inboxLabel);
      if (!hasInboxLabel) continue;

      const raw = Buffer.from(msg.source!).toString("utf8");
      bodies.push(raw);

      // Tag as processed
      await client.messageFlagsAdd(msg.uid, [processedLabel]);
      await client.messageFlagsRemove(msg.uid, [inboxLabel]);
    }
    return bodies;
  } finally {
    lock.release();
    await client.logout();
  }

  // Legacy Gmail fetch logic removed – handled above with inbox/processed label handling
}
