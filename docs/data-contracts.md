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

Gate reason codes are free strings in `gate_decisions.rejection_codes` (JSONB) and `canonical_jobs.rejection_reason` (text), so new codes are additive. `src/pipeline/gateReasonCodes.ts` holds the labels, including the legacy codes. Gate logic is versioned by `GATE_VERSION` (`src/contracts/version.ts`, now `gate-2026-11.5`). Since the 2026-11 policy it is independent of `SCHEMA_VERSION`.

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

`GATE_HIGH_INTERACTION` also covers, for any title (including Solutions Architect and Product Specialist), a role that the posting places in a pre-sales, post-sales, customer success or customer engagement organisation, or whose own duties are the customer journey, proofs of value, representing the company, regular customer engagements or partnering with sales on adoption, expansion and renewal (`src/pipeline/customerFacingDuties.ts`). The clause must have this role or the applicant as its subject. Company boilerplate, "our customers", customer data, stakeholder work, analytics or models about customers (journey analytics, upsell propensity models), internal proofs of concept or value, internal customers and buyer-side RFPs never count; the matched clause is stored as evidence.

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
