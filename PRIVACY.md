# Privacy Policy

**Job Decision Engine** is an open-source, local-first standalone desktop application and pipeline designed to give users complete control, transparency, and data ownership over their job discovery and career decision processes.

This Privacy Policy explains how data is handled by the application, how external services (such as your database and AI providers) are accessed, and how your privacy is protected.

---

## 1. Local-First Architecture & No Telemetry

- **Zero Central Telemetry**: Job Decision Engine does not collect, transmit, or store any telemetry, usage metrics, analytics, crash reports, IP addresses, or device identifiers on any centralized server.
- **No Intermediary SaaS**: The project maintainers do not operate a hosted SaaS backend, cloud intermediary, proxy server, or central database.
- **Local Execution**: All pipeline logic, data ingestion, deterministic hard gates, lane scoring, and document formatting run locally on your computer.

---

## 2. Data Storage & Ownership

- **Your Private Database**: All job observations, normalized postings, match evaluations, decision records, and profile fact ledgers are stored directly in your own private [Neon PostgreSQL](https://neon.tech) database (or local PostgreSQL instance).
  - Only you have access to your database connection strings.
  - The project maintainers have no access to your database, your job search history, or your stored records.
- **Local Secure Storage**: Desktop credentials—including your `DATABASE_URL`, `GEMINI_API_KEY`, and `OPENAI_API_KEY`—are encrypted on your computer using Electron's `safeStorage` API, which leverages your operating system's native cryptographic storage:
  - **Windows**: Data Protection API (DPAPI)
  - **macOS**: Keychain
  - **Linux**: Secret Service API / libsecret

---

## 3. Communication with External Services

Job Decision Engine connects only to services that you explicitly configure:

### A. Your PostgreSQL Database (Neon)
- The application connects directly from your local machine to your PostgreSQL database over encrypted TLS (`sslmode=require`).
- Used to store job observations, audit logs, and matching results.

### B. AI Providers (Google Gemini & OpenAI)
- **Bring Your Own Keys (BYOK)**: All generative AI evaluations and document synthesis calls use your personal API keys provided during setup.
- **Configured-provider operation**: When you configure a Gemini or OpenAI API key, the application uses that provider as part of its normal pipeline and document-generation behavior. No separate evaluation or document-generation consent gate is required by the desktop setup flow.
- **Strict Data Minimization**:
  - Deterministic hard gates run locally *before* any AI evaluation. Unqualified jobs and workability non-fits are rejected locally and never sent to an AI provider.
  - Only bounded, pre-screened job requirements and verified factual career claims are included in AI prompts.
  - Communications are sent directly from your local machine to the official API endpoints (`https://generativelanguage.googleapis.com` or `https://api.openai.com`) over HTTPS.
- Data sent to your AI provider is subject to the terms and privacy policy of that provider (e.g., Google Cloud / Google AI Studio Terms, OpenAI API Terms). Neither provider trains base models on API requests under standard developer API terms.

### C. Job Sources & Ingestion
- **Public Job Feeds & Web Endpoints**: When enabled, local collectors fetch public job postings from configured board APIs (e.g. Greenhouse, Ashby, Lever, Himalayas, Jobicy, Remotive, We Work Remotely) via HTTPS. No personal data is sent in these requests.
- **Gmail Job Alerts (Optional)**: If you configure Gmail ingestion, the application uses your personal Google OAuth 2.0 credentials to read emails from your specified job alert folder over HTTPS. Email content remains inside your private database and is never shared externally.

---

## 4. User Controls & Data Deletion

You retain absolute authority over your data at all times:
- **Consent Revocation**: You can enable or disable AI evaluation or document generation at any time in the application Settings or Setup Wizard.
- **Credential Removal**: You can clear stored API keys and database connections through the application settings or by clearing the local application storage directory.
- **Database Wipe**: You can purge or drop your database tables directly in your Neon console or by running the local reset commands.

---

## 5. Open Source Code Signing

Windows desktop installers and updates are digitally signed using a free code-signing certificate provided by the **SignPath Foundation** ([signpath.org](https://signpath.org)).
- When installing or running the application on Windows, the verified publisher will appear as **SignPath Foundation**.
- Code signing provides cryptographic verification that the installer has not been tampered with and was built directly from our public GitHub repository source code.
- No personal user data is sent to or collected by the SignPath Foundation during the installation or operation of the software.

---

## 6. Contact & Questions

If you have questions regarding this Privacy Policy or the security of the application, please open an issue or security advisory on the GitHub repository:
- Repository: [https://github.com/elenaokhonko-eng/Job-Decision-Engine](https://github.com/elenaokhonko-eng/Job-Decision-Engine)
- Security reporting: See [SECURITY.md](SECURITY.md)

