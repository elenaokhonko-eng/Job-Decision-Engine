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
    database_url = os.environ.get("DATABASE_URL", "").strip().strip('"').strip("'")
    if not database_url:
        print("❌ ERROR: DATABASE_URL environment variable is missing.")
        exit(1)

    # Ensure sslmode=require is in the database connection string for Neon
    if "sslmode=" not in database_url and "localhost" not in database_url and "127.0.0.1" not in database_url:
        if "?" in database_url:
            database_url += "&sslmode=require"
        else:
            database_url += "?sslmode=require"

    gmail_user = os.environ.get("GMAIL_USER", "").strip().strip('"').strip("'")
    gmail_password = os.environ.get("GMAIL_APP_PASSWORD", "").strip().strip('"').strip("'")
    gmail_folder = os.environ.get("GMAIL_FOLDER", "").strip().strip('"').strip("'")
    if not gmail_folder:
        gmail_folder = "Jobs-Alerts"
    gmail_processed_folder = os.environ.get("GMAIL_PROCESSED_FOLDER", "").strip().strip('"').strip("'")
    if not gmail_processed_folder:
        gmail_processed_folder = "Jobs-Alerts-Processed"

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
            raise Exception(f"Failed to select mailbox folder '{gmail_folder}'. Please make sure this label exists in Gmail.")

        # Search for ALL messages in the Jobs-Alerts folder
        status, search_data = mail.search(None, "ALL")
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

        # Create the processed folder if it doesn't exist
        mail.create(gmail_processed_folder)

        count = 0
        for mail_id in mail_ids:
            # Fetch raw RFC822 email content
            status, data = mail.fetch(mail_id, "(RFC822)")
            if status != "OK" or not data or not isinstance(data, list) or data[0] is None:
                print(f"Failed to fetch mail ID {mail_id} or message no longer exists.")
                continue

            if not isinstance(data[0], tuple) or len(data[0]) < 2:
                print(f"Unexpected format returned for mail ID {mail_id}")
                continue

            raw_email = data[0][1]
            msg = email.message_from_bytes(raw_email)

            # Decode Subject
            subject = "No Subject"
            if msg["Subject"]:
                try:
                    decoded = decode_header(msg["Subject"])[0]
                    subj_bytes, encoding = decoded
                    if isinstance(subj_bytes, bytes):
                        subject = subj_bytes.decode(encoding or "utf-8", errors="replace")
                    elif subj_bytes:
                        subject = str(subj_bytes)
                except Exception as e:
                    print(f"Warning: Failed to decode subject: {e}")

            print(f"Processing email: '{subject}'")

            # Extract Body
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    content_type = part.get_content_type()
                    content_disposition = str(part.get("Content-Disposition"))
                    
                    if content_type == "text/plain" and "attachment" not in content_disposition:
                        payload = part.get_payload(decode=True)
                        if payload:
                            body = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
                            break
                    elif content_type == "text/html" and "attachment" not in content_disposition:
                        payload = part.get_payload(decode=True)
                        if payload:
                            body = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            else:
                payload = msg.get_payload(decode=True)
                if payload:
                    body = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")

            # Insert email details into raw_email_alerts table
            cursor.execute(
                "INSERT INTO raw_email_alerts (subject, body, processed) VALUES (%s, %s, FALSE)",
                (subject, body)
            )
            
            # Mark email as read by adding the \Seen flag
            mail.store(mail_id, "+FLAGS", "\\Seen")
            
            # Copy to processed folder (label)
            mail.copy(mail_id, gmail_processed_folder)
            
            # Mark as deleted in current folder (removing the Jobs-Alerts label)
            mail.store(mail_id, "+FLAGS", "\\Deleted")
            
            count += 1

        conn.commit()
        cursor.close()
        conn.close()

        # Permanently remove marked messages from current folder
        mail.expunge()

        print(f"✅ Successfully ingested {count} raw email alerts to Postgres and moved to '{gmail_processed_folder}'.")
        
        mail.close()
        mail.logout()

    except Exception as err:
        print(f"❌ Error during Gmail alerts ingestion: {err}")
        exit(1)

if __name__ == "__main__":
    main()
