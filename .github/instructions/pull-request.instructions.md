---
description: "Required structure for CrewPilot pull request bodies"
applyTo: '**/.crewpilot/**/pr-body.md, **/.crewpilot/**/pull-request*.md'
---

# Pull Request Body

The `assure-pr-intelligence` skill drafts PR descriptions into files matched by this glob. The `crewpilot_git_commit` flow and any tool that posts to GitHub or ADO consumes the rendered body.

## Required sections

A PR body contains these sections in this order. Omit a section only when there is genuinely nothing to say.

```markdown
## Summary

One paragraph stating what this PR changes and why. Reference the linked issue or story.

## Changes

* Bullet list of meaningful code or doc changes.
* Group related changes; do not list every file.
* 3-10 bullets typical. Split into subsections only for very large PRs.

## Risk

State the blast radius and rollback path:

* Affected components or services.
* Data migration or schema changes (link the migration step).
* Backward compatibility impact.
* Monitoring or alerting that should fire if something regresses.

## Validation

How the change was verified:

* Tests added or updated (link the test files).
* Manual verification steps performed.
* CI checks expected to pass.
* Performance numbers when relevant.

## Rollback

* How to revert in production (revert commit, feature flag, config change).
* Time-to-rollback estimate.
* Dependencies that complicate rollback.
```

## Optional sections

Add when context warrants, in this order after the required sections:

* `## Screenshots` — for UI-affecting changes. Include before/after.
* `## Migration Notes` — when consumers of the changed code must update.
* `## Follow-ups` — known work intentionally deferred. Each item links to a tracking issue or is filed before merge.

## Style rules

* Title (the PR subject, not in the body) follows Conventional Commits — see [commit-message.instructions.md](commit-message.instructions.md).
* Write in past or present tense, not future. ("Added retry logic", not "Will add retry logic".)
* Link issues with the platform's auto-close syntax when the PR fully resolves them: `Closes #123`, `Fixes WI-456`, `Resolves JIRA-789`.
* Reference files using markdown links to workspace-relative paths.
* Do not include internal `.crewpilot/` paths, absolute filesystem paths, or stack traces in any section. See [board-sanitization.instructions.md](board-sanitization.instructions.md).

## Example

```markdown
## Summary

Adds retry-with-exponential-backoff to the board adapter so transient Jira and ADO timeouts no longer fail entire autopilot runs. Closes #142.

## Changes

* Introduce `withRetry` helper in `crewpilot-engine/src/services/board-adapter.ts`.
* Wrap all outbound calls in `JiraAdapter` and `AdoAdapter` with the helper.
* Add jittered backoff (100ms base, 5 attempts max).
* Update tests to cover transient-failure recovery.

## Risk

* Affects every board write path. Long-running autopilot runs now take up to ~3s longer in worst-case retry scenarios.
* No schema or data migration.
* Backward compatible.

## Validation

* New unit tests in `crewpilot-engine/tests/board-adapter.test.ts`.
* Manual smoke against a Jira sandbox confirmed retries fire on simulated 503s.
* CI green on Node 18 and 20.

## Rollback

* Revert this PR. No data changes to undo.
* Time to rollback: under 5 minutes.
```

> Brought to you by CrewPilot.
