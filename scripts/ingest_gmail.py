import os
import imaplib
import email
from email.header import decode_header
import psycopg2

def main():
    print("====================================================")
    print("       GMAIL JOB ALERT INGESTION PIPELINE           ")
    print("====================================================")

    # Load Database URL
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("❌ ERROR: DATABASE_URL environment variable is missing.")
        exit(1)

    # Ensure sslmode=require is in the database connection string for Neon
    if "sslmode=" not in database_url and "localhost" not in database_url and "127.0.0.1" not in database_url:
        if "?" in database_url:
            database_url += "&sslmode=require"
        else:
            database_url += "?sslmode=require"

    gmail_user = os.environ.get("GMAIL_USER")
    gmail_password = os.environ.get("GMAIL_APP_PASSWORD")
    gmail_folder = os.environ.get("GMAIL_FOLDER", "Job Alerts")

    if not gmail_user or not gmail_password:
        print("⚠️ WARNING: GMAIL_USER or GMAIL_APP_PASSWORD environment variable is missing.")
        print("   Skipping Gmail alert ingestion. You can still insert jobs manually in the vault.")
        exit(0)

    try:
        print(f"Connecting to Gmail IMAP at imap.gmail.com...")
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(gmail_user, gmail_password)
        
        print(f"Selecting folder: '{gmail_folder}'...")
        status, messages = mail.select(gmail_folder)
        if status != "OK":
            print(f"⚠️ Folder '{gmail_folder}' not found. Defaulting to 'INBOX'...")
            status, messages = mail.select("INBOX")
            if status != "OK":
                raise Exception("Failed to select INBOX mailbox folder.")

        # Search for UNREAD messages
        status, search_data = mail.search(None, "UNSEEN")
        if status != "OK":
            print("No unread messages found.")
            mail.logout()
            exit(0)

        mail_ids = search_data[0].split()
        print(f"Found {len(mail_ids)} unread email alerts to process.")

        if len(mail_ids) == 0:
            mail.logout()
            exit(0)

        print("Connecting to Neon Postgres database...")
        conn = psycopg2.connect(database_url)
        cursor = conn.cursor()

        count = 0
        for mail_id in mail_ids:
            # Fetch raw RFC822 email content
            status, data = mail.fetch(mail_id, "(RFC822)")
            if status != "OK":
                print(f"Failed to fetch mail ID {mail_id}")
                continue

            raw_email = data[0][1]
            msg = email.message_from_bytes(raw_email)

            # Decode Subject
            subject, encoding = decode_header(msg["Subject"])[0]
            if isinstance(subject, bytes):
                subject = subject.decode(encoding or "utf-8", errors="replace")

            print(f"Processing email: '{subject}'")

            # Extract Body
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    content_type = part.get_content_type()
                    content_disposition = str(part.get("Content-Disposition"))
                    
                    if content_type == "text/plain" and "attachment" not in content_disposition:
                        payload = part.get_payload(decode=True)
                        body = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
                        break
                    elif content_type == "text/html" and "attachment" not in content_disposition:
                        payload = part.get_payload(decode=True)
                        body = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            else:
                payload = msg.get_payload(decode=True)
                body = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")

            # Insert email details into raw_email_alerts table
            cursor.execute(
                "INSERT INTO raw_email_alerts (subject, body, processed) VALUES (%s, %s, FALSE)",
                (subject, body)
            )
            
            # Mark email as read by adding the \Seen flag
            mail.store(mail_id, "+FLAGS", "\\Seen")
            count += 1

        conn.commit()
        cursor.close()
        conn.close()

        print(f"✅ Successfully ingested {count} raw email alerts to Postgres database.")
        
        mail.close()
        mail.logout()

    except Exception as err:
        print(f"❌ Error during Gmail alerts ingestion: {err}")
        exit(1)

if __name__ == "__main__":
    main()
