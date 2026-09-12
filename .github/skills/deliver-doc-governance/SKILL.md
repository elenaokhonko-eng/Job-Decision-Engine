# Doc Governance

> **Pillar**: Deliver | **ID**: `deliver-doc-governance`

## Purpose

Treat documentation as a first-class deliverable. This skill runs in one of four modes selected by the caller or inferred from the trigger phrase: `audit` (build the doc inventory), `drift` (compare docs against current code), `validate` (check completeness), and `author` (produce the corrected content). Each mode has a bounded input, a bounded workflow, and a bounded output so callers can compose them without pulling in the full pipeline every time.

## Activation Triggers

- "update docs", "docs are stale", "check documentation" — infer `drift` mode.
- "sync README", "API docs", "documentation drift" — infer `drift` mode.
- "audit docs", "inventory documentation", "what docs cover this repo" — `audit` mode.
- "is doc coverage complete", "missing docs", "documentation checklist" — `validate` mode.
- "rewrite this doc", "generate the README section", "author the changelog entry" — `author` mode.
- Automatically chained after `engineer-feature-builder` or `engineer-architecture-planner` when public APIs change — `drift` mode, then `author` mode if drift is found.

## Methodology

The skill selects one of four modes. Callers pass the mode explicitly when known; otherwise infer from the trigger phrase.

### Mode: `audit`

Input: repository root or a subdirectory path.

Workflow:

1. Locate every documentation file: `README.md` at root and in subdirectories, everything under `docs/`, generated API docs (OpenAPI, JSDoc, docstrings), `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`.
2. For each file, record: path, headings tree, last-modified timestamp, and the code surface it purports to cover (module, package, config key, CLI subcommand).
3. Emit the inventory table.

Output: `Documentation Map` table only. Does not read code; does not detect drift.

### Mode: `drift`

Input: the `audit` output plus the current source tree.

Workflow:

For each covered surface, compare the documented behaviour against the code:

| Check | Method |
|---|---|
| API signatures | Compare documented function signatures against actual definitions. |
| Configuration | Compare documented env vars and config keys against actual reads in code. |
| Installation | Verify documented install steps still work by inspecting scripts and dependencies. |
| Examples | Check whether code examples in docs match the current API. |
| Architecture | Compare documented file tree or module map against the actual layout. |
| Dependencies | Compare documented requirements against the current manifest. |

For each drift, emit one line: `DRIFT: <doc file>:<line> — <documented> ≠ <actual>`.

Classify each drift:

| Severity | Criteria |
|---|---|
| Critical | Wrong API usage instructions will cause errors for users. |
| High | Missing documentation for new public features. |
| Medium | Outdated examples, stale screenshots, wrong file paths. |
| Low | Minor wording inaccuracies or formatting issues. |

Output: `Drift Detected` list with severity per entry. Does not modify files.

### Mode: `validate`

Input: the `audit` output.

Workflow:

Check the minimum documentation set exists:

- [ ] README with project description, setup, usage.
- [ ] API documentation for every public interface.
- [ ] Configuration reference for every env var and setting.
- [ ] Contributing guide when the repository is open-source.
- [ ] Changelog when releases are managed.

Output: `Completeness` checklist with pass or fail per item. Does not detect drift; does not author content.

### Mode: `author`

Input: a specific drift entry or a specific missing item from `validate`.

Workflow:

1. Read the source-of-truth code path for the item under repair.
2. Generate the corrected documentation content.
3. Preserve the existing voice, tone, and heading structure of the surrounding document.
4. When examples are included, verify they compile or run against the current code before writing them.
5. Update any auto-generated sidebar or table of contents entries touched by the change.

Output: the corrected content as a patch or ready-to-write block. Does not commit; commit belongs to `deliver-change-management`.

## Tools Required

- `codebase` — read source code and documentation files.
- `terminal` — verify install steps and run examples.
- `crewpilot_knowledge_search` — check whether documentation decisions were previously recorded.

## Output Format

Each mode has its own output block. The caller emits only the blocks for the mode(s) run.

````markdown
## [CrewPilot → Doc Governance — {{mode}}]

### Documentation Map
| Doc File | Covers | Status |
|---|---|---|
| {{path}} | {{what it documents}} | {{current | stale | missing}} |

### Drift Detected
#### [{{severity}}] {{doc file}}:{{line}}
Documented: {{what the doc says}}
Actual: {{what the code does}}
Fix: {{corrected content}}

### Completeness
- [x] README present
- [ ] Configuration reference missing

### Authored Content
```diff
- old content
+ new content
```

### Summary
Mode: {{mode}}. {{N}} drifts: {{critical}}/{{high}}/{{medium}}/{{low}}. Completeness: {{pass|fail}}.
````

## Chains To

- [`deliver-change-management`](../deliver-change-management/SKILL.md) — commit the authored updates.

## Anti-Patterns

- Do NOT rewrite documentation in a different voice or style.
- Do NOT add documentation for internal or private APIs unless asked.
- Do NOT remove valid documentation just because it is verbose.
- Do NOT generate placeholder documentation ("TODO: add docs").
- Do NOT run `author` mode without first running `drift` or `validate` on the specific item being changed. The mode map exists so authoring never runs blind.

## Verification

Evidence produced:

- Drift-detection report mapping every changed public API, config key, or CLI surface to its corresponding doc location (or `MISSING`).
- Stale-doc list with last-modified timestamps and the source change that invalidated each doc.
- Updated-docs diff produced (or, when updates are declined, an explicit list of accepted-stale items).

Completion gates:

- [ ] Every public API or config change is mapped to a doc verdict (in-sync / drift / missing / not-required-with-reason).
- [ ] Updated docs preserve the project's existing voice and structure.
- [ ] No placeholder text ("TODO: add docs", "see implementation") in delivered updates.
- [ ] Internal or private surfaces are not documented unless explicitly requested.
- [ ] The selected mode is recorded in the output so downstream skills know which slice ran.

Blocking conditions:

- Drift detected and updates declined without a stated reason → surface as a release blocker.
- Generated docs contradict the code → do not commit; rewrite from the source of truth.
- Doc location ambiguous → ask the user instead of writing in the wrong place.
- `author` mode invoked without a prior `drift` or `validate` finding to anchor on → refuse and re-route the caller.
