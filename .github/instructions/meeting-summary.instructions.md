---
description: "Required structure for CrewPilot meeting summary artifacts"
applyTo: '**/.crewpilot/meetings/**/*.md'
---

# Meeting Summary

The `autopilot-meeting` skill writes summaries into files matched by this glob. Predictable structure makes downstream extraction (action items into the board, decisions into knowledge) reliable.

## Frontmatter

```yaml
---
title: "Meeting subject"
date: 2026-05-08
attendees: [alice, bob, carol]
duration_minutes: 45
type: standup
---
```

Field rules:

* `title` — short subject. Same value repeats as the H1.
* `date` — ISO 8601 date the meeting occurred.
* `attendees` — list of names or handles. Sanitize per [board-sanitization.instructions.md](board-sanitization.instructions.md) before any export.
* `duration_minutes` — positive integer.
* `type` — one of `standup`, `planning`, `review`, `retro`, `customer`, `interview`, `other`.

## Required sections

```markdown
# {{title}}

## Context

One paragraph describing the meeting's purpose and any prior context a reader needs to understand the decisions.

## Decisions

Numbered list of decisions reached. Each decision is one sentence stating the chosen path and, when relevant, who owns it.

1. Decision one.
2. Decision two.

## Action Items

Checkbox list. Each item names the owner and a target date when known.

- [ ] Owner — Action description (due YYYY-MM-DD)
- [ ] Owner — Action description

## Open Questions

Bullet list of unresolved items. Each entry states the question and, when known, who is expected to resolve it.

* Question one — owner.
* Question two.
```

## Optional sections

Append in this order when applicable:

* `## Discussion Notes` — chronological summary for meetings whose value is the discussion itself (retro, customer interview).
* `## Risks` — newly surfaced risks worth tracking.
* `## Next Steps` — sequence of follow-up meetings or milestones.
* `## References` — links to slides, recordings, related artifacts.

## Style rules

* Decisions and action items use complete sentences in past or present tense.
* Action item owners use display names, not internal aliases.
* When the meeting transcript contains sensitive customer or financial detail, summarize at a level safe for export and place verbatim quotes (if needed) in a separate file outside `.crewpilot/meetings/`.
* Do not include verbatim transcripts in this file. Reference them by link in `## References` if they exist.

## Action item lifecycle

The `autopilot-meeting` skill chains to `crewpilot_board_create` for unchecked action items. Sanitization rules apply to every field that crosses the boundary.

> Brought to you by CrewPilot.
