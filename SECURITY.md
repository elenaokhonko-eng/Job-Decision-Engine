# Security Policy

The **Job Decision Engine** project takes security, confidentiality, and data privacy seriously. Because this software evaluates career data, connects to private databases, and interfaces with AI providers, we adhere to strict security invariants and release governance.

---

## Supported Versions

Security updates and patches are actively applied to the latest release and the `main` branch.

| Version | Supported |
| :--- | :--- |
| Latest Release (`>= 1.0.0`) | :white_check_mark: |
| `main` branch | :white_check_mark: |
| Pre-release / Legacy branches | :x: |

---

## Maintainer Multi-Factor Authentication (MFA)

To guard against account takeovers and unauthorized code modifications:
- All repository maintainers and team members with write access or release approval rights **must enforce Multi-Factor Authentication (MFA / 2FA)** on their GitHub and SignPath Foundation accounts.
- FIDO2/WebAuthn hardware security keys or TOTP mobile authenticators are required.
- Any maintainer account found without active MFA will be suspended from release and commit privileges immediately.

---

## Build System & Supply Chain Security

- **Trusted Build Environment**: All production desktop binaries and update feeds are compiled strictly on ephemeral, official **GitHub-hosted runners** (`windows-latest`). Self-hosted runners are prohibited for releases.
- **Hardware-Backed Code Signing**: Windows executables are signed via the **SignPath Foundation** ([signpath.org](https://signpath.org)). Private signing keys reside exclusively on certified Hardware Security Modules (HSMs) managed by SignPath. No developer, workflow, or repository ever has access to private key material.
- **Manual Signing Approval Gate**: Every production signing request requires explicit manual approval by an authorized maintainer with MFA in the SignPath portal.
- **Automated Security Scanning**: The repository executes GitHub CodeQL and secret scanning on every pull request to detect potential vulnerabilities and prevent accidental credential leaks.

---

## Secrets and Data Safety

1. **Local-First Isolation**: Database credentials (`DATABASE_URL`) and AI keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`) are stored on the user's local device using operating-system-backed encryption (Electron `safeStorage`).
2. **Never Commit Secrets**: Do not commit `.env*`, database connection strings, API tokens, or OAuth refresh tokens to git.
3. **Anonymized Testing Fixtures**: All repository test fixtures and golden evaluation cases use synthetic or anonymized job records and mock profiles.

---

## Reporting a Vulnerability

If you discover a potential security vulnerability in Job Decision Engine, please report it privately. **Do not create a public GitHub issue.**

### How to Report
1. Use [GitHub Private Vulnerability Reporting](https://github.com/elenaokhonko-eng/Job-Decision-Engine/security/advisories/new) if available on the repository.
2. Alternatively, email the maintainer directly at **elena.okhonko@gmail.com** with the subject `[SECURITY] Job Decision Engine Vulnerability Report`.

Please include:
- A description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or proof-of-concept.
- Affected file(s), version, and platform (e.g. Windows desktop, API v2, database migration).

### Response SLA
- **Initial Acknowledgement**: Within 48 hours.
- **Triage and Fix Timeline**: Critical vulnerabilities will be patched and a signed update released within 7 days.
