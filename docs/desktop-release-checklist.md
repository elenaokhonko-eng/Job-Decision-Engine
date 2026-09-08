# Desktop Release Checklist

This checklist organizes the remaining work for a signed Windows desktop release. It is intentionally stricter than a local package build: a green local installer proves packaging, not production readiness.

## 1. Choose The Channel And Version

- `alpha`: internal smoke test, version like `1.0.0-alpha.1`.
- `beta`: supervised external testing, version like `1.0.0-beta.1`.
- `stable`: production candidate, version like `1.0.0`.

The validator rejects a channel/version mismatch. Published builds must run from a tag named exactly `v<package.json version>`.

## 2. Add Required GitHub Secrets

Choose a signing path first:

- PFX-compatible code signing certificate: fastest path for the current workflow. The certificate is exported as `.pfx`, base64 encoded, and loaded by GitHub Actions.
- CA cloud/HSM signing: acceptable for production, but may require a provider-specific workflow step instead of `.pfx` secrets.
- Microsoft Trusted Signing/Azure Artifact Signing: preferred for some direct-distribution Windows apps, but it is a separate integration path from the current PFX workflow.
- Self-signed certificate: useful only for internal smoke tests; it does not provide public trust.

For the current PFX workflow, add:

- `WINDOWS_CERTIFICATE_BASE64`: base64-encoded `.pfx` certificate.
- `WINDOWS_CERTIFICATE_PASSWORD`: password for that `.pfx`.

The workflow uses GitHub's built-in `GITHUB_TOKEN`; confirm repository Actions workflow permissions allow contents write before `publish=true`.

PowerShell helper for a local `.pfx`:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\certificate.pfx")) | Set-Content windows-certificate-base64.txt
```

Never commit the `.pfx`, password, or generated base64 text file.

## 3. Dry-Run The Installer

Run the manual `Desktop Release` workflow with:

- `channel`: selected channel.
- `publish`: `false`.

Expected evidence:

- Workflow is green.
- Uploaded artifact contains `Job-Decision-Engine-Setup-<version>.exe`.
- Uploaded artifact contains `latest.yml`.
- Uploaded artifact contains `desktop-release-evidence.md`.
- `desktop-release-evidence.md` says validation `PASS` and update metadata matches the installer artifact.

## 4. Publish The Signed Release

After the dry-run artifact is inspected, dispatch `Desktop Release` from the matching tag with:

- `channel`: selected channel.
- `publish`: `true`.

Expected evidence:

- Strict release validation passes.
- Signing certificate is loaded from GitHub secrets.
- GitHub Release receives the installer, `.blockmap`, and `latest.yml`.
- The app runtime reports the intended release channel.

## 5. Smoke-Test Install And Update

- Install the generated `.exe` on a clean Windows profile.
- Confirm the app opens and the settings screen reports `Native Shell`, `Secret Storage`, `Channel`, `Local API`, and `Updates`.
- Save an API token and confirm it is not present in browser localStorage.
- For update testing, publish a second higher version on the same channel and verify the app can check update metadata.

## 6. Release Evidence To Retain

- GitHub workflow URL.
- Commit SHA and git tag.
- `desktop-release-evidence.md`.
- Installer filename and SHA512 from `latest.yml`.
- Screenshot or log of installed app version/channel.
- Confirmation that no private `.env`, database export, Gmail content, or profile ledger was uploaded.

## Remaining Production Sign-Off Boundary

The repo can enforce packaging, versioning, artifact evidence, and publish prerequisites. Final production readiness still requires independent `release-security-reviewer` sign-off under `AGENTS.md`.
