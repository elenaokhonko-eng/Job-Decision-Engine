# Gmail API setup

The discovery workflow reads job-alert messages through the Gmail REST API over HTTPS. It does not open an IMAP socket or use a Gmail app password.

## Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable the Gmail API for that project.
3. Configure the OAuth consent screen for the account that owns the job-alert mailbox.
4. Create an OAuth 2.0 client and complete one interactive authorization to obtain a refresh token.

Use the least-privileged scope that matches the workflow:

- `https://www.googleapis.com/auth/gmail.readonly` when `GMAIL_READ_ONLY=true`.
- `https://www.googleapis.com/auth/gmail.modify` when the workflow must apply `GMAIL_PROCESSED_FOLDER` after database staging.

The API endpoint is `https://gmail.googleapis.com/gmail/v1/users/me`; GitHub Actions reaches it over standard HTTPS port `443`.

## GitHub configuration

Add these repository secrets:

- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REFRESH_TOKEN`

Optional repository variables:

- `GMAIL_FOLDER` — source label, default `Jobs-Alerts`.
- `GMAIL_PROCESSED_FOLDER` — destination label, default `Jobs-Alerts-Processed`.
- `GMAIL_READ_ONLY` — set to `true` to prevent Gmail label changes.

## Processing guarantee

The collector first reads the source label and stages each raw message in `raw_email_alerts`. Only after the PostgreSQL transaction commits does it apply the processed label. If labeling fails, the message remains available for retry and the durable database record is not lost.
