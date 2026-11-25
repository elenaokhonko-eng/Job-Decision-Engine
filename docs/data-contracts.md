# Data Contracts

Runtime contracts are defined in `src/contracts/index.ts`. JSON Schema artifacts in `src/contracts/json/` are generated with:

```bash
npm run contracts:export
```

CI runs `npm run contracts:check`, which regenerates schemas and fails when committed artifacts drift.

## Boundaries

- `IngestionEnvelope`: source identity, run identity, raw payload, and hash.
- `ExtractedJob`: normalized adapter/extractor output with raw payload and attribution metadata.
- `JobObservation`: persisted staging record.
- `CanonicalJobVersion`: canonical identity plus immutable description version.
- `GateDecision`: deterministic outcome and evidence.
- `LaneDecision`: semantic lane scores and evidence.
- `EvaluationQueueItem`: version-pinned lease/retry state.
- `EvaluationResult`: validated model output and provider audit metadata.
- `ShortlistRow`: version-pinned database read model consumed by Streamlit.
- `ApplicationReadiness`: strict runtime validation on persistence and on current-readiness consumption; `READY` cannot include unresolved mandatory checks.
- `DocumentOutputManifest`: versioned DOCX/PDF paths and SHA-256 hashes; document provenance rejects unversioned or malformed output manifests.
- Profile contact facts use versioned `CONTACT` rows with a supported key/value pair, `PRIVATE_INTERNAL` confidentiality, and `VERIFIED` or `SELF_ATTESTED` status. They are available to document rendering only and must be excluded from matching, embeddings, model evaluation context, and capability-profile artifacts.
- Compensation readiness treats undisclosed base salary as a preferred verification item; disclosed below-floor compensation remains a blocking check.

Canonical source names use uppercase values from `SourceNameSchema`. Schema tests require every exported boundary schema to contain object properties and required fields.

## Hard-gate reason codes and on-site exceptions

