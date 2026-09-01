# Security Policy

## Supported Versions

Security fixes are applied to the latest `main` branch.

## Reporting a Vulnerability

Please do not open public issues for sensitive vulnerabilities.

Report privately with:

1. Impact summary.
2. Reproduction steps.
3. Affected files and configuration.
4. Suggested mitigation, if available.

## Secrets and Data Safety

1. Never commit credentials (`DATABASE_URL`, API keys, app passwords).
2. Use GitHub Actions secrets for workflow runtime values.
3. Rotate credentials immediately if exposure is suspected.
4. Avoid committing personal profile artifacts unless explicitly anonymized for fixtures.
