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

Gate reason codes are free strings in `gate_decisions.rejection_codes` (JSONB) and `canonical_jobs.rejection_reason` (text), so new codes are additive. `src/pipeline/gateReasonCodes.ts` holds the labels, including the legacy codes. Gate logic is versioned by `GATE_VERSION` (`src/contracts/version.ts`, now `gate-2026-11.1`). Since the 2026-11 policy it is independent of `SCHEMA_VERSION`.

| Code | Meaning | Status |
|---|---|---|
| `GATE_TRAVEL_ABOVE_LIMIT` | Travel above the configured `max_travel_pct` (20% today), or frequent travel with no percentage. The evidence names the configured limit. | New |
| `GATE_ON_CALL_REQUIRED` | Regular on-call is required while `regular_on_call_allowed` is false | New |
| `GATE_SHIFT_WORK_REQUIRED` | Shift work is required while `shift_work_allowed` is false | New |
| `GATE_JOB_LOCATION_MISMATCH` | The job is located only outside the authorized regions | New. Before, a job location was reported as `WORK_AUTHORIZATION_INCOMPATIBLE`, which now means only an explicit worker restriction. |
| `GATE_LIFESTYLE_INCOMPATIBLE` | Legacy umbrella code for travel, on-call and shift work | No longer emitted. Stored rows stay valid. |
| `NON_TECHNICAL_FUNCTION`, `GATE_NOT_AI_DATA` | Axis 1 (generic technical-function check) and Axis 2 (AI/data domain) | No longer emitted. A non-technical PM, programme, transformation, product-policy or investigator role is acceptable when it fits a lane and the candidate's experience, and lane routing decides. |
| `NON_TARGET_ROLE_FAMILY` + `GATE_OUT_OF_SCOPE_DOMAIN` | Explicit non-target title families: `GLOBAL_TITLE_EXCLUSIONS` (HR, sales, customer success, legal practice and counsel) and `NON_TECHNICAL_FUNCTION_TITLES` (accountant, payroll, support specialist, graphic/UX designer) | Still hard rejects. The second list emitted `NON_TECHNICAL_FUNCTION` before 2026-11 and now uses this role-family code. Legal-technology titles ("Legal Engineer", "Legal Innovation Technologist") and the agency name "Attorney-General's Chambers" do not match. |

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

The field is an optional array of 1–200 strings, each 2–120 characters. If it is absent or empty, no employer exception applies. A name matches the employer as whole words ("Example Bank" matches "Example Bank Singapore"). It also matches as a name prefix of at least five letters on the employer's first word, provided the rest of that word is empty or at least three letters ("ExampleBank" matches "ExampleBankGroup", but "Stripe" does not match "Stripes").

One shared resolver, `resolveEffectiveWorkabilityPolicy` (`src/pipeline/effectiveWorkabilityPolicy.ts`), builds the workspace policy plus this list. The hard gate, the recommendation decider (readiness) and the HN pre-filter all use it, and they all call `findOnsiteException`. Gate, decision and readiness rows therefore carry the same `workability_policy_hash`.

**Seeding.** Add the field to the private `work_preferences.json` under `mobility` and run `scripts/seed_workspace_preferences.ts --apply`. That script writes only to `STAGE3_STAGING_DATABASE_URL`. Activating the stage3 revision in production is a separate, owner-approved step. Re-gate after activation.

**Policy hash on merge.** `workability_policy_hash` changes for every workspace when this policy ships, because the hashed policy now contains the on-site exception config. Every gate, decision and readiness row written afterwards carries the new hash, with or without the stage3 field. A non-empty employer list changes the hash again. Stored decisions are not re-gated automatically, so a scoped re-gate is expected. Run `scripts/replay_hard_gate_policy_2026_11.ts`: its default is a read-only dry run, and `--apply` is guarded.
