# Daily job archiving

## Lifecycle and age policy

Archiving is a reversible lifecycle flag on `canonical_jobs` introduced by additive migration `migrations/080_reversible_job_archiving.sql` (numbered `080` after Agent 2's `079_profile_fact_contact_type.sql`). It does not change qualification, recommendation, or application status, and it does not delete or move observations, versions, decisions, documents, or application history.

The daily cutoff is calculated by PostgreSQL as `run_started_at - INTERVAL '3 months'`. A job is age-eligible only when its reference date is strictly earlier than that cutoff. Reference dates are selected in this order:

1. An evidenced genuine repost date.
2. An authoritative publication date.
3. The earliest recorded observation of the current posting identity. This basis is displayed as `Observed age; publication date unknown`.

Source updates, repeated ingestion, availability checks, and `updated_at` do not reset the archive clock. Contradictory and future source dates are reported as invalid rather than accepted. The separate 60-day application freshness policy is unchanged.

## Protection and restoration

Automated archiving protects jobs with an active application, active document-generation work, a running pipeline or evaluation lease, an active archive hold, or evaluation work awaiting manual review. The workspace-scoped Archive category shows archive date, reason, age basis, reference date, and the current user's application status. Application history remains in the tracker while a vacancy is archived.

A user can create a time-bounded `USER_PRESERVE` hold from the Archive category. The `AGENT2_PILOT` hold type is reserved for the selected live-job pilot. A restore records an audit event, clears the current recommendation pointer and outcome, creates a 14-day reassessment hold, and enqueues `APPLY_HARD_GATES` with a force-recalculation intent. The normal downstream pipeline recomputes freshness and readiness; stale or missing availability evidence remains `NEEDS_VERIFICATION` rather than becoming `OPEN`.

A source-normalized genuine repost with a newer evidenced repost date, or a new authoritative posting identity with a recent age reference, can reactivate an archived job. The normal pipeline then recomputes its current decision. Re-ingesting the same old posting does not reactivate it.

## Running and enabling the workflow

The scheduled workflow runs daily at 19:15 UTC, approximately 03:15 Singapore time. Like other production workflows, it restricts execution to `refs/heads/main` before accessing production credentials, enforces `WORKFLOW_KILL_SWITCH`, uses a PostgreSQL advisory lock, and runs with page size 250 and a maximum of 500 archives per apply run.

Scheduled runs remain dry-run until `JOB_ARCHIVING_ENABLED=true` and `JOB_ARCHIVING_PILOT_COMPLETE=true`. The **initial** `APPLY` activation run also requires `JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID` to identify the selected pilot job and an unexpired `AGENT2_PILOT` hold for that job, preventing the first bulk archive run from starting before the pilot is complete and protected. Once the initial `APPLY` run has succeeded, ongoing daily `APPLY` runs continue operating after that temporary `AGENT2_PILOT` hold expires or is released (while `runJobArchive` still honors any unexpired holds in `job_archive_holds`). The hold can be created in the Streamlit Archive category.

Run a dry-run locally with:

```powershell
npx tsx scripts/archive_jobs.ts --mode DRY_RUN
```

Apply mode requires the enable flag, the pilot job ID, and its active hold:

```powershell
$env:JOB_ARCHIVING_ENABLED = "true"
$env:JOB_ARCHIVING_PILOT_COMPLETE = "true"
$env:JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID = "<pilot-canonical-job-uuid>"
npx tsx scripts/archive_jobs.ts --mode APPLY
```

Pass `--workspace-id <uuid>` to scope a run to one workspace. The run report includes scanned, eligible, archived, protected, invalid-date, failed, deferred, and observed-age/publication-unknown counts, plus the exact candidate identities. Dry-runs persist operational run metadata but do not change jobs, tasks, decisions, or application history. A successful run that archives zero jobs is still successful.

The last successful run timestamp and latest run counts are available through `v_job_archive_operational_status` and the Streamlit Archive view. Soft archiving narrows active lists and processing; it does not reduce database storage.
