# Code Signing Policy

This document establishes the code-signing and release-governance policy for the **Job Decision Engine** desktop application.

Code signing for our official Windows releases is provided free of charge by the **SignPath Foundation** ([signpath.org](https://signpath.org)), a non-profit dedicated to supporting open-source software with secure code-signing infrastructure.

---

## 1. Verified Publisher Identity

When installing or executing official releases of Job Decision Engine on Microsoft Windows, the Windows User Account Control (UAC) prompt and SmartScreen dialog will display:

- **Verified Publisher**: `SignPath Foundation`
- **Certificate Authority**: Publicly trusted Certificate Authority recognized by Microsoft Windows.

Because the SignPath Foundation sponsors the code-signing certificate for this open-source project, their organization name appears as the verified publisher. This verifies that:
1. The binary was built directly from our public, open-source GitHub repository.
2. The executable has not been altered, infected, or tampered with since compilation.

---

## 2. Defined Roles & Responsibilities

To maintain strict separation of concerns and auditability, the project defines the following release roles:

| Role | Responsibilities | Permissions |
| :--- | :--- | :--- |
| **Contributor** | Submits pull requests, implements features, writes automated tests. | Read-only to repository settings; cannot trigger or approve signing. |
| **Reviewer** | Reviews code changes against architectural invariants, security rules, and tests. | Code review approval; cannot authorize releases without maintainer status. |
| **Approver / Maintainer** | Manages releases, triggers release workflows, and verifies build provenance. | Write access to repo, access to SignPath portal with release signing authorization. |

---

## 3. Mandatory Multi-Factor Authentication (MFA)

All maintainers, repository administrators, and release approvers MUST have Multi-Factor Authentication (MFA / 2FA) enabled on:
- Their **GitHub accounts** (via FIDO2/WebAuthn hardware keys or TOTP authenticator apps).
- Their **SignPath Foundation accounts**.

SMS-based verification is discouraged where hardware tokens or TOTP apps are supported. Any account lacking active MFA will have release and signing permissions revoked immediately.

---

## 4. Trusted Build Environment

To ensure complete build reproducibility and prevent supply-chain attacks:
- **GitHub-Hosted Runners Only**: All compilation, packaging, and signing request jobs MUST execute exclusively on official, ephemeral **GitHub-hosted runners** (`windows-latest`).
- **No Self-Hosted Runners**: Self-hosted or local machines are strictly prohibited from generating production signing requests.
- **Tagged Release Baseline**: Production signing workflows run only from verified Git tags matching the version declared in `package.json` (e.g. `v1.0.0`).
- **Audit Logs**: All GitHub Actions build logs and commit SHAs are permanently recorded in the GitHub workflow run history.

---

## 5. Signing Workflow & Manual Approval Gate

Code signing follows a strict, multi-step verification pipeline:

```mermaid
flowchart TD
  Tag[Git Tag Push\n(vX.Y.Z)] --> Runner[GitHub-Hosted Runner\nwindows-latest]
  Runner --> Build[Build Unsigned NSIS Installer\n& Verify SHA-256]
  Build --> Submit[Submit to SignPath via\ngithub-action-submit-signing-request]
  Submit --> Gate{SignPath Portal\nManual Approval Gate}
  Gate -->|Maintainer with MFA Reviews\nTag, Commit, Release Notes| Sign[SignPath HSM Signs Artifact\nwith Authenticode]
  Gate -->|Rejected| Fail[Workflow Aborts]
  Sign --> Download[Download Signed Installer\nVerify Signature & Publisher]
  Download --> Publish[Publish to GitHub Releases\n& Update Feed]
```

1. **Compilation**: The workflow compiles the frontend and backend, builds the NSIS installer (`Job-Decision-Engine-Setup-${version}.exe`), and computes its pre-signing SHA-256 hash.
2. **Submission**: The unsigned installer is uploaded to GitHub Artifacts and submitted to the SignPath API using the `signpath/github-action-submit-signing-request` action.
3. **Manual Approval Gate**: Every signing request pauses for manual approval in the SignPath Foundation portal. An authorized maintainer must review:
   - The source repository URL and commit SHA.
   - The associated Git tag and release channel (`stable` or `beta`).
   - The automated CI test results.
4. **Hardware Signing**: Once approved, SignPath applies the Authenticode digital signature using keys held securely inside their Hardware Security Modules (HSMs). The private signing keys are never exposed to GitHub, local computers, or developers.
5. **Download & Publish**: The GitHub Action retrieves the signed binary and verifies its cryptographic validity.

---

## 6. Post-Signing Verification & Integrity Checks

Before any signed build is accepted or published to GitHub Releases, the release automation verifies:

1. **Authenticode Signature Validity**: `Get-AuthenticodeSignature` must return status `Valid`.
2. **Publisher Name Check**: The signature Subject must explicitly contain `SignPath Foundation`.
3. **Nested Binary Verification**: The primary installer, the installed application executable, and the uninstaller must all carry valid digital signatures.
4. **Update Metadata Consistency**: Auto-update metadata (`latest.yml`) must contain the exact SHA-512 hash and file size of the final signed installer.

---

## 7. Incident Response & Key Revocation

If a security vulnerability or unauthorized binary is identified:
1. The maintainer will immediately remove the compromised download from GitHub Releases.
2. An advisory will be published via GitHub Security Advisories ([SECURITY.md](SECURITY.md)).
3. The maintainer will immediately notify the SignPath Foundation to revoke the signature or certificate if an integrity breach is suspected.
