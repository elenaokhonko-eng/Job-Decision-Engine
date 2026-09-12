# Code Review — Standards & Conventions

> **Pillar**: Assure | **ID**: `assure-review-standards`

## Purpose

Focused code review that evaluates **coding standards, naming conventions, test patterns, and consistency** with the existing codebase. Separated from functional review so each can be delegated to a specialized subagent or run independently.

## Activation Triggers

- "standards review", "conventions check", "consistency review", "does this match our style"
- Automatically invoked by autopilot-worker Phase 6 via subagent delegation (role: `standards-reviewer`)
- Can be run standalone for targeted reviews

## Methodology

### Step 0 — Prior Art Lookup

1. Call `crewpilot_knowledge_semantic_search` with a query built from the changed file paths and the PR title.
2. Surface up to 3 relevant hits with title, type, and a one-line summary. Prefer hits of type `pattern` (past convention decisions) and `review` (prior findings on the same module).
3. If a prior review flagged the exact convention now under discussion, surface it in Step 3's consistency analysis rather than re-discovering.
4. This lookup is non-blocking — a knowledge store miss must not stall the review.

### Step 1 — Discover Codebase Conventions

Before reviewing, establish the project's conventions by scanning:
1. **Naming**: variable/function/class naming style (camelCase, snake_case, PascalCase)
2. **File structure**: directory layout, module organization, barrel exports
3. **Error handling**: how errors are thrown/caught/logged (Result types? try/catch? error codes?)
4. **Test patterns**: test framework, file naming (`*.test.ts` vs `*.spec.ts`), describe/it structure, setup/teardown
5. **Import style**: absolute vs relative, barrel imports, import ordering
6. **Type patterns**: explicit types vs inference, use of `any`, union types vs enums

Read `.editorconfig`, `.eslintrc`, `tsconfig.json`, or similar config files if they exist.

### Step 2 — Convention Compliance Check

For each changed file, check against the discovered conventions:

| Category | What to Check |
|----------|---------------|
| **Naming** | Functions, variables, types, files match project style |
| **Structure** | New files placed in correct directory, exports follow project pattern |
| **Error handling** | Matches project's error handling style (not just "has error handling") |
| **Tests** | Test file structure mirrors source, uses same describe/it/expect patterns |
| **Types** | Follows project's type annotation style (strict types vs inference) |
| **Imports** | Import ordering, relative vs absolute paths, no circular imports |
| **Comments** | JSDoc where project uses JSDoc, no commented-out code |

### Step 3 — Consistency Analysis

1. Compare the diff against the 5 nearest files in the same directory
2. Flag any deviation from the local style (even if technically valid)
3. Check for copy-paste code that should be extracted
4. Verify new code follows the same patterns as existing code in the same module

### Step 4 — Pattern Detection Integration

1. Query `crewpilot_knowledge_search` (type: `pattern`) for known conventions and anti-patterns
2. Check if any flagged deviation is a **repeat offense** from past reviews
3. If repeat offense found, flag prominently:
   ```
   ⚠️ Recurring Convention Violation: {description}
   Previously flagged in: {previous context}
   Suggestion: Consider adding a lint rule or pre-commit hook.
   ```

### Synthesis

1. Categorize findings: `convention-violation | inconsistency | repeat-offense | suggestion`
2. Filter by confidence threshold
3. Group by category
4. If invoked as subagent, write output as artifact via `crewpilot_artifact_write` (phase: `review-standards`)

## Tools Required

- `crewpilot_knowledge_search` — Query known patterns and past convention violations
- `crewpilot_knowledge_semantic_search` — Step 0 prior-art lookup with fuzzy natural-language queries
- `crewpilot_artifact_write` — Persist review findings as artifact (when run as subagent)
- `crewpilot_artifact_read` — Read prior analysis artifacts for context

## Output Format

```
## [CrewPilot → Standards Review]

### Summary
{N} findings across {files}: {violations} violations, {inconsistencies} inconsistencies, {repeat} repeat offenses

### Convention Violations
| Category | File:Line | Convention | Violation | Fix |
|----------|-----------|------------|-----------|-----|
| ...      | ...       | ...        | ...       | ... |

### Inconsistencies
| File:Line | Expected Pattern | Actual | Nearest Example |
|-----------|------------------|--------|-----------------|
| ...       | ...              | ...    | ...             |

### Repeat Offenses
| Issue | Previous Occurrence | Suggestion |
|-------|---------------------|------------|
| ...   | ...                 | ...        |

### Verdict
{PASS | PASS_WITH_WARNINGS | FAIL}
Confidence: {N}/10
```

## Chains To

- `assure-review-functional` — Companion skill for correctness/security/performance review
- `assure-code-quality` — Full 4-pass review (superset of this skill)
- `insights-pattern-detection` — Deep codebase-wide pattern analysis

## References

- [Review Severity Taxonomy](../../references/review-severity-taxonomy.md) — shared Blocker / Critical / Major / Minor / Suggestion vocabulary and the gate each level applies.
- [Review Output Formats](../../references/review-output-formats.md) — shared report skeleton, verdict vocabulary, and persistence contract.

## Anti-Patterns

- Do NOT enforce a personal style guide over the project's own conventions. Discover, then check.
- Do NOT flag valid alternative styles as violations when the project itself is inconsistent. Flag the inconsistency, not one side.
- Do NOT conflate style with correctness, security, or performance — those belong in `assure-review-functional`.
- Do NOT propose sweeping refactors when only a small diff was changed. Scope findings to the diff plus its immediate neighbors.
- Do NOT ignore project config files (`.editorconfig`, `.eslintrc`, `tsconfig.json`). Their rules win over inferred conventions.
- Do NOT silently downgrade repeat-offense findings. Recurring violations should be flagged prominently with prior context.
- Do NOT block merges on stylistic preferences with no project precedent. Use `PASS_WITH_WARNINGS` when the codebase does not yet have a rule.

## Verification

**Evidence produced:**

- Discovered-conventions list (naming style, file structure, error handling, test patterns, import style, type patterns).
- Project config files inspected (`.editorconfig`, `.eslintrc`, `tsconfig.json`, equivalents).
- Violations table with category, file:line, cited convention, and suggested fix.
- Repeat-offense list cross-referenced with `crewpilot_knowledge_search` results.
- Verdict (`PASS` / `PASS_WITH_WARNINGS` / `FAIL`) with confidence.

**Completion gates:**

- [ ] Conventions were discovered before findings were written (Step 1 ran first).
- [ ] Every violation cites a project rule or a nearby example, not a personal preference.
- [ ] Diff plus 5 nearest neighbor files were compared.
- [ ] When invoked as subagent, output is persisted via `crewpilot_artifact_write` with phase `review-standards`.

**Blocking conditions:**

- A violation has no project precedent → downgrade to suggestion or drop entirely.
- Project config files were not inspected → restart from Step 1.
- All findings flagged as repeat offenses without a knowledge-base lookup → cannot claim repeat-offense pattern.
