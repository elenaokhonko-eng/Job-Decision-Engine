# Daily job archiving

## Lifecycle and age policy

Archiving is a reversible lifecycle flag on `canonical_jobs` introduced by additive migration `migrations/093_reversible_job_archiving.sql` (renumbered from `080` to follow `092` under the migration-order check). It does not change qualification, recommendation, or application status, and it does not delete or move observations, versions, decisions, documents, or application history.

Two independent rules archive jobs; `scripts/archive_jobs.ts --rule age|hard-rejected|all` (default `all`) chooses which run. The hard-rejected rule runs first, so a job that qualifies under both is archived under its more specific reason.

### Hard-rejected rule (`HARD_REJECTED_PERMANENT`)

A job is archived the same day it is hard-rejected (on the next daily run) when all of these hold:

- `processing_state = 'HARD_REJECTED'` and `gate_decision = 'HARD_REJECT'`, not archived, not a test fixture;
- the rejection has stored reason codes (the latest `gate_decisions.rejection_codes`, else `canonical_jobs.rejection_reason`); a rejection without codes is reported as `missing_reason_codes` and kept active;
- the job's latest gate decision is a `HARD_REJECT` (a later `PASS` or `NEEDS_VERIFICATION` row means the canonical outcome is stale; it is reported as `unverifiable_decision` and kept active);
- no observation of the job comes from `LINKEDIN_SAVED` or `MCF_SAVED`: the owner's own saved jobs are always evaluated and never auto-archived (`excluded_saved_source`);
- no protection below applies.

The archive basis is `HARD_REJECTED_DECISION` (migration `111_archive_hard_rejected_basis.sql` widens the basis CHECK constraints) and the reference date is the `created_at` of the job's latest gate decision. Only a legacy job with no gate decision row falls back to `canonical_jobs.updated_at`; the archive event's `details.reference_source` records which (`GATE_DECISION` or `CANONICAL_UPDATED_AT_FALLBACK`), with the gate decision id and the rejection codes.

A hard-rejected archive is restored automatically only when the owner saves the job: a new `LINKEDIN_SAVED` or `MCF_SAVED` observation that normalizes to the job restores it (audited `RESTORED` event, reason `OWNER_SAVED_SOURCE_OBSERVATION`, 14-day reassessment hold, forced `APPLY_HARD_GATES`), and the saved observation keeps it out of the rule from then on. Observations from other sources, including a genuine repost, leave it archived: repost evidence rebuts an age, not a deterministic rejection. A manual restore from the Archive view works for either reason.

### Age rule (`JOB_OLDER_THAN_THREE_CALENDAR_MONTHS`)

The daily cutoff is calculated by PostgreSQL as `run_started_at - INTERVAL '3 months'`. A job is age-eligible only when its reference date is strictly earlier than that cutoff. Reference dates are selected in this order:

1. An evidenced genuine repost date.
2. An authoritative publication date.
3. The earliest recorded observation of the current posting identity. This basis is displayed as `Observed age; publication date unknown`.

Source updates, repeated ingestion, availability checks, and `updated_at` do not reset the archive clock. Contradictory and future source dates are reported as invalid rather than accepted. The separate 60-day application freshness policy is unchanged.

## Protection and restoration

Automated archiving protects jobs with an active application, active document-generation work, a running pipeline or evaluation lease, an active archive hold, or evaluation work awaiting manual review. The workspace-scoped Archive category shows archive date, reason, age basis, reference date, and the current user's application status. Application history remains in the tracker while a vacancy is archived.

A user can create a time-bounded `USER_PRESERVE` hold from the Archive category. The `AGENT2_PILOT` hold type is reserved for the selected live-job pilot. A restore records an audit event, clears the current recommendation pointer and outcome, creates a 14-day reassessment hold, and enqueues `APPLY_HARD_GATES` with a force-recalculation intent. The normal downstream pipeline recomputes freshness and readiness; stale or missing availability evidence remains `NEEDS_VERIFICATION` rather than becoming `OPEN`.

A source-normalized genuine repost with a newer evidenced repost date, or a new authoritative posting identity with a recent age reference, can reactivate a job archived by the age rule. The normal pipeline then recomputes its current decision. Re-ingesting the same old posting does not reactivate it.

## Running and enabling the workflow

The scheduled workflow runs daily at 19:15 UTC, approximately 03:15 Singapore time. Like other production workflows, it restricts execution to `refs/heads/main` before accessing production credentials, enforces `WORKFLOW_KILL_SWITCH`, uses a PostgreSQL advisory lock, and runs with page size 250 and a maximum of 500 archives per apply run.

Scheduled runs evaluate the rules named by the repository variable `JOB_ARCHIVING_RULE` (default `all`). They remain dry-run until `JOB_ARCHIVING_ENABLED=true` and either `JOB_ARCHIVING_PILOT_COMPLETE=true` or `JOB_ARCHIVING_RULE=hard-rejected`. Scheduled runs always cap each rule at 500 archives; a manual dispatch can choose the rule and raise `max_archives` (up to 10000) for a one-off backfill.

The live-job pilot gates the age rule only. A hard-rejected-only `APPLY` needs `JOB_ARCHIVING_ENABLED=true` and no kill switch, but not `JOB_ARCHIVING_PILOT_COMPLETE` or the pilot hold: it only takes jobs the deterministic gate already rejected with stored codes, never the owner's saved jobs, and every protection (including an `AGENT2_PILOT` or `USER_PRESERVE` hold) still applies. A hard-rejected-only `APPLY` run never counts as the age rule's initial activation. The **initial** `APPLY` activation run also requires `JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID` to identify the selected pilot job and an unexpired `AGENT2_PILOT` hold for that job, preventing the first bulk archive run from starting before the pilot is complete and protected. Once the initial `APPLY` run has succeeded, ongoing daily `APPLY` runs continue operating after that temporary `AGENT2_PILOT` hold expires or is released (while `runJobArchive` still honors any unexpired holds in `job_archive_holds`). The hold can be created in the Streamlit Archive category.

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

Archive only the hard-rejected backlog in one run (no pilot needed):

```powershell
$env:JOB_ARCHIVING_ENABLED = "true"
npx tsx scripts/archive_jobs.ts --mode DRY_RUN --rule hard-rejected --max-archives 6000
npx tsx scripts/archive_jobs.ts --mode APPLY --rule hard-rejected --max-archives 6000
```

Pass `--workspace-id <uuid>` to scope a run to one workspace. The run report includes the age rule's scanned, eligible, archived, protected, invalid-date, failed, deferred, and observed-age/publication-unknown counts with the exact candidate identities, and under `hard_rejected` the hard-rejected rule's scanned, eligible, archived, protected, excluded-saved-source, missing-reason-codes, unverifiable-decision, reference-fallback, deferred and failed counts with up to 500 candidate ids (no titles or companies, since workflow logs are public). `job_archive_runs` keeps the age rule's counts in its count columns (except `failed_count`, which covers both rules) and stores `rule` and `hard_rejected` in `report_summary`. A failure in either rule fails the run. Dry-runs persist operational run metadata but do not change jobs, tasks, decisions, or application history. A successful run that archives zero jobs is still successful.

The last successful run timestamp and latest run counts are available through `v_job_archive_operational_status` and the Streamlit Archive view. Soft archiving narrows active lists and processing; it does not reduce database storage.
