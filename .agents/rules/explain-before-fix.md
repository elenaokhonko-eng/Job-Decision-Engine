# Explain Before Fix Rule

When debugging, compiling, or resolving linter errors in the Job Decision Engine codebase:

1. **Investigate the Root Cause first**: Before editing any code or proposing a solution, you MUST identify and explain why the issue exists in the codebase (e.g. state management mismatch, schema error in `src/db/db.ts`, or Gemini API parameters mismatch).
2. **Explain the logic**: Write a concise, human-readable paragraph explaining the bug's mechanical origin before showing or applying the corrective code block.
3. **Draft the fix**: Apply the fix only after the root cause is crystal clear. Do not do silent edits.
