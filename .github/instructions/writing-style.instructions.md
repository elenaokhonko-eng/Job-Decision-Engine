---
description: "Required voice, tone, and language conventions for every Markdown artifact"
applyTo: '**/*.md'
---

# Writing Style

These conventions apply to all prose CrewPilot generates or stores: skill docs, daily digests, PR bodies, knowledge entries, release notes, and meeting summaries.

## Voice and tone by context

| Context | Voice | Pronouns |
|---------|-------|----------|
| Strategic and architecture docs | Authoritative, structured, precise | "we", "our" |
| Tutorials and guides | Direct, warm, concrete | "you", "your" |
| Personal rationale or trade-off notes | Reflective | "I" |
| Technical reference | Impersonal | none |
| Issue and PR comments | Appreciative, scope-focused | "we", "you" |

Maintain professionalism at every register. Adjust formality, never accuracy.

## Language

* Use precise terms over vague alternatives. Prefer specificity to flourish.
* Vary sentence length deliberately: longer for explanation, shorter for instruction.
* Use parallel structure in lists and comparisons.
* Front-load important information. Do not bury the lede.

## Patterns to avoid

### Em dashes

Do not use em dashes (—) for parenthetical asides, explanations, or pauses.

| Instead of | Use | Example |
|-----------|-----|---------|
| Aside | Commas | "The system, when enabled, logs all events." |
| Explanation | Colon | "One option remains: refactor the module." |
| Emphasis | Period | Start a new sentence. |
| Supplementary | Parentheses | "(See the appendix.)" |

### Bolded-prefix list items

Do not write lists where each item is a bolded term followed by a description.

```markdown
<!-- Avoid -->
* **Configuration**: set up env vars
* **Deployment**: push to production

<!-- Prefer -->
* Set up environment variables for configuration.
* Push to production for deployment.
```

Use plain lists, headings, or description lists instead.

### Hedging and filler

Delete these phrases. They add no information.

* "It's worth noting that..." → state directly.
* "It should be mentioned..." → state directly.
* "simply", "easily", "just" → delete.
* "robust", "powerful", "seamless" → replace with a specific quantifiable claim.

### Self-referential openings

Skip phrases like "This document explains..." or "This page will show you...". Start with the content.

### ALL CAPS

Reserve uppercase for acronyms and conventional commit types. Do not use it for emphasis.

## Callouts

Use GitHub alerts only when they match the intent.

| Alert | When to use |
|-------|-------------|
| `[!NOTE]` | Useful information worth noticing while skimming |
| `[!TIP]` | Helpful advice for doing something better or faster |
| `[!IMPORTANT]` | Information the reader needs to achieve the goal |
| `[!WARNING]` | Urgent issue that risks damage if ignored |
| `[!CAUTION]` | Risk or negative outcome of an action |

## Clarity over brevity

When the two conflict, choose clarity. Use examples to illustrate abstractions. Break complex ideas across short paragraphs rather than packing them into one sentence.

> Brought to you by CrewPilot.
