---
description: "Required structure for CrewPilot daily digest artifacts"
applyTo: '**/.crewpilot/digest/**/*.md'
---

# Daily Digest

The `daily-digest` skill produces files matched by this glob. The digest is read by humans first, then often forwarded to chat or email; structure must hold up in both contexts.

## Frontmatter

```yaml
---
title: "CrewPilot Daily Digest"
date: 2026-05-08
window: "2026-05-07T17:00 to 2026-05-08T17:00"
---
```

Field rules:

* `date` — ISO 8601 date the digest covers.
* `window` — half-open time range the digest aggregates. Use ISO 8601 datetimes including timezone offset when a timezone other than the workspace default applies.

## Required sections

In this order:

```markdown
# CrewPilot Daily Digest — {{date}}

## TL;DR

Three to five bullets summarizing the most important activity in the window. A reader who reads only this section understands what happened.

## Activity

### Code

* PRs merged, opened, or stalled. Link each.

### Boards

* Issues created, closed, or moved to in-progress. Link each.

### Knowledge

* New knowledge entries added. Link each with one-line summary.

### Meetings

* Meetings summarized in the window. Link each.

## Risks and Blockers

Items currently blocking work or showing a regression signal. One bullet per risk with owner.

## Recommended Actions

Numbered list of suggested next actions for the team. Each action is concrete and assignable.

1. Action one.
2. Action two.
```

## Optional sections

Append when the window contains meaningful content, in this order:

* `## Metrics` — numeric trends worth highlighting (deploy frequency, mean time to merge, open issue count delta).
* `## Patterns` — recurring themes detected across the window by `insights-pattern-detection`.
* `## Follow-ups from Yesterday` — items that were `## Recommended Actions` in the prior digest, with status.

## Style rules

* The TL;DR section never exceeds five bullets. Move detail into the activity sections.
* Use markdown links for every PR, issue, knowledge entry, and meeting reference.
* Bullets are fragments without trailing periods. Sentences in prose sections take periods.
* Quantify deltas: "5 new issues (+2 vs yesterday)", not "more issues than yesterday".
* Sanitize per [board-sanitization.instructions.md](board-sanitization.instructions.md) — digests often get forwarded externally.

## Empty windows

When the window has no activity in a given subsection, omit the subsection entirely rather than rendering "None" or "No activity". Empty headings clutter the digest.

> Brought to you by CrewPilot.