Gate reason codes are free strings in `gate_decisions.rejection_codes` (JSONB) and `canonical_jobs.rejection_reason` (text), so new codes are additive. `src/pipeline/gateReasonCodes.ts` holds the labels, including the legacy codes. Gate logic is versioned by `GATE_VERSION` (`src/contracts/version.ts`, now `gate-2026-11.8` (11.8 narrows commission to this role's main variable pay, see the paragraph below `GATE_HIGH_INTERACTION`); 11.7 narrows `GATE_HIGH_INTERACTION` to explicit evidence (a stated quota, sales target, commission-based pay, cold outbound duty, a pre-sales, sales-engineer or forward-deployed title (`presalesTitle` now also matches "Sales Engineer", "Senior Sales Engineer", "Sales Engineering Lead"; "Solutions Engineer" and "Solution Architect" do not match), commission as part of the pay ("commission-based", "base + 40k commission", "earnings include commission", "commission on every deal"; only in a clause about pay, never "commission-free", a negation, a body or its output such as "European Commission", "Commission staff", "Law Commission", "commission rates", "commissioning", or commission that a clause gives to other roles ("most sales positions are eligible for commission under the applicable plan") unless it also addresses this role), an interaction share over the cap; owner decision 2026-11-25, decision #213) and removes the bare description keywords "sales engineering", "presales" and "pre-sales" from the rejection rules (the keywords "client relationship management", "manage large teams" and "escalations manager" still reject on the phrase), and turns a bare customer-engagement duty phrase into the role-shape downrank `CUSTOMER_FACING_DELIVERY` (`role_shape_v2`); 11.6 changes no decision rule, it adds the version-refresh stamp and `flagNeedsVerification`, see the gate row of `.agents/DATA-FLOW-CONTRACT.md`). Since the 2026-11 policy it is independent of `SCHEMA_VERSION`.

| Code | Meaning | Status |
|---|---|---|
| `GATE_TRAVEL_ABOVE_LIMIT` | Travel above the configured `max_travel_pct` (20% today), or frequent travel with no percentage. The evidence names the configured limit. | New |
| `GATE_ON_CALL_REQUIRED` | Regular on-call is required while `regular_on_call_allowed` is false | New |
| `GATE_SHIFT_WORK_REQUIRED` | Shift work is required while `shift_work_allowed` is false | New |
| `GATE_JOB_LOCATION_MISMATCH` | The job is located only outside the authorized regions | New. Before, a job location was reported as `WORK_AUTHORIZATION_INCOMPATIBLE`, which now means only an explicit worker restriction. |
| `GATE_LIFESTYLE_INCOMPATIBLE` | Legacy umbrella code for travel, on-call and shift work | No longer emitted. Stored rows stay valid. |
| `NON_TECHNICAL_FUNCTION`, `GATE_NOT_AI_DATA` | Axis 1 (generic technical-function check) and Axis 2 (AI/data domain) | No longer emitted. A non-technical PM, programme, transformation, product-policy or investigator role is acceptable when it fits a lane and the candidate's experience, and lane routing decides. |
| `NON_TARGET_ROLE_FAMILY` + `GATE_OUT_OF_SCOPE_DOMAIN` | Explicit non-target title families: `GLOBAL_TITLE_EXCLUSIONS` (HR, sales, customer success, legal practice and counsel) and `NON_TECHNICAL_FUNCTION_TITLES` (accountant, payroll, support specialist, graphic/UX designer) | Still hard rejects. The second list emitted `NON_TECHNICAL_FUNCTION` before 2026-11 and now uses this role-family code. Legal-technology titles ("Legal Engineer", "Legal Innovation Technologist") and agency names such as "Attorney-General's Office" do not match. |

### Gate verification codes (gate-2026-11.4)

A `NEEDS_VERIFICATION` gate decision stores `NEEDS_VERIFICATION` plus the open fact the employer must confirm, and keeps every open fact when there are several:

| Open fact | Code | Confirmable fact (`v_job_verification_checks_scoped`) |
|---|---|---|
| Work mode unknown | `GATE_UNKNOWN_WORK_MODE` | `WORK_MODE` |
| Hiring territory not established, ambiguous territory alternatives, remote territory not stated | `NEEDS_VERIFICATION_HIRING_TERRITORY` | `LOCATION` |
| Office-day count (unknown office-day answer, hybrid without a count when required, ambiguous office wording) | `NEEDS_VERIFICATION_OFFICE_DAYS` | `OFFICE_DAYS` |
| Travel (unknown travel-cap answer, qualitative minimal travel, travel without a percentage) | `NEEDS_VERIFICATION_TRAVEL` | `TRAVEL_PCT` |

Before `gate-2026-11.4` every open fact other than the work mode was stored as `NEEDS_VERIFICATION_OFFICE_DAYS`. All four codes are routable (`src/pipeline/verificationRouting.ts`), so routing is unchanged. When the structured location is unknown, the gate also reads the posting's own `Location:` / `Job Location:` / `Job Location(s):` / `Work Location:` header value at the start of a line or segment, never a compound label such as `Headquarters Location:` (`src/pipeline/postingLocationLine.ts`) and stores the quote as evidence; `Work Type: Office Working` and `Office-based Working` are full on-site.

Since `gate-2026-11.7` the clauses below no longer reject; they are the downrank signal `CUSTOMER_FACING_DELIVERY`. Before it, `GATE_HIGH_INTERACTION` also covered, for any title (including Solutions Architect and Product Specialist), a role that the posting places in a pre-sales, post-sales, customer success or customer engagement organisation, or whose own duties are the customer journey, proofs of value, representing the company, regular customer engagements or partnering with sales on adoption, expansion and renewal (`src/pipeline/customerFacingDuties.ts`). The clause must have this role or the applicant as its subject. Company boilerplate, "our customers", customer data, stakeholder work, analytics or models about customers (journey analytics, upsell propensity models), internal proofs of concept or value, internal customers and buyer-side RFPs never count; the matched clause is stored as evidence.

Since `gate-2026-11.8` (owner decision 2026-11-26, dry-run evidence of live false positives) commission is read narrowly in `findExplicitSalesDuty` (`src/pipeline/customerFacingDuties.ts`). **Terms treated as sales-linked variable pay (one list): OTE / on-target earnings, commission, quota, sales target (revenue or bookings target), variable sales pay.** They reject as `GATE_HIGH_INTERACTION` only when they are this role's main variable pay or an explicit sales duty: commission-only / commission-based (hyphen form or "is commission based") / commission-driven pay; uncapped commission; OTE or on-target earnings (explicit terms; they reject on their own unless the clause is about other roles such as account executives, sales reps, SDRs or "quota-based roles"); "base plus commission" as the stated pay structure; "earn commission on sales" and "commission on every deal"; "earnings include commission"; "commission eligible" / "eligible for commission"; "you earn commission" in a clause that addresses this role; a quota or sales-target duty; cold calling, cold emailing or outbound prospecting as this role's own duty (a duty verb such as make, do, conduct, handle or "responsible for", or a clause that starts with the term as a duty, e.g. "Cold calling and outbound prospecting to build pipeline"; "Cold calls are made by our SDRs" and "Cold calling experience is a plus" do not count; "experience in cold calling", a team that does it and a negation do not count). They do not reject (ambiguous wording passes with no downrank: no existing role-shape signal fits, so none was added): a performance bonus described as "commission based on performance" for a role with no sales duty, a generic option list ("a bonus or commission", "a bonus, commission, or incentive program", "commission eligible, bonus or incentive program"), "commission opportunities" without a structure, commission paid to others (affiliate, referral, partner, "track affiliate commissions"), commission that a clause gives to other roles or company-wide text, a negation, "commission-free", "commissioning", "commissioned work", and bodies such as the European Commission. The scan stays linear in the clause length (clause facts are computed once; 1 MB of hostile text takes about 30 ms).

### On-site exceptions

The global rule still rejects a full-time on-site role. Two exceptions lift only the on-site and office-day conflicts (`UNWORKABLE_LOCATION_MODEL`, `GATE_HIGH_OFFICE_DAYS`, and readiness `WORK_MODE_INCOMPATIBLE`). Each lifted gate conflict is stored as an evidence quote of the form `ON-SITE EXCEPTION (<KIND>): <reason>; ... Lifted conflict: <original conflict>`. Readiness records the evidence key `onsite_exception:<KIND>`. An unknown work mode still goes to `NEEDS_VERIFICATION`.

- `RESEARCH_ROLE` comes from the public list `global_workability_gates.work_mode.onsite_exceptions` in `config/policies/workability.yml`. It covers universities and research institutes, hospital research units, and research titles such as "research fellow" and "research scientist". Rules for the list:
  - A bare "scientist" title counts only at a research employer (`bare_scientist_title_counts: false`).
  - Abbreviations of four characters or fewer ("NUS", "SIT") match only the whole employer name.
  - Public-list entries never prefix-match.
- `PREFERRED_EMPLOYER` comes from the optional stage3 preference field `mobility.onsite_exception_employers`.

```json
{ "mobility": { "onsite_exception_employers": ["Employer Name", "Another Employer"] } }
```

The field is an optional array of 1–200 strings, each 2–120 characters. If it is absent or empty, no employer exception applies. A name matches the employer as whole words ("Example Bank" matches "Example Bank Singapore"). It also matches as a name prefix of at least five letters on the employer's first word, provided the rest of that word is empty or at least three letters ("ExampleBank" matches "ExampleBankGroup", but "Northwind" does not match "Northwinds").

One shared resolver, `resolveEffectiveWorkabilityPolicy` (`src/pipeline/effectiveWorkabilityPolicy.ts`), builds the workspace policy plus this list. The hard gate, the recommendation decider (readiness) and the HN pre-filter all use it, and they all call `findOnsiteException`. Gate, decision and readiness rows therefore carry the same `workability_policy_hash`.

**Seeding.** Add the field to the private `work_preferences.json` under `mobility` and run `scripts/seed_workspace_preferences.ts --apply`. That script writes only to `STAGE3_STAGING_DATABASE_URL`. Activate it in production with `scripts/activate_workspace_preferences.ts` (see "Activating workspace preferences in production" below), then re-gate.

**Policy hash on merge.** `workability_policy_hash` changes for every workspace when this policy ships, because the hashed policy now contains the on-site exception config. Every gate, decision and readiness row written afterwards carries the new hash, with or without the stage3 field. A non-empty employer list changes the hash again. Stored decisions are not re-gated automatically, so a scoped re-gate is expected. Run `scripts/replay_hard_gate_policy_2026_11.ts`: its default is a read-only dry run that previews work-mode enrichment without fetching pages. `--apply` refuses any new HARD_REJECT unless `--allow-new-rejections=<n>` equals the dry-run count (always required with `--include-non-rejected` or `--ids-file`), reports re-gated, skipped (with reasons) and unchanged counts, compares applied outcomes with the dry run, and exits non-zero when processed differs from eligible. For rollback, `scripts/regate_job_ids.ts --ids-file=<path>` (dry run by default) re-gates an explicit id list; it uses only APIs that predate this change, so it can be restored after a revert and run under the reverted gate code. Bumping `GATE_VERSION` also makes queued `APPLY_HARD_GATES` tasks re-run instead of being treated as already satisfied.

## Task seeds and stale-stage zero checks

- Capped task seeds see live jobs only: the archived and fixture filters are inside the seed query, before its `LIMIT` (`applyLiveJobScope`, `src/tasks/seedQueryScope.ts`). Archived refusals at enqueue are reported as `skippedArchived` (log field `seed_skipped_archived`), not as `existing`.
- The DECIDE seed selects only what the decider will process: a complete description with source content, a state past routing (not `RAW_STAGED` or `PREQUALIFIED`, which the handler no-ops), and no closed outcome conflict, in addition to its state conditions (one shared predicate, `deciderSeedableSql`, also used by the `decider` stale-stage arm). A job the decider skips can no longer fill the cap. A job without complete content is not decided: it waits in the awaiting-content read model until its posting is fetched or normalized, and re-enters the seed then.
- A decider-version reassessment (`reassessment_reason` starting `DECIDER_VERSION:`) of a `HARD_REJECTED` or `UNMATCHED` job that has an outcome runs the decider in `preserveStoredOutcome` mode: the decision row is written only when the recomputed outcome and eligibility equal the stored ones, and the job row keeps every recommendation column (only `latest_deterministic_decision_id` moves). If they differ, nothing is written and the task is closed (not retried, not failed, never `PROCESSING_ERROR`) with `repair_action = OUTCOME_CONFLICT_ON_TERMINAL_JOB`; the decider version, the stored and recomputed outcome and eligibility, and the rule and note codes are recorded in the task payload (`outcome_conflict`). The job row is untouched. Such a job trips exactly one check: the failing zero check `terminal_outcome_conflict` (red until an operator fixes the stored outcome or the rule). It is not a `task_completed_without_result` (the task has a repair action) and is left out of the `decider` stale-stage count and the DECIDE seed, so it is counted once; it appears in `reported_counts.unseeded_stale_decisions` for information. The seed exclusion and the check apply only to a conflict closed under the CURRENT `DECIDER_VERSION`. What clears it: (1) a `DECIDER_VERSION` bump, after which the job is seeded again and is stamped or re-closed under the new version; (2) an explicit reopen without a bump, after the stored outcome or the rule was corrected: `reopenOutcomeConflictTasks` (`src/tasks/pipelineTasks.ts`) puts the closed task back to PENDING and the next drain stamps a decision (clears) or closes it again with fresh evidence. `terminal_outcome_conflict` runs in the post phase only (`runZeroChecks` with `--phase=post`, the default, and `scripts/check_integrity.ts`), so it fails the post-drain reconcile and the integrity check but does not stop `Reconcile pipeline before drain` (`--phase=pre`), which would otherwise keep the worker from running because of one job-local policy disagreement that processing cannot fix. Other `reprocess_existing_state` tasks do not bypass the terminal no-op. A terminal DECIDE task is a no-op only when a decision row exists for the version, which is what `task_completed_without_result` requires.
- `stage_result_older_than_rule_version` also reports `detail.decider` and `detail.gate`. `decider` equals what the DECIDE seed can reach and the handler can stamp (a state past lane routing; HARD_REJECTED, NEEDS_VERIFICATION or ROUTING_DEFERRED, or a current completed match run; complete description with source content; an outcome; a latest decision with another or NULL `decider_version`). `gate` equals the gate version seed. Both are zero after a drain.
- A stage task completes successfully only when its result exists, or when it records a designed no-op in `repair_action` (`src/tasks/designedNoOps.ts`). A DECIDE task that ends without a decision row for its version records `DECISION_NOT_STAMPABLE:<reason>` (`PRE_ROUTING_STATE`, `TERMINAL_HAS_DECISION`, `AWAITING_CONTENT_NOT_DECIDABLE`, `NO_CURRENT_MATCH_RUN`); a decider run that wrote nothing for a decidable job fails the task (retry, then the normal dead-letter path) instead of completing. A MATCH task with no match to perform records `MATCH_NOT_APPLICABLE:<state>`. A task with `repair_action` NULL and no result stays a `task_completed_without_result` error. `task_completed_without_result` also excludes, for rows closed before these codes existed, MATCH tasks of `UNMATCHED`, `ROUTING_DEFERRED`, `NEEDS_VERIFICATION` and `HARD_REJECTED` jobs, DECIDE tasks of `RAW_STAGED` and `PREQUALIFIED` jobs, and DECIDE tasks of a terminal job whose version the decider cannot select (`decidableJobVersionSql`).
- A `EXTRACT_DETERMINISTIC_REQUIREMENTS` task completes only when the active requirement set was made by the current `DETERMINISTIC_EXTRACTOR_VERSION`; an older-version run left in place fails the task.
- A decider-version DECIDE task (`reassessment_reason` starting `DECIDER_VERSION:`) that is `COMPLETED` while its version has no decision stamped under the current `decider_version` is reopened by the next enqueue of the same identity (`enqueuePipelineTask`, attempt count reset), but only for a job `deciderReachableSql` accepts (the predicate shared with the DECIDE seed handler and the `decider` stale-stage arm). An `OUTCOME_CONFLICT_ON_TERMINAL_JOB` closure under the current decider version is never reopened by this rule.
- The matcher re-match seed and the matcher stale-stage arm share `supersededProfileMatchSql`, which has a second branch: a live `UNMATCHED` job with `routing_disposition = ROUTED` and a lane, whose latest match run has another `policy_version` than the current matcher policy, for a matcher-selectable job (complete description with source content, an active requirement set with a completed deterministic extraction, a unique active profile). The task carries `superseded_match_run_id`; the handler and the matcher select accept `UNMATCHED` only for that explicit target. The re-match writes a new match run and, when no mandatory qualification fails any more, `MATCHED` (and clears the old `rejection_reason`); gate, lane and routing disposition are never changed, and a job still failing a mandatory qualification stays `UNMATCHED` with a current-policy run. An `UNMATCHED` job parked by the current policy and a `POLICY_NO_MATCH` job (the lane router seed owns it) are not selected and not counted.
- Stale decisions no seed reaches (for example UNMATCHED without a match run, LANE_ROUTED without a match, PREQUALIFIED) and live jobs with an outcome but no latest decision are not errors. `reconcile_pipeline.ts` reports them as `reported_counts` (`unseeded_stale_decisions`, `outcome_without_latest_decision`, by state); `reportedDecisionCounts` in `src/tasks/integrityZeroChecks.ts`.

## Activating workspace preferences in production

`scripts/seed_workspace_preferences.ts` stays the staging-only seeder: it writes only to `STAGE3_STAGING_DATABASE_URL` and refuses `DATABASE_URL`. A production change to the active `stage3` or `lane_intent` revision goes through `scripts/activate_workspace_preferences.ts` (logic in `src/policy/preferenceActivation.ts`), with these guards:

- **Explicit target database.** The script loads no `.env` or `.env.local`. The URL comes only from `--env=<file>`, which is parsed and never merged into the process environment, or, without `--env`, from the environment the caller set (for example `npx tsx --env-file=<file>`). Within that one source, `DATABASE_URL_UNPOOLED` wins over `DATABASE_URL`. Every dry run and apply prints `targetDatabase`: host, port, `current_database()`, the cluster `system_identifier` (`pg_control_system()`, null when the role cannot read it), the variable name and the source. Credentials are never printed.
- **Dry run by default.** The dry run opens a `READ ONLY` transaction, so it cannot write. It prints:
  - the active revision id, number and `preference_hash` of each domain, and the proposed hash;
  - the changed field paths, with list counts (`itemsAdded`, `itemsRemoved`, `reordered`). Values are printed only with `--show-values`;
  - the follow-up work (`followUps`): re-gate, re-route, re-decide or re-materialize;
  - the `diffHash` and the exact apply arguments.
- **Selection.** `--only=<selector>` (repeatable or comma-separated) takes only the named stage3 section or field (`mobility`, `mobility.onsite_exception_employers`), or `lane_intent` or `lane_intent.<key>`, from the file. Everything else stays as in the active revision. Without `--only`, every stage3 section in the file plus `lane_intent` is taken. A selected path missing from the file is refused, because the command never removes fields.
- **Unknown fields are refused.** Zod objects strip undeclared keys, so before validation the command walks the schema and refuses any undeclared field. A field such as `mobility.onsite_exception_employers` is accepted only once the code that defines it (PR #173) is deployed. Schema failures report the path and Zod issue code, never the value.
- **Apply needs all of these:**
  - `--apply`;
  - `--confirm-workspace=<uuid>`, equal to the resolved workspace;
  - `PREFERENCES_PROD_ACTIVATION_ALLOWED=true` in the environment;
  - `--expect-diff-hash=<hash>`, equal to the hash recomputed under lock;
  - `--operator=<who>` and `--reason=<why>`;
  - an OWNER membership for the resolved workspace;
  - migration 108.

  `PREFERENCES_PROD_ACTIVATION_ALLOWED` is read from the process environment only, never from the `--env` file.

  The OWNER check is a target-membership check, not authentication. It confirms that `WORKSPACE_KEY` / `WORKSPACE_USER_KEY` resolve to an active OWNER membership in the target database. Anyone who holds the database credentials can pass it, so access to those credentials is the real control.

  The diff hash binds the action, the target database (host, port, database name and `system_identifier`), the workspace and user, each domain's starting revision id and hash, and the target content hash. Each of the following is therefore refused with `DIFF_HASH_MISMATCH`:
  - an apply against a different database than the dry run, including a different host for the same cluster;
  - a different file or a different selection;
  - any activation between the dry run and the apply.
- **One transaction.** One transaction takes an advisory lock and `FOR UPDATE` on the active pointers, then saves the revision (`saveWorkspacePreferenceRevision`, which reuses an identical stored revision), moves the active pointer (the migration-075 trigger writes the `SWITCH` event), verifies the active hash and writes one `workspace_user_preference_change_audit` row per domain. Any failure rolls back everything. Revisions are never updated or deleted. Audit rows are append-only: row triggers reject UPDATE and DELETE, and a statement trigger rejects TRUNCATE.
- **Rollback.** `--rollback-to=<revision id>` re-activates a stored revision of the same workspace user, under the same guards and with its own diff hash. It creates no revision. The old revision must still validate against today's schema.

`workspace_user_preference_change_audit` (migration 108) records the domain, `APPLY` or `ROLLBACK`, the previous and active revision ids and hashes, the activation event id, the diff hash, the operator, the reason, the changed field paths (never values), the tool and the database role.

### Runbook

Pass the private `work_preferences.json` with `--file` (the default is `$PROFILE_DIR/work_preferences.json`, else `private/profile/work_preferences.json`). `<prod env file>` holds the production `DATABASE_URL_UNPOOLED` or `DATABASE_URL`. Use the same `--env` file for the dry run and the apply, and check that `targetDatabase` in the output is production. Do not paste preference values into `--reason`.

```bash
# 1. Dry run (read-only). Note workspaceId and diffHash.
npx tsx scripts/activate_workspace_preferences.ts --env=<prod env file> \
  --file=<path to private work_preferences.json> --only=mobility.onsite_exception_employers

# Optional: the same dry run with values, on a private terminal only.
npx tsx scripts/activate_workspace_preferences.ts --env=<prod env file> \
  --file=<path to private work_preferences.json> --only=mobility.onsite_exception_employers --show-values

# 2. Apply exactly what was reviewed.
PREFERENCES_PROD_ACTIVATION_ALLOWED=true npx tsx scripts/activate_workspace_preferences.ts --env=<prod env file> \
  --file=<path to private work_preferences.json> --only=mobility.onsite_exception_employers \
  --apply --confirm-workspace=<workspaceId> --expect-diff-hash=<diffHash> \
  --operator=<your name> --reason="<why, without values>"

# 3. Rollback: dry run, then apply with the rollback diff hash.
#    <previous revision id> is domains[].activeRevisionId from step 1.
npx tsx scripts/activate_workspace_preferences.ts --env=<prod env file> --rollback-to=<previous revision id>
PREFERENCES_PROD_ACTIVATION_ALLOWED=true npx tsx scripts/activate_workspace_preferences.ts --env=<prod env file> \
  --rollback-to=<previous revision id> --apply --confirm-workspace=<workspaceId> \
  --expect-diff-hash=<rollback diffHash> --operator=<your name> --reason="<why>"
```

In PowerShell, set `$env:PREFERENCES_PROD_ACTIVATION_ALLOWED = 'true'` before step 2 and remove it afterwards with `Remove-Item Env:PREFERENCES_PROD_ACTIVATION_ALLOWED`.

**After activation.** New gate, routing and decision runs read the new revision at once. Stored rows are not re-processed automatically, so run the dry run's `followUps`, each from its own reviewed dry run. The re-gate step needs PR #173's scripts, `scripts/replay_hard_gate_policy_2026_11.ts` and `scripts/regate_job_ids.ts`.

| Changed path | Follow-up |
|---|---|
| `stage3.mobility`, `stage3.watchlist`, `stage3.compensation`, `stage3.freshness` | Re-gate: `scripts/replay_hard_gate_policy_2026_11.ts` or `scripts/regate_job_ids.ts --ids-file` (both from PR #173). |
| `stage3.compensation`, `stage3.freshness`, `lane_intent` | Re-decide. Stored decisions keep their pinned preference revision until `DECIDE_RECOMMENDATION` runs again. |
| `lane_intent` | Re-route with `scripts/reroute_all_gate_pass.ts`. Route currency follows lane `routing_content_hash`, not `lane_intent`. |
| `stage3.mobility`, `stage3.freshness`, `stage3.culture_priorities`, `stage3.application_priority_weights` | Re-materialize with `scripts/materialize_application_rankings.ts`. |

With PR #173 deployed, a non-empty `mobility.onsite_exception_employers` list is part of `workability_policy_hash`, so rows written after activation carry a new hash.
