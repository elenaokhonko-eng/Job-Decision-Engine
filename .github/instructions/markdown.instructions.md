---
description: "Required formatting conventions for every Markdown file in CrewPilot"
applyTo: '**/*.md'
---

# Markdown Formatting

Apply these rules to all `.md` files in this repository. They mirror common markdownlint defaults and keep generated artifacts (release notes, digests, knowledge entries, PR bodies) consistent.

## General

* Use UTF-8 and plain ASCII punctuation.
* Files end with exactly one trailing newline.
* No trailing whitespace except a deliberate two-space hard line break.
* No more than one consecutive blank line.

## Headings

* Prefer ATX style (`#`, `##`, `###`).
* Exactly one H1 per file, at the top, matching the document title.
* Increase heading levels by one at a time. Do not skip.
* Surround every heading with a blank line above and below (except at file start).
* No trailing punctuation on headings (`. , ; : !`).
* Do not duplicate headings under the same parent.

## Lists

* Use `*` for unordered lists. Reserve `-` and `+` for files that already use them.
* Indent nested items by two spaces.
* One space between marker and text.
* Surround lists with a blank line before and after.
* Ordered lists use `1.` for every item or strict numerical increment. Do not mix.
* Fragment bullets (short phrases): no terminal period.
* Complete-sentence bullets: end with a period.

## Code blocks and code spans

* Always use fenced blocks (triple backticks). Never indented blocks.
* Always specify a language. Use `text` when no highlighting is desired.
* Surround fenced blocks with a blank line before and after.
* Inline code uses single backticks with no inner padding: `` `code` ``, not `` ` code ` ``.
* Do not prefix shell commands with `$` unless showing output.

## Links and images

* `[text](url)` for inline links. `<https://example.com>` for autolinks. Do not use bare URLs.
* Empty links (`[]()`, `(#)`) are forbidden.
* Provide alternate text for every image.
* Workspace-relative paths for internal file links. Never absolute paths.
* Do not wrap file paths or links in backticks — backticks suppress click targets.

## Tables

* Surround with a blank line before and after.
* Leading and trailing pipes on every row.
* Header and delimiter rows align in column count.
* Pad cells so pipes align vertically when feasible.

## Frontmatter

* CrewPilot artifacts that require frontmatter (`SKILL.md`, `*.instructions.md`, `*.agent.md`, `*.prompt.md`) MUST start with a YAML block delimited by `---` lines.
* When frontmatter contains `title:`, omit the H1 to satisfy MD025/MD041.
* Dates use ISO 8601 (`YYYY-MM-DD`).

## Emphasis and quotes

* `*italic*` and `**bold**` (asterisks). Do not use underscores for emphasis.
* No spaces inside emphasis markers.
* Blockquotes use a single space after `>`. Inside blockquotes, follow the same list and code rules.
* Use GitHub alert callouts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`) for genuine alerts only.

## Examples

```markdown
# Title

## Section

* Fragment item one
* Fragment item two

1. First step
2. Second step

| Column A | Column B |
|----------|----------|
| Value    | Value    |
```

> Brought to you by CrewPilot.
