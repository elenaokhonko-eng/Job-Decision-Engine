---
description: "Required quality conventions for every CrewPilot work item, issue draft, and story artifact"
applyTo: '**/.crewpilot/**/work-items.md, **/.crewpilot/**/issue-draft.md, **/.crewpilot/**/stories/**/*.md'
---

# Story Quality

These conventions apply to any work item, issue, or story CrewPilot drafts before posting to a board (Jira, Azure DevOps, GitHub Issues, GitLab). The `crewpilot_board_create` tool and the `strategize-solution-design`, `engineer-feature-builder`, and `autopilot-meeting` skills all produce artifacts subject to these rules.

## Title

* Action-oriented and verb-first ("Add CSV export", "Reduce p95 search latency").
* Concise and specific. A reader understands the deliverable from the title alone.
* Do not use vague verbs ("improve", "update", "fix things") without a concrete qualifier.
* No trailing punctuation.

## Description format

Choose the clearest of three patterns based on context.

| Pattern | When to use | Example |
|---------|-------------|---------|
| Classic user story | End-user-facing capability | "As a reviewer, I want inline comments so I can give feedback without leaving the diff." |
| Goal statement | Internal or technical work | "Enable CSV export of user profile data for GDPR compliance." |
| Problem statement | Bug-adjacent or improvement | "Search latency exceeds 3 seconds for queries with more than 100 results." |

Every description states:

* Who benefits and in what context.
* What is broken, missing, or needed.
* Why it matters, grounded in evidence when available.

## Acceptance criteria

* Use `- [ ]` checkbox syntax.
* Each item is binary, testable, and unambiguous.
* Target 5–10 focused items per story.
* Cover the relevant categories:
  * Functional behavior — core capability works as described.
  * Edge cases — boundary conditions, error states, empty inputs.
  * Performance — latency, throughput, or resource thresholds when applicable.
  * Observability — logging, metrics, or alerting when relevant.

## Definition of Done (optional section)

Include only when team-wide standards extend beyond the story-specific criteria. Common items:

* Unit or integration tests cover new behavior.
* Documentation updated (API docs, guides, inline comments).
* Structured logging or metrics added for new code paths.
* Migration steps documented when schema or data changes are involved.
* Accessibility verified when UI changes are included.

## Scope and sizing

* Each story targets a single component or concern with clear boundaries.
* Work spanning more than one week becomes an epic with sub-issues, each independently deliverable.
* State explicit exclusions to prevent scope creep.
* When a story touches multiple systems, split by system boundary.

## Evidence source

Tag each requirement with its origin so reviewers see the confidence level:

* User research — interviews, usability studies, support tickets.
* Analytics — usage metrics, error rates, performance traces.
* Stakeholder input — sponsor, product owner, or team lead request.
* Assumption — team hypothesis without direct evidence.

Requirements without direct evidence are explicitly labeled as unvalidated assumptions.

## Completeness checklist

Before marking a story ready, every item passes:

* [ ] User identification — who benefits and in what context.
* [ ] Problem statement — what is broken or missing, grounded in evidence.
* [ ] Evidence source — origin of each requirement noted.
* [ ] Success criteria — specific, measurable outcomes.
* [ ] Acceptance criteria — testable conditions in `- [ ]` form.
* [ ] Dependencies — upstream blockers and downstream consumers identified.
* [ ] Scope boundaries — explicit exclusions stated.

## Output template

```markdown
**Title**
[Verb-first title]

**Description**
[1-3 sentences in the clearest format for the context]

**Acceptance Criteria**
- [ ] Verifiable statement
- [ ] Verifiable statement
- [ ] Verifiable statement

**Definition of Done** (optional)
* Standards that always apply

**Open Questions / Risks / Dependencies** (optional)
* Unresolved items, assumptions, or items that belong in other stories
```

> Brought to you by CrewPilot.
