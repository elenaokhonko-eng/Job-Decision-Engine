# SignPath Foundation Application Submission Pack

This document provides ready-to-use, field-by-field answers for submitting the **Job Decision Engine** application on the **[SignPath Foundation Open Source Code Signing Application Page](https://signpath.org/apply)**.

---

## 1. Project Information Fields

### Project Name *
```text
Job Decision Engine
```

### Repository URL *
```text
https://github.com/elenaokhonko-eng/Job-Decision-Engine
```

### Homepage URL *
```text
https://github.com/elenaokhonko-eng/Job-Decision-Engine#readme
```

### Download URL
*(SignPath requires that this page mentions SignPath Foundation for code signing)*
```text
https://github.com/elenaokhonko-eng/Job-Decision-Engine/releases
```
> **Note for Application Reviewers**: Our public [`README.md`](https://github.com/elenaokhonko-eng/Job-Decision-Engine#readme) and [`CODE_SIGNING_POLICY.md`](https://github.com/elenaokhonko-eng/Job-Decision-Engine/blob/main/CODE_SIGNING_POLICY.md) prominently attribute the SignPath Foundation:
> *"Free code signing for Windows desktop releases is provided by the SignPath Foundation (https://signpath.org). When installing on Windows, the verified publisher will appear as SignPath Foundation."*
> As this application is for our inaugural digitally signed desktop release, unsigned pre-release CI artifacts and reproducible build workflow logs are fully verifiable on GitHub Actions.

### Privacy Policy URL
```text
https://github.com/elenaokhonko-eng/Job-Decision-Engine/blob/main/PRIVACY.md
```

### Wikipedia URL *(optional)*
*(Leave blank)*

---

## 2. Project Presentation & Details

### Tagline *
*(One concise sentence summarizing the project's unique value)*
```text
Local-first, auditable job decision engine with deterministic hard gates, private BYOK AI evaluation, and evidence-grounded document synthesis for independent builders and neurodivergent engineers.
```

### Description *
*(Comprehensive description explaining what the project does, who it serves, and why it matters)*
```text
Job Decision Engine is an open-source, local-first standalone desktop application and decision pipeline designed for independent builders, engineers, and neurodivergent / AuDHD job seekers.

Standard job search platforms create immense cognitive fatigue, sensory overload, and demoralizing rejection trauma through opaque applicant ranking algorithms and automated ATS rejections. Job Decision Engine reverses this paradigm by providing an auditable, personal decision engine with strict architectural invariants:

1. Deterministic Hard Gates: Location limits, remote workability, minimum compensation, and employment types are evaluated deterministically by local code before any AI models are consulted. Non-fits are eliminated locally without AI cost or hallucinated reasoning.
2. Operational Failures Never Become Career Rejections: Infrastructure hiccups, schema mismatches, network timeouts, or rate limits transition to retry states (RETRY_WAIT / NEEDS_MANUAL_REVIEW); they are never labeled as job or career rejections.
3. Unknowns Remain Explicit: Missing requirements or ambiguity produce NEEDS_VERIFICATION rather than fabricated assumptions.
4. Strategic Multi-Lane Discovery: Aggregates across four target domains: Core AI/Data, Legal/RegTech, Health/Bio/Pharma, and Investment/Fintech.
5. Local-First & BYOK Privacy: Runs locally as a standalone Electron desktop app. User data is stored in their private PostgreSQL instance. Generative AI evaluation (Google Gemini or OpenAI) uses personal API keys only with explicit user opt-in (allow_ai_evaluation).
6. Evidence-Grounded Documents: Programmatically generates tailored DOCX resumes and cover letters strictly mapped to a factual career evidence ledger, eliminating hallucination.

The software is 100% open-source under the MIT License with zero proprietary dependencies. Code signing via the SignPath Foundation will ensure our desktop installers carry verifiable provenance and cryptographic integrity on Windows.
```

### Reputation *
*(Evidence demonstrating project legitimacy, maintenance, community discussion, and technical rigor)*
```text
1. Active Public GitHub Repository:
   - Repository: https://github.com/elenaokhonko-eng/Job-Decision-Engine
   - License: MIT License (OSI-approved, no commercial dual-licensing or proprietary dependencies).
   - Commit History: Active, continuous commit history with thorough architectural documentation and commit messages.

2. Comprehensive Automated Testing & CI Quality Gates:
   - Full GitHub Actions continuous integration suite running on every push/PR: https://github.com/elenaokhonko-eng/Job-Decision-Engine/actions
   - Over 275+ unit, integration, and failure-injection tests in Vitest.
   - Strict desktop packaging verification (56 automated checks verifying icons, updater policies, and security configs).
   - Automated database migration runner verifying 46 PostgreSQL migrations in sequence.

3. Documented Public Governance & Policies:
   - Code Signing Policy: https://github.com/elenaokhonko-eng/Job-Decision-Engine/blob/main/CODE_SIGNING_POLICY.md
   - Privacy Policy: https://github.com/elenaokhonko-eng/Job-Decision-Engine/blob/main/PRIVACY.md
   - Security Policy: https://github.com/elenaokhonko-eng/Job-Decision-Engine/blob/main/SECURITY.md
   - Third-Party Notices: https://github.com/elenaokhonko-eng/Job-Decision-Engine/blob/main/THIRD_PARTY_NOTICES.md
   - Architecture & Contracts: Detailed design specifications in docs/architecture.md and AGENTS.md.

4. Community Focus & Real-World Utility:
   - Specifically addresses employment accessibility for neurodivergent (AuDHD) engineers and independent software builders by reducing cognitive load, providing auditable decision traces, and ensuring complete privacy over personal career data.
```

### Maintainer Type
*(Select from dropdown)*
```text
Individual / Project Creator
```
*(Or "Open Source Maintainer" depending on options presented)*

### Build System
*(Select or enter)*
```text
GitHub Actions
```

---

## 3. Contact Details

### First Name *
```text
Elena
```

### Last Name *
```text
Okhonko
```

### Email *
```text
elena.okhonko@gmail.com
```

### Company Name *(optional)*
*(Leave blank or enter: "Job Decision Engine OSS Project")*

---

## 4. Discovery Channel

### Primary Discovery Channel *
*(Select from dropdown)*
```text
Web Search / Recommendation
```
*(Or "GitHub / Other Open Source Projects" if available)*

### Please specify exact source *(optional)*
```text
Recommended by open source developers and community projects using SignPath Foundation for free open-source code signing.
```

---

## 5. Agreements & Consents

- [x] **I acknowledge that I have read and agree to the SignPath Foundation Code of Conduct** *(Check box)*
- [ ] **I agree to receive other communications from SignPath GmbH** *(Optional)*
- [x] **By submitting this form, you agree that we process your personal data according to our privacy policy** *(Check box)*

---

## 6. Post-Submission Checklist for Maintainer

Once your application is approved by the SignPath Foundation team:

1. **Accept Invitation**: Log into the SignPath portal via your invitation link and ensure your account has Multi-Factor Authentication (MFA) enabled.
2. **Retrieve Organization & Project Identifiers**:
   - Organization ID (UUID from SignPath portal)
   - Project Slug (e.g. `job-decision-engine`)
   - Signing Policy Slug (e.g. `release-signing` and `test-signing`)
3. **Generate API Token**: Generate a SignPath API token with signing request submission permissions.
4. **Configure GitHub Repository Secrets**:
   Go to: `https://github.com/elenaokhonko-eng/Job-Decision-Engine/settings/secrets/actions` and add:
   - `SIGNPATH_API_TOKEN`
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
5. **Trigger Desktop Release**:
   Run the `.github/workflows/desktop-release.yml` workflow with `publish: true` from a tagged release (e.g. `v1.0.0`).
6. **Approve Signing Request**:
   When prompted during the GitHub Actions run, log into the SignPath Foundation portal and click **Approve** on the pending signing request.
7. **Verify Signed Release**:
   Download the published installer from GitHub Releases and verify that Windows displays `SignPath Foundation` as the verified publisher.

