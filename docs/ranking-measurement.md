# Ranking measurement

`npm run measure:ranking` is a read-only report that answers one question: does
the deterministic score tell a job the owner saved from a job whose title the
owner would never take?

It runs every query inside one `BEGIN READ ONLY` transaction that is always
rolled back, and prints only the database host. Add `-- --json` for machine
output.

## What it reports

- **Separation**: the chance that a randomly chosen saved job outscores a
  randomly chosen non-fit (ties count one half). 0.5 is a coin flip, 1.0 is
  always right. Reported for match score, coverage and average similarity.
- **Review/Priority share**: saved jobs and non-fits whose deterministic
  decision is `REVIEW` or `PRIORITY` with `ELIGIBLE` eligibility.
- **Top 10 / Top 50**: saved jobs among the highest match scores of the measured
  pool (saved + non-fit). Read these against the "saved share of the pool"
  printed beside them, which is the hit rate a random order would give.
- **Why jobs are not measured**: every saved observation gets exactly one reason
  (counts add up to the total), plus a per-job view with the pipeline state of
  saved jobs that have no completed match.

Each figure is shown for ALL jobs, the FIT split (80%) and the HOLDOUT split
(20%). The split is a SHA-256 of the canonical job id, so a job never changes
side when other jobs are added.

## Non-fit titles

Non-fits are jobs that are not saved and whose title matches one of:
C++/embedded/firmware, frontend, mobile (iOS/Android) developer, game developer,
QA/test engineer, and backend or general software engineer titles that carry no
target-lane word (AI, data, cloud, platform, product, security, and so on).
DevOps, cloud, platform and architect titles are never non-fits. A job that is
also saved is dropped from the non-fit set. The rules live in
`src/reporting/rankingMeasurement.ts` (`classifyNonFitTitle`).

## Tests

- `src/tests/reporting/rankingMeasurement.test.ts`: maths and classification,
  with hand-worked expected values.
- `src/tests/reporting/rankingMeasurement.integration.test.ts`: the real SQL
  against a migrated local Postgres. It refuses non-local URLs and rolls back
  everything it seeds.
