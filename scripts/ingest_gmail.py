"""Compatibility wrapper for the Gmail API ingestion entry point.

The collector is implemented once in TypeScript so local and GitHub Actions
execution use the same OAuth 2.0 and HTTPS/443 behavior.
"""

import os
import subprocess
import sys


def main() -> int:
    npx_command = "npx.cmd" if os.name == "nt" else "npx"
    completed = subprocess.run([npx_command, "tsx", "scripts/ingest_gmail.ts"], check=False)
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
