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

Gate reason codes are free strings in `gate_decisions.rejection_codes` (JSONB) and `canonical_jobs.rejection_reason` (text), so new codes are additive. `src/pipeline/gateReasonCodes.ts` holds the labels, including legacy codes.

| Code | Meaning | Status |
|---|---|---|
| `GATE_TRAVEL_ABOVE_LIMIT` | Travel above the configured `max_travel_pct` (or frequent travel with no percentage) | New |
| `GATE_ON_CALL_REQUIRED` | Regular on-call required while `regular_on_call_allowed` is false | New |
| `GATE_SHIFT_WORK_REQUIRED` | Shift work required while `shift_work_allowed` is false | New |
| `GATE_JOB_LOCATION_MISMATCH` | The job is located only outside the authorized regions | New (was `WORK_AUTHORIZATION_INCOMPATIBLE`) |
| `GATE_LIFESTYLE_INCOMPATIBLE` | Legacy umbrella for travel, on-call and shift work | No longer emitted; stored rows stay valid |
| `NON_TECHNICAL_FUNCTION`, `GATE_NOT_AI_DATA` | Axis 1 / Axis 2 failures | No longer emitted as hard gates; lane routing decides fit |

The global rule still rejects a full-time on-site role. Two exceptions lift only the on-site and office-day rejections (`UNWORKABLE_LOCATION_MODEL`, `GATE_HIGH_OFFICE_DAYS`). Each lifted conflict is stored as an `ON-SITE EXCEPTION (...)` evidence quote. An unknown work mode still goes to `NEEDS_VERIFICATION`.

- `RESEARCH_ROLE`: the public list `global_workability_gates.work_mode.onsite_exceptions` in `config/policies/workability.yml` (universities, research institutes, hospital research units, research titles).
- `PREFERRED_EMPLOYER`: the optional stage3 preference field `mobility.onsite_exception_employers`.

```json
{ "mobility": { "onsite_exception_employers": ["Employer Name", "Another Employer"] } }
```

The field is an optional array of 1–200 strings, each 2–120 characters. If the field is absent or empty, no employer exception applies. A name matches the employer either as whole words ("Example Bank" matches "Example Bank Singapore") or as a name prefix of at least five letters ("ExampleBank" matches "ExampleBankGroup"). Add the field to the private `work_preferences.json` under `mobility` and seed it through `scripts/seed_workspace_preferences.ts` (guarded staging path). When the list is non-empty, the workability policy hash includes it.
