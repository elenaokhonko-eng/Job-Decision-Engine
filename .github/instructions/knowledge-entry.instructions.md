---
description: "Required structure for CrewPilot KnowledgeStore entries"
applyTo: '**/.crewpilot/knowledge/**/*.md'
---

# Knowledge Entry

Files matched by this glob feed CrewPilot's `KnowledgeStore` and are indexed by the `TfIdfEngine`. Consistent structure produces cleaner retrieval signal across the `insights-knowledge-base`, `engineer-root-cause-analysis`, and `insights-pattern-detection` skills.

## Frontmatter

Every entry begins with YAML frontmatter:

```yaml
---
title: "Concise problem statement"
tags: [retry, jira, network]
created: 2026-05-08
confidence: high
source: incident
---
```

Field rules:

* `title` — verb-or-noun phrase under 100 characters. Same value repeats as the H1.
* `tags` — 2–6 lowercase kebab-case tokens. Used for facet retrieval.
* `created` — ISO 8601 date. Set once on creation; do not update on edit.
* `confidence` — one of `high`, `medium`, `low`. Reflects how reproducible the resolution is.
* `source` — one of `incident`, `investigation`, `runbook`, `meeting`, `external`.

## Required sections

In this order:

```markdown
# {{title}}

## Problem

One paragraph stating what was broken or unclear. Include observable symptoms, error messages, and the user-visible impact.

## Context

Bulleted list of environmental facts that shaped the problem:

* System or component affected.
* Versions, configurations, or dependencies that matter.
* Triggering conditions.
* What was attempted before this entry was written.

## Resolution

Numbered steps that fix or prevent recurrence. Each step is independently verifiable.

1. Step one.
2. Step two.
3. Step three.

## Evidence

Link to commits, PRs, board items, logs, or transcripts that ground the resolution. One bullet per source.

## Tags

Repeat the frontmatter tags as a flat bullet list for discoverability when frontmatter is stripped.
```

## Optional sections

Append when applicable, in this order:

* `## Related` — links to other knowledge entries that share root cause or context.
* `## Follow-up` — known unknowns or open questions worth tracking.
* `## Anti-patterns` — approaches that did not work and why.

## Style rules

* Use plain prose in `## Problem`. Avoid bulleted symptoms unless there are three or more independent ones.
* Resolution steps are imperative ("Restart the worker", not "I restarted the worker").
* Quantify when possible (timeouts in ms, sizes in MB, error rates as percentages).
* Sanitize per [board-sanitization.instructions.md](board-sanitization.instructions.md). Knowledge entries are workspace-internal but may be exported to issues or PRs.

## Length

* Aim for 200–800 words total. Entries longer than 1500 words probably contain two distinct knowledge units; split them.

## Why this structure

The TF-IDF engine weights document sections uniformly. Predictable section names keep retrieval relevance high and let downstream skills extract specific fields (Resolution, Evidence) without parsing free-form prose.

> Brought to you by CrewPilot.
