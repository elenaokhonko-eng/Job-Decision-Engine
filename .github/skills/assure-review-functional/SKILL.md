# Code Review — Functional

> **Pillar**: Assure | **ID**: `assure-review-functional`

## Purpose

Focused code review that evaluates **correctness, security, and performance** — the functional aspects that determine whether code works safely and efficiently. Separated from standards review so each can be delegated to a specialized subagent or run independently.

## Activation Triggers

- "functional review", "correctness review", "does this code work", "security review", "performance review"
- Automatically invoked by autopilot-worker Phase 6 via subagent delegation (role: `code-reviewer`)
- Can be run standalone for targeted reviews

## Methodology

### Pass 1 — Correctness

1. Trace the primary execution path against acceptance criteria
2. Identify logic errors, off-by-one, null/undefined risks, race conditions
3. Check edge cases: empty inputs, boundary values, error paths
4. Verify resource cleanup (connections, file handles, subscriptions)
5. Verify error handling: are errors caught, logged, and surfaced appropriately?
6. Confidence-gate: only report findings ≥ threshold

### Pass 2 — Security (OWASP Top 10 Quick Check)

1. **Injection** (A03): SQL, NoSQL, OS command, LDAP injection vectors
2. **Broken Auth** (A07): hardcoded credentials, weak session management
3. **Sensitive Data Exposure** (A02): secrets in code, unencrypted PII, overly broad API responses
4. **XSS** (A03): unescaped user input in HTML/templates
5. **Insecure Deserialization** (A08): untrusted JSON/YAML parsing without validation
6. **Broken Access Control** (A01): missing authorization checks, IDOR vulnerabilities
7. **Security Misconfiguration** (A05): debug mode in prod, overly permissive CORS, default credentials
8. Flag any `eval()`, `dangerouslySetInnerHTML`, `exec()`, or equivalent patterns

### Pass 3 — Performance

1. Identify O(n²) or worse patterns in hot paths
2. Flag await-in-loops and N+1 query patterns
3. Check for unnecessary allocations in loops
4. Look for missing caching opportunities on repeated computations
5. Identify blocking calls that could be async
6. Run `crewpilot_metrics_complexity` on changed files — flag functions above threshold

### Pass 4 — Requirements Alignment (optional, requires Work IQ)

If M365 context is available (via prior `analysis` artifact or direct query), validate the code changes against stated requirements:

1. Read the `analysis` artifact from the workflow (if running as subagent with a `workflow_id`) to retrieve M365 requirements context
2. If no artifact exists but `mcp_workiq_ask_work_iq` is available, query: "What requirements and acceptance criteria were stated for {feature/issue title} in recent meetings and emails?"
3. For each stated requirement, check the code changes:
   - **Implemented**: requirement is fully addressed by the code ✓
   - **Partial**: requirement is partially addressed — note what's missing
   - **Not addressed**: requirement has no corresponding implementation
4. Cross-reference acceptance criteria from the board issue against the actual behavior of the code
5. Flag any requirement gaps as `medium` severity findings

> **Note**: This pass is skipped if no M365 context is available and no board issue acceptance criteria exist. It does not block the review.

### Synthesis

1. Rank all findings by severity: `critical > high > medium > low`
2. Filter by `severity_floor` from config
3. Group by file/function
4. Provide specific fix suggestions with code snippets
5. If invoked as subagent, write output as artifact via `crewpilot_artifact_write` (phase: `review-functional`)

## Tools Required

- `crewpilot_metrics_complexity` — Get cyclomatic/cognitive complexity scores
- `crewpilot_metrics_coverage` — Check test coverage for reviewed code
- `crewpilot_artifact_write` — Persist review findings as artifact (when run as subagent)
- `crewpilot_artifact_read` — Read prior analysis artifacts for context (includes M365 requirements context)
- `mcp_workiq_ask_work_iq` — (optional) Query M365 for stated requirements when no analysis artifact exists

## Output Format

```
## [CrewPilot → Functional Review]

### Summary
{N} findings across {files}: {critical} critical, {high} high, {medium} medium

### Correctness
| Severity | File:Line | Issue | Suggested Fix |
|----------|-----------|-------|---------------|
| ...      | ...       | ...   | ...           |

### Security
| Severity | OWASP Cat | File:Line | Issue | Mitigation |
|----------|-----------|-----------|-------|------------|
| ...      | ...       | ...       | ...   | ...        |

### Performance
| Severity | File:Line | Issue | Suggested Fix |
|----------|-----------|-------|---------------|
| ...      | ...       | ...   | ...           |

### Requirements Alignment (if M365 context available)
| Requirement | Status | Evidence | Gap |
|-------------|--------|----------|-----|
| ...         | ✓/⚠️/❌ | ...      | ... |

### Verdict
{PASS | PASS_WITH_WARNINGS | FAIL}
Confidence: {N}/10
```

## Chains To

- `assure-review-standards` — Companion skill for conventions/consistency review
- `assure-code-quality` — Full 4-pass review (superset of this skill)
- `assure-vulnerability-scan` — Deep security audit (more thorough than Pass 2 here)

## References

- [Review Severity Taxonomy](../../references/review-severity-taxonomy.md) — shared Blocker / Critical / Major / Minor / Suggestion vocabulary and the gate each level applies.
- [Review Output Formats](../../references/review-output-formats.md) — shared report skeleton, verdict vocabulary, and persistence contract.

## Anti-Patterns

- Do NOT lecture on naming, formatting, or style — that work belongs in `assure-review-standards`.
- Do NOT report findings below the configured `severity_floor`. Noisy reviews get ignored.
- Do NOT approve a PR without tracing the primary execution path against acceptance criteria.
- Do NOT claim a security pass without running the full OWASP Top 10 quick check.
- Do NOT conflate high complexity with a bug. Complexity is a flag for follow-up, not a correctness finding.
- Do NOT skip Pass 4 silently when M365 context is available. State explicitly that requirements alignment was checked or skipped, and why.
- Do NOT downgrade severity to avoid producing a `FAIL` verdict. Severity reflects evidence, not appetite for blocking.

## Verification

**Evidence produced:**

- Findings table for each of the 4 passes (Correctness, Security, Performance, Requirements Alignment).
- OWASP Top 10 coverage list (which categories were evaluated, which were not applicable).
- Complexity scores from `crewpilot_metrics_complexity` for every changed file.
- Verdict (`PASS` / `PASS_WITH_WARNINGS` / `FAIL`) with a confidence score.

**Completion gates:**

- [ ] All 4 passes were executed; Pass 4 explicitly states whether M365 context was used or skipped.
- [ ] Every OWASP category from the Pass 2 list has a verdict (covered / not applicable / not evaluated).
- [ ] Findings filtered by `severity_floor`; raw counts preserved in the summary.
- [ ] When invoked as subagent, output is persisted via `crewpilot_artifact_write` with phase `review-functional`.

**Blocking conditions:**

- Any `critical` or `high` finding → verdict must be `FAIL` regardless of other passes.
- Pass 1 was skipped → cannot deliver a verdict; restart from Pass 1.
- Confidence below configured floor → escalate rather than emit a verdict.
