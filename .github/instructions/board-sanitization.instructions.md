---
description: "Required sanitization rules for any CrewPilot content destined for external boards or APIs"
applyTo: '**/.crewpilot/**/handoff*.md, **/.crewpilot/**/work-items.md, **/.crewpilot/**/issue-draft.md, **/.crewpilot/**/pr-body.md, **/.crewpilot/**/board-payload*.md'
---

# Board Sanitization

Files matched by this glob feed outbound API calls (Jira, Azure DevOps, GitHub Issues, GitLab, pull request bodies). They are public from CrewPilot's perspective. Apply these rules before any tool serializes the content for transmission.

## Forbidden in outbound content

The following MUST NOT appear in any sanitized field (title, description, body, comment, custom field):

* Internal `.crewpilot/` paths or filenames. The `.crewpilot/` directory is workspace-private state.
* Absolute filesystem paths (`/Users/...`, `/home/...`, `C:\...`). Use repository-relative paths or omit.
* Authentication material: tokens, passwords, API keys, connection strings, bearer headers, cookies.
* Raw stack traces from internal services. Summarize the failure in one sentence.
* Internal user identifiers (Microsoft alias, employee ID, internal email domains) when the destination is a public board.
* Hostnames or IP addresses of internal infrastructure.
* Customer or tenant identifiers from logs.
* Verbatim secrets-bearing config files (`.env`, `*.pem`, `*.key`).

## Required transformations

Apply these substitutions before serialization:

| Source | Replacement |
|--------|-------------|
| Absolute path under workspace root | Workspace-relative path |
| Stack trace block | One-sentence error summary plus error type |
| Token-shaped string (40+ char alphanumeric) | `[redacted]` |
| Internal email | Display name only, or `[redacted]` |
| Internal hostname | Service role description (for example, `internal-cache-host`) |

## Length and format

* Title fields: under 200 characters. Trim trailing punctuation.
* Description fields: under 32 KB. Move overflow to attachments or linked artifacts.
* No raw HTML. Convert to markdown or plain text per the destination platform's supported syntax.
* No control characters except `\n` and `\t`.

## Verification before send

The MCP tool that posts the content (`crewpilot_board_create`, `crewpilot_board_update`, `crewpilot_git_pr`, etc.) MUST run the sanitization check immediately before transmission and abort with a structured error when any forbidden pattern is detected. The error includes the matched pattern category but never the matched value.

## Edge cases

* Quoted user content (a user explicitly pastes a path or token into their request) is still sanitized. CrewPilot does not relay secrets even when asked.
* Code blocks that demonstrate the bug are allowed to contain repository-relative paths. They MUST NOT contain real credentials. Replace with placeholders.
* Links to internal dashboards (Grafana, AppInsights, internal wikis) are allowed only when the destination board is itself internal (private repository, private project). Public boards strip them.

## Why this is enforced at the file layer

Sanitization at the adapter layer alone fails when a new tool is added without going through the same code path. Auto-applying this instruction whenever any agent edits one of the matched files surfaces violations at draft time, well before the network call.

> Brought to you by CrewPilot.
